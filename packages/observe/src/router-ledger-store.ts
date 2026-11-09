import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  RouterFollowupTimer,
  RouterMatter,
  RouterPublicationTrace,
  RouterSignal,
  RouterTraceEntry,
  RouterTraceRun,
} from '@zero-os/shared'
import { RouterOperationStore } from './router-operation-store'
import { RouterPublicationStore } from './router-publication-store'
import type { TriggerConversationStore, RouterImScope } from './trigger-conversation-store'

type MatterInputOrigin = {
  turnId: number
  kind: 'user' | 'ui_action' | 'worker_result' | 'event' | 'timer'
  receivedAt: string
}
type MatterRow = Omit<RouterMatter, 'context' | 'criteria'> & { context: string; criteria: string }
const matterColumns =
  'id,principal,title,goal,criteria,state,version,context,created_at AS createdAt,updated_at AS updatedAt'
const timerSelection = `SELECT t.id,t.principal,t.matter_id AS matterId,t.scope,t.due_at AS dueAt,t.reason,t.publication_id AS publicationId,t.state,t.created_at AS createdAt,
  c.turn_id AS cancelTurnId,c.reason AS cancelReason FROM router_followup_timers t
  LEFT JOIN router_timer_cancellations c ON c.timer_id=t.id`
const workerMatter =
  "(SELECT w.matter_id FROM router_worker_links w WHERE r.session_id='router-job-' || w.job_id)"
// A signal can finish without a matter tool call. Its recorded, authorized focus still identifies the run.
const recordedPrompt =
  "CASE WHEN json_valid(json_extract(e.data,'$.prompt')) THEN json_extract(e.data,'$.prompt') END"
const focusedMatter = `(SELECT m.id FROM router_trace_entries e JOIN router_matters m
  ON m.id=json_extract(${recordedPrompt},'$.matters.focusedMatter.id')
  AND m.principal=json_extract(${recordedPrompt},'$.contextProvenance.principal')
  WHERE e.run_id=r.id AND e.kind='input' AND r.replay_of IS NULL LIMIT 1)`
const runColumns = `id,ordinal,session_id AS sessionId,label,COALESCE(matter_id,${workerMatter},${focusedMatter}) AS matterId,status,started_at AS startedAt,ended_at AS endedAt,replay_of AS replayOf`
// Original and current Router inputs carry the durable conversation turn in their recorded prompt.
const traceTurnId = `json_extract(CASE WHEN json_valid(json_extract(data,'$.prompt'))
  THEN json_extract(data,'$.prompt') END,'$.contextProvenance.currentTurnId')`
const deliveryOperation = "json_extract(data,'$.name')"
const receiptEntry = `kind='tool_result' AND ${deliveryOperation} IN ('publish_update','retry_delivery')`
const receiptPublicationId = `CASE ${deliveryOperation}
  WHEN 'retry_delivery' THEN json_extract(data,'$.input.publicationId')
  ELSE json_extract(CASE WHEN json_valid(json_extract(data,'$.result.output'))
    THEN json_extract(data,'$.result.output') END,'$.id') END`
const decode = (r: MatterRow): RouterMatter => ({
  ...r,
  criteria: JSON.parse(r.criteria),
  context: JSON.parse(r.context),
})

export class RouterLedgerConflict extends Error {}

/** Additive schema; existing sessions and source events retain their original identities. */
export class RouterLedgerStore {
  readonly operations: RouterOperationStore
  readonly publications: RouterPublicationStore
  constructor(private readonly db: Database) {
    this.operations = new RouterOperationStore(db)
    this.publications = new RouterPublicationStore(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS router_documents (
        id TEXT PRIMARY KEY,principal TEXT NOT NULL,channel_id TEXT NOT NULL,document_id TEXT NOT NULL,
        label TEXT NOT NULL,url TEXT NOT NULL,version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_matter_history (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,matter_id TEXT NOT NULL,principal TEXT NOT NULL,
        version INTEGER NOT NULL,snapshot TEXT NOT NULL,recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS router_history_matter ON router_matter_history(matter_id,ordinal DESC);
      CREATE TABLE IF NOT EXISTS router_source_audit (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,matter_id TEXT NOT NULL,principal TEXT NOT NULL,
        event_id INTEGER NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_matter_sources (matter_id TEXT NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(matter_id,event_id));
      CREATE TABLE IF NOT EXISTS router_matters (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        criteria TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
        context TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE VIEW IF NOT EXISTS router_snapshot_lineage AS
        SELECT h.ordinal,h.matter_id,COALESCE(json_extract(h.snapshot,'$.inheritedSourceIds'),(
          SELECT CASE WHEN json_extract(prior.snapshot,'$.context') IS json_extract(h.snapshot,'$.context')
            THEN json_extract(prior.snapshot,'$.inheritedSourceIds') END
          FROM router_matter_history prior WHERE prior.matter_id=h.matter_id AND prior.ordinal<h.ordinal AND
            (json_type(prior.snapshot,'$.inheritedSourceIds')='array' OR
              json_extract(prior.snapshot,'$.context') IS NOT json_extract(h.snapshot,'$.context'))
          ORDER BY prior.ordinal DESC LIMIT 1
        )) AS inherited FROM router_matter_history h;
      CREATE VIEW IF NOT EXISTS router_matter_evidence AS
        SELECT matter_id,event_id FROM router_matter_sources UNION
        SELECT h.matter_id,source.value FROM router_snapshot_lineage h,json_each(h.inherited) source
        WHERE h.ordinal=(SELECT MAX(last.ordinal) FROM router_matter_history last WHERE last.matter_id=h.matter_id);
      CREATE INDEX IF NOT EXISTS router_matters_principal ON router_matters(principal,updated_at);
      CREATE TABLE IF NOT EXISTS router_trace_runs (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,label TEXT NOT NULL,matter_id TEXT,status TEXT NOT NULL,
        started_at TEXT NOT NULL,ended_at TEXT,replay_of TEXT
      );
      CREATE INDEX IF NOT EXISTS router_trace_session ON router_trace_runs(session_id,ordinal);
      CREATE TABLE IF NOT EXISTS router_trace_matters (run_id TEXT NOT NULL,matter_id TEXT NOT NULL,PRIMARY KEY(run_id,matter_id));
      CREATE TABLE IF NOT EXISTS router_trace_entries (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,kind TEXT NOT NULL,
        created_at TEXT NOT NULL,data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS router_trace_run ON router_trace_entries(run_id,ordinal);
      CREATE INDEX IF NOT EXISTS router_trace_input_turn ON router_trace_entries(${traceTurnId}) WHERE kind='input';
      CREATE INDEX IF NOT EXISTS router_trace_receipt ON router_trace_entries(${receiptPublicationId}) WHERE ${receiptEntry};
      CREATE TABLE IF NOT EXISTS router_identity_links (
        actor_key TEXT PRIMARY KEY, principal TEXT NOT NULL, authority TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,
        kind TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,error TEXT
      );
      CREATE TABLE IF NOT EXISTS router_followup_timers (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, matter_id TEXT NOT NULL,
        scope TEXT NOT NULL,due_at TEXT NOT NULL,reason TEXT NOT NULL,publication_id TEXT,
        state TEXT NOT NULL DEFAULT 'scheduled',created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_timer_cancellations(timer_id TEXT PRIMARY KEY,turn_id INTEGER,reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS router_timer_due ON router_followup_timers(state,due_at);
      CREATE TABLE IF NOT EXISTS router_worker_links (
        job_id INTEGER PRIMARY KEY,principal TEXT NOT NULL,matter_id TEXT NOT NULL,
        scope TEXT NOT NULL,audience TEXT NOT NULL,events TEXT NOT NULL,authority TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_worker_handoffs (
        job_id INTEGER PRIMARY KEY, from_job_id INTEGER NOT NULL, from_attempt INTEGER NOT NULL, from_status TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `)
    if (
      !db
        .query(
          "SELECT 1 FROM pragma_table_info('router_followup_timers') WHERE name='publication_id'",
        )
        .get()
    )
      db.exec('ALTER TABLE router_followup_timers ADD COLUMN publication_id TEXT')
  }

  preparePublication(input: Parameters<RouterPublicationStore['prepare']>[0], remindAt?: string) {
    return this.db
      .transaction(() => {
        this.publications.prepare(input)
        if (remindAt)
          this.scheduleTimer({
            principal: input.principal,
            matterId: input.matterId,
            scope: input.scope,
            requestKey: 'publication:' + input.id,
            publicationId: input.id,
            dueAt: remindAt,
            reason:
              '复核这份网页结果是否仍需提醒；读取原交付和最新偏好，已送达或已过时的内容不重复发送。',
          })
      })
      .immediate()
  }

  configureDocument(input: {
    id: string
    principal: string
    channelId: string
    documentId: string
    label: string
    url: string
  }) {
    this.db.run(
      'INSERT INTO router_documents VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,document_id=excluded.document_id,label=excluded.label,url=excluded.url,version=version+1 WHERE principal=excluded.principal',
      [input.id, input.principal, input.channelId, input.documentId, input.label, input.url],
    )
    const saved = this.documents(input.principal).find((d) => d.id === input.id)
    if (!saved) throw new RouterLedgerConflict('不能覆盖其他身份的归档目标。')
    return saved
  }

  documents(principal: string) {
    return this.db
      .query<
        {
          id: string
          principal: string
          channelId: string
          documentId: string
          label: string
          url: string
          version: number
        },
        [string]
      >(
        'SELECT id,principal,channel_id AS channelId,document_id AS documentId,label,url,version FROM router_documents WHERE principal=? ORDER BY id',
      )
      .all(principal)
  }

  scheduleTimer(
    input: {
      principal: string
      matterId: string
      scope: string
      dueAt: string
      reason: string
      requestKey: string
      publicationId?: string
    },
    now = new Date(),
  ) {
    const matter = this.getMatter(input.principal, input.matterId)
    if (
      !matter ||
      matter.state === 'cancelled' ||
      (matter.state === 'completed' && !input.publicationId)
    )
      throw new RouterLedgerConflict('只能安排当前身份下尚未结束的事项。')
    const due = Date.parse(input.dueAt)
    if (!Number.isFinite(due) || due <= now.getTime())
      throw new RouterLedgerConflict('请指定有效的未来跟进时间。')
    const id = input.requestKey
    const dueAt = new Date(due).toISOString()
    return this.db
      .transaction(() => {
        this.db.run(
          'INSERT INTO router_followup_timers(id,principal,matter_id,scope,due_at,reason,publication_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
          [
            id,
            input.principal,
            input.matterId,
            input.scope,
            dueAt,
            input.reason,
            input.publicationId ?? null,
            now.toISOString(),
          ],
        )
        const saved = this.getTimer(input.principal, id)
        if (
          !saved ||
          saved.matterId !== input.matterId ||
          saved.scope !== input.scope ||
          saved.dueAt !== dueAt ||
          saved.publicationId !== (input.publicationId ?? null) ||
          saved.reason !== input.reason
        )
          throw new RouterLedgerConflict('同一跟进请求的内容发生变化。')
        return saved
      })
      .immediate()
  }

  getTimer(principal: string, id: string): RouterFollowupTimer | null {
    return this.db
      .query<RouterFollowupTimer, [string, string]>(
        `${timerSelection} WHERE t.principal=? AND t.id=?`,
      )
      .get(principal, id)
  }

  listTimers(principal: string, matterId: string): RouterFollowupTimer[] {
    return this.db
      .query<RouterFollowupTimer, [string, string]>(
        `${timerSelection} WHERE t.principal=? AND t.matter_id=? ORDER BY t.due_at`,
      )
      .all(principal, matterId)
  }

  cancelTimer(principal: string, id: string, decision?: { turnId: number; reason: string }) {
    return this.db
      .transaction(() => {
        const timer = this.getTimer(principal, id)
        if (!timer) throw new RouterLedgerConflict('当前身份下找不到这次跟进。')
        if (timer.state !== 'scheduled') return timer
        this.db.run("UPDATE router_followup_timers SET state='cancelled' WHERE id=?", [id])
        if (decision)
          this.db.run(
            'INSERT INTO router_timer_cancellations(timer_id,turn_id,reason) VALUES(?,?,?)',
            [id, decision.turnId, decision.reason],
          )
        return this.getTimer(principal, id)
      })
      .immediate()
  }

  releaseDueTimers(now = new Date()) {
    return this.db
      .transaction(() => {
        const due = this.db
          .query<
            {
              id: string
              principal: string
              matterId: string
              scope: string
              reason: string
              publicationId: string | null
            },
            [string]
          >(
            `SELECT t.id,t.principal,t.matter_id AS matterId,t.scope,t.reason,t.publication_id AS publicationId FROM router_followup_timers t
             WHERE t.state='scheduled' AND t.due_at<=? AND NOT EXISTS(
               SELECT 1 FROM router_matters m WHERE m.id=t.matter_id AND m.state='paused')
             ORDER BY t.due_at LIMIT 100`,
          )
          .all(now.toISOString())
        let count = 0
        for (const timer of due) {
          const matter = this.getMatter(timer.principal, timer.matterId)
          if (
            !matter ||
            matter.state === 'cancelled' ||
            (matter.state === 'completed' && !timer.publicationId)
          ) {
            this.db.run("UPDATE router_followup_timers SET state='cancelled' WHERE id=?", [
              timer.id,
            ])
            continue
          }
          this.receiveSignal({
            key: `timer:${timer.id}`,
            principal: timer.principal,
            kind: 'timer',
            scope: timer.scope,
            payload: {
              matterId: timer.matterId,
              timerId: timer.id,
              ...(timer.publicationId && { publicationId: timer.publicationId }),
              reason: timer.reason,
              observedVersion: matter.version,
            },
          })
          this.db.run("UPDATE router_followup_timers SET state='fired' WHERE id=?", [timer.id])
          count++
        }
        return count
      })
      .immediate()
  }

  linkSource(principal: string, matterId: string, eventId: number, reason = '本轮已关联来源') {
    if (!this.getMatter(principal, matterId)) throw new RouterLedgerConflict('事项身份不符。')
    if (
      this.db.run('INSERT OR IGNORE INTO router_matter_sources VALUES(?,?)', [matterId, eventId])
        .changes
    )
      this.db.run(
        'INSERT INTO router_source_audit(matter_id,principal,event_id,action,reason,recorded_at) VALUES(?,?,?,?,?,?)',
        [matterId, principal, eventId, 'link', reason, new Date().toISOString()],
      )
  }
  unlinkSource(principal: string, matterId: string, eventId: number, reason: string) {
    if (!this.getMatter(principal, matterId)) throw new RouterLedgerConflict('事项身份不符。')
    this.db
      .transaction(() => {
        const linked = this.db
          .query<{ jobId: number; events: string }, [string, string]>(
            'SELECT job_id AS jobId,events FROM router_worker_links WHERE principal=? AND matter_id=?',
          )
          .all(principal, matterId)
        for (const worker of linked)
          this.db.run('UPDATE router_worker_links SET events=? WHERE job_id=?', [
            JSON.stringify((JSON.parse(worker.events) as number[]).filter((id) => id !== eventId)),
            worker.jobId,
          ])
        if (
          this.db.run('DELETE FROM router_matter_sources WHERE matter_id=? AND event_id=?', [
            matterId,
            eventId,
          ]).changes
        )
          this.db.run(
            'INSERT INTO router_source_audit(matter_id,principal,event_id,action,reason,recorded_at) VALUES(?,?,?,?,?,?)',
            [matterId, principal, eventId, 'unlink', reason, new Date().toISOString()],
          )
      })
      .immediate()
  }
  changeSourceAssociation(
    principal: string,
    eventId: number,
    from: string | undefined,
    to: string | undefined,
    reason: string,
    origin?: MatterInputOrigin,
  ) {
    return this.db
      .transaction(() => {
        if ((!from && !to) || (from && from === to))
          throw new RouterLedgerConflict('请指定要加入或移出的不同事项。')
        const oldMatter = from && this.getMatter(principal, from)
        const newMatter = to && this.getMatter(principal, to)
        if ((from && !oldMatter) || (to && !newMatter))
          throw new RouterLedgerConflict('关联事项不可访问。')
        const alreadyLinked = !!newMatter && this.matterSources(newMatter.id).includes(eventId)
        const versions: Record<string, number> = {}
        if (oldMatter && this.matterSources(oldMatter.id).includes(eventId)) {
          const inherited = this.matterEvidenceSources(oldMatter.id)
          this.unlinkSource(principal, oldMatter.id, eventId, reason)
          versions[oldMatter.id] = this.updateMatter(
            principal,
            oldMatter.id,
            oldMatter.version,
            { state: oldMatter.state, context: oldMatter.context },
            origin,
            inherited,
          ).version
        } else if (from && !alreadyLinked) {
          throw new RouterLedgerConflict('线索与原事项没有当前关联。')
        }
        if (newMatter && !alreadyLinked) {
          const inherited = this.matterEvidenceSources(newMatter.id)
          this.linkSource(principal, newMatter.id, eventId, reason)
          versions[newMatter.id] = this.updateMatter(
            principal,
            newMatter.id,
            newMatter.version,
            { state: newMatter.state, context: newMatter.context },
            origin,
            inherited,
          ).version
        }
        return { eventId, removedFrom: from, associatedWith: to, versions }
      })
      .immediate()
  }

  sourceCorrections(principal: string, matterId: string) {
    return this.db
      .query<{ eventId: number; reason: string; recordedAt: string }, [string, string]>(
        "SELECT event_id AS eventId,reason,recorded_at AS recordedAt FROM router_source_audit WHERE principal=? AND matter_id=? AND action='unlink' ORDER BY ordinal DESC",
      )
      .all(principal, matterId)
  }

  eventMatters(principal: string, eventId: number) {
    return this.db
      .query<{ id: string }, [string, number]>(
        'SELECT m.id FROM router_matter_sources s JOIN router_matters m ON m.id=s.matter_id WHERE m.principal=? AND s.event_id=? ORDER BY m.id',
      )
      .all(principal, eventId)
      .map((m) => m.id)
  }

  matterHistory(principal: string, matterId: string, before = Number.MAX_SAFE_INTEGER) {
    return this.db
      .query<
        {
          ordinal: number
          version: number
          snapshot: string
          recordedAt: string
          inherited: string | null
        },
        [string, string, number]
      >(
        `SELECT h.ordinal,h.version,h.snapshot,h.recorded_at AS recordedAt,
          (SELECT inherited FROM router_snapshot_lineage WHERE ordinal=h.ordinal) AS inherited
          FROM router_matter_history h WHERE h.principal=? AND h.matter_id=? AND h.ordinal<? ORDER BY h.ordinal DESC LIMIT 20`,
      )
      .all(principal, matterId, before)
      .map(({ inherited, snapshot, ...row }) => ({
        ...row,
        snapshot: {
          ...JSON.parse(snapshot),
          ...(inherited && { inheritedSourceIds: JSON.parse(inherited) }),
        },
      }))
  }
  latestUserUpdate(principal: string, matterId: string) {
    return this.db
      .query<{ turnId: number; version: number; receivedAt: string }, [string, string]>(
        `SELECT json_extract(snapshot,'$.inputOrigin.turnId') AS turnId, version,
        json_extract(snapshot,'$.inputOrigin.receivedAt') AS receivedAt
       FROM router_matter_history WHERE principal=? AND matter_id=?
       AND json_extract(snapshot,'$.inputOrigin.kind') IN ('user','ui_action')
       ORDER BY receivedAt DESC,turnId DESC,version DESC LIMIT 1`,
      )
      .get(principal, matterId)
  }

  matterSources(matterId: string): number[] {
    return this.db
      .query<{ eventId: number }, [string]>(
        'SELECT event_id AS eventId FROM router_matter_sources WHERE matter_id=? ORDER BY event_id',
      )
      .all(matterId)
      .map((r) => r.eventId)
  }

  matterEvidenceSources(matterId: string): number[] {
    return this.db
      .query<{ eventId: number }, [string]>(
        'SELECT event_id AS eventId FROM router_matter_evidence WHERE matter_id=? ORDER BY event_id',
      )
      .all(matterId)
      .map((r) => r.eventId)
  }

  bindWorker(input: {
    jobId: number
    principal: string
    matterId: string
    scope: string
    audience: string
    eventIds: number[]
    authority: 'user' | 'source'
    handoff?: { fromJobId: number; fromAttempt: number; fromStatus: string }
  }) {
    if (!this.getMatter(input.principal, input.matterId))
      throw new RouterLedgerConflict('Worker 必须关联当前身份可访问的事项。')
    const existing = this.workerLink(input.jobId)
    if (
      existing &&
      (existing.principal !== input.principal ||
        existing.matterId !== input.matterId ||
        existing.scope !== input.scope ||
        existing.audience !== input.audience)
    )
      throw new RouterLedgerConflict('不能把已有 Worker 移到另一身份、事项或权限范围。')
    const from = input.handoff && this.workerLink(input.handoff.fromJobId)
    if (
      input.handoff &&
      (!from ||
        from.jobId >= input.jobId ||
        from.matterId !== input.matterId ||
        from.principal !== input.principal)
    )
      throw new RouterLedgerConflict('只能移交同一身份、同一事项的原 Worker。')
    const events = [
      ...new Set([...(existing?.eventIds ?? []), ...(from?.eventIds ?? []), ...input.eventIds]),
    ]
    this.db.transaction(() => {
      for (const eventId of events) this.linkSource(input.principal, input.matterId, eventId)
      this.db.run(
        'INSERT INTO router_worker_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET events=excluded.events,authority=excluded.authority',
        [
          input.jobId,
          input.principal,
          input.matterId,
          input.scope,
          input.audience,
          JSON.stringify(events),
          existing?.authority === 'user' ? 'user' : input.authority,
        ],
      )
      if (input.handoff) {
        const saved = this.workerHandoff(input.jobId)
        if (saved && saved.fromJobId !== input.handoff.fromJobId)
          throw new RouterLedgerConflict('这次派工已关联另一个移交来源。')
        if (saved) return
        this.db.run('INSERT INTO router_worker_handoffs VALUES(?,?,?,?,?)', [
          input.jobId,
          input.handoff.fromJobId,
          input.handoff.fromAttempt,
          input.handoff.fromStatus,
          new Date().toISOString(),
        ])
      }
    })()
  }

  workerHandoff(jobId: number) {
    return this.db
      .query<
        { fromJobId: number; fromAttempt: number; fromStatus: string; recordedAt: string },
        [number]
      >(
        'SELECT from_job_id AS fromJobId,from_attempt AS fromAttempt,from_status AS fromStatus,recorded_at AS recordedAt FROM router_worker_handoffs WHERE job_id=?',
      )
      .get(jobId)
  }

  handoffEvidence(fromJobId: number, recordedAt: string) {
    return this.db
      .query<
        { runId: string; ordinal: number; kind: string; createdAt: string; data: string },
        [string, string]
      >(
        `SELECT r.id AS runId,e.ordinal,e.kind,e.created_at AS createdAt,e.data
       FROM router_trace_runs r JOIN router_trace_entries e ON e.run_id=r.id
       WHERE r.session_id=? AND e.created_at<=? AND (e.kind IN ('tool_result','result','error') OR
         (e.kind='worker_event' AND json_extract(e.data,'$.method')='item/completed'))
       ORDER BY e.ordinal`,
      )
      .all(`router-job-${fromJobId}`, recordedAt)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }))
  }

  workerLink(jobId: number): {
    jobId: number
    principal: string
    matterId: string
    scope: string
    audience: string
    eventIds: number[]
    authority: 'user' | 'source'
  } | null {
    const row = this.db
      .query<
        {
          jobId: number
          principal: string
          matterId: string
          scope: string
          audience: string
          events: string
          authority: 'user' | 'source'
        },
        [number]
      >(
        'SELECT job_id AS jobId,principal,matter_id AS matterId,scope,audience,events,authority FROM router_worker_links WHERE job_id=?',
      )
      .get(jobId)
    if (!row) return null
    const { events, ...link } = row
    return { ...link, eventIds: JSON.parse(events) }
  }

  workerSessions(principal: string, matterId: string) {
    return this.db
      .query<
        { jobId: number; latestRunId: string | null; handoffFromJobId: number | null },
        [string, string]
      >(
        `SELECT w.job_id AS jobId,(SELECT h.from_job_id FROM router_worker_handoffs h WHERE h.job_id=w.job_id) AS handoffFromJobId,(SELECT r.id FROM router_trace_runs r
        WHERE r.session_id='router-job-' || w.job_id ORDER BY r.ordinal DESC LIMIT 1) AS latestRunId
       FROM router_worker_links w WHERE w.principal=? AND w.matter_id=? ORDER BY w.job_id`,
      )
      .all(principal, matterId)
  }

  receiveSignal(input: Pick<RouterSignal, 'key' | 'principal' | 'kind' | 'scope' | 'payload'>) {
    const payload = JSON.stringify(input.payload)
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<
            { id: number; principal: string; kind: string; scope: string; payload: string },
            [string]
          >('SELECT id,principal,kind,scope,payload FROM router_signals WHERE key=?')
          .get(input.key)
        if (existing) {
          if (
            existing.principal !== input.principal ||
            existing.kind !== input.kind ||
            existing.scope !== input.scope ||
            (existing.payload !== payload &&
              !isDeepStrictEqual(JSON.parse(existing.payload), JSON.parse(payload)))
          )
            throw new RouterLedgerConflict('同一输入标识的内容或身份发生变化。')
          return existing.id
        }
        // A second click may carry a new transport id for the same saved button.
        if (input.kind === 'ui_action' && input.payload.publicationId) {
          const button = this.db
            .query<{ id: number }, [string, string, string]>(
              "SELECT id FROM router_signals WHERE kind='ui_action' AND principal=? AND scope=? AND payload=? LIMIT 1",
            )
            .get(input.principal, input.scope, payload)
          if (button) return button.id
        }
        return Number(
          this.db.run(
            'INSERT INTO router_signals(key,principal,kind,scope,payload,created_at) VALUES(?,?,?,?,?,?)',
            [
              input.key,
              input.principal,
              input.kind,
              input.scope,
              payload,
              new Date().toISOString(),
            ],
          ).lastInsertRowid,
        )
      })
      .immediate()
  }

  claimSignal(): RouterSignal | null {
    const row = this.db
      .query<Omit<RouterSignal, 'payload'> & { payload: string }, []>(
        `UPDATE router_signals SET state='running' WHERE id=(SELECT s.id FROM router_signals s WHERE s.state='pending' AND
        (s.kind!='timer' OR NOT EXISTS(SELECT 1 FROM router_matters m
          WHERE m.id=json_extract(s.payload,'$.matterId') AND m.state='paused'))
        ORDER BY s.id LIMIT 1)
      RETURNING id,key,principal,kind,scope,payload,state,created_at AS createdAt,error`,
      )
      .get()
    return row ? { ...row, payload: JSON.parse(row.payload) } : null
  }

  finishSignal(id: number, state: 'completed' | 'failed', error: string | null = null) {
    if (
      !this.db.run("UPDATE router_signals SET state=?,error=? WHERE id=? AND state='running'", [
        state,
        error,
        id,
      ]).changes
    )
      throw new RouterLedgerConflict('输入已结束或没有执行权。')
  }

  deferSignal(id: number) {
    if (
      !this.db.run("UPDATE router_signals SET state='pending' WHERE id=? AND state='running'", [id])
        .changes
    )
      throw new RouterLedgerConflict('输入没有执行权。')
  }

  listSignals(principal: string, limit = 30): RouterSignal[] {
    return this.db
      .query<Omit<RouterSignal, 'payload'> & { payload: string }, [string, number]>(
        'SELECT id,key,principal,kind,scope,payload,state,created_at AS createdAt,error FROM router_signals WHERE principal=? ORDER BY id DESC LIMIT ?',
      )
      .all(principal, Math.max(1, Math.min(100, limit)))
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
  }

  linkIdentity(actorKey: string, principal: string, authority: string) {
    this.db.run(
      'INSERT INTO router_identity_links VALUES(?,?,?) ON CONFLICT(actor_key) DO UPDATE SET principal=excluded.principal,authority=excluded.authority',
      [actorKey, principal, authority],
    )
  }

  identityBinding(actorKey: string) {
    return this.db
      .query<{ principal: string; authority: string }, [string]>(
        'SELECT principal,authority FROM router_identity_links WHERE actor_key=?',
      )
      .get(actorKey)
  }

  identity(actorKey: string, authority: string): string | null {
    return (
      this.db
        .query<{ principal: string }, [string, string]>(
          'SELECT principal FROM router_identity_links WHERE actor_key=? AND authority=?',
        )
        .get(actorKey, authority)?.principal ?? null
    )
  }

  createMatter(
    principal: string,
    title: string,
    goal: string,
    criteria: string[],
    inputOrigin?: MatterInputOrigin,
  ): RouterMatter {
    if (
      !principal.trim() ||
      !title.trim() ||
      !goal.trim() ||
      !criteria.length ||
      criteria.some((c) => !c.trim())
    )
      throw new RangeError('A matter needs a principal, goal and completion criteria')
    return this.db.transaction(() => {
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.run("INSERT INTO router_matters VALUES (?,?,?,?,?,'open',1,'{}',?,?)", [
        id,
        principal,
        title,
        goal,
        JSON.stringify(criteria),
        now,
        now,
      ])
      const matter = this.getMatter(principal, id)
      if (!matter) throw new RouterLedgerConflict('事项保存后无法读取。')
      this.db.run(
        'INSERT INTO router_matter_history(matter_id,principal,version,snapshot,recorded_at) VALUES(?,?,?,?,?)',
        [
          id,
          principal,
          matter.version,
          JSON.stringify({ ...matter, sourceEventIds: this.matterSources(id), inputOrigin }),
          new Date().toISOString(),
        ],
      )
      return matter
    })()
  }

  getMatter(principal: string, id: string): RouterMatter | null {
    const row = this.db
      .query<MatterRow, [string, string]>(
        `SELECT ${matterColumns} FROM router_matters WHERE principal=? AND id=?`,
      )
      .get(principal, id)
    return row ? decode(row) : null
  }

  searchMatters(
    principal: string,
    query = '',
    limit = 30,
    before?: Pick<RouterMatter, 'updatedAt' | 'id'>,
  ): RouterMatter[] {
    const count = Math.max(1, Math.min(100, Math.floor(limit)))
    return this.db
      .query<MatterRow, (string | number)[]>(`SELECT ${matterColumns} FROM router_matters
      WHERE principal=? AND (instr(lower(title),lower(?))>0 OR instr(lower(goal),lower(?))>0 OR instr(lower(context),lower(?))>0)
      ${before ? 'AND (updated_at < ? OR (updated_at = ? AND id > ?))' : ''}
      ORDER BY updated_at DESC,id LIMIT ?`)
      .all(
        principal,
        query,
        query,
        query,
        ...(before ? [before.updatedAt, before.updatedAt, before.id] : []),
        count,
      )
      .map(decode)
  }

  updateMatter(
    principal: string,
    id: string,
    version: number,
    patch: Pick<RouterMatter, 'state' | 'context'> &
      Partial<Pick<RouterMatter, 'title' | 'goal' | 'criteria'>>,
    inputOrigin?: MatterInputOrigin,
    inheritedSourceIds?: number[],
  ): RouterMatter {
    return this.db
      .transaction(() => {
        const changed = this.db.run(
          `UPDATE router_matters SET state=?,context=?,version=version+1,updated_at=?,title=COALESCE(?,title),goal=COALESCE(?,goal),criteria=COALESCE(?,criteria)
      WHERE principal=? AND id=? AND version=?`,
          [
            patch.state,
            JSON.stringify(patch.context),
            new Date().toISOString(),
            patch.title ?? null,
            patch.goal ?? null,
            patch.criteria ? JSON.stringify(patch.criteria) : null,
            principal,
            id,
            version,
          ],
        ).changes
        if (!changed) throw new RouterLedgerConflict('事项已变化或无法访问，请重新读取后再更新。')
        if (patch.state === 'completed' || patch.state === 'cancelled') {
          const workTimers = patch.state === 'completed' ? ' AND publication_id IS NULL' : ''
          this.db.run(
            `INSERT INTO router_timer_cancellations(timer_id,turn_id,reason)
            SELECT id,?,? FROM router_followup_timers WHERE principal=? AND matter_id=? AND state='scheduled'${workTimers}`,
            [
              inputOrigin?.turnId ?? null,
              `事项第 ${version + 1} 版已${patch.state === 'completed' ? '完成' : '取消'}。`,
              principal,
              id,
            ],
          )
          this.db.run(
            "UPDATE router_followup_timers SET state='cancelled' WHERE principal=? AND matter_id=? AND state='scheduled'" +
              workTimers,
            [principal, id],
          )
          this.db.run(
            "UPDATE router_signals SET state='cancelled',error='事项已结束。' WHERE principal=? AND kind='timer' AND state='pending' AND json_extract(payload,'$.matterId')=?" +
              (patch.state === 'completed'
                ? " AND json_extract(payload,'$.publicationId') IS NULL"
                : ''),
            [principal, id],
          )
        }
        const matter = this.getMatter(principal, id)
        if (!matter) throw new RouterLedgerConflict('事项保存后无法读取。')
        this.db.run(
          'INSERT INTO router_matter_history(matter_id,principal,version,snapshot,recorded_at) VALUES(?,?,?,?,?)',
          [
            id,
            principal,
            matter.version,
            JSON.stringify({
              ...matter,
              sourceEventIds: this.matterSources(id),
              inheritedSourceIds,
              inputOrigin,
            }),
            new Date().toISOString(),
          ],
        )
        return matter
      })
      .immediate()
  }

  begin(sessionId: string, label: string, input: unknown, replayOf: string | null = null): string {
    const id = randomUUID()
    this.db
      .transaction(() => {
        if (replayOf && !this.getRun(replayOf)) throw new RangeError('Unknown original trace')
        this.db.run(
          `INSERT INTO router_trace_runs(id,session_id,label,status,started_at,replay_of) VALUES (?,?,?,'running',?,?)`,
          [id, sessionId, label, new Date().toISOString(), replayOf],
        )
        this.append(id, 'input', input)
      })
      .immediate()
    return id
  }

  linkMatter(runId: string, matterId: string) {
    if (!this.db.query('SELECT 1 FROM router_matters WHERE id=?').get(matterId))
      throw new RangeError('Unknown matter')
    if (
      !this.db.run('UPDATE router_trace_runs SET matter_id=? WHERE id=? AND matter_id IS NULL', [
        matterId,
        runId,
      ]).changes
    )
      throw new RouterLedgerConflict('Trace already linked or absent')
  }

  referenceMatter(runId: string, matterId: string) {
    const exists = this.db.query('SELECT 1 FROM router_matters WHERE id=?').get(matterId)
    if (!exists) return
    this.db.run('INSERT OR IGNORE INTO router_trace_matters VALUES(?,?)', [runId, matterId])
    this.db.run('UPDATE router_trace_runs SET matter_id=? WHERE id=? AND matter_id IS NULL', [
      matterId,
      runId,
    ])
  }

  append(runId: string, kind: RouterTraceEntry['kind'], data: unknown): void {
    if (
      !this.db.run(
        `INSERT INTO router_trace_entries(run_id,kind,created_at,data)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM router_trace_runs WHERE id=? AND status='running')`,
        [runId, kind, new Date().toISOString(), JSON.stringify(data), runId],
      ).changes
    )
      throw new RouterLedgerConflict('Trace is absent or already ended')
  }

  end(runId: string, status: 'completed' | 'failed') {
    if (
      !this.db.run(
        `UPDATE router_trace_runs SET status=?,ended_at=? WHERE id=? AND status='running'`,
        [status, new Date().toISOString(), runId],
      ).changes
    )
      throw new RouterLedgerConflict('Trace is absent or already ended')
  }

  recoverInterrupted(conversations?: Pick<TriggerConversationStore, 'get'>) {
    return this.db
      .transaction(() => {
        this.publications.recoverInterrupted()
        this.operations.recoverInterrupted()
        const claimed = this.db
          .query<{ id: number; scope: string }, []>(
            "SELECT id,scope FROM router_signals WHERE state='running'",
          )
          .all()
        for (const signal of claimed) {
          let state: RouterSignal['state'] = 'interrupted'
          let error: string | null = '进程在处理期间退出，请核对已执行的工具后重试。'
          if (conversations) {
            const scope =
              signal.scope === 'general'
                ? 'general'
                : signal.scope.startsWith('im-')
                  ? (signal.scope as RouterImScope)
                  : Number(signal.scope)
            const turn = conversations.get(scope, `signal-${signal.id}`)
            // The loop starts only after the turn has been inserted. No turn means it is safe to claim the signal again.
            if (!turn) {
              state = 'pending'
              error = null
            } else if (turn.status === 'completed') {
              error = turn.answer?.incompleteReason ?? null
              state = error ? 'failed' : 'completed'
            } else if (turn.error) error = turn.error
          }
          this.db.run('UPDATE router_signals SET state=?,error=? WHERE id=?', [
            state,
            error,
            signal.id,
          ])
        }
        return this.db.run(
          "UPDATE router_trace_runs SET status='interrupted',ended_at=? WHERE status='running'",
          [new Date().toISOString()],
        ).changes
      })
      .immediate()
  }

  publishedLinks(principal: string, runs: string[]) {
    if (!runs.length) return []
    return this.db
      .query<{ runId: string; id: string; matterId: string; title: string }, string[]>(
        `SELECT DISTINCT e.run_id AS runId,p.id,p.matter_id AS matterId,json_extract(d.presentation,'$.title') AS title
       FROM router_trace_entries e JOIN router_publications p ON p.id=${receiptPublicationId}
       JOIN router_publication_deliveries d ON d.publication_id=p.id AND d.channel='web' AND d.status='accepted'
       WHERE e.kind='tool_result' AND ${deliveryOperation}='publish_update' AND p.principal=?
       AND e.run_id IN (${runs.map(() => '?').join(',')}) ORDER BY e.ordinal`,
      )
      .all(principal, ...runs)
  }

  publicationTraces(ids: string[]) {
    const grouped = new Map<string, RouterPublicationTrace[]>()
    if (!ids.length) return grouped
    const records = this.db
      .query<RouterPublicationTrace & { publicationId: string }, string[]>(
        `SELECT ${receiptPublicationId} AS publicationId, e.run_id AS runId, e.ordinal,
        ${deliveryOperation} AS operation,json_extract(data,'$.input.channel') AS channel
       FROM router_trace_entries e JOIN router_trace_runs r ON r.id=e.run_id
       WHERE ${receiptEntry} AND ${receiptPublicationId} IN (${ids.map(() => '?').join(',')})
       AND r.replay_of IS NULL ORDER BY e.ordinal`,
      )
      .all(...ids)
    for (const { publicationId, runId, ordinal, operation, channel } of records) {
      const group = grouped.get(publicationId) ?? []
      group.push({ runId, ordinal, operation, ...(channel && { channel }) })
      grouped.set(publicationId, group)
    }
    return grouped
  }

  workerAttemptRuns(jobId: number) {
    const rows = this.db
      .query<{ id: string; attempt: number }, [string]>(
        `SELECT r.id,json_extract(e.data,'$.context.attempt') AS attempt FROM router_trace_runs r
       JOIN router_trace_entries e ON e.run_id=r.id WHERE r.session_id=? AND r.replay_of IS NULL
       AND e.kind='input' AND json_type(e.data,'$.context.attempt')='integer' ORDER BY r.ordinal`,
      )
      .all(`router-job-${jobId}`)
    return new Map(rows.map((row) => [row.attempt, row.id]))
  }

  conversationRuns(sessionId: string, turnIds: number[]): Map<number, string[]> {
    const runs = new Map<number, string[]>()
    if (!turnIds.length) return runs
    const rows = this.db
      .query<{ turnId: number; id: string }, (number | string)[]>(
        `SELECT ${traceTurnId} AS turnId, r.id FROM router_trace_entries e JOIN router_trace_runs r ON r.id=e.run_id
       WHERE e.kind='input' AND ${traceTurnId} IN (${turnIds.map(() => '?').join(',')})
       AND r.session_id=? AND r.replay_of IS NULL ORDER BY r.ordinal`,
      )
      .all(...turnIds, sessionId)
    for (const row of rows) {
      const group = runs.get(row.turnId) ?? []
      group.push(row.id)
      runs.set(row.turnId, group)
    }
    return runs
  }

  getRun(id: string): RouterTraceRun | null {
    const run = this.db
      .query<RouterTraceRun, [string]>(`SELECT ${runColumns} FROM router_trace_runs r WHERE id=?`)
      .get(id)
    if (!run) return null
    const relatedMatters = this.db
      .query<{ id: string; title: string }, [string, string | null, string]>(
        `SELECT m.id,m.title FROM router_matters m WHERE m.id IN (SELECT matter_id FROM router_trace_matters WHERE run_id=?)
      OR m.id=? OR m.id=(SELECT ${focusedMatter} FROM router_trace_runs r WHERE r.id=?) ORDER BY m.created_at,m.id`,
      )
      .all(id, run.matterId, id)
    return { ...run, relatedMatters }
  }

  listRuns(
    input: {
      sessionId?: string
      matterId?: string
      query?: string
      before?: number
      limit?: number
      runId?: string
      toolCallId?: string
      status?: string
      platform?: string
      eventId?: number
      workerId?: number
      startedAfter?: string
      startedBefore?: string
    } = {},
  ): RouterTraceRun[] {
    const conditions: string[] = ['r.ordinal < ?']
    const values: (string | number)[] = [input.before ?? Number.MAX_SAFE_INTEGER]
    for (const [column, value] of [
      ['session_id', input.sessionId],
      ['id', input.runId],
      ['status', input.status],
    ])
      if (value) {
        conditions.push(`r.${column} = ?`)
        values.push(value)
      }
    if (input.matterId) {
      conditions.push(
        `(r.matter_id=? OR EXISTS(SELECT 1 FROM router_trace_matters m WHERE m.run_id=r.id AND m.matter_id=?) OR ${workerMatter}=? OR ${focusedMatter}=?)`,
      )
      values.push(input.matterId, input.matterId, input.matterId, input.matterId)
    }
    if (input.toolCallId) {
      conditions.push(
        "EXISTS(SELECT 1 FROM router_trace_entries e WHERE e.run_id=r.id AND e.kind IN ('tool_start','tool_result') AND json_extract(e.data,'$.id')=?)",
      )
      values.push(input.toolCallId)
    }
    if (input.query) {
      conditions.push(
        '(instr(lower(r.label),lower(?))>0 OR EXISTS(SELECT 1 FROM router_trace_entries e WHERE e.run_id=r.id AND instr(lower(e.data),lower(?))>0))',
      )
      values.push(input.query, input.query)
    }
    for (const [key, value] of Object.entries({
      platform: input.platform,
      eventId: input.eventId,
      workerId: input.workerId,
    })) {
      if (value === undefined || value === '') continue
      conditions.push(
        "EXISTS(SELECT 1 FROM router_trace_entries e WHERE e.run_id=r.id AND e.kind='input' AND json_extract(e.data, ?) = ?)",
      )
      values.push(`$.context.${key}`, value)
    }
    if (input.startedAfter) {
      conditions.push('r.started_at >= ?')
      values.push(input.startedAfter)
    }
    if (input.startedBefore) {
      conditions.push('r.started_at <= ?')
      values.push(input.startedBefore)
    }
    values.push(Math.max(1, Math.min(100, input.limit ?? 30)))
    return this.db
      .query<RouterTraceRun, (string | number)[]>(
        `SELECT ${runColumns} FROM router_trace_runs r WHERE ${conditions.join(' AND ')} ORDER BY r.ordinal DESC LIMIT ?`,
      )
      .all(...values)
  }

  entries(runId: string, after = 0, limit = 100): RouterTraceEntry[] {
    return this.db
      .query<
        Omit<RouterTraceEntry, 'data'> & { data: string },
        [string, number, number]
      >(`SELECT ordinal,run_id AS runId,kind,created_at AS createdAt,data FROM router_trace_entries
      WHERE run_id=? AND ordinal>? ORDER BY ordinal LIMIT ?`)
      .all(runId, after, Math.max(1, Math.min(200, limit)))
      .map((r) => ({ ...r, data: JSON.parse(r.data) }))
  }
}
