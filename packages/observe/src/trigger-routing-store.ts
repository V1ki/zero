import type { Database } from 'bun:sqlite'
import {
  type MandatePlatform,
  type MandateTarget,
  type TriggerAgentResult,
  type TriggerBotBindingsSnapshot,
  type TriggerInboxItem,
  type TriggerRouteDecision,
  type TriggerRouteRecord,
  type TriggerRouteWork,
  type TriggerRoutingSettings,
  type TriggerRoutingSettingsSnapshot,
  TriggerSettingsConflictError,
  type TriggerWeixinTarget,
  getTriggerRouteBot,
  isTriggerRoutePlatform,
  sameTriggerRouteTarget,
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
  'agent' | 'decision' | 'weixinTarget' | 'deliveryTarget' | 'firstDeferred'
> & {
  agent: string | null
  firstDeferred: string | null
  decision: string | null
  weixinTarget: string | null
  deliveryTarget: string | null
}
type WorkRow = RouteRow & Omit<TriggerInboxItem, 'url'> & { url: string | null }
type BotBindingRow = { target: string | null; revision: number; automatic: number }

function encodeTarget({ platform, channelId, peerId, operatorId }: MandateTarget) {
  return JSON.stringify({ platform, channelId, peerId, operatorId })
}

function legacyWeixinTarget(value: TriggerWeixinTarget | null): MandateTarget | null {
  return value && { ...value, platform: 'weixin', operatorId: value.peerId }
}

const routeFields = `inbox_id AS inboxId, origin, status, session_id AS sessionId, agent,
  decision, first_deferred AS firstDeferred, settings_revision AS settingsRevision, weixin_target AS weixinTarget,
  delivery_target AS deliveryTarget, error, updated_at AS updatedAt`
const workQuery = `SELECT ${routeFields}, i.id, i.source, i.event_id AS eventId, i.scope,
  i.title, i.summary, i.occurred_at AS occurredAt, i.received_at AS receivedAt, i.url
  FROM trigger_routes JOIN trigger_visible_inbox i ON i.id = trigger_routes.inbox_id`

// Check eligibility again in the write that claims work, since another connection can pause a source.
const enabled =
  "(SELECT json_extract(json, '$.enabled') FROM trigger_route_settings WHERE id = 1) = 1"
const subscribed = `(origin = 'manual' OR EXISTS (
  SELECT 1 FROM trigger_inbox src JOIN trigger_streams s ON s.stream = src.stream
  WHERE src.id = trigger_routes.inbox_id))`
const eligible = `${subscribed} AND ${enabled}`
const hasMandate = `(EXISTS(SELECT 1 FROM mandate_matches m WHERE m.inbox_id=i.id) OR
  EXISTS(SELECT 1 FROM mandates d WHERE d.stream=i.stream AND json_extract(d.definition,'$.enabled')=1))`
const authorizedClaim = `send_source_revoked=0 AND ${subscribed} AND NOT EXISTS(
  SELECT 1 FROM trigger_inbox i WHERE i.id=trigger_routes.inbox_id AND ${hasMandate})`

// Source baseline replacement revokes prior authorization even if a stream is later re-enabled.
const cancelSubscription = `UPDATE trigger_routes SET status = 'cancelled', due_at = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = '来源已暂停或筛选条件已更改。'
  WHERE origin = 'subscription' AND status IN ('pending','analyzing','ready','deferred','failed')
  AND inbox_id IN (SELECT id FROM trigger_inbox WHERE stream = OLD.stream);
  UPDATE trigger_routes SET send_source_revoked=1 WHERE origin='subscription' AND status='sending'
  AND inbox_id IN (SELECT id FROM trigger_inbox WHERE stream = OLD.stream);`

function decodeRoute({
  agent,
  decision,
  weixinTarget,
  deliveryTarget,
  firstDeferred,
  ...fields
}: RouteRow): TriggerRouteRecord {
  const weixin = weixinTarget === null ? null : (JSON.parse(weixinTarget) as TriggerWeixinTarget)
  return {
    ...fields,
    firstDeferred:
      firstDeferred === null
        ? null
        : (JSON.parse(firstDeferred) as TriggerRouteRecord['firstDeferred']),
    agent: agent === null ? null : (JSON.parse(agent) as TriggerAgentResult),
    decision: decision === null ? null : (JSON.parse(decision) as TriggerRouteDecision),
    weixinTarget: weixin,
    deliveryTarget:
      deliveryTarget === null
        ? legacyWeixinTarget(weixin)
        : (JSON.parse(deliveryTarget) as MandateTarget),
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
        decision TEXT, settings_revision INTEGER, weixin_target TEXT, delivery_target TEXT, due_at TEXT,
        web_id INTEGER, first_deferred TEXT, error TEXT, updated_at TEXT NOT NULL,
        send_source_revoked INTEGER NOT NULL DEFAULT 0, send_binding_revision INTEGER
      );
      CREATE INDEX IF NOT EXISTS trigger_routes_due ON trigger_routes(status, due_at);
      CREATE UNIQUE INDEX IF NOT EXISTS trigger_routes_web ON trigger_routes(web_id)
        WHERE web_id IS NOT NULL;
    `)
    db.transaction(() => {
      const columns = db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('trigger_routes')")
        .all()
      for (const name of ['first_deferred', 'delivery_target']) {
        if (!columns.some((column) => column.name === name))
          db.exec(`ALTER TABLE trigger_routes ADD COLUMN ${name} TEXT`)
      }
      if (!columns.some((column) => column.name === 'send_source_revoked')) {
        db.exec(`ALTER TABLE trigger_routes ADD COLUMN send_source_revoked INTEGER NOT NULL DEFAULT 0;
          DROP TRIGGER IF EXISTS trigger_route_cancel_on_unsubscribe;
          DROP TRIGGER IF EXISTS trigger_route_cancel_on_new_filter;`)
      }
      if (!columns.some((column) => column.name === 'send_binding_revision'))
        db.exec('ALTER TABLE trigger_routes ADD COLUMN send_binding_revision INTEGER')
      // Import the pre-existing Weixin address only when introducing the channel registry.
      // Subsequent unbinding remains authoritative even when the legacy setting still exists.
      if (
        !db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trigger_route_bot_bindings'",
          )
          .get()
      ) {
        db.exec(`CREATE TABLE trigger_route_bot_bindings (
          platform TEXT NOT NULL, channel_id TEXT NOT NULL, target TEXT, revision INTEGER NOT NULL,
          automatic INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(platform, channel_id)
        )`)
        const row = db
          .query<{ json: string }, []>('SELECT json FROM trigger_route_settings WHERE id=1')
          .get()
        const previous = row && (JSON.parse(row.json) as TriggerRoutingSettings).weixinTarget
        if (previous)
          this.writeBotBinding('weixin', previous.channelId, legacyWeixinTarget(previous))
      } else if (
        !db
          .query(
            "SELECT 1 FROM pragma_table_info('trigger_route_bot_bindings') WHERE name='automatic'",
          )
          .get()
      ) {
        db.exec(
          'ALTER TABLE trigger_route_bot_bindings ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0',
        )
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trigger_route_cancel_on_unsubscribe AFTER DELETE ON trigger_streams
          BEGIN ${cancelSubscription} END;
        CREATE TRIGGER IF NOT EXISTS trigger_route_cancel_on_new_filter AFTER UPDATE OF started_at ON trigger_streams
          BEGIN ${cancelSubscription} END;
      `)
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

  private bindingsRevision(): number {
    const row = this.db
      .query<{ revision: number }, []>(
        'SELECT COALESCE(MAX(revision), 0) AS revision FROM trigger_route_bot_bindings',
      )
      .get()
    if (!row) throw new Error('Bot binding revision is missing')
    return row.revision
  }

  getBotBindings(): TriggerBotBindingsSnapshot {
    // Both the global revision and the list of addresses must represent the same snapshot.
    return this.db.transaction(() => ({
      revision: this.bindingsRevision(),
      targets: this.db
        .query<{ target: string }, []>(
          'SELECT target FROM trigger_route_bot_bindings WHERE target IS NOT NULL ORDER BY platform, channel_id',
        )
        .all()
        .map((row) => JSON.parse(row.target) as MandateTarget),
    }))()
  }

  getPersonalBotBinding(platform: MandatePlatform, channelId: string) {
    const row = this.db
      .query<BotBindingRow, [string, string]>(
        'SELECT target, revision, automatic FROM trigger_route_bot_bindings WHERE platform=? AND channel_id=?',
      )
      .get(platform, channelId)
    return (
      row && {
        target: row.target ? (JSON.parse(row.target) as MandateTarget) : null,
        revision: row.revision,
        automatic: row.automatic === 1,
      }
    )
  }

  resolveBotTarget(
    settings: TriggerRoutingSettings,
    platform: MandatePlatform,
  ): MandateTarget | null {
    const channelId = getTriggerRouteBot(settings, platform)
    return channelId ? (this.getPersonalBotBinding(platform, channelId)?.target ?? null) : null
  }

  private insertAutomaticBinding(target: MandateTarget, revision: number) {
    this.db.run(
      'INSERT INTO trigger_route_bot_bindings(platform,channel_id,target,revision,automatic) VALUES(?,?,?,?,1)',
      [target.platform, target.channelId, encodeTarget(target), revision],
    )
  }

  /** Pin a verified private recipient only when the user has authorized an actual send. */
  claimDirectBotBinding(
    target: MandateTarget,
    bindingRevision: number | null,
    settingsRevision: number,
  ) {
    return this.db
      .transaction(() => {
        const config = this.getSettings()
        if (
          config.revision !== settingsRevision ||
          getTriggerRouteBot(config.settings, target.platform) !== target.channelId
        )
          return null
        const current = this.getPersonalBotBinding(target.platform, target.channelId)
        if (current)
          return (current.revision === bindingRevision ||
            (bindingRevision === null && current.automatic)) &&
            sameTriggerRouteTarget(current.target, target)
            ? current.revision
            : null
        if (bindingRevision !== null || !target.peerId || !target.operatorId) return null
        const revision = this.bindingsRevision() + 1
        this.insertAutomaticBinding(target, revision)
        return revision
      })
      .immediate()
  }

  /** Caller holds a write transaction. Null addresses remain as revisioned tombstones. */
  private writeBotBinding(
    platform: MandatePlatform,
    channelId: string,
    target: MandateTarget | null,
  ) {
    if (target && (target.platform !== platform || target.channelId !== channelId))
      throw new Error('投递目标和机器人账号不匹配。')
    const previous = this.getPersonalBotBinding(platform, channelId)
    if (previous && !previous.automatic && sameTriggerRouteTarget(previous.target, target))
      return false
    this.db.run(
      `INSERT INTO trigger_route_bot_bindings(platform,channel_id,target,revision) VALUES(?,?,?,?)
       ON CONFLICT(platform,channel_id) DO UPDATE SET target=excluded.target,revision=excluded.revision,automatic=0`,
      [platform, channelId, target ? encodeTarget(target) : null, this.bindingsRevision() + 1],
    )
    return true
  }

  saveBotBinding(
    platform: MandatePlatform,
    channelId: string,
    target: MandateTarget | null,
    expectedRevision: number,
  ): TriggerBotBindingsSnapshot {
    return this.db
      .transaction(() => {
        if (expectedRevision !== this.bindingsRevision()) throw new TriggerSettingsConflictError()
        if (this.writeBotBinding(platform, channelId, target)) {
          const { settings } = this.getSettings()
          const selected = getTriggerRouteBot(settings, platform)
          if (platform === 'weixin' && settings.weixinTarget?.channelId === channelId) {
            // Keep the legacy editor's address and its CAS token in the same transaction.
            // Clearing the address does not deselect the bot inherited by the modern Router.
            const updated = {
              ...settings,
              ...(!target &&
                settings.personalBots?.weixin === undefined && {
                  personalBots: { ...settings.personalBots, weixin: channelId },
                }),
              weixinTarget: target ? { channelId, peerId: target.peerId } : null,
            }
            this.db.run(
              'UPDATE trigger_route_settings SET json=?, revision=revision+1 WHERE id=1',
              [JSON.stringify(updated)],
            )
          }
          if (selected === channelId) this.wakeDeferred(nowIso())
        }
        return this.getBotBindings()
      })
      .immediate()
  }

  saveSettings(settings: TriggerRoutingSettings, expectedRevision: number): number {
    return this.db
      .transaction(() => {
        const current = this.getSettings()
        if (current.revision !== expectedRevision) throw new TriggerSettingsConflictError()
        // Older clients omit newer settings. An explicit null still clears a selected recipient.
        const next = {
          ...settings,
          retentionDays:
            settings.retentionDays === undefined
              ? current.settings.retentionDays
              : settings.retentionDays,
          personalBots:
            settings.personalBots === undefined
              ? current.settings.personalBots
              : { ...current.settings.personalBots, ...settings.personalBots },
        }
        const previousTarget = legacyWeixinTarget(current.settings.weixinTarget)
        const newTarget = legacyWeixinTarget(settings.weixinTarget)
        if (!sameTriggerRouteTarget(previousTarget, newTarget)) {
          if (newTarget) this.writeBotBinding('weixin', newTarget.channelId, newTarget)
          if (!newTarget && previousTarget)
            this.writeBotBinding('weixin', previousTarget.channelId, null)
          // Old editors may either omit personalBots or echo the map unchanged from GET.
          if (
            next.personalBots?.weixin !== undefined &&
            (settings.personalBots?.weixin === undefined ||
              settings.personalBots.weixin === current.settings.personalBots?.weixin)
          )
            next.personalBots = { ...next.personalBots, weixin: newTarget?.channelId ?? null }
        }
        const json = JSON.stringify(next)
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
          this.db.query(`SELECT 1 FROM trigger_inbox i WHERE i.id=? AND ${hasMandate}`).get(inboxId)
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
   * For an IM channel, true is the caller's exclusive claim for this revision's target.
   * Terminal deliveries cannot be reclaimed by a second worker or an explicit enqueue.
   */
  applyDecision(
    inboxId: number,
    decision: TriggerRouteDecision,
    expectedRevision: number,
    now: string,
    claim?: { target: MandateTarget; bindingRevision: number | null },
  ): boolean {
    return this.db
      .transaction(() => {
        const { settings, revision } = this.getSettings()
        if (revision !== expectedRevision || !settings.enabled) return false
        const { destination } = decision
        const external = isTriggerRoutePlatform(destination)
        const bot = external ? getTriggerRouteBot(settings, destination) : null
        const binding = bot && external ? this.getPersonalBotBinding(destination, bot) : null
        if (
          claim &&
          (claim.target.platform !== destination ||
            claim.target.channelId !== bot ||
            !claim.target.peerId ||
            !claim.target.operatorId ||
            (binding?.revision ?? null) !== claim.bindingRevision ||
            (binding && !sameTriggerRouteTarget(binding.target, claim.target)))
        )
          return false
        const target = binding?.target ?? claim?.target
        if (external && !target) return false
        const encoded = target ? encodeTarget(target) : null
        const bindingRevision = binding?.revision ?? (claim ? this.bindingsRevision() + 1 : null)
        if (
          decision.destination === 'defer' &&
          !(Date.parse(decision.recheckAt) > Date.parse(now))
        ) {
          throw new Error('Deferred routing needs a future recheck time')
        }
        const status = external ? 'sending' : decision.destination === 'web' ? 'web' : 'deferred'
        const applied =
          this.db.run(
            `UPDATE trigger_routes SET status = ?, decision = ?, settings_revision = ?,
        weixin_target = ?, delivery_target = ?, send_binding_revision=?, due_at = ?, updated_at = ?, send_source_revoked=0,
        first_deferred = COALESCE(first_deferred, ?),
        web_id = CASE WHEN ? = 'web' THEN (SELECT COALESCE(MAX(web_id), 0) + 1 FROM trigger_routes) END
        WHERE inbox_id = ? AND (status = 'ready' OR (status = 'deferred' AND due_at <= ?))
        AND ${eligible}`,
            [
              status,
              JSON.stringify(decision),
              revision,
              target?.platform === 'weixin'
                ? JSON.stringify({ channelId: target.channelId, peerId: target.peerId })
                : null,
              encoded,
              bindingRevision,
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
        // Only a successful claim learns an address. Both writes use the same immediate
        // transaction so a concurrent claim, manual override or revoke cannot replace it.
        if (applied && !binding && claim && bindingRevision !== null)
          this.insertAutomaticBinding(claim.target, bindingRevision)
        return applied
      })
      .immediate()
  }

  /** Recheck authorization after token lookup and immediately before the external request. */
  maySend(inboxId: number, routingRevision: number): boolean {
    return !!this.db
      .query(
        `SELECT 1 FROM trigger_routes WHERE inbox_id=? AND status='sending' AND ${authorizedClaim}
        AND ${enabled} AND settings_revision=? AND settings_revision=(SELECT revision FROM trigger_route_settings WHERE id=1)
        AND EXISTS (SELECT 1 FROM trigger_route_bot_bindings b
          WHERE b.platform=json_extract(delivery_target,'$.platform') AND b.channel_id=json_extract(delivery_target,'$.channelId')
            AND b.revision=send_binding_revision AND b.target IS NOT NULL)`,
      )
      .get(inboxId, routingRevision)
  }

  /** Only for a confirmed pre-request stop. Unknown platform receipts keep their original claim. */
  releaseUnsent(inboxId: number): boolean {
    return this.db
      .transaction(() => {
        const claim = this.db
          .query<{ authorized: number }, [number]>(
            `SELECT (${authorizedClaim}) AS authorized FROM trigger_routes WHERE inbox_id=? AND status='sending'`,
          )
          .get(inboxId)
        if (!claim) return false
        return (
          this.db.run(
            `UPDATE trigger_routes SET status=?, error=?, updated_at=?, weixin_target=NULL, delivery_target=NULL,
          decision=NULL, settings_revision=NULL, send_binding_revision=NULL WHERE inbox_id=? AND status='sending'`,
            [
              claim.authorized ? 'ready' : 'cancelled',
              claim.authorized ? null : '监听来源或委托授权已变更，已撤销投递。',
              nowIso(),
              inboxId,
            ],
          ).changes === 1
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
          ['服务在渠道确认发送前中断，请核实投递结果。', now],
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
