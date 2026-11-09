import type { RouterJob } from '@zero-os/observe'
import {
  type CommissionOperator,
  type MandatePlatform,
  type TriggerRouteDecision,
  sameTriggerRouteTarget,
} from '@zero-os/shared'
import { jobActor } from './router-job-principal'
import { routerJobReceipt } from './router-jobs'
import { jobReply } from './router-work-reply'
import { DirectReminderUnavailableError, type TriggerRoutingRuntime } from './routing-runtime'

type Routing = Pick<
  TriggerRoutingRuntime,
  | 'getConfig'
  | 'previewCurrentRoute'
  | 'isSelectedDirectTarget'
  | 'prepareDirectReminder'
  | 'sendDirectReminder'
> &
  Partial<Pick<TriggerRoutingRuntime, 'listPersonalTargets'>>
type ReturnResult = 'delivered' | 'unavailable' | 'unknown' | { recheckAt: string }

function watchRecipient(routing: Routing, platform: MandatePlatform): CommissionOperator | null {
  const live = routing
    .listPersonalTargets?.()
    .filter((target) => target.platform === platform && routing.isSelectedDirectTarget(target))
  if (live?.length !== 1) return null
  const { channelId, peerId, operatorId } = live[0]
  return operatorId && peerId && channelId ? { platform, channelId, peerId, operatorId } : null
}

/** Personal jobs return only to their originating recipient. GitHub watches belong
 * to the Router and can nudge a separately authorized personal recipient. */
export function createRouterJobDelivery(
  routing: Routing,
  authorized: (job: RouterJob) => boolean,
  watchAccessKey?: (actor: CommissionOperator) => string | null,
  githubWork?: (
    job: RouterJob,
    signal: AbortSignal,
  ) => Promise<'delivered' | 'unavailable' | 'unknown' | null>,
  hasSourceNotification?: (job: RouterJob) => boolean,
) {
  return async (job: RouterJob, signal: AbortSignal): Promise<ReturnResult> => {
    if (signal.aborted || !authorized(job)) return 'unavailable'
    const actor = jobActor(job)
    if (!actor) return 'unavailable'
    // Archive receipts are available exclusively in their authenticated local Web event.
    if (job.kind === 'event-followup')
      return actor === 'web' && job.scope === 'general' ? 'delivered' : 'unavailable'
    const watching = job.kind === 'github-watch'
    if (watching && (actor !== 'web' || job.scope !== 'general')) return 'unavailable'
    // The source subscription already owns external notifications. Keep the Worker receipt on the Web.
    if (watching && hasSourceNotification?.(job)) return 'delivered'
    if (watching && githubWork) {
      const original = await githubWork(job, signal)
      if (original !== null) return original
    }
    // The authenticated Router activity feed already contains every watched result.
    if (watching && job.status === 'completed' && !job.attentionQuestion?.trim()) return 'delivered'
    if (!watching && actor === 'web') return 'delivered'
    const snapshot = routing.getConfig()
    if (!snapshot.settings.enabled) return 'unavailable'
    let decision: TriggerRouteDecision
    try {
      decision = await routing.previewCurrentRoute()
    } catch (error) {
      if (signal.aborted || !authorized(job)) return 'unavailable'
      if (routing.getConfig().revision !== snapshot.revision)
        return { recheckAt: new Date(Date.now() + 1000).toISOString() }
      throw error
    }
    const current = () =>
      !signal.aborted && routing.getConfig().revision === snapshot.revision && authorized(job)
    if (!current()) return 'unavailable'
    if (decision.destination === 'web') return watching ? 'delivered' : 'unavailable'
    // An offline bot may become available at the policy's next recheck. Its durable
    // authorization is still required, but live deliverability matters only at send.
    if (decision.destination === 'defer') return { recheckAt: decision.recheckAt }
    const platform = decision.destination
    const target = watching ? watchRecipient(routing, platform) : actor
    if (!target || target === 'web' || target.platform !== platform) return 'unavailable'
    const grant = watching ? watchAccessKey?.(target) : null
    const maySend = () =>
      current() &&
      (watching
        ? !!grant &&
          sameTriggerRouteTarget(watchRecipient(routing, platform), target) &&
          watchAccessKey?.(target) === grant
        : routing.isSelectedDirectTarget(target))
    if (!maySend()) return 'unavailable'

    try {
      const prepared = routing.prepareDirectReminder(platform)
      if (prepared.channelId !== target.channelId || !maySend()) return 'unavailable'
      const full = watching
        ? `有一项 GitHub 跟踪结果需要你查看。请打开 Router 网页查看派工 #${job.id}。`
        : jobReply(routerJobReceipt(job))
      const text =
        full.length <= 1800
          ? full
          : `${full.slice(0, 1750).toWellFormed()}…\n可在此查询派工 #${job.id} 查看完整结果。`
      const receipt = await routing.sendDirectReminder(
        platform,
        prepared,
        text,
        `router-job-${job.id}-${job.attempt}`,
        signal,
        maySend,
      )
      if (receipt.status === 'accepted') return 'delivered'
      return receipt.status === 'unknown' ? 'unknown' : 'unavailable'
    } catch (error) {
      if (error instanceof DirectReminderUnavailableError) return 'unavailable'
      throw error
    }
  }
}
