import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  RouterJobConflictError,
  type RouterJobScope,
  type RouterJobStore,
} from './router-job-store'

/** The trusted adapter supplies identity and authority. Never infer these from message text. */
export interface RouterFollowupInput {
  scope: RouterJobScope
  audience: string
  authority: string
  subject: string
  /** Stable, source-namespaced delivery identity. */
  eventKey: string
  instruction: string
  repository?: string
  kind?: 'github-watch' | 'event-followup'
}

type Receipt = { jobId: number; attempt: number | null }
type Authority = Pick<
  RouterFollowupInput,
  'scope' | 'audience' | 'authority' | 'repository' | 'kind'
>
function partitionKey({ scope, audience, authority, repository, kind }: Authority) {
  return key([scope, audience, authority, kind ?? '', repository?.toLowerCase() ?? ''])
}
const receiptFields = 'job_id AS jobId, attempt'
function key(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** An input survives restarts, even when its original Worker is still occupied. */
export class RouterFollowupStore {
  constructor(
    private readonly db: Database,
    private readonly jobs: RouterJobStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_followup_inputs (
      partition_key TEXT NOT NULL, subject_key TEXT NOT NULL, event_key TEXT NOT NULL,
      job_id INTEGER NOT NULL, attempt INTEGER, pending_instruction TEXT,
      PRIMARY KEY(partition_key,event_key), UNIQUE(job_id,attempt));
      CREATE INDEX IF NOT EXISTS router_followup_subject ON router_followup_inputs(subject_key,job_id);
      CREATE INDEX IF NOT EXISTS router_followup_event ON router_followup_inputs(event_key);
      CREATE INDEX IF NOT EXISTS router_followup_pending ON router_followup_inputs(job_id) WHERE attempt IS NULL;`)
  }

  /** Bind an existing worker's first receipt once. This never queues or replays work. */
  adopt(jobId: number, input: Authority & Pick<RouterFollowupInput, 'subject' | 'eventKey'>) {
    const job = this.jobs.get(input.scope, jobId, 1)
    if (
      !job ||
      job.audience !== input.audience ||
      job.kind !== input.kind ||
      job.repository !== input.repository
    )
      return
    const partition = partitionKey(input)
    const binding = key([partition, input.subject])
    this.db.run(
      `INSERT INTO router_followup_inputs(partition_key,subject_key,event_key,job_id,attempt)
      SELECT ?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM router_followup_inputs WHERE subject_key=? OR job_id=?)`,
      [partition, binding, input.eventKey, jobId, binding, jobId],
    )
  }

  receive(input: RouterFollowupInput): Receipt {
    const { scope, audience, authority, subject, eventKey, instruction, repository, kind } = input
    if (
      ![audience, authority, subject, eventKey].every((v) => v.trim() && v.length <= 2048) ||
      !instruction.trim() ||
      instruction.length > 8192
    )
      throw new RouterJobConflictError('跟进线索的范围、标识或指令无效。')
    const partition = partitionKey(input)
    const binding = key([partition, subject])
    return this.db
      .transaction(() => {
        const replay = this.db
          .query<Receipt & { binding: string }, [string, string]>(
            `SELECT ${receiptFields},subject_key AS binding FROM router_followup_inputs WHERE partition_key=? AND event_key=?`,
          )
          .get(partition, eventKey)
        if (replay) {
          if (replay.binding !== binding)
            throw new RouterJobConflictError('同一线索的事项标识不一致。')
          return { jobId: replay.jobId, attempt: replay.attempt }
        }
        const existing = this.db
          .query<{ id: number }, [string]>(
            `SELECT f.job_id AS id FROM router_followup_inputs f WHERE subject_key=? AND EXISTS
         (SELECT 1 FROM router_job_steps j WHERE j.job_id=f.job_id AND j.retired=0)
         ORDER BY f.job_id DESC LIMIT 1`,
          )
          .get(binding)
        const job =
          existing ??
          this.jobs.submit(scope, this.requestId(partition, eventKey), {
            executor: 'zero',
            instruction,
            audience,
            repository,
            kind,
          })
        this.db.run('INSERT INTO router_followup_inputs VALUES(?,?,?,?,?,?)', [
          partition,
          binding,
          eventKey,
          job.id,
          existing ? null : 1,
          existing ? instruction : null,
        ])
        if (existing) this.promote(existing.id)
        const recorded = this.forEvent(job.id, eventKey)
        if (!recorded) throw new Error('Missing follow-up receipt')
        return recorded
      })
      .immediate()
  }

  private requestId(partition: string, eventKey: string) {
    return `followup:${key([partition, eventKey])}`
  }

  forEvent(jobId: number, eventKey: string) {
    return this.db
      .query<Receipt, [number, string]>(
        `SELECT ${receiptFields} FROM router_followup_inputs WHERE job_id=? AND event_key=?`,
      )
      .get(jobId, eventKey)
  }

  /** For trusted globally unique inbox IDs. Authorization is checked by the consuming adapter. */
  latestForKey(eventKey: string) {
    return this.db
      .query<Receipt, [string]>(
        `SELECT ${receiptFields} FROM router_followup_inputs WHERE event_key=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(eventKey)
  }

  matchesAuthority(jobId: number, authority: Authority) {
    return !!this.db
      .query('SELECT 1 FROM router_followup_inputs WHERE job_id=? AND partition_key=? LIMIT 1')
      .get(jobId, partitionKey(authority))
  }

  step(jobId: number, attempt: number) {
    const row = this.db
      .query<{ eventKey: string }, [number, number]>(
        'SELECT event_key AS eventKey FROM router_followup_inputs WHERE job_id=? AND attempt=?',
      )
      .get(jobId, attempt)
    return row && { ...row, followup: attempt > 1 }
  }

  /** Promote at most one input, in arrival order; never retry an interrupted attempt. */
  promote(jobId?: number) {
    return this.db
      .transaction(() => {
        const waiting = this.db
          .query<
            {
              row: number
              jobId: number
              scope: RouterJobScope
              eventKey: string
              partition: string
              instruction: string
            },
            [number | null]
          >(
            `SELECT f.rowid AS row,f.job_id AS jobId,j.scope,f.event_key AS eventKey,
          f.partition_key AS partition,f.pending_instruction AS instruction
         FROM router_followup_inputs f JOIN router_job_steps j ON j.job_id=f.job_id AND j.attempt=1
         WHERE f.attempt IS NULL AND (?1 IS NULL OR f.job_id=?1) AND j.retired=0
         AND NOT EXISTS (SELECT 1 FROM router_job_steps active WHERE active.job_id=f.job_id AND active.status IN ('queued','running'))
         ORDER BY f.rowid LIMIT 1`,
          )
          .get(jobId ?? null)
        if (!waiting) return
        const step = this.jobs.continue(
          waiting.scope,
          waiting.jobId,
          this.requestId(waiting.partition, waiting.eventKey),
          waiting.instruction,
          undefined,
          true,
        )
        this.db.run(
          'UPDATE router_followup_inputs SET attempt=?,pending_instruction=NULL WHERE rowid=?',
          [step.attempt, waiting.row],
        )
      })
      .immediate()
  }
}
