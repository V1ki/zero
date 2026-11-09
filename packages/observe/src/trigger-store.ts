import { Database } from 'bun:sqlite'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type CommissionOperator,
  type RouterEventActivity,
  type TriggerEvent,
  type TriggerIgnoredComment,
  type TriggerIgnoredDiscussion,
  type TriggerInboxItem,
  type TriggerSettings,
  TriggerSettingsConflictError,
  type TriggerSettingsSnapshot,
  type TriggerSource,
  type TriggerWorkspaceEvent,
  githubLifecycleKind,
  triggerGithubAppRefPattern,
} from '@zero-os/shared'
import { RouterLedgerStore } from './router-ledger-store'

import { GithubReplyStore } from './github-reply-store'
import { RouterArchiveStore } from './router-archive-store'
import { type RouterJob, RouterJobStore } from './router-job-store'
import { RouterTrackingStore, githubActorKey } from './router-tracking-store'
import { TriggerConversationStore } from './trigger-conversation-store'
import { TriggerMandateStore } from './trigger-mandate-store'
import { TriggerRetentionStore } from './trigger-retention-store'
import { TriggerRoutingStore } from './trigger-routing-store'
import { TriggerWebNotificationStore } from './trigger-web-notification-store'

export { TriggerSettingsConflictError }

export interface TriggerPush {
  source: TriggerSource
  stream: string
  revision: number
  events: readonly TriggerEvent[]
  ignoredComments?: readonly TriggerIgnoredDiscussion[]
}

export interface TriggerBatch extends TriggerPush {
  previousCursor: string | null
  cursor: string
}

function streamKey(source: TriggerSource, scope: string): string {
  return `${source}:${source === 'github' ? scope.toLowerCase() : scope}`
}

// Write grants are installation-bound. Activation timestamps come only from this transaction.
function applyGithubWriteGrants(
  settings: TriggerSettings,
  previous: TriggerSettings,
  now: string,
): TriggerSettings {
  const old = new Map(previous.github.repositories.map((r) => [r.name.toLowerCase(), r]))
  const repositories = settings.github.repositories.map((row) => {
    const {
      ownerMentionReplies,
      ownerMentionRepliesSince: _replyTime,
      closeResolvedDuplicates,
      closeResolvedDuplicatesSince: _duplicateTime,
      allowOwnerIssueClose,
      allowOwnerIssueCloseSince: _ownerCloseTime,
      ...repo
    } = row
    if (!repo.enabled || !repo.githubAppRef || !triggerGithubAppRefPattern.test(repo.githubAppRef))
      return repo
    const prior = old.get(repo.name.toLowerCase())
    const sameApp = prior?.enabled && prior.githubAppRef === repo.githubAppRef
    const sameReplyScope =
      sameApp &&
      !(repo.issueComments && !prior.issueComments) &&
      !(repo.pullRequestComments && !prior.pullRequestComments)
    return {
      ...repo,
      ...(ownerMentionReplies &&
        (repo.issueComments || repo.pullRequestComments) &&
        (!prior?.ownerMentionReplies || sameApp) && {
          ownerMentionReplies: true,
          ownerMentionRepliesSince:
            (sameReplyScope && prior.ownerMentionReplies && prior.ownerMentionRepliesSince) || now,
        }),
      ...(allowOwnerIssueClose &&
        repo.issueComments &&
        (!prior?.allowOwnerIssueClose || sameApp) && {
          allowOwnerIssueClose: true,
          allowOwnerIssueCloseSince:
            (sameApp &&
              prior.issueComments &&
              prior.allowOwnerIssueClose &&
              prior.allowOwnerIssueCloseSince) ||
            now,
        }),
      ...(closeResolvedDuplicates &&
        repo.issues &&
        (!prior?.closeResolvedDuplicates || sameApp) && {
          closeResolvedDuplicates: true,
          closeResolvedDuplicatesSince:
            (sameApp &&
              prior.issues &&
              prior.closeResolvedDuplicates &&
              !(repo.issueComments && !prior.issueComments) &&
              prior.closeResolvedDuplicatesSince) ||
            now,
        }),
    }
  })
  return { ...settings, github: { ...settings.github, repositories } }
}

/** Only settings that change the event filter should reset its baseline. */
function activeFilters(settings: TriggerSettings): Map<string, string> {
  const filters = new Map<string, string>()
  for (const repo of settings.github.repositories) {
    if (repo.enabled) {
      filters.set(
        streamKey('github', repo.name),
        JSON.stringify([
          settings.github.credentialRef,
          repo.branch,
          repo.workflow,
          repo.workflowFailures,
          repo.mention,
          repo.deliveryMode ?? 'poll',
          repo.webhookSecretRef ?? '',
          repo.ciWebhookSecretRef ?? '',
        ]),
      )
    }
  }
  for (const session of settings.wxarc.sessions) {
    if (session.enabled) filters.set(streamKey('wxarc', session.id), session.keyword)
  }
  return filters
}

type InboxRow = Omit<
  TriggerInboxItem,
  'url' | 'githubCommentKind' | 'githubCommentMention' | 'githubOwnComment'
> & {
  url: string | null
  githubCommentKind: NonNullable<TriggerEvent['githubCommentKind']> | null
  githubCommentMention: number | null
  githubOwnComment: number
}
const inboxQuery = `SELECT i.id, source, event_id AS eventId, scope, title, summary,
  occurred_at AS occurredAt, received_at AS receivedAt, url, c.kind AS githubCommentKind,
  c.mentioned AS githubCommentMention, i.github_own_comment AS githubOwnComment FROM trigger_visible_inbox i
  LEFT JOIN trigger_github_comments c ON c.inbox_id=i.id`

function decodeInboxItem({
  url,
  githubCommentKind,
  githubCommentMention,
  githubOwnComment,
  ...row
}: InboxRow): TriggerInboxItem {
  return {
    ...row,
    ...(url !== null && { url }),
    ...(githubCommentKind && { githubCommentKind }),
    ...(githubCommentMention && { githubCommentMention: true as const }),
    ...(githubOwnComment && { githubOwnComment: true as const }),
  }
}

export class TriggerStore {
  private agentIntake = false

  useAgentIntake() {
    this.agentIntake = true
  }

  canReadWxarcForRouter(event: TriggerInboxItem) {
    return this.agentIntake
      ? this.archive.hasRouterGrant(event)
      : this.getSettings().settings.wxarc.sessions.some(
          (session) => session.enabled && session.id === event.scope,
        )
  }
  /** One-time, additive migration; old evidence and effect receipts are never replayed. */
  migrateRouterWork(authorized: (job: RouterJob) => boolean) {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS router_legacy_links(kind TEXT NOT NULL,legacy_id INTEGER NOT NULL,matter_id TEXT NOT NULL,PRIMARY KEY(kind,legacy_id))',
    )
    return this.db
      .transaction(() => {
        let count = 0
        const remembered = (kind: string, id: number) =>
          this.db
            .query('SELECT 1 FROM router_legacy_links WHERE kind=? AND legacy_id=?')
            .get(kind, id)
        const remember = (kind: string, id: number, matterId: string) => {
          this.db.run('INSERT INTO router_legacy_links VALUES(?,?,?)', [kind, id, matterId])
          count++
        }
        const jobs = this.db
          .query<
            {
              id: number
              scope: import('./router-job-store').RouterJobScope
              returnState: string | null
            },
            []
          >(
            'SELECT job_id AS id,scope,return_state AS returnState FROM router_job_steps j WHERE retired=0 AND attempt=(SELECT max(attempt) FROM router_job_steps n WHERE n.job_id=j.job_id)',
          )
          .all()
        for (const row of jobs) {
          if (remembered('worker', row.id) || this.ledger.workerLink(row.id)) continue
          const job = this.jobs.get(row.scope, row.id)
          if (!job || !job.audience || !authorized(job)) continue
          const match = this.tracking.eventForJob(job.id, job.attempt)
          const matter = this.ledger.createMatter(
            'router-owner',
            `原 Worker #${job.id} 的事项`,
            job.instruction,
            ['核对原任务目标与已有证据，验证实际交付；旧执行状态不代表事项完成。'],
          )
          const uncertain =
            job.status === 'running' ||
            job.status === 'unknown' ||
            row.returnState === 'unknown' ||
            row.returnState === 'sending'
          this.ledger.updateMatter('router-owner', matter.id, matter.version, {
            state: uncertain ? 'paused' : 'waiting',
            context: {
              migration: {
                kind: 'worker',
                id: job.id,
                note: uncertain
                  ? '旧执行结果不确定，保留暂停状态，先核对外部事实，不能盲目重跑。'
                  : '沿用已有 Worker；首次继续时由 Router 核对原目标和实际完成证据。',
              },
              workerId: job.id,
              originalInstruction: job.instruction,
              lastResult: job.result,
              executionStatus: job.status,
              returnState: row.returnState,
            },
          })
          this.ledger.bindWorker({
            jobId: job.id,
            principal: 'router-owner',
            matterId: matter.id,
            scope: job.scope,
            audience: job.audience,
            eventIds: match?.event ? [match.event.id] : [],
            authority: job.workOrigin === 'manual' || !job.kind ? 'user' : 'source',
          })
          remember('worker', job.id, matter.id)
        }
        let before = Number.MAX_SAFE_INTEGER
        for (;;) {
          const tasks = this.mandates.listTasks(100, before)
          if (!tasks.length) break
          for (const task of tasks) {
            if (remembered('task', task.id)) continue
            const detail = this.mandates.getTask(task.id)
            const source = this.getInboxItem(task.latestInboxId)
            if (!detail || !source) continue
            const mandate = this.mandates
              .getSettings()
              .settings.mandates.find((m) => m.id === task.mandateId)
            const effects = detail.matches.flatMap((match) =>
              match.effects.map(({ target: _private, ...effect }) => ({
                ...effect,
                inboxId: match.inboxId,
              })),
            )
            const uncertain =
              effects.some(
                (effect) => effect.status === 'sending' || effect.status === 'unknown',
              ) || detail.matches.some((match) => match.status === 'analyzing')
            const matter = this.ledger.createMatter(
              'router-owner',
              task.title,
              mandate?.purpose || task.title,
              ['核对原委托目标、已有交付和未完成项；只补做尚未完成且仍授权的工作。'],
            )
            this.ledger.updateMatter('router-owner', matter.id, 1, {
              state: !task.active ? 'cancelled' : task.paused || uncertain ? 'paused' : 'waiting',
              context: {
                migration: {
                  kind: 'legacy-task',
                  id: task.id,
                  uncertain,
                  note: '保留原有回执，不能重复已经成功或结果未知的写入。',
                },
                standingInstructionId: task.mandateId,
                summaries: detail.matches.map((m) => ({
                  inboxId: m.inboxId,
                  summary: m.summary,
                  status: m.status,
                })),
                effects,
              },
            })
            for (const match of detail.matches)
              if (this.getInboxItem(match.inboxId))
                this.ledger.linkSource('router-owner', matter.id, match.inboxId)
            if (task.active && !task.paused && !uncertain) {
              const deferred = effects
                .filter((e) => e.status === 'deferred' && e.dueAt)
                .map((e) => e.dueAt as string)
                .sort()[0]
              const hasPending =
                effects.some((effect) => effect.status === 'pending') ||
                detail.matches.some((match) => match.status === 'pending')
              if (deferred || hasPending)
                this.ledger.scheduleTimer({
                  principal: 'router-owner',
                  matterId: matter.id,
                  scope: String(task.latestInboxId),
                  dueAt: new Date(
                    Math.max(deferred ? Date.parse(deferred) : 0, Date.now() + 1000),
                  ).toISOString(),
                  reason:
                    '接回原任务尚未完成的工作。先核对已保存的回执，再判断需补做的工作，不重复已交付结果。',
                  requestKey: `migrated-task:${task.id}`,
                })
            }
            remember('task', task.id, matter.id)
          }
          before = tasks[tasks.length - 1].id
        }
        return count
      })
      .immediate()
  }
  get followups() {
    return this.jobs.followups
  }
  readonly ledger: RouterLedgerStore
  readonly archive: RouterArchiveStore
  readonly githubReplies: GithubReplyStore
  readonly tracking: RouterTrackingStore
  readonly jobs: RouterJobStore
  readonly mandates: TriggerMandateStore
  readonly conversations: TriggerConversationStore
  readonly retention: TriggerRetentionStore
  readonly routing: TriggerRoutingStore
  readonly webNotifications: TriggerWebNotificationStore
  private readonly db: Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
      // SQLite inherits the database's permissions for WAL and shared-memory files.
      closeSync(openSync(dbPath, 'a', 0o600))
    }
    this.db = new Database(dbPath, { create: true })
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trigger_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_github_grants (
        actor TEXT PRIMARY KEY,
        credential_ref TEXT NOT NULL,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trigger_streams (
        stream TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        cursor TEXT
      );
      CREATE TABLE IF NOT EXISTS trigger_inbox (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        stream TEXT NOT NULL,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        url TEXT,
        UNIQUE (stream, event_id)
      );
      CREATE TABLE IF NOT EXISTS trigger_github_comments (
        inbox_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, mentioned INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_ignored_comments (
        stream TEXT NOT NULL,event_id TEXT NOT NULL,url TEXT NOT NULL,occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL,PRIMARY KEY(stream,event_id));
    `)
    this.githubReplies = new GithubReplyStore(this.db)
    this.ledger = new RouterLedgerStore(this.db)
    this.jobs = new RouterJobStore(this.db)
    this.routing = new TriggerRoutingStore(this.db)
    this.mandates = new TriggerMandateStore(this.db, (id) => this.getInboxItem(id))
    this.tracking = new RouterTrackingStore(this.db, this)
    if (
      !this.db
        .query("SELECT 1 FROM pragma_table_info('trigger_inbox') WHERE name='github_own_comment'")
        .get()
    ) {
      this.db.exec(`ALTER TABLE trigger_inbox ADD COLUMN github_own_comment INTEGER NOT NULL DEFAULT 0;
        UPDATE trigger_inbox SET github_own_comment=1 WHERE source='github' AND (
          id IN (SELECT inbox_id FROM router_watch_events WHERE self_echo=1)
          OR EXISTS(SELECT 1 FROM router_github_replies r WHERE r.state='sent'
            AND r.url=trigger_inbox.url COLLATE NOCASE
            AND trigger_inbox.event_id LIKE '%:comment:' || r.comment_id));`)
    }
    this.conversations = new TriggerConversationStore(this.db)
    this.retention = new TriggerRetentionStore(this.db)
    this.webNotifications = new TriggerWebNotificationStore(this.db)
    this.archive = new RouterArchiveStore(this.db, this)
    const defaults: TriggerSettings = {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [] },
    }
    this.db.run(
      'INSERT INTO trigger_settings (id, revision, json) VALUES (1, 0, ?) ON CONFLICT(id) DO NOTHING',
      [JSON.stringify(defaults)],
    )
    this.db
      .transaction(() => {
        const { revision, settings } = this.getSettings()
        this.syncGithubGrants(settings.github, revision)
        this.tracking.sync(settings.github, revision, new Date().toISOString())
        this.tracking.restoreHistoricalSubjects()
      })
      .immediate()
  }

  private syncGithubGrants(github: TriggerSettings['github'], revision: number): void {
    const actors = github.credentialRef
      ? [
          'web',
          ...(github.routerOperators ?? []).filter((actor) => actor.operatorId).map(githubActorKey),
        ]
      : []
    this.db.run(
      'DELETE FROM router_github_grants WHERE actor NOT IN (SELECT value FROM json_each(?))',
      [JSON.stringify(actors)],
    )
    for (const actor of actors) {
      // Only (re)granting this principal or replacing its connection creates a new generation.
      this.db.run(
        `INSERT INTO router_github_grants (actor, credential_ref, generation) VALUES (?, ?, ?)
         ON CONFLICT (actor) DO UPDATE SET credential_ref = excluded.credential_ref,
           generation = excluded.generation
         WHERE router_github_grants.credential_ref <> excluded.credential_ref`,
        [actor, github.credentialRef, revision],
      )
    }
  }

  getRouterGithubGrant(actor: 'web' | CommissionOperator) {
    return this.db
      .query<{ credentialRef: string; generation: number }, [string]>(
        'SELECT credential_ref AS credentialRef, generation FROM router_github_grants WHERE actor = ?',
      )
      .get(githubActorKey(actor))
  }

  getSettings(): TriggerSettingsSnapshot {
    const row = this.db
      .query<{ revision: number; json: string }, []>(
        'SELECT revision, json FROM trigger_settings WHERE id = 1',
      )
      .get()
    if (!row) throw new Error('Trigger settings are missing')
    return { revision: row.revision, settings: JSON.parse(row.json) as TriggerSettings }
  }

  saveSettings(
    input: TriggerSettings,
    expectedRevision: number,
    githubLookbackHours?: 1 | 24,
    expectedMandateRevision?: number,
  ): number {
    return this.db
      .transaction(() => {
        const current = this.getSettings()
        if (current.revision !== expectedRevision) throw new TriggerSettingsConflictError()
        if (
          expectedMandateRevision !== undefined &&
          this.mandates.getSettings().revision !== expectedMandateRevision
        )
          throw new TriggerSettingsConflictError()
        const now = new Date()
        const settings = applyGithubWriteGrants(input, current.settings, now.toISOString())
        const json = JSON.stringify(settings)
        if (JSON.stringify(current.settings) === json) return current.revision

        const before = activeFilters(current.settings)
        const after = activeFilters(settings)
        for (const stream of before.keys()) {
          if (!after.has(stream))
            this.db.run('DELETE FROM trigger_streams WHERE stream = ?', [stream])
        }
        const githubStart = new Date(now.getTime() - (githubLookbackHours ?? 0) * 3_600_000)
        for (const [stream, filter] of after) {
          if (before.get(stream) !== filter) {
            this.db.run(
              `INSERT INTO trigger_streams (stream, started_at, cursor) VALUES (?, ?, NULL)
             ON CONFLICT(stream) DO UPDATE SET started_at = excluded.started_at, cursor = NULL`,
              [stream, (stream.startsWith('github:') ? githubStart : now).toISOString()],
            )
          }
        }
        const revision = current.revision + 1
        this.syncGithubGrants(settings.github, revision)
        this.tracking.sync(settings.github, revision, githubStart.toISOString(), now.toISOString())
        this.db.run('UPDATE trigger_settings SET revision = ?, json = ? WHERE id = 1', [
          revision,
          json,
        ])
        return revision
      })
      .immediate()
  }

  getStreamStartedAt(stream: string): string | null {
    return (
      this.db
        .query<{ startedAt: string }, [string]>(
          'SELECT started_at AS startedAt FROM trigger_streams WHERE stream = ?',
        )
        .get(stream)?.startedAt ?? null
    )
  }

  readCursor(stream: string): string | null {
    return (
      this.db
        .query<{ cursor: string | null }, [string]>(
          'SELECT cursor FROM trigger_streams WHERE stream = ?',
        )
        .get(stream)?.cursor ?? null
    )
  }

  /** A stale poll cannot write an event or advance the cursor of a newer subscription. */
  commitBatch(batch: TriggerBatch): boolean {
    return this.db
      .transaction(() => {
        const changed = this.db.run(
          `UPDATE trigger_streams SET cursor = ? WHERE stream = ? AND cursor IS ?
         AND (SELECT revision FROM trigger_settings WHERE id = 1) = ?`,
          [batch.cursor, batch.stream, batch.previousCursor, batch.revision],
        )
        if (changed.changes === 0) return false

        this.insertEvents(batch)
        if (batch.source === 'github') this.tracking.scanned(batch.stream.slice('github:'.length))
        return true
      })
      .immediate()
  }

  /** Push delivery shares the inbox transaction and deduplication key without moving a poll cursor. */
  commitPush(batch: TriggerPush): boolean {
    return this.db
      .transaction(() => {
        const active = this.db
          .query(`SELECT 1 FROM trigger_streams WHERE stream = ?
        AND (SELECT revision FROM trigger_settings WHERE id=1) = ?`)
          .get(batch.stream, batch.revision)
        if (!active) return false
        this.insertEvents(batch)
        return true
      })
      .immediate()
  }

  private insertEvents(batch: TriggerPush) {
    for (const record of batch.ignoredComments ?? []) {
      if (
        !record.mentioned &&
        !this.tracking.accepts(batch.stream.slice('github:'.length), record.kind, record.occurredAt)
      )
        continue
      this.db.run(
        'INSERT INTO trigger_ignored_comments VALUES(?,?,?,?,?) ON CONFLICT(stream,event_id) DO NOTHING',
        [batch.stream, record.eventId, record.url, record.occurredAt, record.reason],
      )
    }
    const insert = this.db.query(
      `INSERT INTO trigger_inbox (source, stream, event_id, scope, title, summary, occurred_at, received_at, url, github_own_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stream, event_id) DO NOTHING`,
    )
    const receivedAt = new Date().toISOString()
    for (const event of batch.events) {
      if (streamKey(batch.source, event.scope) !== batch.stream) {
        throw new Error('Trigger event scope does not match its subscription')
      }
      const kind =
        batch.source === 'github'
          ? (event.githubCommentKind ?? githubLifecycleKind(event.eventId))
          : undefined
      const track = kind && this.tracking.accepts(event.scope, kind, event.occurredAt)
      // A separately verified PR @mention may predate or outlive the ordinary comment subscription.
      if (kind && !track && !(kind === 'pr-comment' && event.githubCommentMention)) continue
      const ownComment =
        batch.source === 'github' &&
        !!(
          event.githubOwnComment ||
          (event.url &&
            this.db
              .query(
                "SELECT 1 FROM router_github_replies WHERE state='sent' AND comment_id=? AND url=? COLLATE NOCASE",
              )
              .get(
                event.eventId.split(':')[1] === 'comment' ? event.eventId.split(':')[2] : '',
                event.url,
              ))
        )
      const added = insert.run(
        batch.source,
        batch.stream,
        event.eventId,
        event.scope,
        event.title,
        event.summary,
        event.occurredAt,
        receivedAt,
        event.url ?? null,
        ownComment ? 1 : 0,
      )
      if (!added.changes && ownComment)
        this.db.run('UPDATE trigger_inbox SET github_own_comment=1 WHERE stream=? AND event_id=?', [
          batch.stream,
          event.eventId,
        ])
      if (added.changes) {
        const item = {
          ...event,
          id: Number(added.lastInsertRowid),
          source: batch.source,
          receivedAt,
          ...(ownComment && { githubOwnComment: true as const }),
        }
        if (event.githubCommentKind) {
          this.db.run(
            'INSERT INTO trigger_github_comments(inbox_id,kind,mentioned) VALUES(?,?,?)',
            [item.id, event.githubCommentKind, event.githubCommentMention ? 1 : 0],
          )
        }
        if (this.agentIntake) {
          const archiveAuthority =
            item.source === 'wxarc' ? this.archive.modelAuthority(item) : undefined
          if (item.source === 'wxarc' && !archiveAuthority) continue
          const quoted =
            archiveAuthority && item.wxarcReplyToEventId
              ? this.db
                  .query<{ id: number }, [string, string]>(
                    'SELECT id FROM trigger_visible_inbox WHERE stream=? AND event_id=?',
                  )
                  .get(batch.stream, item.wxarcReplyToEventId)
              : null
          const original = quoted && this.getInboxItem(quoted.id)
          this.ledger.receiveSignal({
            key: `inbox:${item.id}`,
            principal: 'router-owner',
            kind: 'event',
            scope: String(item.id),
            payload: {
              inboxId: item.id,
              source: item.source,
              ...(archiveAuthority && { archiveAuthority }),
              ...(original &&
                this.archive.hasRouterGrant(original) && { quotedInboxId: original.id }),
            },
          })
          continue
        }
        this.mandates.match(item)
        if (batch.source === 'wxarc') this.archive.match(item)
        if (kind && track) this.tracking.match(item, kind)
        else if (item.source === 'github') this.tracking.matchWorkflow(item)
      }
    }
  }

  getInboxItem(id: number): TriggerInboxItem | null {
    const row = this.db.query<InboxRow, [number]>(`${inboxQuery} WHERE id = ?`).get(id)
    return row ? decodeInboxItem(row) : null
  }

  lastIgnoredComment(stream: string) {
    return (
      this.db
        .query<TriggerIgnoredComment, [string]>(
          'SELECT event_id AS eventId,url,occurred_at AS occurredAt,reason FROM trigger_ignored_comments WHERE stream=? ORDER BY occurred_at DESC,event_id DESC LIMIT 1',
        )
        .get(stream) ?? undefined
    )
  }

  listInbox(limit = 50, beforeId = Number.MAX_SAFE_INTEGER): TriggerInboxItem[] {
    return this.db
      .query<InboxRow, [number, number]>(`${inboxQuery} WHERE id < ? ORDER BY id DESC LIMIT ?`)
      .all(beforeId, Math.max(1, Math.min(200, limit)))
      .map(decodeInboxItem)
  }

  getEventActivity(inboxId: number): RouterEventActivity | undefined {
    const signal = this.db
      .query<Omit<RouterEventActivity, 'worker'>, [string]>(
        `SELECT state,kind,error FROM router_signals WHERE principal='router-owner' AND scope=? ORDER BY id DESC LIMIT 1`,
      )
      .get(String(inboxId))
    if (!signal) return
    // Use the exact attempt dispatched from this event, not a later job for another input.
    const worker = this.db
      .query<NonNullable<RouterEventActivity['worker']>, [string]>(
        `SELECT j.job_id AS id,j.attempt,j.status FROM trigger_visible_turns t
       JOIN router_job_steps j ON j.job_id=json_extract(t.answer,'$.job.id')
         AND j.attempt=json_extract(t.answer,'$.job.attempt') AND j.retired=0
       WHERE t.thread=? ORDER BY t.id DESC LIMIT 1`,
      )
      .get(String(inboxId))
    return { ...signal, ...(worker && { worker }) }
  }

  listWorkspaceEvents(
    limit = 35,
    beforeId = Number.MAX_SAFE_INTEGER,
    includeOwn = true,
  ): TriggerWorkspaceEvent[] {
    return this.db
      .query<
        Omit<TriggerWorkspaceEvent, 'githubOwnComment'> & { githubOwnComment: number },
        [number, number, number]
      >(
        `SELECT i.id, i.source, i.title, i.received_at AS receivedAt, r.status, i.github_own_comment AS githubOwnComment
         FROM trigger_visible_inbox i LEFT JOIN trigger_routes r ON r.inbox_id = i.id
         WHERE i.id < ? AND (? OR i.github_own_comment=0) ORDER BY i.id DESC LIMIT ?`,
      )
      .all(beforeId, includeOwn ? 1 : 0, Math.max(1, Math.min(100, limit)))
      .map(({ githubOwnComment, ...row }) => {
        const activity = this.getEventActivity(row.id)
        return {
          ...row,
          ...(githubOwnComment && { githubOwnComment: true as const }),
          ...(activity && { activity }),
        }
      })
  }

  close(): void {
    this.db.close()
  }
}
