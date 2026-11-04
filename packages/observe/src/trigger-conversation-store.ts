import type { Database } from 'bun:sqlite'
import type {
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerConversationTurn,
} from '@zero-os/shared'
import { TriggerCommissionStore } from './trigger-commission-store'
import { migrateLegacyTaskTurns } from './trigger-task-thread-migration'

type TurnRow = Omit<TriggerConversationTurn, 'answer'> & { answer: string | null }

type BeginResult =
  | { kind: 'started'; turn: TriggerConversationTurn; attempt: number }
  | { kind: 'existing'; turn: TriggerConversationTurn }
  | { kind: 'busy' | 'conflict' }

const turnColumns =
  'id, request_id AS requestId, question, answer, status, error, created_at AS createdAt, updated_at AS updatedAt'

function threadId(scope: TriggerConversationScope) {
  if (scope === 'general') return '0'
  if (
    typeof scope === 'string' &&
    /^task-[1-9]\d*$/.test(scope) &&
    Number.isSafeInteger(Number(scope.slice(5)))
  )
    return scope
  if (typeof scope !== 'number' || !Number.isSafeInteger(scope) || scope < 1)
    throw new RangeError('Invalid conversation thread')
  return String(scope)
}

function decodeTurn(row: TurnRow): TriggerConversationTurn {
  return { ...row, answer: row.answer === null ? null : JSON.parse(row.answer) }
}

export class TriggerConversationStore {
  readonly commissions: TriggerCommissionStore
  constructor(private readonly db: Database) {
    this.commissions = new TriggerCommissionStore(db)
    db.transaction(() => {
      // Event ids and zero retain their former meaning. The task prefix owns a separate namespace.
      const turnsSchema = `(
        id INTEGER PRIMARY KEY, thread TEXT NOT NULL, request_id TEXT NOT NULL,
        question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
        attempt INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(thread,request_id))`
      const actionsSchema = `(thread TEXT NOT NULL, request_id TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(thread,request_id))`
      db.exec(`CREATE TABLE IF NOT EXISTS trigger_conversation_turns ${turnsSchema};
        CREATE TABLE IF NOT EXISTS trigger_conversation_actions ${actionsSchema};`)
      if (
        db
          .query(
            "SELECT 1 FROM pragma_table_info('trigger_conversation_turns') WHERE name='thread' AND type='INTEGER'",
          )
          .get()
      ) {
        db.exec(`
          DROP VIEW IF EXISTS trigger_visible_turns;
          CREATE TABLE new_trigger_conversation_turns ${turnsSchema};
          INSERT INTO new_trigger_conversation_turns
            SELECT id,CAST(thread AS TEXT),request_id,question,answer,status,attempt,error,created_at,updated_at
            FROM trigger_conversation_turns;
          CREATE TABLE new_trigger_conversation_actions ${actionsSchema};
          INSERT INTO new_trigger_conversation_actions SELECT CAST(thread AS TEXT),request_id,identity FROM trigger_conversation_actions;
          DROP TABLE trigger_conversation_turns;
          DROP TABLE trigger_conversation_actions;
          ALTER TABLE new_trigger_conversation_turns RENAME TO trigger_conversation_turns;
          ALTER TABLE new_trigger_conversation_actions RENAME TO trigger_conversation_actions;
        `)
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS trigger_thread_pending ON trigger_conversation_turns(thread)
          WHERE status='pending';
        CREATE INDEX IF NOT EXISTS trigger_thread_history ON trigger_conversation_turns(thread,id);
        CREATE TABLE IF NOT EXISTS trigger_retired_turns(id INTEGER PRIMARY KEY);
        CREATE VIEW IF NOT EXISTS trigger_visible_turns AS SELECT c.* FROM trigger_conversation_turns c
          WHERE c.id NOT IN (SELECT id FROM trigger_retired_turns);`)
      migrateLegacyTaskTurns(db)
    }).immediate()
  }

  private expired(thread: string): boolean {
    if (thread === '0') return false
    if (thread.startsWith('task-')) {
      return !this.db
        .query(`SELECT 1 FROM mandate_tasks WHERE id=?
        AND id NOT IN (SELECT id FROM trigger_retired_task_threads)`)
        .get(Number(thread.slice(5)))
    }
    return !!this.db.query('SELECT 1 FROM trigger_retired_inbox WHERE id=?').get(thread)
  }

  get(scope: TriggerConversationScope, requestId: string): TriggerConversationTurn | null {
    const row = this.db
      .query<TurnRow, [string, string]>(
        `SELECT ${turnColumns} FROM trigger_visible_turns WHERE thread = ? AND request_id = ?`,
      )
      .get(threadId(scope), requestId)
    return row ? decodeTurn(row) : null
  }

  /** Latest window (or the previous page), always returned in reading order. */
  list(scope: TriggerConversationScope, limit = 50, beforeId = Number.MAX_SAFE_INTEGER) {
    return this.db
      .query<TurnRow, [string, number, number]>(
        `SELECT ${turnColumns} FROM trigger_visible_turns
         WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(threadId(scope), beforeId, Math.min(100, Math.max(1, limit)))
      .reverse()
      .map(decodeTurn)
  }

  begin(
    scope: TriggerConversationScope,
    requestId: string,
    question: string,
    retry = false,
  ): BeginResult {
    const thread = threadId(scope)
    return this.db
      .transaction((): BeginResult => {
        if (this.expired(thread) || this.getActionIdentity(scope, requestId) !== null)
          return { kind: 'conflict' }
        const previous = this.get(scope, requestId)
        if (previous) {
          if (previous.question !== question) return { kind: 'conflict' }
          if (previous.status !== 'failed' || !retry) return { kind: 'existing', turn: previous }
        }

        const busy = this.db
          .query(
            "SELECT id FROM trigger_conversation_turns WHERE thread = ? AND status = 'pending'",
          )
          .get(thread)
        if (busy) return { kind: 'busy' }

        const now = new Date().toISOString()
        const row = this.db
          .query<TurnRow & { attempt: number }, [string, string, string, string, string]>(
            `INSERT INTO trigger_conversation_turns
             (thread, request_id, question, status, attempt, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 1, ?, ?)
           ON CONFLICT(thread, request_id) DO UPDATE SET
             status = 'pending', attempt = attempt + 1, error = NULL, updated_at = excluded.updated_at
           RETURNING ${turnColumns}, attempt`,
          )
          .get(thread, requestId, question, now, now)
        if (!row) throw new Error('Could not claim the Router turn')
        const { attempt, ...turn } = row
        return { kind: 'started', turn: decodeTurn(turn), attempt }
      })
      .immediate()
  }

  finish(
    scope: TriggerConversationScope,
    requestId: string,
    attempt: number,
    answer: TriggerConversationAnswer,
  ): boolean {
    if (answer.proposalAppliedAt !== undefined)
      throw new Error('A new Router answer cannot confirm its own proposal')
    return (
      this.db.run(
        `UPDATE trigger_conversation_turns SET status = 'completed', answer = ?, updated_at = ?
       WHERE thread = ? AND request_id = ? AND status = 'pending' AND attempt = ?`,
        [JSON.stringify(answer), new Date().toISOString(), threadId(scope), requestId, attempt],
      ).changes === 1
    )
  }

  fail(
    scope: TriggerConversationScope,
    requestId: string,
    attempt: number,
    error: string,
  ): boolean {
    return (
      this.db.run(
        `UPDATE trigger_conversation_turns SET status = 'failed', error = ?, updated_at = ?
       WHERE thread = ? AND request_id = ? AND status = 'pending' AND attempt = ?`,
        [error, new Date().toISOString(), threadId(scope), requestId, attempt],
      ).changes === 1
    )
  }

  /** Called by the sole runtime at startup; opening a separate reader must never interrupt a turn. */
  recoverInterrupted() {
    this.db.run(
      `UPDATE trigger_conversation_turns SET status = 'failed', error = ?, updated_at = ?
       WHERE status = 'pending'`,
      ['服务重启中断了这次回答，可重试此轮对话。', new Date().toISOString()],
    )
    migrateLegacyTaskTurns(this.db)
  }

  markProposalApplied(scope: TriggerConversationScope, turnRequestId: string, at: string): void {
    const changed = this.db.run(
      `UPDATE trigger_conversation_turns
       SET answer = json_set(answer, '$.proposalAppliedAt', ?), updated_at = ?
       WHERE thread = ? AND request_id = ? AND status = 'completed'
         AND json_type(answer, '$.proposal') = 'object'
         AND json_type(answer, '$.proposalAppliedAt') IS NULL`,
      [at, at, threadId(scope), turnRequestId],
    ).changes
    if (changed !== 1) throw new Error('The Router proposal is missing or already applied')
  }

  /** Persist a local state change and its receipt in the same transaction. */
  applyActionOnce(
    scope: TriggerConversationScope,
    requestId: string,
    identity: string,
    apply: () => void,
  ): 'applied' | 'existing' | 'conflict' {
    const thread = threadId(scope)
    return this.db
      .transaction(() => {
        if (this.expired(thread) || this.get(scope, requestId)) return 'conflict' as const
        const previous = this.getActionIdentity(scope, requestId)
        if (previous !== null)
          return previous === identity ? ('existing' as const) : ('conflict' as const)
        this.db.run(
          'INSERT INTO trigger_conversation_actions(thread,request_id,identity) VALUES(?,?,?)',
          [thread, requestId, identity],
        )
        apply()
        return 'applied' as const
      })
      .immediate()
  }

  getActionIdentity(scope: TriggerConversationScope, requestId: string): string | null {
    return (
      this.db
        .query<{ identity: string }, [string, string]>(
          'SELECT identity FROM trigger_conversation_actions WHERE thread = ? AND request_id = ?',
        )
        .get(threadId(scope), requestId)?.identity ?? null
    )
  }
}
