import type { TriggerStore } from '@zero-os/observe'
import type {
  TriggerAgentResult,
  TriggerInboxItem,
  TriggerRouteWork,
  TriggerRoutingSettings,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { type NativePresenceProbe, TriggerPresenceReader } from './native-presence'
import { TRIGGER_PRESENCE_TTL_MS, decideTriggerRoute } from './routing-policy'
import { TriggerWeixinDeliveryError, type createTriggerWeixin } from './weixin-delivery'

interface RoutingDependencies {
  analyze(
    item: TriggerInboxItem,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TriggerAgentResult>
  weixin: ReturnType<typeof createTriggerWeixin>
  onPolicyChange?(): void
  onPresence?(): void
  onWebDelivery?(): void
  nativePresence?: NativePresenceProbe
}

export class TriggerRoutingRuntime {
  private readonly controller = new AbortController()
  private started = false
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private requested = false
  private lastPresenceAt?: Date
  private readonly presenceReader: TriggerPresenceReader

  constructor(
    private readonly store: TriggerStore['routing'],
    private readonly deps: RoutingDependencies,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.presenceReader = new TriggerPresenceReader(deps.nativePresence)
  }

  start() {
    if (this.started || this.controller.signal.aborted) return
    this.store.recoverInterrupted()
    this.started = true
    this.notify()
  }

  async close() {
    this.controller.abort()
    clearTimeout(this.timer)
    await this.running
  }

  getConfig() {
    return this.store.getSettings()
  }

  saveConfig(settings: TriggerRoutingSettings, revision: number) {
    this.store.saveSettings(settings, revision)
    this.presenceReader.reset()
    this.deps.onPolicyChange?.()
    this.notify()
    return this.getConfig()
  }

  listTargets() {
    return this.deps.weixin.listTargets()
  }

  async getPresenceContext(settings: TriggerRoutingSettings) {
    const native =
      settings.enabled && settings.presence !== 'away'
        ? await this.presenceReader.read(
            settings.nativePresence,
            this.now(),
            this.controller.signal,
          )
        : undefined
    return { lastPresenceAt: this.lastPresenceAt, native }
  }

  listRoutes(limit?: number) {
    return this.store.list(limit)
  }

  listWeb(limit?: number) {
    return this.store.listWeb(limit)
  }

  latestWebDeliveryId() {
    return this.store.latestWebDeliveryId()
  }

  heartbeat() {
    const now = this.now()
    const ageMs = this.lastPresenceAt
      ? now.getTime() - this.lastPresenceAt.getTime()
      : Number.POSITIVE_INFINITY
    this.lastPresenceAt = now
    this.deps.onPresence?.()
    if (ageMs >= 0 && ageMs < TRIGGER_PRESENCE_TTL_MS) return
    const { settings } = this.getConfig()
    if (settings.enabled && settings.presence === 'auto') {
      this.store.wakeDeferred(now.toISOString())
      this.notify()
    }
  }

  process(inboxId: number) {
    if (!this.getConfig().settings.enabled) return 'disabled' as const
    const existing = this.store.get(inboxId)
    if (existing && ['web', 'sent', 'uncertain', 'analyzing', 'sending'].includes(existing.status))
      return 'already_processed' as const
    if (!this.store.enqueue(inboxId)) return 'not_found' as const
    if (existing?.status === 'failed') this.store.retry(inboxId)
    this.notify()
    return 'accepted' as const
  }

  /** A committed source batch, rule change, presence transition or due timer wakes one dispatcher. */
  notify() {
    if (!this.started || this.controller.signal.aborted) return
    clearTimeout(this.timer)
    this.requested = true
    if (this.running) return
    this.running = Promise.resolve()
      .then(async () => {
        do {
          this.requested = false
          const batch = this.store.listReady(this.now().toISOString(), 16)
          for (const work of batch) {
            if (this.controller.signal.aborted) return
            await this.handle(work)
          }
          if (batch.length === 16) this.requested = true
        } while (this.requested && !this.controller.signal.aborted)
        const next = this.store.nextDueAt()
        if (next) this.schedule(Date.parse(next) - this.now().getTime())
      })
      .catch(() => {
        console.error('[Trigger Router] Could not advance the delivery queue. Will retry.')
        this.schedule(30_000)
      })
      .finally(() => {
        this.running = undefined
        if (this.requested) this.notify()
      })
  }

  private schedule(delay: number) {
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => this.notify(), Math.min(2_147_483_647, Math.max(1, delay)))
    this.timer.unref?.()
  }

  private async handle({ event, route }: TriggerRouteWork) {
    let agent = route.agent
    if (route.status === 'pending') {
      const sessionId = route.sessionId ?? `trigger-${crypto.randomUUID()}`
      if (!this.store.claimAgent(event.id, sessionId)) return
      try {
        agent = await this.deps.analyze(event, sessionId, this.controller.signal)
      } catch (error) {
        this.store.failAgent(
          event.id,
          sessionId,
          error instanceof TriggerAgentError ? error.message : 'Agent 分析失败，可手动重试。',
        )
        return
      }
      if (!this.store.finishAgent(event.id, sessionId, agent)) return
    }
    if (!agent || this.controller.signal.aborted) return

    // The model may have taken time. Only the latest policy and current authorized target can release a send.
    const { settings, revision } = this.getConfig()
    if (!settings.enabled) return
    const presence = await this.getPresenceContext(settings)
    if (this.controller.signal.aborted || this.getConfig().revision !== revision) return
    const target = settings.weixinTarget
    const available =
      !!target &&
      this.listTargets().some(
        (option) => option.channelId === target.channelId && option.peerId === target.peerId,
      )
    const now = this.now()
    const decision = decideTriggerRoute(
      settings,
      now,
      presence.lastPresenceAt,
      available,
      presence.native,
    )
    if (!this.store.applyDecision(event.id, decision, revision, now.toISOString())) return
    if (decision.destination === 'web') this.deps.onWebDelivery?.()
    if (decision.destination !== 'weixin' || !target) return
    try {
      await this.deps.weixin.send(target, event, agent)
    } catch (error) {
      const known = error instanceof TriggerWeixinDeliveryError
      this.store.failSend(
        event.id,
        known ? error.message : '无法确认微信是否已受理，请核实会话。',
        known ? error.uncertain : true,
      )
      return
    }
    this.store.finishSend(event.id)
  }
}
