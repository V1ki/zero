import type { Database } from 'bun:sqlite'
import {
  type TriggerAgentResult,
  type TriggerInboxItem,
  type TriggerRouteDecision,
  type TriggerRouteRecord,
  type TriggerRouteWork,
  type TriggerRoutingSettings,
  type TriggerRoutingSettingsSnapshot,
  TriggerSettingsConflictError,
  type TriggerWeixinTarget,
} from '@zero-os/shared'

const defaults: TriggerRoutingSettings = {
  enabled: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'auto',
  duringWork: 'web',
  afterWork: 'defer',
  offDay: 'defer',
  awayFallback: 'defer',
  weixinTarget: null,
}

type RouteRow = Omit<
  TriggerRouteRecord,
  'agent' | 'decision' | 'weixinTarget' | 'firstDeferred'
> & {
  agent: string | null
  firstDeferred: string | null
  decision: string | null
  weixinTarget: string | null
}
type WorkRow = RouteRow & Omit<TriggerInboxItem, 'url'> & { url: string | null }

const routeFields = `inbox_id AS inboxId, origin, status, session_id AS sessionId, agent,
  decision, first_deferred AS firstDeferred, settings_revision AS settingsRevision, weixin_target AS weixinTarget,
  error, updated_at AS updatedAt`
const workQuery = `SELECT ${routeFields}, i.id, i.source, i.event_id AS eventId, i.scope,
  i.title, i.summary, i.occurred_at AS occurredAt, i.received_at AS receivedAt, i.url
  FROM trigger_routes JOIN trigger_visible_inbox i ON i.id = trigger_routes.inbox_id`

// Check eligibility again in the write that claims work, since another connection can pause a source.
const enabled =
  "(SELECT json_extract(json, '$.enabled') FROM trigger_route_settings WHERE id = 1) = 1"
const eligible = `(origin = 'manual' OR EXISTS (
  SELECT 1 FROM trigger_inbox src JOIN trigger_streams s ON s.stream = src.stream
  WHERE src.id = trigger_routes.inbox_id)) AND ${enabled}`

// Source baseline replacement revokes prior authorization even if a stream is later re-enabled.
const cancelSubscription = `UPDATE trigger_routes SET status = 'cancelled', due_at = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = '来源已暂停或筛选条件已更改。'
  WHERE origin = 'subscription' AND status IN ('pending','analyzing','ready','deferred','failed')
  AND inbox_id IN (SELECT id FROM trigger_inbox WHERE stream = OLD.stream);`

function decodeRoute({
  agent,
  decision,
  weixinTarget,
  firstDeferred,
  ...fields
}: RouteRow): TriggerRouteRecord {
  return {
    ...fields,
    firstDeferred:
      firstDeferred === null
        ? null
        : (JSON.parse(firstDeferred) as TriggerRouteRecord['firstDeferred']),
    agent: agent === null ? null : (JSON.parse(agent) as TriggerAgentResult),
    decision: decision === null ? null : (JSON.parse(decision) as TriggerRouteDecision),
    weixinTarget: weixinTarget === null ? null : (JSON.parse(weixinTarget) as TriggerWeixinTarget),
  }
}

function decodeWork(row: WorkRow): TriggerRouteWork {
  const { id, source, eventId, scope, title, summary, occurredAt, receivedAt, url, ...route } = row
  const event = { id, source, eventId, scope, title, summary, occurredAt, receivedAt }
  return { event: url === null ? event : { ...event, url }, route: decodeRoute(route) }
}

function nowIso() {
  return new Date().toISOString()
}

export class TriggerRoutingStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_route_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trigger_routes (
        inbox_id INTEGER PRIMARY KEY REFERENCES trigger_inbox(id),
        origin TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT, agent TEXT,
        decision TEXT, settings_revision INTEGER, weixin_target TEXT, due_at TEXT,
        web_id INTEGER, first_deferred TEXT, error TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trigger_routes_due ON trigger_routes(status, due_at);
      CREATE UNIQUE INDEX IF NOT EXISTS trigger_routes_web ON trigger_routes(web_id)
        WHERE web_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trigger_route_cancel_on_unsubscribe AFTER DELETE ON trigger_streams
        BEGIN ${cancelSubscription} END;
      CREATE TRIGGER IF NOT EXISTS trigger_route_cancel_on_new_filter AFTER UPDATE OF started_at ON trigger_streams
        BEGIN ${cancelSubscription} END;
    `)
    db.transaction(() => {
      const hasHistory = db
        .query("SELECT 1 FROM pragma_table_info('trigger_routes') WHERE name = 'first_deferred'")
        .get()
      if (!hasHistory) db.exec('ALTER TABLE trigger_routes ADD COLUMN first_deferred TEXT')
    }).immediate()
    db.run('INSERT OR IGNORE INTO trigger_route_settings VALUES (1, 0, ?)', [
      JSON.stringify(defaults),
    ])
  }

  getSettings(): TriggerRoutingSettingsSnapshot {
    const row = this.db
      .query<{ revision: number; json: string }, []>(
        'SELECT revision, json FROM trigger_route_settings WHERE id = 1',
      )
      .get()
    if (!row) throw new Error('Routing settings are missing')
    return { revision: row.revision, settings: JSON.parse(row.json) as TriggerRoutingSettings }
  }

  saveSettings(settings: TriggerRoutingSettings, expectedRevision: number): number {
    return this.db
      .transaction(() => {
        const current = this.getSettings()
        if (current.revision !== expectedRevision) throw new TriggerSettingsConflictError()
        const json = JSON.stringify(
          settings.retentionDays === undefined && current.settings.retentionDays !== undefined
            ? { ...settings, retentionDays: current.settings.retentionDays }
            : settings,
        )
        if (JSON.stringify(current.settings) === json) return current.revision
        const revision = expectedRevision + 1
        this.db.run('UPDATE trigger_route_settings SET revision = ?, json = ? WHERE id = 1', [
          revision,
          json,
        ])
        this.wakeDeferred(nowIso())
        return revision
      })
      .immediate()
  }

  /** Only an explicit user action may enroll an inbox event received before routing was enabled. */
  enqueue(inboxId: number): boolean {
    return this.db
      .transaction(() => {
        // An event covered by an explicit mandate must retain that mandate's audience even on replay.
        if (
          this.db
            .query(`SELECT 1 FROM trigger_inbox i WHERE i.id=? AND (
            EXISTS(SELECT 1 FROM mandate_matches m WHERE m.inbox_id=i.id) OR
            EXISTS(SELECT 1 FROM mandates d WHERE d.stream=i.stream AND json_extract(d.definition,'$.enabled')=1)
          )`)
            .get(inboxId)
        )
          return false
        const now = nowIso()
        const added = this.db.run(
          `INSERT INTO trigger_routes(inbox_id, origin, updated_at)
           SELECT id, 'manual', ? FROM trigger_visible_inbox WHERE id = ? ON CONFLICT(inbox_id) DO NOTHING`,
          [now, inboxId],
        )
        if (added.changes === 1) return true
        const previous = this.get(inboxId)
        if (!previous) return false
        this.db.run(
          `UPDATE trigger_routes SET origin = 'manual', due_at = CASE WHEN status = 'deferred' THEN ? ELSE due_at END
           WHERE inbox_id = ? AND status IN ('pending','ready','deferred','cancelled','failed')`,
          [now, inboxId],
        )
        if (previous.status === 'cancelled') this.resume(inboxId, 'cancelled')
        return true
      })
      .immediate()
  }

  get(inboxId: number): TriggerRouteRecord | null {
    const row = this.db
      .query<RouteRow, [number]>(
        `SELECT ${routeFields} FROM trigger_routes WHERE inbox_id = ? AND inbox_id NOT IN (SELECT id FROM trigger_retired_inbox)`,
      )
      .get(inboxId)
    return row ? decodeRoute(row) : null
  }

  list(limit = 50, beforeId = Number.MAX_SAFE_INTEGER): TriggerRouteWork[] {
    return this.db
      .query<WorkRow, [number, number]>(
        `${workQuery} WHERE inbox_id < ? ORDER BY inbox_id DESC LIMIT ?`,
      )
      .all(beforeId, Math.max(1, Math.min(200, limit)))
      .map(decodeWork)
  }

  listWeb(limit = 30): TriggerRouteWork[] {
    return this.db
      .query<WorkRow, [number]>(
        `${workQuery} WHERE web_id IS NOT NULL ORDER BY web_id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, limit)))
      .map(decodeWork)
  }

  latestWebDeliveryId(): number | null {
    return (
      this.db
        .query<{ latestId: number | null }, []>(
          'SELECT MAX(web_id) AS latestId FROM trigger_routes',
        )
        .get()?.latestId ?? null
    )
  }

  listReady(now: string, limit = 25): TriggerRouteWork[] {
    return this.db
      .query<WorkRow, [string, number]>(
        `${workQuery} WHERE (status IN ('pending','ready') OR (status = 'deferred' AND due_at <= ?))
       AND ${eligible} ORDER BY inbox_id LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(200, limit)))
      .map(decodeWork)
  }

  nextDueAt(): string | null {
    return (
      this.db
        .query<{ dueAt: string | null }, []>(
          `SELECT MIN(due_at) AS dueAt FROM trigger_routes WHERE status = 'deferred' AND ${eligible}`,
        )
        .get()?.dueAt ?? null
    )
  }

  wakeDeferred(now: string): void {
    this.db.run("UPDATE trigger_routes SET due_at = ? WHERE status = 'deferred' AND due_at > ?", [
      now,
      now,
    ])
  }

  claimAgent(inboxId: number, sessionId: string): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = 'analyzing', session_id = ?, updated_at = ?
      WHERE inbox_id = ? AND status = 'pending' AND ${eligible}`,
        [sessionId, nowIso(), inboxId],
      ).changes === 1
    )
  }

  finishAgent(inboxId: number, sessionId: string, result: TriggerAgentResult): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = 'ready', agent = ?, updated_at = ?
      WHERE inbox_id = ? AND status = 'analyzing' AND session_id = ?`,
        [JSON.stringify(result), nowIso(), inboxId, sessionId],
      ).changes === 1
    )
  }

  failAgent(inboxId: number, sessionId: string, error: string): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = 'failed', error = ?, updated_at = ?
      WHERE inbox_id = ? AND status = 'analyzing' AND session_id = ?`,
        [error, nowIso(), inboxId, sessionId],
      ).changes === 1
    )
  }

  /**
   * For Weixin, true is the caller's exclusive right to send to this revision's target.
   * Terminal deliveries cannot be reclaimed by a second worker or an explicit enqueue.
   */
  applyDecision(
    inboxId: number,
    decision: TriggerRouteDecision,
    expectedRevision: number,
    now: string,
  ): boolean {
    return this.db
      .transaction(() => {
        const { settings, revision } = this.getSettings()
        if (revision !== expectedRevision || !settings.enabled) return false
        const weixin = decision.destination === 'weixin'
        if (weixin && !settings.weixinTarget)
          throw new Error('Weixin delivery needs a configured target')
        if (
          decision.destination === 'defer' &&
          !(Date.parse(decision.recheckAt) > Date.parse(now))
        ) {
          throw new Error('Deferred routing needs a future recheck time')
        }
        const status = weixin ? 'sending' : decision.destination === 'web' ? 'web' : 'deferred'
        return (
          this.db.run(
            `UPDATE trigger_routes SET status = ?, decision = ?, settings_revision = ?,
        weixin_target = ?, due_at = ?, updated_at = ?,
        first_deferred = COALESCE(first_deferred, ?),
        web_id = CASE WHEN ? = 'web' THEN (SELECT COALESCE(MAX(web_id), 0) + 1 FROM trigger_routes) END
        WHERE inbox_id = ? AND (status = 'ready' OR (status = 'deferred' AND due_at <= ?))
        AND ${eligible}`,
            [
              status,
              JSON.stringify(decision),
              revision,
              weixin ? JSON.stringify(settings.weixinTarget) : null,
              decision.destination === 'defer' ? new Date(decision.recheckAt).toISOString() : null,
              now,
              decision.destination === 'defer'
                ? JSON.stringify({ at: now, reason: decision.reason })
                : null,
              status,
              inboxId,
              now,
            ],
          ).changes > 0
        )
      })
      .immediate()
  }

  finishSend(inboxId: number): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = 'sent', updated_at = ?
      WHERE inbox_id = ? AND status = 'sending'`,
        [nowIso(), inboxId],
      ).changes === 1
    )
  }

  failSend(inboxId: number, error: string, uncertain: boolean): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = ?, error = ?, updated_at = ?
      WHERE inbox_id = ? AND status = 'sending'`,
        [uncertain ? 'uncertain' : 'failed', error, nowIso(), inboxId],
      ).changes === 1
    )
  }

  retry(inboxId: number): boolean {
    return this.resume(inboxId, 'failed')
  }

  private resume(inboxId: number, from: 'failed' | 'cancelled'): boolean {
    return (
      this.db.run(
        `UPDATE trigger_routes SET status = CASE WHEN agent IS NULL THEN 'pending' ELSE 'ready' END,
      session_id = CASE WHEN agent IS NOT NULL THEN session_id END,
      error = NULL, updated_at = ? WHERE inbox_id = ? AND status = ? AND ${eligible}`,
        [nowIso(), inboxId, from],
      ).changes === 1
    )
  }

  /** Called only by the sole dispatcher on startup, never when opening a second read connection. */
  recoverInterrupted(): void {
    const now = nowIso()
    this.db
      .transaction(() => {
        this.db.run(
          `UPDATE trigger_routes SET status = 'uncertain', error = ?, updated_at = ?
        WHERE status = 'sending'`,
          ['服务在微信发送确认前中断，请核实投递结果。', now],
        )
        this.db.run(
          `UPDATE trigger_routes SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'analyzing'`,
          ['Agent 分析中断，可手动重试。', now],
        )
      })
      .immediate()
  }
}
