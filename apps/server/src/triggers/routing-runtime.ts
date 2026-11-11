import { createHash } from 'node:crypto'
import type { TriggerStore } from '@zero-os/observe'
import {
  type MandatePlatform,
  type MandateTarget,
  type TriggerAgentResult,
  type TriggerInboxItem,
  type TriggerRouteWork,
  type TriggerRoutingBot,
  type TriggerRoutingSettings,
  getTriggerRouteBot,
  isTriggerRoutePlatform,
  sameTriggerRouteTarget,
} from '@zero-os/shared'
import { TriggerAgentError, type TriggerAnalysisContext } from './event-agent'
import type { createMandatePlatforms } from './mandate-platforms'
import type { MandateReceipt } from './mandate-runtime'
import type { MandateTargetOption } from './mandate-service'
import { type NativePresenceProbe, TriggerPresenceReader } from './native-presence'
import { TRIGGER_PRESENCE_TTL_MS, decideTriggerRoute } from './routing-policy'
import { TriggerWeixinDeliveryError, type createTriggerWeixin } from './weixin-delivery'

interface RoutingDependencies {
  analyze(
    item: TriggerInboxItem,
    sessionId: string,
    signal?: AbortSignal,
    context?: TriggerAnalysisContext,
  ): Promise<TriggerAgentResult>
  weixin: Pick<ReturnType<typeof createTriggerWeixin>, 'listTargets' | 'send'>
  personal?: Pick<
    ReturnType<typeof createMandatePlatforms>,
    'listPersonalBots' | 'listPersonalTargets' | 'sendPersonal'
  > &
    Partial<Pick<ReturnType<typeof createMandatePlatforms>, 'sendDirect'>> & {
      listPersonalDirectTargets(): readonly MandateTarget[]
    }
  onPolicyChange?(): void
  onPresence?(): void
  onWebDelivery?(): void
  nativePresence?: NativePresenceProbe
}

type Bot = ReturnType<NonNullable<RoutingDependencies['personal']>['listPersonalBots']>[number]
type BotBinding = ReturnType<TriggerStore['routing']['getPersonalBotBinding']>
type DeliveryState = TriggerRoutingBot['deliveryState']
type BotClaim = { target: MandateTarget; bindingRevision: number | null; automatic: boolean }
export class DirectReminderUnavailableError extends Error {}

/** How far back triage looks for earlier events of the same stream. */
const triageWindowMs = 7 * 86_400_000

/** Program rules the model cannot override: only a subscription route with triage on may be filtered. */
function applyTriageRules(agent: TriggerAgentResult, triage: boolean, manual: boolean) {
  const { triage: judgement, ...result } = agent
  if (!triage || !judgement) return result
  if (judgement.decision === 'skip' && manual)
    return {
      ...result,
      triage: { decision: 'notify' as const, reason: '手动提交的事件不做筛选。' },
    }
  return { ...result, triage: judgement }
}

const directUnavailable: Record<Exclude<DeliveryState, 'ready'>, string> = {
  offline: '所选机器人离线，请在它重新连接后发送。',
  ambiguous: '这个机器人有多个私聊联系人。请改选个人专用的机器人。',
  awaiting_private: '请先给所选机器人发一条私聊消息，再发送提醒。',
  unavailable: '所选机器人当前没有可用的个人私聊。请核对机器人及其私聊状态。',
}

function audienceKey({ target, bindingRevision, automatic }: BotClaim, settingsRevision: number) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.platform,
        target.channelId,
        target.peerId,
        target.operatorId,
        automatic ? null : bindingRevision,
        settingsRevision,
      ]),
    )
    .digest('hex')
}

function resolveBotDelivery(
  bot: Bot,
  binding: BotBinding,
  live: readonly MandateTarget[],
  direct: readonly MandateTarget[],
):
  | { deliveryState: 'ready'; claim: BotClaim }
  | { deliveryState: Exclude<DeliveryState, 'ready'>; claim?: undefined } {
  if (!bot.online) return { deliveryState: 'offline' }
  let target = binding?.target
  if (!binding || binding.automatic) {
    const candidates = direct.filter(
      (t) => t.platform === bot.platform && t.channelId === bot.channelId,
    )
    if (candidates.length > 1) return { deliveryState: 'ambiguous' }
    if (target && !sameTriggerRouteTarget(target, candidates[0]))
      return { deliveryState: 'unavailable' }
    target = candidates[0]
    if (!target) return { deliveryState: 'awaiting_private' }
  }
  // Explicit revocations and lost pins never fall through to another recipient.
  if (
    !target?.peerId ||
    !target.operatorId ||
    !live.some((entry) => sameTriggerRouteTarget(entry, target))
  ) {
    return { deliveryState: 'unavailable' }
  }
  return {
    deliveryState: 'ready',
    claim: {
      target,
      bindingRevision: binding?.revision ?? null,
      automatic: binding?.automatic ?? false,
    },
  }
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

  listPersonalTargets(): MandateTargetOption[] {
    return (
      this.deps.personal?.listPersonalTargets() ??
      this.listTargets().map((target) => ({
        ...target,
        platform: 'weixin',
        operatorId: target.peerId,
      }))
    )
  }

  private personalEndpoints(privateOnly = false) {
    const live = this.listPersonalTargets()
    const direct = this.deps.personal?.listPersonalDirectTargets() ?? []
    const eligible = privateOnly
      ? live.filter((t) => direct.some((d) => sameTriggerRouteTarget(t, d)))
      : live
    const bots =
      this.deps.personal?.listPersonalBots() ??
      Array.from(new Set(live.map((target) => target.channelId)), (channelId) => ({
        platform: 'weixin' as const,
        channelId,
        label: channelId,
        online: true,
      }))
    return bots.map((bot) => ({
      bot,
      ...resolveBotDelivery(
        bot,
        this.store.getPersonalBotBinding(bot.platform, bot.channelId),
        eligible,
        direct,
      ),
    }))
  }

  listPersonalBots(): TriggerRoutingBot[] {
    return this.personalEndpoints().map(({ bot, deliveryState }) => ({
      ...bot,
      ready: deliveryState === 'ready',
      deliveryState,
    }))
  }

  getBotBindings() {
    return this.store.getBotBindings()
  }

  saveBotBinding(
    platform: MandatePlatform,
    channelId: string,
    target: MandateTarget | null,
    revision: number,
  ) {
    const saved = this.store.saveBotBinding(platform, channelId, target, revision)
    this.deps.onPolicyChange?.()
    this.notify()
    return saved
  }

  private selectedClaims(settings: TriggerRoutingSettings) {
    const claims = new Map<MandatePlatform, BotClaim>()
    for (const { bot, claim } of this.personalEndpoints()) {
      if (claim && getTriggerRouteBot(settings, bot.platform) === bot.channelId) {
        claims.set(bot.platform, claim)
      }
    }
    return claims
  }

  isPersonalTarget(target: MandateTarget): boolean {
    const { settings } = this.getConfig()
    return (
      settings.enabled &&
      sameTriggerRouteTarget(this.selectedClaims(settings).get(target.platform)?.target, target)
    )
  }

  private selectedDirectClaim(target: MandateTarget) {
    if (getTriggerRouteBot(this.getConfig().settings, target.platform) !== target.channelId)
      return undefined
    const endpoint = this.personalEndpoints(true).find(
      ({ bot }) => bot.platform === target.platform && bot.channelId === target.channelId,
    )
    return endpoint?.claim && sameTriggerRouteTarget(endpoint.claim.target, target)
      ? endpoint.claim
      : undefined
  }

  isSelectedDirectTarget(target: MandateTarget): boolean {
    return !!this.selectedDirectClaim(target)
  }

  /** Pin the verified private recipient and fence an in-flight conversation against rebinding. */
  claimRouterImTarget(target: MandateTarget): (() => boolean) | null {
    const revision = this.getConfig().revision
    const claim = this.selectedDirectClaim(target)
    if (!claim || this.controller.signal.aborted) return null
    const pin = this.store.claimDirectBotBinding(target, claim.bindingRevision, revision)
    if (pin === null) return null
    return () =>
      !this.controller.signal.aborted &&
      this.getConfig().revision === revision &&
      this.selectedDirectClaim(target)?.bindingRevision === pin
  }

  private directRecipient(platform: MandatePlatform) {
    const { settings, revision } = this.getConfig()
    const channelId = getTriggerRouteBot(settings, platform)
    if (!channelId)
      throw new DirectReminderUnavailableError('请先在 Router 设置中选择这个平台的机器人。')
    const selected = this.personalEndpoints(true).find(
      ({ bot }) => bot.platform === platform && bot.channelId === channelId,
    )
    if (!selected || !this.deps.personal?.sendDirect)
      throw new DirectReminderUnavailableError('所选机器人尚未接入。请在 Router 设置中重新选择。')
    if (selected.deliveryState !== 'ready')
      throw new DirectReminderUnavailableError(directUnavailable[selected.deliveryState])
    return { bot: selected.bot, claim: selected.claim, revision }
  }

  prepareDirectReminder(platform: MandatePlatform) {
    const { bot, claim, revision } = this.directRecipient(platform)
    return { channelId: bot.channelId, label: bot.label, audienceKey: audienceKey(claim, revision) }
  }

  async sendDirectReminder(
    platform: MandatePlatform,
    prepared: { channelId: string; audienceKey: string },
    text: string,
    deliveryId: string,
    signal: AbortSignal,
    originAuthorized: () => boolean = () => true,
  ): Promise<MandateReceipt> {
    const cancelled = {
      status: 'rejected' as const,
      reason: '机器人、私聊授权或通知设置已变更，请重新提出提醒。',
    }
    const send = this.deps.personal?.sendDirect
    const operation = AbortSignal.any([signal, this.controller.signal])
    if (!text.trim() || !deliveryId.trim() || operation.aborted || !send || !originAuthorized())
      return cancelled
    let selected: ReturnType<TriggerRoutingRuntime['directRecipient']>
    try {
      selected = this.directRecipient(platform)
    } catch (error) {
      if (error instanceof DirectReminderUnavailableError)
        return { status: 'rejected', reason: error.message }
      throw error
    }
    const { bot, claim, revision } = selected
    if (
      bot.channelId !== prepared.channelId ||
      audienceKey(claim, revision) !== prepared.audienceKey
    )
      return cancelled
    const pinned = this.store.claimDirectBotBinding(claim.target, claim.bindingRevision, revision)
    if (pinned === null) return cancelled
    // A first send creates the pin. From now on even an address changed away and back is stale.
    const maySend = () =>
      !operation.aborted &&
      originAuthorized() &&
      this.getConfig().revision === revision &&
      this.personalEndpoints(true).some(
        ({ claim: current }) =>
          current?.bindingRevision === pinned &&
          sameTriggerRouteTarget(current.target, claim.target),
      )
    if (!maySend()) return cancelled
    try {
      return await send(claim.target, text, deliveryId, operation, maySend)
    } catch {
      return { status: 'unknown', reason: '未能确认平台回执，请先在机器人私聊中核对。' }
    }
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

  private evaluateRoute(
    settings: TriggerRoutingSettings,
    presence: Awaited<ReturnType<TriggerRoutingRuntime['getPresenceContext']>>,
  ) {
    const claims = this.selectedClaims(settings)
    const now = this.now()
    const decision = decideTriggerRoute(
      settings,
      now,
      presence.lastPresenceAt,
      Object.fromEntries(Array.from(claims.keys(), (platform) => [platform, true])),
      presence.native,
    )
    return { decision, claims, now }
  }

  async previewCurrentRoute() {
    const { settings, revision } = this.getConfig()
    const presence = await this.getPresenceContext(settings)
    if (this.getConfig().revision !== revision) throw new Error('通知设置刚刚变更，请重新查询。')
    return this.evaluateRoute(settings, presence).decision
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
      const triage = this.getConfig().settings.triage !== false
      const context = triage
        ? {
            previous: this.store.listRecentInStream(
              event.id,
              new Date(Date.parse(event.receivedAt) - triageWindowMs).toISOString(),
            ),
          }
        : undefined
      if (!this.store.claimAgent(event.id, sessionId)) return
      let result: TriggerAgentResult
      try {
        result = await this.deps.analyze(event, sessionId, this.controller.signal, context)
      } catch (error) {
        this.store.failAgent(
          event.id,
          sessionId,
          error instanceof TriggerAgentError ? error.message : 'Agent 分析失败，可手动重试。',
        )
        return
      }
      agent = applyTriageRules(result, triage, route.origin === 'manual')
      if (agent.triage?.decision === 'skip') {
        // Filtered is terminal: nothing is routed or delivered, not even to the Web.
        if (this.store.filterAgent(event.id, sessionId, agent)) return
        // A manual request or turning triage off won the race. Continue as without triage.
        agent = applyTriageRules(agent, false, false)
      }
      if (!this.store.finishAgent(event.id, sessionId, agent)) return
    }
    if (!agent || this.controller.signal.aborted) return

    // The model may have taken time. Only the latest policy and current authorized target can release a send.
    const { settings, revision } = this.getConfig()
    if (!settings.enabled) return
    const presence = await this.getPresenceContext(settings)
    if (this.controller.signal.aborted || this.getConfig().revision !== revision) return
    const { decision, claims, now } = this.evaluateRoute(settings, presence)
    const claim = isTriggerRoutePlatform(decision.destination)
      ? claims.get(decision.destination)
      : undefined
    if (!this.store.applyDecision(event.id, decision, revision, now.toISOString(), claim)) {
      if (claim) this.requested = true
      return
    }
    if (decision.destination === 'web') this.deps.onWebDelivery?.()
    if (decision.destination === 'web' || decision.destination === 'defer') return
    const target = this.store.get(event.id)?.deliveryTarget
    let denied = false
    const maySend = () => {
      if (
        !target ||
        this.controller.signal.aborted ||
        !this.store.maySend(event.id, revision) ||
        !this.isPersonalTarget(target)
      )
        denied = true
      return !denied
    }
    const releaseUnsent = () => {
      if (this.store.releaseUnsent(event.id)) this.requested = true
    }
    try {
      // The claim pins the actual recipient. A different binding can only take effect
      // through a fresh routing decision after an unstarted send has been released.
      if (!target || !maySend()) {
        releaseUnsent()
        return
      }
      if (decision.destination === 'weixin') {
        // iLink validates its bound context and starts the single send synchronously.
        await this.deps.weixin.send(
          { channelId: target.channelId, peerId: target.peerId },
          event,
          agent,
        )
      } else {
        if (!this.deps.personal) {
          this.store.failSend(event.id, '所选通知渠道当前不可用。', false)
          return
        }
        const result = await this.deps.personal.sendPersonal(
          target,
          event,
          agent,
          this.controller.signal,
          maySend,
        )
        if (result.status === 'rejected' && (denied || result.authorizationLost)) {
          releaseUnsent()
          return
        }
        if (result.status !== 'accepted') {
          this.store.failSend(event.id, result.reason, result.status === 'unknown')
          return
        }
      }
    } catch (error) {
      const known = error instanceof TriggerWeixinDeliveryError
      this.store.failSend(
        event.id,
        known ? error.message : '无法确认平台是否已受理，请核实所选会话。',
        known ? error.uncertain : true,
      )
      return
    }
    this.store.finishSend(event.id)
  }
}
