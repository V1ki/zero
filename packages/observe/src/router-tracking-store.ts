import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type {
  CommissionOperator,
  RouterRepositoryTrackingReceipt,
  RouterTrackingResult,
  TriggerGithubRepository,
  TriggerInboxItem,
  TriggerSettings,
} from '@zero-os/shared'
import {
  githubFollowupSubject,
  githubReplySubject,
  githubWorkflowFollowupSubject,
  routerFollowupSignal,
} from '@zero-os/shared'
import { type RouterJob, RouterJobConflictError, type RouterJobScope } from './router-job-store'
import type { TriggerStore } from './trigger-store'

export class RouterTrackingError extends Error {}
type Actor = 'web' | CommissionOperator
const families = {
  issue: { flag: 'issues', column: 'issues_since' },
  pr: { flag: 'pullRequests', column: 'pulls_since' },
  'issue-comment': { flag: 'issueComments', column: 'issue_comments_since' },
  'pr-comment': { flag: 'pullRequestComments', column: 'pr_comments_since' },
} as const

type Kind = keyof typeof families
type ResultRow = { id: number; inboxId: number; kind: Kind | 'workflow-failure'; watchId: number }
interface JobEvent {
  trackingId: number
  inboxId: number
  event: TriggerInboxItem
  active: boolean
  selfEcho?: boolean
  followup?: boolean
  hadAction?: boolean
  previousResult?: string
  previousSources?: { label: string; url: string }[]
}
type IssueLink = { id: number; attempt: number; inboxId: number; appRef: string }
const linkColumns = 'job_id AS id,attempt,inbox_id AS inboxId,app_ref AS appRef'
const visibleResults = `SELECT e.job_id AS id,e.inbox_id AS inboxId,e.kind,e.watch_id AS watchId FROM router_watch_events e
  JOIN router_current_followup_watches w ON w.id=e.watch_id JOIN trigger_visible_inbox i ON i.id=e.inbox_id
  WHERE e.revoked=0`
const kinds = Object.keys(families) as Kind[]
const sinceColumns = Object.values(families).map(({ column }) => column)
const activeWatch = sinceColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')

export function githubActorKey(actor: Actor): string {
  return actor === 'web'
    ? actor
    : JSON.stringify([actor.platform, actor.channelId, actor.peerId, actor.operatorId])
}

interface Start {
  actor: Actor
  scope: RouterJobScope
  audience: string
  ownerAudience: string
  repository: string
  issues: boolean
  pullRequests: boolean
  issueComments?: boolean
  pullRequestComments?: boolean
  expectedGrantGeneration: number
  requestId: string
}
type Watch = {
  id: number
  audience: string
  repository: string
} & Record<(typeof sinceColumns)[number], string | null>
const columns = `id,audience,repository,${sinceColumns.join(',')}`
function secondBoundary(time: string) {
  return new Date(Math.floor(Date.parse(time) / 1000) * 1000).toISOString()
}

/** Register and fan out normalized lifecycle events in the same SQLite transactions as settings and inbox. */
export class RouterTrackingStore {
  // The runtime pins the local Web operator to its live credential. Store code never reads the secret.
  private workflowAudience?: () => string | null

  setWorkflowAudience(current: () => string | null) {
    this.workflowAudience = current
  }

  constructor(
    private readonly db: Database,
    private readonly host: Pick<
      TriggerStore,
      'jobs' | 'getSettings' | 'saveSettings' | 'getInboxItem'
    >,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_tracking_connection (
        id INTEGER PRIMARY KEY CHECK(id=1), credential_ref TEXT NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS router_lifecycle_starts (
        repository TEXT COLLATE NOCASE NOT NULL, kind TEXT NOT NULL, since TEXT,
        managed INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(repository,kind));
      CREATE TABLE IF NOT EXISTS router_github_watches (
        id INTEGER PRIMARY KEY, audience TEXT NOT NULL, generation INTEGER NOT NULL,
        repository TEXT COLLATE NOCASE NOT NULL, issues_since TEXT, pulls_since TEXT,
        issue_comments_since TEXT, pr_comments_since TEXT);
      CREATE TABLE IF NOT EXISTS router_watch_requests (
        scope TEXT NOT NULL,request_id TEXT NOT NULL,watch_id INTEGER NOT NULL,selection TEXT NOT NULL,
        PRIMARY KEY(scope,request_id));
      CREATE TABLE IF NOT EXISTS router_watch_events (
        watch_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,job_id INTEGER NOT NULL,
        kind TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0, app_ref TEXT, self_echo INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(watch_id,inbox_id));
      CREATE INDEX IF NOT EXISTS router_watch_events_inbox ON router_watch_events(inbox_id);
      CREATE TABLE IF NOT EXISTS router_issue_work_links (
        inbox_id INTEGER NOT NULL, request_id TEXT NOT NULL, job_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
        app_ref TEXT NOT NULL, PRIMARY KEY(inbox_id,request_id), UNIQUE(job_id,attempt));`)
    // Keep existing watches, request receipts and jobs when extending a two-family installation.
    db.transaction(() => {
      // The original table assigned a unique job per inbox row. Retain the old links as
      // attempt-1 receipts while allowing subsequent events to share that Worker.
      if (
        !db
          .query("SELECT 1 FROM pragma_table_info('router_watch_events') WHERE name='self_echo'")
          .get()
      ) {
        db.exec(`ALTER TABLE router_watch_events RENAME TO router_watch_events_v1;
          CREATE TABLE router_watch_events (
            watch_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,job_id INTEGER NOT NULL,kind TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,app_ref TEXT,self_echo INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(watch_id,inbox_id));
          INSERT INTO router_watch_events(watch_id,inbox_id,job_id,kind,revoked)
            SELECT watch_id,inbox_id,job_id,kind,revoked FROM router_watch_events_v1;
          DROP TABLE router_watch_events_v1;
          CREATE INDEX router_watch_events_inbox ON router_watch_events(inbox_id);`)
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS router_watch_events_job ON router_watch_events(job_id,inbox_id)',
      )
      const existing = db
        .query<{ name: string }, []>('PRAGMA table_info(router_github_watches)')
        .all()
      const missing = sinceColumns.filter((column) => !existing.some(({ name }) => name === column))
      if (missing.length) {
        for (const column of missing)
          db.exec(`ALTER TABLE router_github_watches ADD COLUMN ${column} TEXT`)
        db.exec(
          'DROP VIEW IF EXISTS router_current_watches; DROP INDEX IF EXISTS router_active_watch_per_repository;',
        )
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS router_active_watch_per_repository ON router_github_watches(repository)
          WHERE ${activeWatch};
        CREATE VIEW IF NOT EXISTS router_current_watches AS SELECT w.* FROM router_github_watches w
          JOIN router_tracking_connection g ON g.generation=w.generation WHERE ${activeWatch};
        CREATE TABLE IF NOT EXISTS router_workflow_watches (
          id INTEGER PRIMARY KEY AUTOINCREMENT, repository TEXT NOT NULL COLLATE NOCASE UNIQUE,
          binding TEXT NOT NULL, since TEXT NOT NULL);
        CREATE VIEW IF NOT EXISTS router_current_followup_watches AS
          SELECT id FROM router_current_watches UNION ALL SELECT -id FROM router_workflow_watches;
        CREATE TRIGGER IF NOT EXISTS router_revoke_workflow_model AFTER UPDATE OF json ON trigger_route_settings
          WHEN json_extract(OLD.json,'$.enabled')=1 AND json_extract(NEW.json,'$.enabled') IS NOT 1
          BEGIN UPDATE router_watch_events SET revoked=1 WHERE kind='workflow-failure' AND revoked=0; END;
        ${['INSERT', 'UPDATE']
          .map(
            (change) => `CREATE TRIGGER IF NOT EXISTS router_revoke_workflow_on_mandate_${change}
          AFTER ${change} ON mandates WHEN json_extract(NEW.definition,'$.enabled')=1 BEGIN
            UPDATE router_watch_events SET revoked=1 WHERE revoked=0 AND kind='workflow-failure'
            AND watch_id IN (SELECT -id FROM router_workflow_watches WHERE 'github:' || lower(repository)=NEW.stream);
          END;`,
          )
          .join('')}`)
    }).immediate()
  }

  grant(actor: Actor) {
    return this.db
      .query<{ generation: number; credentialRef: string }, [string]>(
        `SELECT max(c.generation,g.generation) AS generation,c.credential_ref AS credentialRef
         FROM router_tracking_connection c JOIN router_github_grants g ON g.credential_ref=c.credential_ref
         WHERE g.actor=?`,
      )
      .get(githubActorKey(actor))
  }

  /** Caller holds the settings transaction. Toggle each event family without rewinding unrelated sources. */
  sync(github: TriggerSettings['github'], revision: number, since: string, savedAt = since) {
    if (github.credentialRef && github.routerTrackingEnabled) {
      this.db.run(
        `INSERT INTO router_tracking_connection VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
        credential_ref=excluded.credential_ref,generation=excluded.generation WHERE credential_ref<>excluded.credential_ref`,
        [github.credentialRef, revision],
      )
    } else {
      this.db.run('DELETE FROM router_tracking_connection')
    }
    const workflows = github.repositories.filter((repo) => repo.enabled && repo.workflowFailures)
    this.db.run(
      'DELETE FROM router_workflow_watches WHERE repository NOT IN (SELECT value FROM json_each(?))',
      [JSON.stringify(workflows.map((repo) => repo.name))],
    )
    for (const repo of workflows) {
      const binding = JSON.stringify([
        github.credentialRef,
        repo.githubAppRef ?? '',
        repo.branch,
        repo.workflow,
        repo.deliveryMode ?? 'poll',
        repo.webhookSecretRef ?? '',
      ])
      this.db.run('DELETE FROM router_workflow_watches WHERE repository=? AND binding<>?', [
        repo.name,
        binding,
      ])
      this.db.run(
        'INSERT OR IGNORE INTO router_workflow_watches(repository,binding,since) VALUES(?,?,?)',
        [repo.name, binding, secondBoundary(savedAt)],
      )
    }
    for (const repo of github.repositories) {
      this.db.run(
        `UPDATE router_watch_events SET revoked=1 WHERE revoked=0 AND app_ref IS NOT NULL AND app_ref<>?
        AND watch_id IN (SELECT id FROM router_github_watches WHERE repository=?)`,
        [repo.githubAppRef ?? '', repo.name],
      )
    }
    for (const kind of kinds) {
      const { flag, column } = families[kind]
      const repos = github.repositories.filter((repo) => repo[flag])
      this.db.run(
        'DELETE FROM router_lifecycle_starts WHERE kind=? AND repository NOT IN (SELECT value FROM json_each(?))',
        [kind, JSON.stringify(repos.map((repo) => repo.name))],
      )
      // Pausing the entire repository suspends intake but preserves each family's routing owner.
      for (const repo of repos) {
        this.db.run(
          `INSERT INTO router_lifecycle_starts(repository,kind,since) VALUES(?,?,?)
           ON CONFLICT(repository,kind) DO UPDATE SET since=excluded.since,pending=1
           WHERE (since IS NULL) <> (excluded.since IS NULL)`,
          [
            repo.name,
            kind,
            repo.enabled
              ? secondBoundary(kind === 'issue-comment' || kind === 'pr-comment' ? savedAt : since)
              : null,
          ],
        )
      }
      this.db.run(
        `UPDATE router_github_watches SET ${column}=NULL WHERE ${column} IS NOT NULL
        AND repository NOT IN (SELECT repository FROM router_lifecycle_starts WHERE kind=? AND since IS NOT NULL)`,
        [kind],
      )
      this.db.run(
        `UPDATE router_watch_events SET revoked=1 WHERE revoked=0 AND kind=? AND watch_id NOT IN
        (SELECT id FROM router_current_watches WHERE ${column} IS NOT NULL)`,
        [kind],
      )
    }
  }

  start(input: Start): RouterRepositoryTrackingReceipt {
    const {
      actor,
      scope,
      audience,
      ownerAudience,
      repository,
      issues,
      pullRequests,
      expectedGrantGeneration,
      requestId,
    } = input
    const identity = githubActorKey(actor)
    const expectedScope =
      actor === 'web' ? 'general' : `im-${createHash('sha256').update(identity).digest('hex')}`
    if (
      scope !== expectedScope ||
      !audience ||
      !ownerAudience ||
      (actor === 'web' && audience !== ownerAudience) ||
      !requestId.trim() ||
      requestId.length > 256 ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) ||
      repository.length > 180 ||
      !kinds.some((kind) => input[families[kind].flag])
    )
      throw new RouterTrackingError('无法确认当前入口、仓库或需要跟踪的事件。')
    return this.db
      .transaction(() => {
        const grant = this.grant(actor)
        const ownerGrant = this.grant('web')
        if (!ownerGrant || !grant || grant.generation !== expectedGrantGeneration)
          throw new RouterTrackingError('当前入口没有有效的 GitHub 跟踪授权。')
        const prior = this.db
          .query<{ id: number; selection: string }, [string, string]>(
            'SELECT watch_id AS id,selection FROM router_watch_requests WHERE scope=? AND request_id=?',
          )
          .get(scope, requestId)
        const selection = JSON.stringify([
          repository.toLowerCase(),
          issues,
          pullRequests,
          grant.generation,
          audience,
          // Preserve already-durable request IDs from the original two-family schema.
          ...(input.issueComments || input.pullRequestComments
            ? [!!input.issueComments, !!input.pullRequestComments]
            : []),
        ])
        const snapshot = this.host.getSettings()
        const github = snapshot.settings.github
        const existing = github.repositories.find(
          (repo) => repo.name.toLowerCase() === repository.toLowerCase(),
        )
        if (prior) {
          const watch = this.db
            .query<Watch, [number, string]>(
              `SELECT ${columns} FROM router_current_watches WHERE id=? AND audience=?`,
            )
            .get(prior.id, ownerAudience)
          if (
            prior.selection !== selection ||
            !watch ||
            !existing?.enabled ||
            kinds.some((kind) => input[families[kind].flag] && !watch[families[kind].column])
          )
            throw new RouterTrackingError('先前的请求或跟踪授权已经变更，请重新提出跟踪。')
          return this.receipt(watch, existing)
        }
        if (existing && !existing.enabled)
          throw new RouterTrackingError('此仓库的监听已暂停，请先在监听配置中启用。')
        if (!existing && github.repositories.length >= 100)
          throw new RouterTrackingError('监听仓库已达到 100 个，请先在配置中移除不再需要的仓库。')
        const repo: TriggerGithubRepository = {
          ...(existing ?? {
            name: repository,
            enabled: true,
            branch: '',
            workflow: '',
            workflowFailures: false,
            mention: '',
          }),
          ...(issues && { issues: true }),
          ...(pullRequests && { pullRequests: true }),
          ...(input.issueComments && { issueComments: true }),
          ...(input.pullRequestComments && { pullRequestComments: true }),
        }
        const repositories = existing
          ? github.repositories.map((item) => (item === existing ? repo : item))
          : [...github.repositories, repo]
        this.host.saveSettings(
          { ...snapshot.settings, github: { ...github, repositories } },
          snapshot.revision,
        )
        // Only flags introduced through Router should stop collecting on loss of the watch.
        for (const kind of kinds) {
          const { flag } = families[kind]
          if (input[flag] && !existing?.[flag])
            this.db.run(
              'UPDATE router_lifecycle_starts SET managed=1 WHERE repository=? AND kind=?',
              [repo.name, kind],
            )
        }
        // A credential replacement must never resume work authorized against its predecessor.
        this.db.run(
          `UPDATE router_github_watches SET ${sinceColumns.map((column) => `${column}=NULL`).join(',')}
          WHERE repository=? AND (audience<>? OR generation<>?)`,
          [repo.name, ownerAudience, ownerGrant.generation],
        )
        const now = secondBoundary(new Date().toISOString())
        const watch = this.db
          .query<Watch, [string, number, string, ...(string | null)[]]>(
            `INSERT INTO router_github_watches(audience,generation,repository,${sinceColumns.join(',')})
             VALUES(?,?,?,${sinceColumns.map(() => '?').join(',')})
             ON CONFLICT(repository) WHERE ${activeWatch} DO UPDATE SET
             ${sinceColumns.map((column) => `${column}=COALESCE(${column},excluded.${column})`).join(',')}
             RETURNING ${columns}`,
          )
          .get(
            ownerAudience,
            ownerGrant.generation,
            repo.name,
            ...kinds.map((kind) => (input[families[kind].flag] ? now : null)),
          )
        if (!watch) throw new Error('Failed to save GitHub watch')
        this.db.run('INSERT INTO router_watch_requests VALUES(?,?,?,?)', [
          scope,
          requestId,
          watch.id,
          selection,
        ])
        return this.receipt(watch, repo)
      })
      .immediate()
  }

  private receipt(watch: Watch, repo: TriggerGithubRepository): RouterRepositoryTrackingReceipt {
    return {
      id: watch.id,
      repository: watch.repository,
      issues: !!watch.issues_since,
      pullRequests: !!watch.pulls_since,
      ...(watch.issue_comments_since && { issueComments: true }),
      ...(watch.pr_comments_since && { pullRequestComments: true }),
      deliveryMode: repo.deliveryMode ?? 'poll',
    }
  }

  pendingSince(repository: string): string | null {
    return (
      this.db
        .query<{ since: string | null }, [string]>(
          'SELECT min(since) AS since FROM router_lifecycle_starts WHERE repository=? AND pending=1',
        )
        .get(repository)?.since ?? null
    )
  }

  scanned(repository: string) {
    this.db.run('UPDATE router_lifecycle_starts SET pending=0 WHERE repository=? AND pending=1', [
      repository,
    ])
  }

  accepts(repository: string, kind: Kind, at: string): boolean {
    const since = families[kind].column
    return !!this.db
      .query(`SELECT 1 FROM router_lifecycle_starts
      WHERE repository=?1 AND kind=?2 AND since<=?3 AND (managed=0
        OR EXISTS(SELECT 1 FROM router_current_watches WHERE repository=?1 AND ${since}<=?3)
        OR (kind IN ('issue','pr') AND EXISTS(
          SELECT 1 FROM mandates WHERE stream=?4 AND json_extract(definition,'$.enabled')=1)))`)
      .get(repository, kind, at, `github:${repository.toLowerCase()}`)
  }

  /** Only Router-managed families that lost every watch/mandate are removed from an upstream poll. */
  pollSelection(repo: TriggerGithubRepository): TriggerGithubRepository | null {
    if (!kinds.some((kind) => repo[families[kind].flag])) return repo
    const at = new Date().toISOString()
    const selection = { ...repo }
    for (const kind of kinds) {
      const { flag } = families[kind]
      if (repo[flag]) selection[flag] = this.accepts(repo.name, kind, at)
    }
    if (
      !kinds.some((kind) => selection[families[kind].flag]) &&
      !repo.workflowFailures &&
      !repo.mention
    )
      return null
    return selection
  }

  private authority(watchId: number, app: string) {
    const lastRevocation =
      this.db
        .query<{ boundary: number }, [number]>(
          'SELECT COALESCE(max(inbox_id),0) AS boundary FROM router_watch_events WHERE watch_id=? AND revoked=1',
        )
        .get(watchId)?.boundary ?? 0
    return JSON.stringify([watchId, app, lastRevocation])
  }

  /** The old per-event schema recorded App identity only for Issue work handoffs.
   * Adopt verified active work without attributing old observations to today's App. */
  restoreHistoricalSubjects() {
    this.db.exec('CREATE TABLE IF NOT EXISTS router_tracking_migrations(name TEXT PRIMARY KEY)')
    if (
      this.db.query("SELECT 1 FROM router_tracking_migrations WHERE name='followup-subjects'").get()
    )
      return
    const repos = this.host.getSettings().settings.github.repositories
    const rows = this.db
      .query<{ watchId: number; jobId: number; original: number; linked: number; app: string }, []>(
        `SELECT e.watch_id AS watchId,e.job_id AS jobId,e.inbox_id AS original,l.inbox_id AS linked,l.app_ref AS app
       FROM router_watch_events e JOIN router_current_watches w ON w.id=e.watch_id
       JOIN trigger_visible_inbox i ON i.id=e.inbox_id
       JOIN router_issue_work_links l ON l.job_id=e.job_id AND l.app_ref != ''
       JOIN router_watch_events linked ON linked.watch_id=e.watch_id AND linked.inbox_id=l.inbox_id
       JOIN trigger_visible_inbox li ON li.id=linked.inbox_id
       WHERE e.app_ref IS NULL AND e.revoked=0 AND linked.revoked=0
         AND NOT EXISTS(SELECT 1 FROM router_issue_work_links other WHERE other.job_id=e.job_id
                        AND other.app_ref NOT IN ('',l.app_ref))
         AND EXISTS(SELECT 1 FROM router_job_steps j WHERE j.job_id=e.job_id AND j.retired=0
              AND j.audience=w.audience AND j.status='completed' AND json_extract(j.work_json,'$.outcome')='resolved')
       ORDER BY EXISTS(SELECT 1 FROM router_job_steps j, json_each(j.work_json,'$.steps') tool
              WHERE j.job_id=e.job_id AND json_extract(tool.value,'$.tool')='find_related_issues'
              AND json_extract(tool.value,'$.ok')=1) DESC, l.rowid DESC`,
      )
      .all()
    for (const row of rows) {
      const origin = this.host.getInboxItem(row.original)
      const linked = this.host.getInboxItem(row.linked)
      const a = githubReplySubject(origin, repos)
      const b = githubReplySubject(linked, repos)
      if (
        !a ||
        !b ||
        !origin ||
        a.ref !== row.app ||
        b.ref !== row.app ||
        a.kind !== 'issue' ||
        a.repositoryId !== b.repositoryId ||
        a.kind !== b.kind ||
        a.number !== b.number
      )
        continue
      const job = this.host.jobs.get('general', row.jobId, 1)
      if (!job?.audience || job.repository?.toLowerCase() !== a.repository.toLowerCase()) continue
      const subject = githubFollowupSubject(origin)
      if (!subject) continue
      this.host.jobs.followups.adopt(row.jobId, {
        kind: 'github-watch',
        scope: 'general',
        audience: job.audience,
        repository: job.repository,
        authority: this.authority(row.watchId, row.app),
        subject,
        eventKey: `inbox:${row.original}`,
      })
      // A future App change must immediately revoke this attested historical binding.
      this.db.run(
        'UPDATE router_watch_events SET app_ref=? WHERE watch_id=? AND inbox_id IN (?,?) AND app_ref IS NULL',
        [row.app, row.watchId, row.original, row.linked],
      )
    }
    this.db.run("INSERT INTO router_tracking_migrations VALUES('followup-subjects')")
  }

  /** Source subscription and the local Web operator must both allow model processing.
   * Keep the subscription receipt so its configured notification policy still applies. */
  matchWorkflow(event: TriggerInboxItem) {
    const subject = githubWorkflowFollowupSubject(event)
    if (!subject) return
    const watch = this.db
      .query<{ id: number; repository: string }, [string, string, number]>(
        `SELECT -w.id AS id,w.repository FROM router_workflow_watches w
        WHERE w.repository=?1 AND w.since<=?2 AND EXISTS(SELECT 1 FROM trigger_routes r
          WHERE r.inbox_id=?3 AND r.origin='subscription' AND r.status<>'cancelled')`,
      )
      .get(event.scope, event.occurredAt, event.id)
    const audience = watch && this.workflowAudience?.()
    if (!audience || !watch) return
    this.receive(event, 'workflow-failure', watch.id, watch.repository, audience, subject, '')
  }

  /** Called only on new, authenticated lifecycle events and under the inbox transaction. */
  match(event: TriggerInboxItem, kind: Kind) {
    const since = families[kind].column
    const watch = this.db
      .query<Watch, [string, string]>(
        `SELECT ${columns} FROM router_current_watches WHERE repository=? AND ${since}<=?`,
      )
      .get(event.scope, event.occurredAt)
    if (!watch) return
    const repo = this.host
      .getSettings()
      .settings.github.repositories.find(
        (r) => r.name.toLowerCase() === watch.repository.toLowerCase(),
      )
    if (!repo?.enabled) return
    const app = repo.githubAppRef ?? ''
    this.receive(
      event,
      kind,
      watch.id,
      watch.repository,
      watch.audience,
      routerFollowupSignal(event).subject,
      app,
    )
    if (!event.githubCommentMention) {
      this.db.run(
        "DELETE FROM trigger_routes WHERE inbox_id=? AND origin='subscription' AND status='pending'",
        [event.id],
      )
    }
  }

  private receive(
    event: TriggerInboxItem,
    kind: ResultRow['kind'],
    watchId: number,
    repository: string,
    audience: string,
    subject: string,
    app: string,
  ) {
    const priorReply =
      event.githubCommentKind &&
      event.url &&
      this.db
        .query(
          "SELECT 1 FROM router_github_replies WHERE state='sent' AND comment_id=? AND url=? COLLATE NOCASE",
        )
        .get(event.eventId.split(':')[2] ?? '', event.url)
    const job = this.host.jobs.followups.receive({
      scope: 'general',
      kind: 'github-watch',
      audience,
      repository,
      subject,
      authority: this.authority(watchId, app),
      eventKey: `inbox:${event.id}`,
      instruction: '判断该线索是否需要跟进，结合已有工作的进展，在当前授权范围内办理并交付结果。',
    })
    this.db.run(
      'INSERT INTO router_watch_events(watch_id,inbox_id,job_id,kind,app_ref,self_echo) VALUES(?,?,?,?,?,?)',
      [watchId, event.id, job.jobId, kind, app, event.githubOwnComment || priorReply ? 1 : 0],
    )
  }

  private originalEventForJob(jobId: number, inboxId?: number) {
    const row = this.db
      .query<
        { trackingId: number; inboxId: number; active: number; selfEcho: number },
        [number, number | null]
      >(
        `SELECT e.watch_id AS trackingId,e.inbox_id AS inboxId,e.self_echo AS selfEcho,
        (e.revoked=0 AND w.id IS NOT NULL) AS active FROM router_watch_events e
       LEFT JOIN router_current_followup_watches w ON w.id=e.watch_id WHERE e.job_id=?1 AND (?2 IS NULL OR e.inbox_id=?2) ORDER BY e.inbox_id LIMIT 1`,
      )
      .get(jobId, inboxId ?? null)
    const event = row && this.host.getInboxItem(row.inboxId)
    return row && event
      ? {
          trackingId: row.trackingId,
          inboxId: row.inboxId,
          event,
          active:
            !!row.active &&
            (row.trackingId >= 0 ||
              this.workflowAudience?.() === this.host.jobs.get('general', jobId, 1)?.audience),
          selfEcho: !!row.selfEcho,
        }
      : null
  }

  private eventRows(inboxId: number) {
    return this.db
      .query<ResultRow, [number]>(
        `${visibleResults} AND e.inbox_id=? ORDER BY e.job_id DESC LIMIT 1`,
      )
      .get(inboxId)
  }

  /** A continuation reads its own authenticated trigger, even when the worker began on an older comment. */
  eventForJob(jobId: number, attempt?: number): JobEvent | null {
    const step = attempt ?? this.host.jobs.get('general', jobId)?.attempt
    if (!step) return null
    const input = this.host.jobs.followups.step(jobId, step)
    if (input) {
      const current = this.originalEventForJob(jobId, Number(input.eventKey.slice('inbox:'.length)))
      if (!current) return null
      return {
        ...current,
        followup: input.followup,
        ...(current.active && input.followup && this.previousContext(jobId, step)),
      }
    }
    const original = this.originalEventForJob(jobId)
    if (!original || step === 1) return original
    const link = this.db
      .query<IssueLink, [number, number]>(
        `SELECT ${linkColumns} FROM router_issue_work_links WHERE job_id=? AND attempt=?`,
      )
      .get(jobId, step)
    if (!link) {
      const prior = this.db
        .query<{ attempt: number }, [number, number]>(`SELECT max(attempt) AS attempt FROM (
        SELECT attempt FROM router_followup_inputs WHERE job_id=?1 AND attempt<?2 UNION ALL
        SELECT attempt FROM router_issue_work_links WHERE job_id=?1 AND attempt<?2) HAVING max(attempt) IS NOT NULL`)
        .get(jobId, step)
      const source = prior ? this.eventForJob(jobId, prior.attempt) : original
      return source?.active
        ? { ...source, followup: false, ...this.previousContext(jobId, step) }
        : source
    }
    if (link.appRef === '') {
      const job = this.host.jobs.get('general', jobId, step)
      const current = this.originalEventForJob(jobId, link.inboxId)
      if (
        !current?.active ||
        job?.workOrigin !== 'manual' ||
        !job.requestId.startsWith(`event-work:${link.inboxId}:`)
      )
        return null
      return { ...current, followup: true, ...this.previousContext(jobId, step) }
    }
    const source = this.eventRows(link.inboxId)
    const event = source && this.host.getInboxItem(source.inboxId)
    if (!original.active || source?.watchId !== original.trackingId || !event) return null
    const repos = this.host.getSettings().settings.github.repositories
    const a = githubReplySubject(original.event, repos)
    const b = githubReplySubject(event, repos)
    if (
      !a ||
      !b ||
      a.kind !== 'issue' ||
      b.kind !== 'issue' ||
      a.repositoryId !== b.repositoryId ||
      a.number !== b.number ||
      a.ref !== link.appRef ||
      b.ref !== link.appRef
    )
      return null
    return { trackingId: source.watchId, inboxId: event.id, event, active: true }
  }

  private previousContext(jobId: number, before: number) {
    const history = this.db
      .query<{ attempt: number; actionable: number }, [number, number]>(
        `SELECT j.attempt, (j.work_origin IS NOT NULL OR COALESCE(json_extract(j.work_json,'$.followup.decision')='act',0)
          OR COALESCE(json_array_length(j.work_json,'$.steps'),0)>0
          OR COALESCE(json_extract(j.work_json,'$.outcome') IN ('needs_input','resolved'),0)) AS actionable
       FROM router_job_steps j JOIN router_watch_events e
       ON e.inbox_id=COALESCE(
         (SELECT l.inbox_id FROM router_issue_work_links l WHERE l.job_id=j.job_id AND l.attempt=j.attempt),
         (SELECT CAST(substr(f.event_key,7) AS INTEGER) FROM router_followup_inputs f WHERE f.job_id=j.job_id AND f.attempt=j.attempt),
         (SELECT min(base.inbox_id) FROM router_watch_events base WHERE base.job_id=j.job_id))
       JOIN router_current_followup_watches w ON w.id=e.watch_id JOIN trigger_visible_inbox i ON i.id=e.inbox_id
       WHERE j.job_id=? AND j.attempt<? AND j.retired=0 AND j.status IN ('completed','failed','unknown')
         AND e.revoked=0 AND (e.self_echo=0 OR j.work_origin='manual')
       ORDER BY actionable DESC,j.attempt DESC LIMIT 8`,
      )
      .iterate(jobId, before)
    let latest: RouterJob | null = null
    let action: RouterJob | null = null
    const sources = new Map<string, { label: string; url: string }>()
    for (const row of history) {
      const job = this.host.jobs.get('general', jobId, row.attempt)
      if (!job) continue
      latest ??= job
      if (row.actionable) {
        action ??= job
        for (const source of job.work?.sources ?? []) {
          if (sources.size < 8 && !sources.has(source.url)) sources.set(source.url, source)
        }
        if (sources.size >= 8) break
      }
    }
    return {
      hadAction: !!action,
      previousResult: (action ?? latest)?.result ?? undefined,
      previousSources: [...sources.values()],
    }
  }

  /** Bind a local action to the selected inbox event, including when several events share a Worker. */
  continueEventWork(
    inboxId: number,
    requestId: string,
    instruction: string,
    effectiveJobId: number,
  ) {
    return this.db
      .transaction(() => {
        const source = this.eventRows(inboxId)
        if (!source) throw new RouterJobConflictError('事件跟踪授权已变更。')
        let appRef = ''
        if (source.id !== effectiveJobId) {
          // Only an earlier authenticated issue handoff can move this action to a different job.
          const link = this.lastLinkedAttempt(inboxId)
          if (
            link?.id !== effectiveJobId ||
            !link.appRef ||
            !this.eventForJob(link.id, link.attempt)?.active
          )
            throw new RouterJobConflictError('事件的关联 Worker 已变更。')
          appRef = link.appRef
        }
        const identity = `event-work:${inboxId}:${requestId}`
        const step = this.host.jobs.continue(
          'general',
          effectiveJobId,
          identity,
          instruction,
          'manual',
        )
        this.db.run(
          `INSERT INTO router_issue_work_links(inbox_id,request_id,job_id,attempt,app_ref)
         VALUES(?,?,?,?,?) ON CONFLICT(inbox_id,request_id) DO NOTHING`,
          [inboxId, identity, step.id, step.attempt, appRef],
        )
        return step
      })
      .immediate()
  }

  continueIssueWork(
    inboxId: number,
    requestId: string,
    instruction: string,
    allowed: (job: RouterJob) => boolean,
  ) {
    return this.queueIssueWork(inboxId, requestId, instruction, allowed)
  }

  /** Called only after the GitHub reader authenticates the owner and their addressed close instruction. */
  handoffOwnerIssueWork(job: RouterJob, instruction: string) {
    const source = this.originalEventForJob(job.id)
    if (!source?.active || job.attempt !== 1) return null
    return this.queueIssueWork(source.inboxId, `owner:${job.id}`, instruction, () => true, job.id)
  }

  private queueIssueWork(
    inboxId: number,
    requestId: string,
    instruction: string,
    allowed: (job: RouterJob) => boolean,
    ownerJobId?: number,
  ) {
    if (!requestId.trim() || requestId.length > 256)
      throw new RouterJobConflictError('续办请求编号无效。')
    return this.db
      .transaction(() => {
        const source = this.eventRows(inboxId)
        const event = source && this.host.getInboxItem(inboxId)
        const ownJob = source && this.host.jobs.get('general', source.id)
        if (!source || !event?.url || !ownJob?.audience || !allowed(ownJob)) return null
        const repos = this.host.getSettings().settings.github.repositories
        const subject = githubReplySubject(event, repos)
        if (subject?.kind !== 'issue') return null
        if (ownerJobId !== undefined) {
          const repo = repos.find((r) => r.name === subject.repository)
          if (
            ownJob.id !== ownerJobId ||
            ownJob.attempt !== 1 ||
            ownJob.status !== 'running' ||
            event.githubCommentKind !== 'issue-comment' ||
            !repo?.allowOwnerIssueClose ||
            !repo.allowOwnerIssueCloseSince ||
            !(Date.parse(event.occurredAt) > Date.parse(repo.allowOwnerIssueCloseSince))
          )
            return null
        }
        const origin = ownerJobId === undefined ? 'manual' : 'owner'
        const identity = createHash('sha256')
          .update(JSON.stringify([origin, inboxId, requestId]))
          .digest('hex')
        const replay = this.db
          .query<IssueLink, [number, string]>(
            `SELECT ${linkColumns} FROM router_issue_work_links WHERE inbox_id=? AND request_id=?`,
          )
          .get(inboxId, identity)
        if (replay) {
          const job = this.host.jobs.get('general', replay.id, replay.attempt)
          if (!job || !allowed(job) || !this.eventForJob(job.id, job.attempt)?.active) return null
          if (job.instruction !== instruction || job.workOrigin !== origin)
            throw new RouterJobConflictError('请求编号已用于其他指令。')
          return job
        }
        // A known outgoing bot comment identifies the event that generated it. Never parse a cited Issue from text.
        const receipt =
          event.githubCommentKind &&
          this.db
            .query<{ inboxId: number }, [string, string]>(
              "SELECT inbox_id AS inboxId FROM router_github_replies WHERE state='sent' AND comment_id=? AND url=? COLLATE NOCASE LIMIT 1",
            )
            .get(event.eventId.split(':')[2], event.url)
        const candidates = this.db
          .query<ResultRow, [number, number, string, string, string, number]>(
            `${visibleResults} AND e.watch_id=?1 AND e.inbox_id<=?2 AND i.event_id LIKE ?3
          AND (i.url=?4 COLLATE NOCASE OR lower(substr(i.url,1,length(?5)))=lower(?5))
          ORDER BY (e.inbox_id=?6) DESC, e.inbox_id DESC`,
          )
          .all(
            source.watchId,
            inboxId,
            `${subject.repositoryId}:%`,
            subject.url,
            `${subject.url}#`,
            receipt?.inboxId ?? 0,
          )
        let target: RouterJob | null = null
        const ownInput = this.host.jobs.followups.forEvent(ownJob.id, `inbox:${inboxId}`)
        for (const candidate of candidates) {
          if (
            ownInput &&
            candidate.id !== ownJob.id &&
            this.host.jobs.followups.forEvent(candidate.id, `inbox:${candidate.inboxId}`)
          )
            continue
          const binding = githubReplySubject(this.host.getInboxItem(candidate.inboxId), repos)
          if (
            binding?.kind !== 'issue' ||
            binding.repositoryId !== subject.repositoryId ||
            binding.number !== subject.number ||
            binding.ref !== subject.ref
          )
            continue
          const prior = this.lastLinkedAttempt(candidate.inboxId)
          const linked = prior && this.eventForJob(prior.id, prior.attempt)?.active
          const job = this.host.jobs.get('general', linked ? prior.id : candidate.id)
          if (!job || job.audience !== ownJob.audience || !allowed(job) || job.id === ownerJobId)
            continue
          const meaningful = this.host.jobs
            .history('general', job.id)
            .some((s) => s.workOrigin || (s.work && s.work.outcome !== 'observed'))
          if (meaningful) {
            target = job
            break
          }
        }
        if (!target && ownerJobId !== undefined) return null
        const step = this.host.jobs.continue(
          'general',
          target?.id ?? ownJob.id,
          `issue-work:${identity}`,
          instruction,
          origin,
        )
        this.db.run(
          'INSERT INTO router_issue_work_links(inbox_id,request_id,job_id,attempt,app_ref) VALUES(?,?,?,?,?)',
          [inboxId, identity, step.id, step.attempt, subject.ref],
        )
        return step
      })
      .immediate()
  }

  private projectResult(
    row: ResultRow,
    allowed?: (job: RouterJob) => boolean,
    attempt?: number,
  ): RouterTrackingResult | undefined {
    const input = this.host.jobs.followups.forEvent(row.id, `inbox:${row.inboxId}`)
    const waiting = attempt === undefined && input?.attempt === null
    const job = this.host.jobs.get(
      'general',
      row.id,
      attempt ?? input?.attempt ?? (waiting ? undefined : 1),
    )
    if (!job?.repository || (allowed && !allowed(job))) return
    if (row.kind === 'workflow-failure' && this.workflowAudience?.() !== job.audience) return
    const event = this.host.getInboxItem(row.inboxId)
    if (!event) return
    const previous =
      !waiting && job.attempt > 1 && this.eventForJob(job.id, job.attempt - 1)?.active
        ? this.host.jobs.get('general', job.id, job.attempt - 1)
        : null
    const details = (step: RouterJob) => ({
      attempt: step.attempt,
      status: step.status,
      result: step.result,
      ...(step.workOrigin === 'manual' && { workOrigin: step.workOrigin }),
      ...(step.work && { work: step.work }),
    })
    return {
      id: row.id,
      repository: job.repository,
      inboxId: event.id,
      kind: row.kind,
      title: event.title,
      ...(event.url && { url: event.url }),
      occurredAt: event.occurredAt,
      ...(waiting ? { status: 'queued' as const, result: null } : details(job)),
      ...(previous && previous.audience === job.audience && { previous: details(previous) }),
      needsAttention:
        !waiting &&
        (job.work?.outcome === 'needs_input' ||
          !!job.attentionQuestion ||
          job.status === 'failed' ||
          job.status === 'unknown'),
      ...(!waiting && job.attentionQuestion && { attentionQuestion: job.attentionQuestion }),
    }
  }

  private lastLinkedAttempt(inboxId: number) {
    return this.db
      .query<IssueLink, [number]>(
        `SELECT ${linkColumns} FROM router_issue_work_links WHERE inbox_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(inboxId)
  }

  resultForEvent(inboxId: number, allowed: (job: RouterJob) => boolean) {
    const row = this.eventRows(inboxId)
    if (!row) return
    const link = this.lastLinkedAttempt(inboxId)
    if (link && this.eventForJob(link.id, link.attempt)?.active)
      return this.projectResult({ ...row, id: link.id }, allowed, link.attempt)
    // Older Web actions persisted the selected inbox in the local request ID, before
    // explicit step links existed. Match only that job's unlinked manual action.
    const prefix = `event-work:${inboxId}:`
    const legacy = this.db
      .query<{ attempt: number }, [number, string]>(
        `SELECT j.attempt FROM router_job_steps j WHERE j.job_id=?1 AND j.scope='general'
       AND j.kind='github-watch' AND j.work_origin='manual' AND j.retired=0
       AND substr(j.request_id,1,length(?2))=?2 AND length(j.request_id)>length(?2)
       AND NOT EXISTS(SELECT 1 FROM router_issue_work_links l WHERE l.job_id=j.job_id AND l.attempt=j.attempt)
       ORDER BY j.attempt DESC LIMIT 1`,
      )
      .get(row.id, prefix)
    if (legacy) {
      const selected = this.eventForJob(row.id, legacy.attempt)
      if (selected?.active && selected.inboxId === inboxId)
        return this.projectResult(row, allowed, legacy.attempt)
    }
    return this.projectResult(row, allowed)
  }

  listResults(
    limit = 30,
    beforeId = Number.MAX_SAFE_INTEGER,
    allowed?: (job: RouterJob) => boolean,
  ): RouterTrackingResult[] {
    const results: RouterTrackingResult[] = []
    const rows = this.db
      .query<ResultRow, [number]>(`${visibleResults} AND e.inbox_id<? ORDER BY e.inbox_id DESC`)
      .iterate(beforeId)
    for (const row of rows) {
      const result = this.resultForEvent(row.inboxId, allowed ?? (() => true))
      if (!result) continue
      results.push(result)
      if (results.length >= Math.max(1, Math.min(100, limit))) break
    }
    return results
  }
}
