import { createHash } from 'node:crypto'
import type { TriggerStore } from '@zero-os/observe'
import type {
  MandateArchive,
  MandateTarget,
  MandateWork,
  TriggerAgentResult,
  TriggerInboxItem,
  TriggerNativePresence,
  TriggerRoutingSettings,
} from '@zero-os/shared'
import { TriggerAgentError, type TriggerMandateAnalysisContext } from './event-agent'
import { githubEventSubject } from './investigation'
import { decideMandateNotification } from './mandate-policy'
import { TRIGGER_PRESENCE_TTL_MS } from './routing-policy'

export interface MandateDelivery {
  /** Stable across definite failures and retries of the same authorized effect. */
  id: string
  digest: boolean
  entries: { taskId: number; matchId: number; inboxId: number; title: string; summary: string }[]
}

export type MandateReceipt =
  | { status: 'accepted'; receipt?: string }
  | { status: 'rejected' | 'unknown'; reason: string }

export interface MandatePlatforms {
  listTargets(): readonly MandateTarget[]
  send(
    target: MandateTarget,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean,
  ): Promise<MandateReceipt>
  archive(
    target: MandateArchive,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean,
  ): Promise<MandateReceipt>
}

interface MandateDependencies {
  analyze(
    item: TriggerInboxItem,
    sessionId: string,
    signal: AbortSignal,
    context: TriggerMandateAnalysisContext,
  ): Promise<TriggerAgentResult>
  platforms: MandatePlatforms
  getPresenceContext?(settings: TriggerRoutingSettings): Promise<{
    lastPresenceAt?: Date
    native?: TriggerNativePresence
  }>
}

type EffectKind = 'archive' | 'notify'
type PolicyVersion = { mandateRevision: number; routingRevision: number }

function keyForTarget(target: MandateTarget | MandateArchive | null) {
  if (!target) return []
  return 'platform' in target
    ? [target.platform, target.channelId, target.peerId, target.operatorId ?? null]
    : [target.channelId, target.documentId]
}

/** Only adapter event identifiers and the configured repository may enter a fixed reminder. */
function directReminder({ event, mandate }: MandateWork): string {
  if (event.source === 'wxarc') return '已订阅的微信会话有一条匹配的文字消息。'
  const repo = mandate.scope.slice(0, 148)
  const subject = githubEventSubject(event)
  if (subject?.kind === 'run')
    return `${repo} 的工作流运行 #${subject.run} 第 ${subject.attempt} 次尝试失败。`
  if (subject?.kind === 'issue') return `${repo} 的 Issue 收到了一条新评论。`
  if (subject?.kind === 'pull' && event.githubCommentKind && !event.githubCommentMention)
    return `${repo} 的 PR 收到了一条新评论。`
  if (subject?.kind === 'pull')
    return `${repo} 的 PR 讨论评论 #${subject.comment} 提到了订阅中指定的账号。`
  if (event.eventId.startsWith('ci:')) return `${repo} 收到一条匹配的 CI 失败报告。`
  return `${repo} 收到一条符合监听条件的 GitHub 事件。`
}

function buildDelivery(
  kind: EffectKind,
  target: MandateTarget | MandateArchive | null,
  claims: MandateWork[],
  digest: boolean,
): MandateDelivery {
  const sorted = [...claims].sort((a, b) => a.match.id - b.match.id)
  const ids = sorted.map(({ mandate, event }) => [
    mandate.id,
    event.source,
    event.scope,
    event.eventId,
  ])
  const id = createHash('sha256')
    .update(JSON.stringify([kind, keyForTarget(target), ids]))
    .digest('hex')
  return {
    id,
    digest,
    entries: sorted.map(({ event, mandate, task, match }) => ({
      taskId: task.id,
      matchId: match.id,
      inboxId: event.id,
      // WXARC room names, excerpts and model paraphrases stay in the local Web scope.
      title:
        event.source === 'wxarc'
          ? '微信监听事项'
          : mandate.processing === 'direct'
            ? 'GitHub 订阅提醒'
            : event.title.slice(0, 256),
      summary:
        event.source === 'wxarc'
          ? '已订阅的微信会话有新的处理结果，可在 ZeRo 查看。'
          : (match.summary ?? '').slice(0, 600),
    })),
  }
}

export class TriggerMandateRuntime {
  private readonly stop = new AbortController()
  private started = false
  private lastPresenceAt?: Date
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private requested = false

  constructor(
    private readonly store: TriggerStore,
    private readonly deps: MandateDependencies,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.started || this.stop.signal.aborted) return
    this.store.mandates.recoverInterrupted()
    this.started = true
    this.notify()
  }

  async close() {
    this.stop.abort()
    clearTimeout(this.timer)
    await this.running
  }

  heartbeat() {
    const now = this.now()
    const elapsed = this.lastPresenceAt
      ? now.getTime() - this.lastPresenceAt.getTime()
      : Number.POSITIVE_INFINITY
    this.lastPresenceAt = now
    if (elapsed < 0 || elapsed >= TRIGGER_PRESENCE_TTL_MS) this.wakeDeferred()
  }

  wakeDeferred() {
    if (this.stop.signal.aborted) return
    this.store.mandates.recheckDeferred(this.now().toISOString())
    this.notify()
  }

  retry(matchId: number, kind: 'analysis' | EffectKind) {
    const accepted = this.store.mandates.retry(matchId, kind)
    if (accepted) this.notify()
    return accepted
  }

  preview(mandateId: string, at: string, present: boolean | null, urgent?: boolean) {
    const now = new Date(at)
    if (!Number.isFinite(now.getTime())) throw new RangeError('无效的预演时间。')
    const { settings } = this.store.mandates.getSettings()
    const mandate = settings.mandates.find((row) => row.id === mandateId)
    if (!mandate) throw new RangeError('找不到该委托。')
    const global = this.store.routing.getSettings().settings
    const decision = decideMandateNotification({
      mandate: urgent === undefined ? mandate : { ...mandate, urgent },
      project: settings.projects.find((row) => row.id === mandate.projectId) ?? null,
      settings: { ...global, presence: present === null ? 'auto' : present ? 'present' : 'away' },
      nativeContext:
        present === true
          ? {
              observedAt: now.toISOString(),
              locked: false,
              idleSeconds: 0,
              bluetoothConnected: null,
            }
          : undefined,
      availableTargets: this.deps.platforms.listTargets(),
      now,
      receivedAt: now.toISOString(),
    })
    return { decision, archive: mandate.archive }
  }

  notify() {
    if (!this.started || this.stop.signal.aborted) return
    clearTimeout(this.timer)
    this.requested = true
    if (this.running) return
    this.running = Promise.resolve()
      .then(async () => {
        do {
          this.requested = false
          // Each lane has its own durable claim: a document rejection cannot suppress a notification.
          const advanced = await Promise.allSettled([
            this.analyzeOne(),
            this.advanceArchive(),
            this.advanceNotification(),
          ])
          for (const result of advanced) {
            if (result.status === 'rejected') throw result.reason
            if (result.value) this.requested = true
          }
        } while (this.requested && !this.stop.signal.aborted)
        const next = this.store.mandates.nextDueAt()
        if (next) this.schedule(Date.parse(next) - this.now().getTime())
      })
      .catch(() => {
        console.error('[Mandates] Could not advance the task queue. Will retry.')
        this.requested = false
        this.schedule(30_000)
      })
      .finally(() => {
        this.running = undefined
        if (this.requested) this.notify()
      })
  }

  private schedule(delayMs: number) {
    if (this.stop.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.notify(), Math.min(2_147_483_647, Math.max(1, delayMs)))
    this.timer.unref?.()
  }

  private versions(): PolicyVersion {
    return {
      mandateRevision: this.store.mandates.getSettings().revision,
      routingRevision: this.store.routing.getSettings().revision,
    }
  }

  private async analyzeOne(): Promise<boolean> {
    if (this.stop.signal.aborted) return false
    const db = this.store.mandates
    const session = `mandate-${crypto.randomUUID()}`
    const work = db.claimAnalysis(session)
    if (!work) return false
    if (work.mandate.processing === 'direct') {
      db.finishAnalysis(work.match.id, directReminder(work), work.claimToken)
      return true
    }
    let result: TriggerAgentResult
    try {
      result = await this.deps.analyze(
        work.event,
        work.task.sessionId ?? session,
        this.stop.signal,
        {
          purpose: work.mandate.purpose,
          previousSummaries: db.getPriorSummaries(work.task.id, work.match.id),
        },
      )
    } catch (error) {
      // Interrupted read-only analysis can be recovered on the next owner startup.
      if (!this.stop.signal.aborted) {
        db.failAnalysis(
          work.match.id,
          error instanceof TriggerAgentError ? error.message : 'Agent 分析失败，可重试。',
          work.claimToken,
        )
      }
      return true
    }
    if (!this.stop.signal.aborted) db.finishAnalysis(work.match.id, result.summary, work.claimToken)
    return true
  }

  private async advanceArchive(): Promise<boolean> {
    if (this.stop.signal.aborted) return false
    const db = this.store.mandates
    const now = this.now().toISOString()
    const version = this.versions()
    const [work] = db.listReadyEffects('archive', now, 1)
    if (!work) return false
    const target = work.mandate.archive
    if (!target) {
      db.skipEffect(work.match.id, 'archive', '委托未指定归档文档。', version)
      return true
    }
    const claims = db.claimEffect(
      work.match.id,
      'archive',
      'archive',
      target,
      '写入委托指定的飞书文档。',
      now,
      [],
      version,
    )
    if (claims.length) {
      await this.deliver('archive', claims, target, false, version, (payload, maySend) =>
        this.deps.platforms.archive(target, payload, this.stop.signal, maySend),
      )
    }
    return true
  }

  private async advanceNotification(): Promise<boolean> {
    if (this.stop.signal.aborted) return false
    const db = this.store.mandates
    const mandateRevision = db.getSettings().revision
    const { settings, revision: routingRevision } = this.store.routing.getSettings()
    const version = { mandateRevision, routingRevision }
    const readyAt = this.now().toISOString()
    const head = db.nextEffect('notify', readyAt)
    if (!head) return false
    const context = await this.deps.getPresenceContext?.(settings)
    if (this.stop.signal.aborted) return false
    const now = this.now()
    const availableTargets = this.deps.platforms.listTargets()
    const decide = (work: MandateWork) =>
      decideMandateNotification({
        mandate: work.mandate,
        project: work.project,
        receivedAt: work.event.receivedAt,
        settings,
        now,
        lastPresenceAt: context?.lastPresenceAt ?? this.lastPresenceAt,
        nativeContext: context?.native,
        availableTargets,
      })
    // When the machine resumes after a window has closed, wait for that window's other
    // analyses to finish. Independent, non-digest work may still advance immediately.
    const oldest = decide(head)
    const plans =
      'digestKey' in oldest && oldest.digestKey
        ? db.listReadyEffects('notify', readyAt, 100).map((work) => ({
            work,
            route: work.match.id === head.match.id ? oldest : decide(work),
          }))
        : [{ work: head, route: oldest }]
    const selected = plans.find(
      ({ work, route }) =>
        !(
          'digestKey' in route &&
          route.digestKey &&
          db.hasPendingAnalysisBefore(work.mandate.id, route.digestKey)
        ),
    )
    if (!selected) return false
    const { work: first, route: decision } = selected
    const id = first.match.id
    if (decision.destination === 'defer') {
      db.deferEffect(id, 'notify', decision.recheckAt, decision.reason, version)
      return true
    }
    if (decision.destination === 'none') {
      db.skipEffect(id, 'notify', decision.reason, version)
      return true
    }
    const target = 'target' in decision ? decision.target : null
    const group: number[] = []
    if (decision.digestKey) {
      const peer = JSON.stringify(keyForTarget(target))
      for (const { work: other, route } of plans) {
        if (other.match.id === id || other.mandate.id !== first.mandate.id) continue
        if (
          route.destination === decision.destination &&
          'digestKey' in route &&
          route.digestKey === decision.digestKey &&
          JSON.stringify(keyForTarget('target' in route ? route.target : null)) === peer
        )
          group.push(other.match.id)
        if (group.length === 49) break
      }
    }
    const claims = db.claimEffect(
      id,
      'notify',
      decision.destination,
      target,
      decision.reason,
      now.toISOString(),
      group,
      version,
    )
    if (!claims.length) return true
    if (decision.destination === 'web') {
      for (const { match } of claims) db.finishEffect(match.id, 'notify', 'done', 'web')
      this.store.webNotifications.changed()
      return true
    }
    await this.deliver(
      'notify',
      claims,
      decision.target,
      !!decision.digestKey,
      version,
      (payload, maySend) =>
        this.deps.platforms.send(decision.target, payload, this.stop.signal, maySend),
    )
    return true
  }

  private async deliver(
    kind: EffectKind,
    claims: MandateWork[],
    target: MandateTarget | MandateArchive,
    digest: boolean,
    version: PolicyVersion,
    deliver: (payload: MandateDelivery, maySend: () => boolean) => Promise<MandateReceipt>,
  ) {
    const db = this.store.mandates
    const matchIds = claims.map(({ match }) => match.id)
    // A native adapter may wait for document access or a bot token after it has claimed
    // the work. Revalidate at the external write boundary as well as before preparation.
    let authorizationDenied = false
    const maySend = () => {
      if (!authorizationDenied) {
        authorizationDenied = !db.areEffectsAuthorized(matchIds, kind, target, version)
      }
      return !authorizationDenied
    }
    if (!maySend()) {
      db.releaseUnsentEffects(matchIds, kind)
      return
    }
    let result: MandateReceipt
    try {
      result = await deliver(buildDelivery(kind, target, claims, digest), maySend)
    } catch {
      result = { status: 'unknown', reason: '未收到明确的平台回执，请先核实，系统不会自动重发。' }
    }
    if (result.status === 'rejected' && authorizationDenied) {
      db.releaseUnsentEffects(matchIds, kind)
      return
    }
    for (const { match } of claims) {
      if (result.status === 'accepted')
        db.finishEffect(match.id, kind, 'done', result.receipt ?? '')
      else
        db.finishEffect(
          match.id,
          kind,
          result.status === 'unknown' ? 'unknown' : 'failed',
          result.reason,
        )
    }
  }
}
