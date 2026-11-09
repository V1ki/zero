import type { Database } from 'bun:sqlite'
import type {
  ChannelMessageReference,
  CommissionOperator,
  RouterDirectReminder,
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerConversationTurn,
} from '@zero-os/shared'
import { TriggerCommissionStore } from './trigger-commission-store'
import { migrateLegacyTaskTurns } from './trigger-task-thread-migration'

/** Internal IM audience threads are deliberately outside the Web API scope. */
export type RouterImScope = `im-${string}`
export type RouterConversationStoreScope = TriggerConversationScope | RouterImScope

function isPersonalScope(scope: RouterConversationStoreScope): scope is 'general' | RouterImScope {
  return scope === 'general' || (typeof scope === 'string' && /^im-[a-f0-9]{64}$/.test(scope))
}

type TurnRow = Omit<TriggerConversationTurn, 'answer' | 'quotedMessage'> & {
  answer: string | null
  referenceJson: string | null
}

interface QueuedImOrigin {
  actor: CommissionOperator
  routingRevision: number
  bindingRevision: number | null
  reference?: ChannelMessageReference
}

type BeginResult =
  | { kind: 'started'; turn: TriggerConversationTurn; attempt: number }
  | { kind: 'existing'; turn: TriggerConversationTurn; newlyQueued?: boolean }
  | { kind: 'busy' | 'conflict' }

const turnColumns =
  "id, request_id AS requestId, question, json_extract(queue_origin, '$.reference') AS referenceJson, answer, CASE WHEN queue_position>0 THEN 'queued' ELSE status END AS status, error, created_at AS createdAt, updated_at AS updatedAt"

function threadId(scope: RouterConversationStoreScope) {
  if (isPersonalScope(scope)) return scope === 'general' ? '0' : scope
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
  const { referenceJson, ...rest } = row
  return {
    ...rest,
    answer: row.answer === null ? null : JSON.parse(row.answer),
    ...(referenceJson && { quotedMessage: JSON.parse(referenceJson) }),
  }
}

function isPreparedDraft(scope: RouterConversationStoreScope, reminder: RouterDirectReminder) {
  return isPersonalScope(scope) && reminder.status === 'draft' && !!reminder.audienceKey?.trim()
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
      if (
        !db
          .query(
            "SELECT 1 FROM pragma_table_info('trigger_conversation_turns') WHERE name='reminder_source_id'",
          )
          .get()
      ) {
        db.exec('ALTER TABLE trigger_conversation_turns ADD COLUMN reminder_source_id INTEGER')
      }
      if (
        !db
          .query(
            "SELECT 1 FROM pragma_table_info('trigger_conversation_turns') WHERE name='queue_position'",
          )
          .get()
      ) {
        db.exec(`ALTER TABLE trigger_conversation_turns ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0;
          DROP INDEX IF EXISTS trigger_thread_pending;`)
      }
      if (
        !db
          .query(
            "SELECT 1 FROM pragma_table_info('trigger_conversation_turns') WHERE name='queue_origin'",
          )
          .get()
      )
        db.exec('ALTER TABLE trigger_conversation_turns ADD COLUMN queue_origin TEXT')
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS trigger_thread_pending ON trigger_conversation_turns(thread)
          WHERE status='pending' AND queue_position=0;
        CREATE INDEX IF NOT EXISTS trigger_waiting_order ON trigger_conversation_turns(queue_position) WHERE queue_position>0;
        CREATE INDEX IF NOT EXISTS trigger_thread_history ON trigger_conversation_turns(thread,id);
        CREATE UNIQUE INDEX IF NOT EXISTS trigger_reminder_source ON trigger_conversation_turns(reminder_source_id)
          WHERE reminder_source_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS trigger_retired_turns(id INTEGER PRIMARY KEY);
        CREATE VIEW IF NOT EXISTS trigger_visible_turns AS SELECT c.* FROM trigger_conversation_turns c
          WHERE c.id NOT IN (SELECT id FROM trigger_retired_turns);`)
      migrateLegacyTaskTurns(db)
    }).immediate()
  }

  private expired(thread: string): boolean {
    if (thread === '0' || thread.startsWith('im-')) return false
    if (thread.startsWith('task-')) {
      return !this.db
        .query(`SELECT 1 FROM mandate_tasks WHERE id=?
        AND id NOT IN (SELECT id FROM trigger_retired_task_threads)`)
        .get(Number(thread.slice(5)))
    }
    return !!this.db.query('SELECT 1 FROM trigger_retired_inbox WHERE id=?').get(thread)
  }

  get(scope: RouterConversationStoreScope, requestId: string): TriggerConversationTurn | null {
    const row = this.db
      .query<TurnRow, [string, string]>(
        `SELECT ${turnColumns} FROM trigger_visible_turns WHERE thread = ? AND request_id = ?`,
      )
      .get(threadId(scope), requestId)
    return row ? decodeTurn(row) : null
  }

  turnIdForSurface(scope: RouterConversationStoreScope, surfaceId: string, replyPrefix: string) {
    return this.db
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM trigger_visible_turns WHERE thread=?1 AND (
        json_extract(answer,'$.generatedUI.messages[0].createSurface.surfaceId')=?2 OR ?3 || id=?2
      ) ORDER BY id DESC LIMIT 1`,
      )
      .get(threadId(scope), surfaceId, replyPrefix)?.id
  }

  /** Latest window (or the previous page), always returned in reading order. */
  list(scope: RouterConversationStoreScope, limit = 50, beforeId = Number.MAX_SAFE_INTEGER) {
    return this.db
      .query<TurnRow, [string, number, number]>(
        `SELECT ${turnColumns} FROM trigger_visible_turns
         WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(threadId(scope), beforeId, Math.min(100, Math.max(1, limit)))
      .reverse()
      .map(decodeTurn)
  }

  /** Filter before applying the page limit, so older related turns remain reachable. */
  listForMatter(
    scope: RouterConversationStoreScope,
    matterId: string,
    limit = 20,
    beforeId = Number.MAX_SAFE_INTEGER,
  ) {
    return this.db
      .query<TurnRow, [string, number, string, number]>(
        `SELECT ${turnColumns} FROM trigger_visible_turns
       WHERE thread=? AND id<? AND EXISTS (
         SELECT 1 FROM json_each(json_extract(answer, '$.matterIds')) WHERE value=?
       ) ORDER BY id DESC LIMIT ?`,
      )
      .all(threadId(scope), beforeId, matterId, Math.min(100, Math.max(1, limit)))
      .reverse()
      .map(decodeTurn)
  }

  begin(
    scope: RouterConversationStoreScope,
    requestId: string,
    question: string,
    retry = false,
    queueWhenBusy: boolean | QueuedImOrigin = false,
  ): BeginResult {
    const thread = threadId(scope)
    return this.db
      .transaction((): BeginResult => {
        if (this.expired(thread) || this.getActionIdentity(scope, requestId) !== null)
          return { kind: 'conflict' }
        const previous = this.get(scope, requestId)
        if (previous) {
          if (previous.question !== question) return { kind: 'conflict' }
          if (previous.status !== 'failed' || previous.answer?.reminder || !retry)
            return { kind: 'existing', turn: previous }
        }

        const busy = this.db
          .query(
            "SELECT id FROM trigger_conversation_turns WHERE thread = ? AND status = 'pending'",
          )
          .get(thread)
        if (busy && !queueWhenBusy) return { kind: 'busy' }

        const now = new Date().toISOString()
        const row = this.db
          .query<
            TurnRow & { attempt: number },
            [string, string, string, string, string, number, string | null]
          >(
            `INSERT INTO trigger_conversation_turns
             (thread, request_id, question, status, attempt, created_at, updated_at, queue_position, queue_origin)
           VALUES (?, ?, ?, 'pending', 1, ?, ?, CASE WHEN ? THEN
             (SELECT COALESCE(max(queue_position), 0)+1 FROM trigger_conversation_turns WHERE queue_position>0) ELSE 0 END, ?)
           ON CONFLICT(thread, request_id) DO UPDATE SET
             status = 'pending', attempt = attempt + 1, error = NULL, updated_at = excluded.updated_at,
             queue_position = excluded.queue_position, queue_origin = excluded.queue_origin
           RETURNING ${turnColumns}, attempt`,
          )
          .get(
            thread,
            requestId,
            question,
            now,
            now,
            busy ? 1 : 0,
            typeof queueWhenBusy === 'object' && (busy || queueWhenBusy.reference)
              ? JSON.stringify(queueWhenBusy)
              : null,
          )
        if (!row) throw new Error('Could not claim the Router turn')
        const { attempt, ...turn } = row
        if (turn.status === 'queued')
          return { kind: 'existing', turn: decodeTurn(turn), newlyQueued: true }
        return { kind: 'started', turn: decodeTurn(turn), attempt }
      })
      .immediate()
  }

  queuedImScopes() {
    return this.db
      .query<{ thread: RouterImScope }, []>(
        'SELECT DISTINCT thread FROM trigger_visible_turns WHERE queue_position>0 AND queue_origin IS NOT NULL',
      )
      .all()
      .map((row) => row.thread)
  }

  /** Claim a saved text turn before invoking the Agent. IM scopes keep their original authority. */
  claimQueuedTurn(imScope?: RouterImScope) {
    const row = this.db
      .query<
        TurnRow & { thread: string; attempt: number; origin: string | null },
        [string | null, string | null]
      >(
        `UPDATE trigger_conversation_turns SET queue_position=0 WHERE id=(
        SELECT q.id FROM trigger_visible_turns q WHERE q.queue_position>0 AND
          ((? IS NULL AND q.queue_origin IS NULL) OR q.thread=?) AND NOT EXISTS (
          SELECT 1 FROM trigger_conversation_turns active WHERE active.thread=q.thread
          AND active.status='pending' AND active.queue_position=0)
        ORDER BY q.queue_position, q.id LIMIT 1
      ) RETURNING ${turnColumns}, thread, attempt, queue_origin AS origin`,
      )
      .get(imScope ?? null, imScope ?? null)
    if (!row) return null
    const { thread, attempt, origin, ...turn } = row
    const scope: TriggerConversationScope =
      imScope || thread === '0'
        ? 'general'
        : thread.startsWith('task-')
          ? `task-${Number(thread.slice(5))}`
          : Number(thread)
    return {
      scope,
      turn: decodeTurn(turn),
      attempt,
      origin: origin ? (JSON.parse(origin) as QueuedImOrigin) : null,
    }
  }

  finish(
    scope: RouterConversationStoreScope,
    requestId: string,
    attempt: number,
    answer: TriggerConversationAnswer,
  ): boolean {
    if (answer.proposalAppliedAt !== undefined)
      throw new Error('A new Router answer cannot confirm its own proposal')
    return this.db
      .transaction(() => {
        const receipt = this.get(scope, requestId)?.answer?.reminder
        if (!receipt && answer.reminder && !isPreparedDraft(scope, answer.reminder))
          throw new Error('A new reminder must be an unsent draft in the main Router conversation')
        // The model can summarize a tool result, but only the transport may author the receipt.
        return (
          this.db.run(
            `UPDATE trigger_conversation_turns SET status = 'completed', answer = ?, updated_at = ?
       WHERE thread = ? AND request_id = ? AND status = 'pending' AND attempt = ?`,
            [
              JSON.stringify(receipt ? { ...answer, reminder: receipt } : answer),
              new Date().toISOString(),
              threadId(scope),
              requestId,
              attempt,
            ],
          ).changes === 1
        )
      })
      .immediate()
  }

  fail(
    scope: RouterConversationStoreScope,
    requestId: string,
    attempt: number,
    error: string,
  ): boolean {
    return this.db
      .transaction(() => {
        const changed = this.db
          .query<{ reminderStatus: string | null }, [string, string, string, string, number]>(
            `UPDATE trigger_conversation_turns SET
          status=CASE WHEN json_type(answer,'$.reminder')='object' THEN 'completed' ELSE 'failed' END,
          error=CASE WHEN json_type(answer,'$.reminder')='object' THEN NULL ELSE ? END, updated_at=?
         WHERE thread=? AND request_id=? AND status='pending' AND attempt=?
         RETURNING json_extract(answer,'$.reminder.status') AS reminderStatus`,
          )
          .get(error, new Date().toISOString(), threadId(scope), requestId, attempt)
        if (changed?.reminderStatus === 'sending')
          this.finishReminder(scope, requestId, {
            status: 'unknown',
            reason: '提醒发出时未能取得平台回执，请先在机器人私聊核对。',
          })
        return changed !== null
      })
      .immediate()
  }

  /** Called by the sole runtime at startup; opening a separate reader must never interrupt a turn. */
  recoverInterrupted() {
    // Sending was claimed before the external call. The platform may have already accepted it.
    this.db
      .transaction(() => {
        const now = new Date().toISOString()
        this.db.run(
          `UPDATE trigger_conversation_turns SET answer = json_set(json_remove(answer,'$.reminder.audienceKey'),
        '$.reminder.status', 'unknown', '$.reminder.reason', ?), updated_at = ?
       WHERE (thread='0' OR thread GLOB 'im-*') AND json_extract(answer,'$.reminder.status')='sending'`,
          ['服务重启时尚未记录平台回执，请先在机器人私聊核对。', now],
        )
        this.db.run(
          `UPDATE trigger_conversation_turns SET
          status=CASE WHEN json_type(answer,'$.reminder')='object' THEN 'completed' ELSE 'failed' END,
          error=CASE WHEN json_type(answer,'$.reminder')='object' THEN NULL ELSE ? END, updated_at=?
         WHERE status='pending' AND queue_position=0`,
          ['服务重启中断了这次回答，可重试此轮对话。', now],
        )
      })
      .immediate()
    migrateLegacyTaskTurns(this.db)
  }

  /** Prepare an old plain answer only once when its user explicitly requests it. */
  attachReminder(
    scope: RouterConversationStoreScope,
    turnRequestId: string,
    reminder: RouterDirectReminder,
  ): boolean {
    return (
      isPreparedDraft(scope, reminder) &&
      this.db.run(
        `UPDATE trigger_conversation_turns SET answer=json_set(answer,'$.reminder',json(?)), updated_at=?
         WHERE thread=? AND request_id=? AND status='completed' AND json_type(answer)='object'
           AND json_type(answer,'$.reminder') IS NULL AND json_type(answer,'$.proposal') IS NULL
           AND json_type(answer,'$.commission') IS NULL AND json_type(answer,'$.investigation') IS NULL
           AND id NOT IN (SELECT id FROM trigger_retired_turns)`,
        [JSON.stringify(reminder), new Date().toISOString(), threadId(scope), turnRequestId],
      ).changes === 1
    )
  }

  /** Claim the draft before calling the platform, even when two clicks have different request IDs. */
  claimReminder(scope: RouterConversationStoreScope, turnRequestId: string): boolean {
    return (
      isPersonalScope(scope) &&
      this.db.run(
        `UPDATE trigger_conversation_turns SET answer=json_set(answer,'$.reminder.status','sending'), updated_at=?
         WHERE thread=? AND request_id=? AND status='completed' AND json_extract(answer,'$.reminder.status')='draft'
           AND id NOT IN (SELECT id FROM trigger_retired_turns)`,
        [new Date().toISOString(), threadId(scope), turnRequestId],
      ).changes === 1
    )
  }

  /** Only the current model attempt may reserve a send; confirmation of an old draft consumes both turns. */
  reserveToolReminder(
    scope: RouterConversationStoreScope,
    turnRequestId: string,
    attempt: number,
    reminder: RouterDirectReminder,
    sourceDraftId?: number,
  ): boolean {
    if (!isPreparedDraft(scope, reminder)) return false
    return this.db
      .transaction(() => {
        const pending = this.db
          .query<{ id: number }, [string, string, number]>(
            "SELECT id FROM trigger_visible_turns WHERE thread=? AND request_id=? AND attempt=? AND status='pending' AND answer IS NULL",
          )
          .get(threadId(scope), turnRequestId, attempt)
        if (!pending) return false
        const now = new Date().toISOString()
        if (sourceDraftId !== undefined) {
          if (
            !Number.isSafeInteger(sourceDraftId) ||
            sourceDraftId < 1 ||
            sourceDraftId >= pending.id
          )
            return false
          const claimed = this.db.run(
            `UPDATE trigger_conversation_turns SET answer=json_set(answer,'$.reminder.status','sending'),updated_at=?
           WHERE id=? AND thread=? AND status='completed' AND id NOT IN (SELECT id FROM trigger_retired_turns)
             AND json_extract(answer,'$.reminder.status')='draft' AND json_extract(answer,'$.reminder.platform')=?
             AND json_extract(answer,'$.reminder.channelId')=? AND json_extract(answer,'$.reminder.text')=?
             AND json_extract(answer,'$.reminder.audienceKey')=?`,
            [
              now,
              sourceDraftId,
              threadId(scope),
              reminder.platform,
              reminder.channelId,
              reminder.text,
              reminder.audienceKey ?? null,
            ],
          )
          if (!claimed.changes) return false
        }
        const { audienceKey: _private, ...details } = reminder
        this.db.run(
          'UPDATE trigger_conversation_turns SET answer=?,reminder_source_id=?,updated_at=? WHERE id=?',
          [
            JSON.stringify({
              text: '请查看机器人的发送回执。',
              reminder: { ...details, status: 'sending' },
            }),
            sourceDraftId ?? null,
            now,
            pending.id,
          ],
        )
        return true
      })
      .immediate()
  }

  finishReminder(
    scope: RouterConversationStoreScope,
    turnRequestId: string,
    outcome: { status: 'accepted' | 'rejected' | 'unknown'; reason?: string },
  ): boolean {
    return (
      isPersonalScope(scope) &&
      this.db.run(
        `WITH sender AS MATERIALIZED (
           SELECT id,reminder_source_id FROM trigger_conversation_turns c WHERE thread=? AND request_id=?
             AND status IN ('pending','completed') AND json_extract(answer,'$.reminder.status')='sending'
             AND NOT EXISTS(SELECT 1 FROM trigger_conversation_turns other WHERE other.reminder_source_id=c.id))
         UPDATE trigger_conversation_turns SET answer=json_patch(answer,?), updated_at=?
         WHERE thread=? AND id IN (SELECT id FROM sender UNION ALL SELECT reminder_source_id FROM sender)
           AND json_extract(answer,'$.reminder.status')='sending'`,
        [
          threadId(scope),
          turnRequestId,
          JSON.stringify({
            reminder: { status: outcome.status, reason: outcome.reason, audienceKey: null },
          }),
          new Date().toISOString(),
          threadId(scope),
        ],
      ).changes > 0
    )
  }

  markProposalApplied(
    scope: RouterConversationStoreScope,
    turnRequestId: string,
    at: string,
  ): void {
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

  /** Save the UI gesture and resulting Agent input atomically, sharing a stable request id. */
  beginAction(
    scope: RouterConversationStoreScope,
    requestId: string,
    identity: string,
    question: string,
  ): BeginResult {
    return this.db
      .transaction((): BeginResult => {
        const previous = this.getActionIdentity(scope, requestId)
        if (previous !== null) {
          const turn = this.get(scope, requestId)
          return previous === identity && turn && turn.question === question
            ? { kind: 'existing', turn }
            : { kind: 'conflict' }
        }
        if (this.get(scope, requestId)) return { kind: 'conflict' }
        const sameButton = this.db
          .query<{ requestId: string }, [string, string]>(
            'SELECT request_id AS requestId FROM trigger_conversation_actions WHERE thread=? AND identity=? LIMIT 1',
          )
          .get(threadId(scope), identity)
        if (sameButton) {
          const turn = this.get(scope, sameButton.requestId)
          return turn && turn.question === question
            ? { kind: 'existing', turn }
            : { kind: 'conflict' }
        }
        const started = this.begin(scope, requestId, question)
        if (started.kind === 'started')
          this.db.run(
            'INSERT INTO trigger_conversation_actions(thread,request_id,identity) VALUES(?,?,?)',
            [threadId(scope), requestId, identity],
          )
        return started
      })
      .immediate()
  }

  /** Persist a local state change and its receipt in the same transaction. */
  applyActionOnce(
    scope: RouterConversationStoreScope,
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

  getActionIdentity(scope: RouterConversationStoreScope, requestId: string): string | null {
    return (
      this.db
        .query<{ identity: string }, [string, string]>(
          'SELECT identity FROM trigger_conversation_actions WHERE thread = ? AND request_id = ?',
        )
        .get(threadId(scope), requestId)?.identity ?? null
    )
  }
}
