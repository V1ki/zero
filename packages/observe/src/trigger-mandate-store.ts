import type { Database } from 'bun:sqlite'
import {
  type MandateAuditEntry,
  type MandateEffect,
  type MandateMatch,
  type MandateTarget,
  type MandateTask,
  type MandateTaskDetail,
  type MandateWork,
  type TriggerInboxItem,
  type TriggerMandate,
  type TriggerMandateSettings,
  type TriggerMandateSnapshot,
  TriggerSettingsConflictError,
} from '@zero-os/shared'
import { MandateEffectStore } from './trigger-mandate-effects'

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const taskFields = `id, mandate_id AS mandateId, business_key AS businessKey, title,
  latest_inbox_id AS latestInboxId, event_count AS eventCount, session_id AS sessionId,
  active, paused, acknowledged_at AS acknowledgedAt, updated_at AS updatedAt`
const matchFields = `id, task_id AS taskId, mandate_id AS mandateId, inbox_id AS inboxId,
  status, summary, error`
type TaskRow = Omit<MandateTask, 'paused' | 'active'> & { paused: number; active: number }
type MatchRow = Omit<MandateMatch, 'effects'>
type EffectRow = Omit<MandateEffect, 'target'> & { target: string | null }
const decodeTask = (row: TaskRow): MandateTask => ({
  ...row,
  paused: !!row.paused,
  active: !!row.active,
})
const pageSize = (limit: number) => Math.max(1, Math.min(200, limit))
const streamFor = ({ source, scope }: Pick<TriggerMandate, 'source' | 'scope'>) =>
  `${source}:${source === 'github' ? scope.toLowerCase() : scope}`

function businessKey(event: TriggerInboxItem): string {
  if (event.businessKey && /^[a-zA-Z0-9][\w.:/-]{0,199}$/.test(event.businessKey))
    return `adapter:${event.businessKey}`
  if (event.source === 'github') {
    const run = /^(\d+):run:(\d+):\d+:failure$/.exec(event.eventId)
    if (run) return `repo:${run[1]}:run:${run[2]}`
    const comment = /^(\d+):comment:(\d+)$/.exec(event.eventId)
    const prefix = `https://github.com/${event.scope.toLowerCase()}/pull/`
    if (comment && event.url?.toLowerCase().startsWith(prefix)) {
      const pr = /^(\d+)#issuecomment-(\d+)$/.exec(event.url.slice(prefix.length))
      if (pr && pr[2] === comment[2]) return `repo:${comment[1]}:pr:${pr[1]}`
    }
  }
  return `event:${event.eventId}`
}

// Changes in data scope, purpose or audience start a new task generation. A recipient
// added tomorrow cannot acquire the previous audience's task history by guessing its id.
function authority(m: TriggerMandate) {
  return JSON.stringify([
    m.enabled,
    streamFor(m),
    m.purpose,
    m.keyword,
    m.groupBy ?? 'thread',
    m.processing ?? 'agent',
    m.projectId,
    m.targets.map((t) => [t.platform, t.channelId, t.peerId, t.operatorId ?? null]).sort(),
    m.archive ? [m.archive.channelId, m.archive.documentId] : null,
  ])
}
const retireTasks = (where: string) => `
  UPDATE mandate_tasks SET active=0,updated_at=${now} WHERE active=1 AND ${where};
`
export class TriggerMandateStore extends MandateEffectStore {
  constructor(
    db: Database,
    private readonly inbox: (id: number) => TriggerInboxItem | null,
  ) {
    super(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_mandate_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL);
      INSERT OR IGNORE INTO trigger_mandate_settings VALUES(1,0,'{"mandates":[],"projects":[]}');
      CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, stream TEXT NOT NULL, definition TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mandates_scope ON mandates(stream);
      CREATE TABLE IF NOT EXISTS mandate_tasks (
        id INTEGER PRIMARY KEY, mandate_id TEXT NOT NULL, business_key TEXT NOT NULL,
        title TEXT NOT NULL, latest_inbox_id INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 1,
        session_id TEXT, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        paused INTEGER NOT NULL DEFAULT 0, acknowledged_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS mandate_active_task ON mandate_tasks(mandate_id,business_key) WHERE active=1;
      CREATE TABLE IF NOT EXISTS mandate_matches (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, mandate_id TEXT NOT NULL, inbox_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', summary TEXT, error TEXT, claim_token TEXT,
        UNIQUE(mandate_id,inbox_id));
      CREATE INDEX IF NOT EXISTS mandate_match_task ON mandate_matches(task_id,id);
      CREATE INDEX IF NOT EXISTS mandate_match_queue ON mandate_matches(status,id);
      CREATE TABLE IF NOT EXISTS mandate_effects (
        match_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        destination TEXT, target TEXT, reason TEXT, due_at TEXT, receipt TEXT, PRIMARY KEY(match_id,kind));
      CREATE INDEX IF NOT EXISTS mandate_effect_queue ON mandate_effects(kind,status,due_at,match_id);
      CREATE TABLE IF NOT EXISTS mandate_actions (
        task_id INTEGER NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, verb TEXT NOT NULL,
        PRIMARY KEY(task_id,actor,request_id));
      CREATE TABLE IF NOT EXISTS mandate_audit (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (${now}), action TEXT NOT NULL,
        mandate_id TEXT, match_id INTEGER, detail TEXT NOT NULL);
      CREATE VIEW IF NOT EXISTS mandate_eligible_matches AS
        SELECT m.id FROM mandate_matches m JOIN mandate_tasks t ON t.id=m.task_id
        JOIN mandates d ON d.id=m.mandate_id JOIN trigger_streams s ON s.stream=d.stream
        WHERE t.active=1 AND t.paused=0 AND m.status!='revoked' AND json_extract(d.definition,'$.enabled')=1
        AND (SELECT json_extract(json,'$.enabled') FROM trigger_route_settings WHERE id=1)=1;
      CREATE TRIGGER IF NOT EXISTS mandate_cancel_on_stream_removal AFTER DELETE ON trigger_streams
        BEGIN ${retireTasks('mandate_id IN (SELECT id FROM mandates WHERE stream=OLD.stream)')} END;
      CREATE TRIGGER IF NOT EXISTS mandate_cancel_on_stream_change AFTER UPDATE OF started_at ON trigger_streams
        BEGIN ${retireTasks('mandate_id IN (SELECT id FROM mandates WHERE stream=OLD.stream)')} END;
      CREATE TRIGGER IF NOT EXISTS mandate_cancel_on_retirement AFTER UPDATE OF active,paused ON mandate_tasks
        WHEN (NEW.active=0 OR NEW.paused=1) BEGIN
          UPDATE mandate_effects SET status='revoked',reason='任务已暂停或委托授权已变更',due_at=NULL
          WHERE match_id IN (SELECT id FROM mandate_matches WHERE task_id=NEW.id)
            AND status IN ('pending','deferred','failed');
          UPDATE mandate_matches SET status='revoked',claim_token=NULL
          WHERE task_id=NEW.id AND status IN ('pending','analyzing','failed');
        END;
      CREATE TRIGGER IF NOT EXISTS mandate_log_match AFTER INSERT ON mandate_matches BEGIN
        INSERT INTO mandate_audit(action,mandate_id,match_id,detail) VALUES('match',NEW.mandate_id,NEW.id,NEW.status);
      END;
      CREATE TRIGGER IF NOT EXISTS mandate_log_analysis AFTER UPDATE OF status ON mandate_matches
        WHEN OLD.status!=NEW.status BEGIN
        INSERT INTO mandate_audit(action,mandate_id,match_id,detail) VALUES('analysis',NEW.mandate_id,NEW.id,NEW.status);
      END;
      CREATE TRIGGER IF NOT EXISTS mandate_log_effect AFTER UPDATE OF status,due_at ON mandate_effects
        WHEN OLD.status!=NEW.status OR OLD.due_at IS NOT NEW.due_at BEGIN
        INSERT INTO mandate_audit(action,mandate_id,match_id,detail)
          SELECT NEW.kind,mandate_id,id,NEW.status || COALESCE(' · ' || NEW.destination,'')
          FROM mandate_matches WHERE id=NEW.match_id;
      END;
    `)
    // Replace the previous unconditional enqueue atomically on existing installations.
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS trigger_inbox_enqueue_route;
        CREATE TRIGGER IF NOT EXISTS trigger_inbox_enqueue_ungoverned_route AFTER INSERT ON trigger_inbox
        WHEN (SELECT json_extract(json,'$.enabled') FROM trigger_route_settings WHERE id=1)=1
          AND NOT EXISTS(SELECT 1 FROM mandates WHERE stream=NEW.stream AND json_extract(definition,'$.enabled')=1)
        BEGIN
          INSERT INTO trigger_routes(inbox_id,origin,updated_at) VALUES(NEW.id,'subscription',NEW.received_at);
        END;
      `)
    }).immediate()
  }

  getSettings(): TriggerMandateSnapshot {
    const row = this.db
      .query<{ revision: number; json: string }, []>(
        'SELECT revision,json FROM trigger_mandate_settings WHERE id=1',
      )
      .get()
    if (!row) throw new Error('Missing mandate configuration')
    return { revision: row.revision, settings: JSON.parse(row.json) as TriggerMandateSettings }
  }

  saveSettings(
    settings: TriggerMandateSettings,
    expectedRevision: number,
    commit?: { before: () => void; after: () => void },
  ): number {
    return this.db
      .transaction(() => {
        const current = this.getSettings()
        if (expectedRevision !== current.revision) throw new TriggerSettingsConflictError()
        commit?.before()
        const json = JSON.stringify(settings)
        if (JSON.stringify(current.settings) === json) {
          commit?.after()
          return current.revision
        }
        const previousById = new Map(current.settings.mandates.map((m) => [m.id, m]))
        const incoming = new Map(settings.mandates.map((m) => [m.id, m]))
        const projects = new Set(settings.projects.map((p) => p.id))
        if (
          incoming.size !== settings.mandates.length ||
          projects.size !== settings.projects.length
        )
          throw new Error('委托或项目编号重复')
        for (const mandate of settings.mandates) {
          const previous = previousById.get(mandate.id)
          const sameSelection = previous?.enabled && streamFor(previous) === streamFor(mandate)
          if (mandate.projectId && !projects.has(mandate.projectId))
            throw new Error('关联的项目不存在')
          if (
            mandate.enabled &&
            !sameSelection &&
            !this.db.query('SELECT 1 FROM trigger_streams WHERE stream=?').get(streamFor(mandate))
          )
            throw new Error('请先启用委托对应的监听来源')
        }
        for (const previous of current.settings.mandates) {
          const next = incoming.get(previous.id)
          if (!next || authority(previous) !== authority(next))
            this.db.run(
              `UPDATE mandate_tasks SET active=0,updated_at=${now} WHERE mandate_id=? AND active=1`,
              [previous.id],
            )
          if (!next) this.db.run('DELETE FROM mandates WHERE id=?', [previous.id])
        }
        for (const m of settings.mandates) {
          if (m.enabled) {
            this.db.run(
              `UPDATE trigger_routes SET status='cancelled',due_at=NULL,updated_at=${now},
              error='此来源已改由独立委托处理。' WHERE status IN ('pending','analyzing','ready','deferred','failed')
              AND inbox_id IN (SELECT id FROM trigger_inbox WHERE stream=?)`,
              [streamFor(m)],
            )
          }
          this.db.run(
            `INSERT INTO mandates(id,stream,definition) VALUES(?,?,?)
          ON CONFLICT(id) DO UPDATE SET stream=excluded.stream,definition=excluded.definition`,
            [m.id, streamFor(m), JSON.stringify(m)],
          )
        }
        const revision = current.revision + 1
        this.db.run('UPDATE trigger_mandate_settings SET revision=?,json=? WHERE id=1', [
          revision,
          json,
        ])
        this.db.run("INSERT INTO mandate_audit(action,detail) VALUES('configuration',?)", [
          `revision ${revision}`,
        ])
        this.recheckDeferred(new Date().toISOString())
        commit?.after()
        return revision
      })
      .immediate()
  }

  /** Called once per newly inserted inbox row, inside its intake transaction. */
  match(event: TriggerInboxItem) {
    // Enabling ordinary comments must not expand the audience of an existing mandate.
    if (event.githubCommentKind && !event.githubCommentMention) return
    const stream = streamFor(event)
    const mandates = this.db
      .query<{ definition: string }, [string]>(
        "SELECT definition FROM mandates WHERE stream=? AND json_extract(definition,'$.enabled')=1",
      )
      .all(stream)
    if (!mandates.length) return
    if (
      !this.db
        .query(
          "SELECT 1 FROM trigger_route_settings WHERE id=1 AND json_extract(json,'$.enabled')=1",
        )
        .get()
    )
      return
    const thread = businessKey(event)
    for (const { definition } of mandates) {
      const m = JSON.parse(definition) as TriggerMandate
      if (
        m.keyword &&
        !`${event.title}\n${event.summary}`.toLowerCase().includes(m.keyword.toLowerCase())
      )
        continue
      const key =
        m.groupBy === 'mandate'
          ? 'mandate'
          : m.groupBy === 'event'
            ? `event:${event.eventId}`
            : thread
      const task = this.db
        .query<{ id: number; paused: number }, [string, string]>(
          'SELECT id,paused FROM mandate_tasks WHERE mandate_id=? AND business_key=? AND active=1',
        )
        .get(m.id, key)
      if (task?.paused) continue
      const taskId =
        task?.id ??
        Number(
          this.db.run(
            `INSERT INTO mandate_tasks
        (mandate_id,business_key,title,latest_inbox_id,updated_at) VALUES(?,?,?,?,?)`,
            [m.id, key, event.title, event.id, event.receivedAt],
          ).lastInsertRowid,
        )
      const match = this.db.run(
        'INSERT INTO mandate_matches(task_id,mandate_id,inbox_id) VALUES(?,?,?)',
        [taskId, m.id, event.id],
      )
      if (task)
        this.db.run(
          `UPDATE mandate_tasks SET latest_inbox_id=?,title=?,event_count=event_count+1,
        updated_at=?,acknowledged_at=NULL WHERE id=?`,
          [event.id, event.title, event.receivedAt, taskId],
        )
      this.db.run(
        "INSERT INTO mandate_effects(match_id,kind,status) VALUES(?,'notify','pending'),(?,'archive',?)",
        [match.lastInsertRowid, match.lastInsertRowid, m.archive ? 'pending' : 'skipped'],
      )
    }
  }

  listTasks(limit = 50, beforeId = Number.MAX_SAFE_INTEGER): MandateTask[] {
    return this.db
      .query<TaskRow, [number, number]>(`SELECT ${taskFields} FROM mandate_tasks
      WHERE id<? ORDER BY id DESC LIMIT ?`)
      .all(beforeId, pageSize(limit))
      .map(decodeTask)
  }

  private taskRow(id: number): MandateTask | null {
    const row = this.db
      .query<TaskRow, [number]>(`SELECT ${taskFields} FROM mandate_tasks WHERE id=?`)
      .get(id)
    return row ? decodeTask(row) : null
  }

  private acknowledgedBy(
    task: MandateTask,
  ): NonNullable<MandateTaskDetail['acknowledgedBy']> | null {
    if (!task.acknowledgedAt) return null
    // A successful acknowledgement and its immutable actor row commit together. A new
    // event clears acknowledged_at. Ignored duplicate callbacks never insert an actor.
    const row = this.db
      .query<
        { actor: string | null },
        [number, number]
      >(`SELECT CASE WHEN json_valid(actor) THEN actor END AS actor
      FROM mandate_actions WHERE task_id=? AND verb='ack'
      AND EXISTS(SELECT 1 FROM trigger_visible_inbox WHERE id=?) ORDER BY rowid DESC LIMIT 1`)
      .get(task.id, task.latestInboxId)
    if (!row?.actor) return null
    const value: unknown = JSON.parse(row.actor)
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every((id) => typeof id === 'string' && id.trim().length > 0)
    )
      return null
    const [platform, channelId, peerId, operatorId] = value
    if (platform !== 'weixin' && platform !== 'feishu' && platform !== 'dingtalk') return null
    return { platform, channelId, peerId, operatorId }
  }

  getTask(id: number): MandateTaskDetail | null {
    return this.db
      .transaction(() => {
        const task = this.taskRow(id)
        if (!task) return null
        return {
          ...task,
          acknowledgedBy: this.acknowledgedBy(task),
          matches: this.db
            .query<MatchRow, [number]>(`SELECT ${matchFields} FROM mandate_matches
        WHERE task_id=? ORDER BY id DESC`)
            .all(id)
            .map((row) => this.decodeMatch(row)),
        }
      })
      .deferred()
  }

  private decodeMatch(row: MatchRow): MandateMatch {
    const effects = this.db
      .query<
        EffectRow,
        [number]
      >(`SELECT kind,status,destination,target,reason,due_at AS dueAt,receipt
      FROM mandate_effects WHERE match_id=? ORDER BY kind`)
      .all(row.id)
    return {
      ...row,
      effects: effects.map((e) => ({
        ...e,
        target: e.target ? (JSON.parse(e.target) as MandateEffect['target']) : null,
      })),
    }
  }

  getMatch(id: number): MandateMatch | null {
    const row = this.db
      .query<MatchRow, [number]>(`SELECT ${matchFields} FROM mandate_matches WHERE id=?`)
      .get(id)
    return row ? this.decodeMatch(row) : null
  }

  listMatches(limit = 50, beforeId = Number.MAX_SAFE_INTEGER, inboxId?: number): MandateMatch[] {
    return this.db
      .query<
        MatchRow,
        [number, number | null, number | null, number]
      >(`SELECT ${matchFields} FROM mandate_matches
      WHERE id<? AND (? IS NULL OR inbox_id=?) ORDER BY id DESC LIMIT ?`)
      .all(beforeId, inboxId ?? null, inboxId ?? null, pageSize(limit))
      .map((row) => this.decodeMatch(row))
  }

  listAudit(limit = 50, beforeId = Number.MAX_SAFE_INTEGER): MandateAuditEntry[] {
    return this.db
      .query<MandateAuditEntry, [number, number]>(`SELECT id,at,action,mandate_id AS mandateId,
      match_id AS matchId,detail FROM mandate_audit WHERE id<? ORDER BY id DESC LIMIT ?`)
      .all(beforeId, pageSize(limit))
  }

  getWork(id: number): MandateWork | null {
    if (!this.db.query('SELECT 1 FROM mandate_eligible_matches WHERE id=?').get(id)) return null
    const match = this.getMatch(id)
    if (!match) return null
    const event = this.inbox(match.inboxId)
    const task = this.taskRow(match.taskId)
    const config = this.getSettings().settings
    const mandate = config.mandates.find((m) => m.id === match.mandateId)
    if (!event || !task || !mandate) return null
    return {
      match,
      event,
      task,
      mandate,
      project: config.projects.find((p) => p.id === mandate.projectId) ?? null,
    }
  }

  getPriorSummaries(taskId: number, beforeMatchId: number): string[] {
    return this.db
      .query<{ summary: string }, [number, number]>(`SELECT summary FROM mandate_matches
      WHERE task_id=? AND id<? AND id IN (SELECT id FROM mandate_eligible_matches) AND status='ready' AND summary IS NOT NULL
      ORDER BY id DESC LIMIT 4`)
      .all(taskId, beforeMatchId)
      .reverse()
      .map((row) => row.summary)
  }

  claimAnalysis(sessionId: string): MandateWork | null {
    return this.db
      .transaction(() => {
        const next = this.db
          .query<
            { id: number; taskId: number },
            []
          >(`SELECT m.id,m.task_id AS taskId FROM mandate_matches m
        WHERE m.status='pending' AND m.id IN (SELECT id FROM mandate_eligible_matches)
        AND NOT EXISTS(SELECT 1 FROM mandate_matches prior WHERE prior.task_id=m.task_id
          AND (prior.status='analyzing' OR (prior.id<m.id AND prior.status='pending'))) ORDER BY m.id LIMIT 1`)
          .get()
        if (!next) return null
        const claimToken = crypto.randomUUID()
        this.db.run(
          "UPDATE mandate_matches SET status='analyzing',claim_token=?,error=NULL WHERE id=?",
          [claimToken, next.id],
        )
        this.db.run('UPDATE mandate_tasks SET session_id=COALESCE(session_id,?) WHERE id=?', [
          sessionId,
          next.taskId,
        ])
        const work = this.getWork(next.id)
        if (!work) throw new Error('Missing claimed mandate analysis')
        return { ...work, claimToken }
      })
      .immediate()
  }

  finishAnalysis(id: number, summary: string, claimToken?: string): boolean {
    return (
      this.db.run(
        `UPDATE mandate_matches SET status='ready',summary=?,claim_token=NULL
      WHERE id=? AND status='analyzing' AND claim_token=?`,
        [summary, id, claimToken ?? null],
      ).changes > 0
    )
  }
  failAnalysis(id: number, error: string, claimToken?: string): boolean {
    return (
      this.db.run(
        `UPDATE mandate_matches SET status='failed',error=?,claim_token=NULL
      WHERE id=? AND status='analyzing' AND claim_token=?`,
        [error, id, claimToken ?? null],
      ).changes > 0
    )
  }
  retryAnalysis(id: number): boolean {
    return (
      this.db.run(
        `UPDATE mandate_matches SET status='pending',error=NULL WHERE status='failed'
      AND id=? AND id IN (SELECT id FROM mandate_eligible_matches)`,
        [id],
      ).changes > 0
    )
  }
  retry(id: number, kind: 'analysis' | 'archive' | 'notify'): boolean {
    return kind === 'analysis' ? this.retryAnalysis(id) : this.retryEffect(id, kind)
  }

  authorizedTask(id: number, peer: MandateTarget): MandateTaskDetail | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<
            { definition: string },
            [number]
          >(`SELECT d.definition FROM mandate_tasks t JOIN mandates d
      ON d.id=t.mandate_id JOIN trigger_streams s ON s.stream=d.stream WHERE t.id=? AND t.active=1
      AND json_extract(d.definition,'$.enabled')=1`)
          .get(id)
        const mandate = row ? (JSON.parse(row.definition) as TriggerMandate) : null
        const authorized = mandate?.targets.some(
          (t) =>
            t.platform === peer.platform &&
            t.channelId === peer.channelId &&
            t.peerId === peer.peerId &&
            (t.operatorId
              ? t.operatorId === peer.operatorId
              : t.platform === 'weixin' && (peer.operatorId ?? peer.peerId) === peer.peerId),
        )
        if (!authorized) return null
        const task = this.getTask(id)
        const by = task?.acknowledgedBy
        if (
          task &&
          by &&
          (by.platform !== peer.platform ||
            by.channelId !== peer.channelId ||
            by.peerId !== peer.peerId ||
            by.operatorId !== (peer.operatorId ?? peer.peerId))
        ) {
          task.acknowledgedBy = null
        }
        return task
      })
      .deferred()
  }

  private act(id: number, peer: MandateTarget, requestId: string, verb: 'ack' | 'pause'): boolean {
    if (!requestId || requestId.length > 512) return false
    return this.db
      .transaction(() => {
        if (!this.authorizedTask(id, peer)) return false
        const actor = JSON.stringify([
          peer.platform,
          peer.channelId,
          peer.peerId,
          peer.operatorId ?? peer.peerId,
        ])
        const inserted = this.db.run('INSERT OR IGNORE INTO mandate_actions VALUES(?,?,?,?)', [
          id,
          actor,
          requestId,
          verb,
        ])
        if (!inserted.changes) return false
        if (verb === 'ack')
          this.db.run(`UPDATE mandate_tasks SET acknowledged_at=${now} WHERE id=?`, [id])
        else this.setTaskPaused(id, true)
        this.db.run(
          'INSERT INTO mandate_audit(action,mandate_id,detail) SELECT ?,mandate_id,? FROM mandate_tasks WHERE id=?',
          [verb, `task ${id}`, id],
        )
        return true
      })
      .immediate()
  }
  acknowledge(id: number, peer: MandateTarget, requestId: string): boolean {
    return this.act(id, peer, requestId, 'ack')
  }
  pauseTask(id: number, peer: MandateTarget, requestId: string): boolean {
    return this.act(id, peer, requestId, 'pause')
  }
  setTaskPaused(id: number, paused: boolean): boolean {
    return (
      this.db.run(`UPDATE mandate_tasks SET paused=?,updated_at=${now} WHERE id=? AND active=1`, [
        +paused,
        id,
      ]).changes > 0
    )
  }
}
