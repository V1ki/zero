import type { RouterJob } from '@zero-os/observe'
import type { TriggerRouteDecision } from '@zero-os/shared'
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
>
type ReturnResult = 'delivered' | 'unavailable' | 'unknown' | { recheckAt: string }

/** A result belongs to its originating conversation, even if the current notification
 * preference selects an account on another platform. Never guess the same human there. */
export function createRouterJobDelivery(routing: Routing, authorized: (job: RouterJob) => boolean) {
  return async (job: RouterJob, signal: AbortSignal): Promise<ReturnResult> => {
    if (signal.aborted || !authorized(job)) return 'unavailable'
    const actor = jobActor(job)
    if (!actor) return 'unavailable'
    // Web reads the result from the original turn. It needs no external delivery.
    if (actor === 'web') return 'delivered'
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
    // An offline bot may become available at the policy's next recheck. Its durable
    // authorization is still required, but live deliverability matters only at send.
    if (decision.destination === 'defer') return { recheckAt: decision.recheckAt }
    const maySend = () => current() && routing.isSelectedDirectTarget(actor)
    if (decision.destination !== actor.platform || !maySend()) return 'unavailable'

    try {
      const prepared = routing.prepareDirectReminder(actor.platform)
      if (prepared.channelId !== actor.channelId || !maySend()) return 'unavailable'
      const full = jobReply(routerJobReceipt(job))
      const text =
        full.length <= 1800
          ? full
          : `${full.slice(0, 1750).toWellFormed()}…\n可在此查询派工 #${job.id} 查看完整结果。`
      const receipt = await routing.sendDirectReminder(
        actor.platform,
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
