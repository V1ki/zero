import type { Database } from 'bun:sqlite'
import type { RouterImScope } from './trigger-conversation-store'

export class RouterJobConflictError extends Error {}

export type RouterJobScope = 'general' | RouterImScope
export type RouterJobExecutor = 'zero' | 'codex'
export type RouterJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown'

export interface RouterJob {
  id: number
  scope: RouterJobScope
  requestId: string
  executor: RouterJobExecutor
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
}
type Outcome = {
  status: 'completed' | 'failed' | 'unknown'
  result: string
  threadId?: string
}

const columns = `job_id AS id, scope, request_id AS requestId, executor, instruction,
  repository, audience, status, attempt, result, thread_id AS threadId,
  created_at AS createdAt, updated_at AS updatedAt`
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

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

/** A new attempt is only created by an explicit user turn. Restart never replays worker effects. */
export class RouterJobStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_job_steps (
      job_id INTEGER NOT NULL, attempt INTEGER NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL,
      executor TEXT NOT NULL CHECK(executor IN ('zero','codex')), instruction TEXT NOT NULL,
      repository TEXT, audience TEXT, thread_id TEXT, result TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','unknown')),
      return_state TEXT CHECK(return_state IN ('pending','sending','delivered','unavailable','unknown')),
      return_due_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(job_id,attempt), UNIQUE(scope,request_id));
      CREATE INDEX IF NOT EXISTS router_jobs_queued ON router_job_steps(created_at,job_id) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS router_jobs_return ON router_job_steps(updated_at,job_id) WHERE return_state='pending';`)
  }

  get(scope: RouterJobScope, id: number, attempt?: number): RouterJob | null {
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) return null
    return this.db
      .query<RouterJob, [RouterJobScope, number, number | null]>(
        `SELECT ${columns} FROM router_job_steps WHERE scope=?1 AND job_id=?2 AND retired=0
       AND (?3 IS NULL OR attempt=?3) ORDER BY attempt DESC LIMIT 1`,
      )
      .get(scope, id, attempt ?? null)
  }

  /** Includes the current step, in chronological order; worker context is bounded. */
  history(scope: RouterJobScope, id: number): RouterJobStep[] {
    return this.db
      .query<RouterJob, [RouterJobScope, number]>(
        `SELECT ${columns} FROM router_job_steps WHERE scope=? AND job_id=? AND retired=0
       ORDER BY attempt DESC LIMIT 8`,
      )
      .all(scope, id)
      .reverse()
  }

  private replay(scope: RouterJobScope, requestId: string) {
    const row = this.db
      .query<RouterJob & { retired: number }, [RouterJobScope, string]>(
        `SELECT ${columns}, retired FROM router_job_steps WHERE scope=? AND request_id=?`,
      )
      .get(scope, requestId)
    if (!row) return null
    const { retired, ...job } = row
    if (retired) throw new RouterJobConflictError('这次任务已超过保留期限。')
    return job
  }

  submit(scope: RouterJobScope, requestId: string, input: JobInput): RouterJob {
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
            prior.instruction !== input.instruction ||
            prior.repository !== repository ||
            prior.audience !== audience
          )
            throw new RouterJobConflictError('请求编号已用于其他任务。')
          return prior
        }
        const inserted = this.db
          .query<
            RouterJob,
            [RouterJobScope, string, RouterJobExecutor, string, string | null, string | null]
          >(
            `INSERT INTO router_job_steps(job_id,attempt,scope,request_id,executor,instruction,repository,audience,status,created_at,updated_at)
         VALUES((SELECT COALESCE(MAX(job_id),0)+1 FROM router_job_steps),1,?,?,?,?,?,?,'queued',${now},${now})
         RETURNING ${columns}`,
          )
          .get(scope, requestId, input.executor, input.instruction, repository, audience)
        if (!inserted) throw new Error('Failed to create Router job')
        return inserted
      })
      .immediate()
  }

  continue(scope: RouterJobScope, id: number, requestId: string, instruction: string): RouterJob {
    validateRequest(scope, requestId, instruction)
    return this.db
      .transaction(() => {
        const prior = this.replay(scope, requestId)
        if (prior) {
          if (prior.id !== id || prior.attempt === 1 || prior.instruction !== instruction)
            throw new RouterJobConflictError('请求编号已用于其他任务。')
          return prior
        }
        const job = this.get(scope, id)
        if (!job) throw new RouterJobConflictError('当前对话没有这项任务。')
        if (job.status === 'queued' || job.status === 'running')
          throw new RouterJobConflictError('任务仍在处理中。')
        this.db.run(
          "UPDATE router_job_steps SET return_state='unavailable' WHERE job_id=? AND return_state='pending'",
          [id],
        )
        const inserted = this.db
          .query<RouterJob, [string, string, number, number]>(
            `INSERT INTO router_job_steps(job_id,attempt,scope,request_id,executor,instruction,repository,audience,thread_id,status,created_at,updated_at)
         SELECT job_id,attempt+1,scope,?,executor,?,repository,audience,thread_id,'queued',${now},${now}
         FROM router_job_steps WHERE job_id=? AND attempt=? RETURNING ${columns}`,
          )
          .get(requestId, instruction, id, job.attempt)
        if (!inserted) throw new Error('Failed to continue Router job')
        return inserted
      })
      .immediate()
  }

  claimNext(): RouterJob | null {
    return this.db
      .query<RouterJob, []>(
        `UPDATE router_job_steps SET status='running',updated_at=${now}
       WHERE rowid=(SELECT rowid FROM router_job_steps WHERE status='queued' ORDER BY created_at,job_id LIMIT 1)
       RETURNING ${columns}`,
      )
      .get()
  }

  finish(id: number, attempt: number, outcome: Outcome): boolean {
    return (
      this.db.run(
        `UPDATE router_job_steps SET status=?,result=?,thread_id=COALESCE(?,thread_id),
        return_state='pending',updated_at=${now} WHERE job_id=? AND attempt=? AND status='running'`,
        [outcome.status, outcome.result.slice(0, 12000), outcome.threadId ?? null, id, attempt],
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
    return this.db
      .query<RouterJob, []>(`UPDATE router_job_steps SET return_state='sending',updated_at=${now}
       WHERE rowid=(SELECT rowid FROM router_job_steps WHERE return_state='pending'
         AND (return_due_at IS NULL OR return_due_at<=${now}) ORDER BY updated_at,job_id LIMIT 1)
       RETURNING ${columns}`)
      .get()
  }

  deferReturn(id: number, attempt: number, dueAt: string): boolean {
    const due = new Date(dueAt).toISOString()
    return (
      this.db.run(
        `UPDATE router_job_steps SET return_due_at=?,updated_at=${now},
      return_state=CASE WHEN EXISTS(SELECT 1 FROM router_job_steps newer
        WHERE newer.job_id=? AND newer.attempt>?) THEN 'unavailable' ELSE 'pending' END
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
