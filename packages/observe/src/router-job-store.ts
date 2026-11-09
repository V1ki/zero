import type { Database } from 'bun:sqlite'
import { type RouterEventWork, isPublicGithubFact } from '@zero-os/shared'
import { RouterFollowupStore } from './router-followup-store'
import type { RouterImScope } from './trigger-conversation-store'

export class RouterJobConflictError extends Error {}

export type RouterJobScope = 'general' | RouterImScope
export type RouterJobExecutor = string
export type RouterJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown'

export interface RouterJob {
  id: number
  scope: RouterJobScope
  requestId: string
  executor: RouterJobExecutor
  /** Only the intake transaction can create a watch job. Its origin survives continuations. */
  kind?: 'event-followup' | 'github-watch' | null
  workOrigin?: 'manual' | 'owner' | null
  work?: RouterEventWork | null
  attentionQuestion?: string | null
  instruction: string
  repository: string | null
  /** Opaque authorization snapshot supplied by the server, not by the model. */
  audience: string | null
  status: RouterJobStatus
  attempt: number
  result: string | null
  threadId: string | null
  createdAt: string
  updatedAt: string
}
export type RouterJobStep = RouterJob
type JobInput = Pick<RouterJob, 'executor' | 'instruction'> & {
  repository?: string
  audience?: string
  kind?: 'event-followup' | 'github-watch'
}
type Outcome = {
  status: 'completed' | 'failed' | 'unknown'
  result: string
  threadId?: string
  attentionQuestion?: string
  work?: RouterEventWork
}

const columns = `job_id AS id, scope, request_id AS requestId, executor, instruction,
  repository, audience, status, attempt, result, kind, attention_question AS attentionQuestion, thread_id AS threadId,
  created_at AS createdAt, updated_at AS updatedAt, work_origin AS workOrigin, work_json AS workJson`
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

type DbJob = Omit<RouterJob, 'work'> & { workJson: string | null }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isWork(value: unknown): value is RouterEventWork {
  return (
    isRecord(value) &&
    (value.followup === undefined ||
      (isRecord(value.followup) &&
        (value.followup.kind === 'new' || value.followup.kind === 'continue') &&
        (value.followup.decision === 'act' || value.followup.decision === 'observe') &&
        typeof value.followup.reason === 'string' &&
        value.followup.reason.trim().length > 0)) &&
    (value.publicFacts === undefined ||
      (Array.isArray(value.publicFacts) && value.publicFacts.every(isPublicGithubFact))) &&
    (value.outcome === 'observed' ||
      value.outcome === 'resolved' ||
      value.outcome === 'needs_input') &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (s) =>
        isRecord(s) &&
        typeof s.ok === 'boolean' &&
        (s.tool === 'inspect_github' ||
          s.tool === 'compare_runs' ||
          s.tool === 'find_related_issues' ||
          s.tool === 'close_issue' ||
          s.tool === 'inspect_archive'),
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (s) => isRecord(s) && typeof s.label === 'string' && typeof s.url === 'string',
    )
  )
}

function decodeJob(raw: DbJob): RouterJob {
  const { workJson, ...job } = raw
  if (workJson === null) return job
  const work: unknown = JSON.parse(workJson)
  if (!isWork(work) || (job.kind !== 'github-watch' && job.kind !== 'event-followup'))
    throw new Error('存储的事件办理结果无效。')
  return { ...job, work }
}

function validateRequest(scope: RouterJobScope, requestId: string, instruction: string) {
  if (scope !== 'general' && !/^im-[a-f0-9]{64}$/.test(scope))
    throw new RouterJobConflictError('当前对话无法派发任务。')
  if (
    !requestId.trim() ||
    requestId.length > 256 ||
    !instruction.trim() ||
    instruction.length > 8192
  )
    throw new RouterJobConflictError('执行任务的请求无效或内容过长。')
}

/** Each attempt has its own durable execution and delivery receipt. */
export class RouterJobStore {
  readonly followups: RouterFollowupStore
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_job_steps (
      job_id INTEGER NOT NULL, attempt INTEGER NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL,
      executor TEXT NOT NULL, instruction TEXT NOT NULL,
      repository TEXT, audience TEXT, thread_id TEXT, result TEXT,
      kind TEXT, attention_question TEXT, work_origin TEXT, work_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','unknown')),
      return_state TEXT CHECK(return_state IN ('pending','sending','delivered','unavailable','unknown')),
      return_due_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(job_id,attempt), UNIQUE(scope,request_id));
      CREATE INDEX IF NOT EXISTS router_jobs_queued ON router_job_steps(created_at,job_id) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS router_jobs_return ON router_job_steps(updated_at,job_id) WHERE return_state='pending';`)
    db.transaction(() => {
      const fields = new Set(
        db
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('router_job_steps')")
          .all()
          .map((r) => r.name),
      )
      if (!fields.has('kind')) db.exec('ALTER TABLE router_job_steps ADD COLUMN kind TEXT')
      if (!fields.has('attention_question'))
        db.exec('ALTER TABLE router_job_steps ADD COLUMN attention_question TEXT')
      if (!fields.has('work_origin'))
        db.exec('ALTER TABLE router_job_steps ADD COLUMN work_origin TEXT')
      if (!fields.has('work_json'))
        db.exec('ALTER TABLE router_job_steps ADD COLUMN work_json TEXT')
      // SQLite needs a table rebuild to remove the old two-executor CHECK. Use the
      // stored definition so databases upgraded from older layouts keep their column order.
      const legacyCheck = "CHECK(executor IN ('zero','codex'))"
      const sql = db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name='router_job_steps' AND type='table'",
        )
        .get()?.sql
      if (sql?.includes(legacyCheck)) {
        const indexes = db
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE tbl_name='router_job_steps' AND type='index' AND sql IS NOT NULL",
          )
          .all()
        db.exec(
          sql.replace('router_job_steps', 'router_job_steps_upgrade').replace(legacyCheck, ''),
        )
        db.exec('INSERT INTO router_job_steps_upgrade SELECT * FROM router_job_steps')
        db.exec('DROP TABLE router_job_steps')
        db.exec('ALTER TABLE router_job_steps_upgrade RENAME TO router_job_steps')
        for (const index of indexes) db.exec(index.sql)
      }
    }).immediate()
    this.followups = new RouterFollowupStore(db, this)
  }

  get(scope: RouterJobScope, id: number, attempt?: number): RouterJob | null {
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) return null
    const raw = this.db
      .query<DbJob, [RouterJobScope, number, number | null]>(
        `SELECT ${columns} FROM router_job_steps WHERE scope=?1 AND job_id=?2 AND retired=0
       AND (?3 IS NULL OR attempt=?3) ORDER BY attempt DESC LIMIT 1`,
      )
      .get(scope, id, attempt ?? null)
    return raw && decodeJob(raw)
  }

  matchingAttempts(scope: RouterJobScope, id: number, audience: string | null, query: string) {
    return this.db
      .query<{ attempt: number }, [RouterJobScope, number, string | null, string]>(
        `SELECT attempt FROM router_job_steps WHERE scope=?1 AND job_id=?2 AND audience IS ?3 AND retired=0
         AND (instr(lower(instruction),lower(?4))>0 OR instr(lower(result),lower(?4))>0)
         ORDER BY attempt DESC`,
      )
      .all(scope, id, audience, query)
  }

  /** Every retained step in chronological order, including the current attempt. */
  history(scope: RouterJobScope, id: number): RouterJobStep[] {
    return this.db
      .query<DbJob, [RouterJobScope, number]>(
        `SELECT ${columns} FROM router_job_steps WHERE scope=? AND job_id=? AND retired=0
       ORDER BY attempt`,
      )
      .all(scope, id)
      .map(decodeJob)
  }

  private replay(scope: RouterJobScope, requestId: string) {
    const row = this.db
      .query<DbJob & { retired: number }, [RouterJobScope, string]>(
        `SELECT ${columns}, retired FROM router_job_steps WHERE scope=? AND request_id=?`,
      )
      .get(scope, requestId)
    if (!row) return null
    const { retired, ...job } = row
    if (retired) throw new RouterJobConflictError('这次任务已超过保留期限。')
    return decodeJob(job)
  }

  submit(
    scope: RouterJobScope,
    requestId: string,
    input: JobInput,
    registered?: (job: RouterJob) => void,
  ): RouterJob {
    validateRequest(scope, requestId, input.instruction)
    return this.db
      .transaction(() => {
        const prior = this.replay(scope, requestId)
        const repository = input.repository ?? null
        const audience = input.audience ?? null
        if (prior) {
          if (
            prior.attempt !== 1 ||
            prior.executor !== input.executor ||
            prior.kind !== (input.kind ?? null) ||
            prior.instruction !== input.instruction ||
            prior.repository !== repository ||
            prior.audience !== audience
          )
            throw new RouterJobConflictError('请求编号已用于其他任务。')
          registered?.(prior)
          return prior
        }
        const inserted = this.db
          .query<
            DbJob,
            [
              RouterJobScope,
              string,
              RouterJobExecutor,
              string,
              string | null,
              string | null,
              string | null,
            ]
          >(
            `INSERT INTO router_job_steps(job_id,attempt,scope,request_id,executor,instruction,repository,audience,kind,status,created_at,updated_at)
         VALUES((SELECT COALESCE(MAX(job_id),0)+1 FROM router_job_steps),1,?,?,?,?,?,?,?,'queued',${now},${now})
         RETURNING ${columns}`,
          )
          .get(
            scope,
            requestId,
            input.executor,
            input.instruction,
            repository,
            audience,
            input.kind ?? null,
          )
        if (!inserted) throw new Error('Failed to create Router job')
        const saved = decodeJob(inserted)
        registered?.(saved)
        return saved
      })
      .immediate()
  }

  continue(
    scope: RouterJobScope,
    id: number,
    requestId: string,
    instruction: string,
    workOrigin?: 'manual' | 'owner',
    preserveEarlierDelivery = false,
    registered?: (job: RouterJob) => void,
  ): RouterJob {
    validateRequest(scope, requestId, instruction)
    return this.db
      .transaction(() => {
        const prior = this.replay(scope, requestId)
        if (prior) {
          if (
            prior.id !== id ||
            prior.attempt === 1 ||
            prior.instruction !== instruction ||
            (prior.workOrigin ?? null) !== (workOrigin ?? null)
          )
            throw new RouterJobConflictError('请求编号已用于其他任务。')
          registered?.(prior)
          return prior
        }
        const job = this.get(scope, id)
        if (!job) throw new RouterJobConflictError('当前对话没有这项任务。')
        if (
          workOrigin &&
          (scope !== 'general' || job.kind !== 'github-watch' || job.executor !== 'zero')
        )
          throw new RouterJobConflictError('此任务不能办理 GitHub 事件。')
        if (job.status === 'queued' || job.status === 'running')
          throw new RouterJobConflictError('任务仍在处理中。')
        if (!preserveEarlierDelivery)
          this.db.run(
            `UPDATE router_job_steps SET return_state='unavailable' WHERE job_id=? AND return_state='pending'
              AND NOT EXISTS (SELECT 1 FROM router_followup_inputs f WHERE f.job_id=router_job_steps.job_id
                AND f.attempt=router_job_steps.attempt)`,
            [id],
          )
        const inserted = this.db
          .query<DbJob, [string, string, string | null, number, number]>(
            `INSERT INTO router_job_steps(job_id,attempt,scope,request_id,executor,instruction,repository,audience,kind,thread_id,work_origin,status,created_at,updated_at)
         SELECT job_id,attempt+1,scope,?,executor,?,repository,audience,kind,thread_id,?,'queued',${now},${now}
         FROM router_job_steps WHERE job_id=? AND attempt=? RETURNING ${columns}`,
          )
          .get(requestId, instruction, workOrigin ?? null, id, job.attempt)
        if (!inserted) throw new Error('Failed to continue Router job')
        const saved = decodeJob(inserted)
        registered?.(saved)
        return saved
      })
      .immediate()
  }

  claimNext(): RouterJob | null {
    this.followups.promote()
    const row = this.db
      .query<DbJob, []>(
        `UPDATE router_job_steps SET status='running',updated_at=${now}
       WHERE rowid=(SELECT rowid FROM router_job_steps WHERE status='queued' ORDER BY created_at,job_id LIMIT 1)
       RETURNING ${columns}`,
      )
      .get()
    return row && decodeJob(row)
  }

  /** Persist the execution identity before a turn can perform work. */
  attachThread(id: number, attempt: number, threadId: string): void {
    const saved = this.db.run(
      `UPDATE router_job_steps SET thread_id=?,updated_at=${now}
       WHERE job_id=? AND attempt=? AND status='running'`,
      [threadId, id, attempt],
    )
    if (saved.changes !== 1)
      throw new RouterJobConflictError('任务已不在执行，无法记录 Worker 线程。')
  }

  finish(id: number, attempt: number, outcome: Outcome): boolean {
    return (
      this.db.run(
        `UPDATE router_job_steps SET status=?,result=?,attention_question=?,thread_id=COALESCE(?,thread_id),work_json=?,
        return_state='pending',updated_at=${now} WHERE job_id=? AND attempt=? AND status='running'`,
        [
          outcome.status,
          outcome.result,
          outcome.attentionQuestion ?? null,
          outcome.threadId ?? null,
          outcome.work ? JSON.stringify(outcome.work) : null,
          id,
          attempt,
        ],
      ).changes === 1
    )
  }

  /** Called by the exclusive runtime owner at startup after the previous runner stops. */
  recoverInterrupted(): number {
    return this.db
      .transaction(() => {
        this.db.run(
          `UPDATE router_job_steps SET return_state='unknown',updated_at=${now} WHERE return_state='sending'`,
        )
        return this.db.run(`UPDATE router_job_steps SET status='unknown',return_state='pending',
         result='执行中断，结果待核对。',updated_at=${now} WHERE status='running'`).changes
      })
      .immediate()
  }

  claimReturn(): RouterJob | null {
    const row = this.db
      .query<DbJob, []>(`UPDATE router_job_steps SET return_state='sending',updated_at=${now}
       WHERE rowid=(SELECT rowid FROM router_job_steps WHERE return_state='pending'
         AND (return_due_at IS NULL OR return_due_at<=${now}) ORDER BY updated_at,job_id LIMIT 1)
       RETURNING ${columns}`)
      .get()
    return row && decodeJob(row)
  }

  deferReturn(id: number, attempt: number, dueAt: string): boolean {
    const due = new Date(dueAt).toISOString()
    return (
      this.db.run(
        `UPDATE router_job_steps SET return_due_at=?,updated_at=${now},
      return_state=CASE WHEN EXISTS(SELECT 1 FROM router_job_steps newer
        WHERE newer.job_id=? AND newer.attempt>?
        AND NOT EXISTS (SELECT 1 FROM router_followup_inputs f WHERE f.job_id=newer.job_id AND f.attempt=newer.attempt))
        AND NOT EXISTS(SELECT 1 FROM router_followup_inputs f WHERE f.job_id=router_job_steps.job_id
          AND f.attempt=router_job_steps.attempt) THEN 'unavailable' ELSE 'pending' END
      WHERE job_id=? AND attempt=? AND return_state='sending'`,
        [due, id, attempt, id, attempt],
      ).changes === 1
    )
  }

  nextReturnAt(): string | null {
    return (
      this.db
        .query<{ dueAt: string | null }, []>(
          "SELECT min(return_due_at) AS dueAt FROM router_job_steps WHERE return_state='pending'",
        )
        .get()?.dueAt ?? null
    )
  }

  wakeDeferredReturns(): void {
    this.db.run(
      "UPDATE router_job_steps SET return_due_at=NULL WHERE return_state='pending' AND return_due_at IS NOT NULL",
    )
  }

  settleReturn(
    id: number,
    attempt: number,
    status: 'delivered' | 'unavailable' | 'unknown',
  ): boolean {
    return (
      this.db.run(
        `UPDATE router_job_steps SET return_state=?,updated_at=${now}
      WHERE job_id=? AND attempt=? AND return_state='sending'`,
        [status, id, attempt],
      ).changes === 1
    )
  }
}
