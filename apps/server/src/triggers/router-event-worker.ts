import type { RouterJob } from '@zero-os/observe'
import { type RouterEventWork, type TriggerInboxItem, routerFollowupSignal } from '@zero-os/shared'
import { type AgentDependencies, TriggerAgentError } from './event-agent'
import { GithubIssueCloseUncertainError } from './github-issue-close'
import { requestsCurrentIssueClose } from './github-issue-close-intent'
import { type EventWorkServices, executeEventWork } from './router-event-execution'
import { type FollowupDecision, decideRouterFollowup } from './router-followup-policy'
import { jobActor } from './router-job-principal'
import { RouterJobExecutionUncertainError } from './router-jobs'

interface TrackingEvents {
  handoffOwnerIssueWork?(job: RouterJob, instruction: string): RouterJob | null
  eventForJob(
    jobId: number,
    attempt?: number,
  ): {
    active: boolean
    event: TriggerInboxItem
    followup?: boolean
    hadAction?: boolean
    selfEcho?: boolean
    previousResult?: string
    previousSources?: RouterEventWork['sources']
  } | null
}

type Result = { result: string; work: RouterEventWork; attentionQuestion?: string }

function observed(followup: FollowupDecision): Result {
  return {
    result: followup.reason,
    work: { outcome: 'observed', steps: [], sources: [], followup },
  }
}

export function createRouterEventWorker(
  { modelRouter, secretFilter }: AgentDependencies,
  tracking: TrackingEvents,
  services?: EventWorkServices,
) {
  function currentMatch(job: RouterJob) {
    if (
      job.kind !== 'github-watch' ||
      job.scope !== 'general' ||
      jobActor(job) !== 'web' ||
      job.executor !== 'zero' ||
      !job.repository
    )
      return null
    const match = tracking.eventForJob(job.id, job.attempt)
    const event = match?.event
    return match?.active &&
      event?.source === 'github' &&
      event.scope.toLowerCase() === job.repository.toLowerCase()
      ? match
      : null
  }
  return {
    authorized: (job: RouterJob) =>
      job.kind === 'event-followup'
        ? services?.archive?.authorized(job) === true
        : !!currentMatch(job),
    async execute(
      job: RouterJob,
      signal: AbortSignal,
    ): Promise<{
      result: string
      work?: RouterEventWork
      attentionQuestion?: string
    }> {
      if (job.kind === 'event-followup') {
        if (!services?.archive?.authorized(job))
          throw new TriggerAgentError('已无权跟进这条归档线索。')
        return services.archive.execute(job, signal)
      }
      const match = currentMatch(job)
      if (!match) throw new TriggerAgentError('跟踪已停用，或已无权读取这条事件。')
      const { event } = match
      const manual = job.workOrigin === 'manual'
      // The original continue_task entry point supplies a local question without a new trigger.
      // It may guide reads but cannot inherit an old comment's authority to close or reply.
      const localQuestion = job.attempt > 1 && !match.followup && !job.workOrigin
      const current = () => !signal.aborted && currentMatch(job)?.event.id === event.id
      const ensureCurrent = () => {
        signal.throwIfAborted()
        if (!current()) throw new TriggerAgentError('事件授权已变更，本轮跟进已停止。')
      }
      ensureCurrent()
      const operator = manual || localQuestion
      const owner =
        !operator && !match.selfEcho
          ? await services?.ownerRequest?.(event, signal, 'read-only')
          : null
      ensureCurrent()
      if (job.workOrigin === 'owner' && !owner)
        throw new TriggerAgentError('原评论已无法验证为仓主指令，未执行后续工作。')

      // A pre-existing narrow policy checks its own grant, verifies the duplicate remotely,
      // and returns a receipt only for a matching issue. Triage cannot grant this operation.
      const duplicate =
        !operator && !owner && !match.selfEcho
          ? await services?.resolveDuplicate?.(event, signal, current)
          : null
      ensureCurrent()
      const decision = await decideRouterFollowup(
        { modelRouter, secretFilter },
        routerFollowupSignal(event),
        job.id,
        signal,
        {
          related: !!match.followup || job.attempt > 1,
          hadAction: match.followup === true && match.hadAction === true,
          selfEcho: match.selfEcho,
          assignedBy: operator
            ? 'operator'
            : owner
              ? 'verified-owner'
              : duplicate
                ? 'existing-grant'
                : undefined,
        },
      )
      ensureCurrent()
      if (decision.decision === 'observe') return observed(decision)
      if (duplicate) return { ...duplicate, work: { ...duplicate.work, followup: decision } }
      const wantsClose = requestsCurrentIssueClose(
        manual ? job.instruction : (owner?.instruction ?? ''),
        event,
      )
      if (wantsClose) {
        const blocked = (result: string) => ({
          result,
          attentionQuestion: result,
          work: {
            outcome: 'needs_input',
            steps: [],
            sources: [],
            followup: decision,
          } satisfies RouterEventWork,
        })
        const grant = manual ? null : services?.ownerCloseGrant?.(event)
        if (!manual && (!grant || !owner?.closeIssue))
          return blocked(
            '这次未获原帖关闭授权。请在已授权的仓库中直接 @ 机器人明确要求关闭当前 Issue，或从 Router 事件对话中下达指令。',
          )
        if (!services?.closeIssue)
          return blocked('当前仓库没有可用的 GitHub 关闭工具，未执行关闭。')
        if (owner && !job.workOrigin && job.attempt === 1) {
          const previous = tracking.handoffOwnerIssueWork?.(job, owner.instruction)
          if (previous)
            return {
              result: `已将关闭请求交给此前处理本 Issue 的 Worker #${previous.id}。`,
              work: {
                outcome: 'observed',
                steps: [],
                sources: [],
                followup: decision,
              } satisfies RouterEventWork,
            }
        }
        const unchanged = () => current() && (manual || services.ownerCloseGrant?.(event) === grant)
        // The model never decides the write target or its authority. Submit one
        // scoped command to the Worker adapter and record its actual remote receipt.
        try {
          const receipt = await services.closeIssue(event, signal, {
            current: unchanged,
            ...(!manual && {
              verify: async (stop: AbortSignal) => {
                const fresh = await services.ownerRequest?.(event, stop)
                return (
                  unchanged() &&
                  fresh?.closeIssue === true &&
                  fresh.instruction === owner?.instruction
                )
              },
            }),
          })
          const subject = `${receipt.repository}#${receipt.number}`
          return {
            result:
              receipt.state === 'already_closed'
                ? `GitHub 已确认 ${subject} 原本就已关闭，没有重复提交。`
                : `已关闭 ${subject}，GitHub 已确认状态为 closed。`,
            work: {
              followup: decision,
              outcome: 'resolved',
              steps: [{ tool: 'close_issue', ok: true }],
              sources: [{ url: receipt.url, label: `GitHub Issue #${receipt.number}（已关闭）` }],
              publicFacts: [{ label: '当前状态', value: '已关闭' }],
            } satisfies RouterEventWork,
          }
        } catch (error) {
          if (error instanceof GithubIssueCloseUncertainError)
            throw new RouterJobExecutionUncertainError(error.message)
          // Transport errors may include upstream text; never forward them as trusted facts.
          const result = '未能关闭当前 Issue。请核对仓库绑定、Issue 写入授权和原讨论状态。'
          return {
            result,
            attentionQuestion: result,
            work: {
              followup: decision,
              outcome: 'needs_input',
              steps: [{ tool: 'close_issue', ok: false }],
              sources: [],
            } satisfies RouterEventWork,
          }
        }
      }
      if (!services) throw new TriggerAgentError('本次事件没有已配置的核查工具。')

      const goal =
        owner?.instruction ??
        (manual || localQuestion
          ? [job.instruction, event.summary].join('\n')
          : '根据本轮新线索核实可办理的问题或变更，给出有来源的结果。若有此前已核实的结果，说明本轮新增的证据或影响。')
      const result = await executeEventWork(
        { modelRouter, secretFilter },
        event,
        job,
        goal,
        services.investigator,
        signal,
        current,
        {
          reason: decision.reason,
          automaticContinuation: !operator && !owner && match.hadAction === true,
          ...((match.previousResult || match.previousSources?.length) && {
            previous: { result: match.previousResult, sources: match.previousSources },
          }),
        },
      )
      return {
        ...result,
        work: {
          ...result.work,
          followup:
            result.work.outcome === 'observed'
              ? { kind: 'continue', decision: 'observe', reason: result.result }
              : decision,
        },
      }
    },
  }
}
