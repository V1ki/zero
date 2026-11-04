import type { RouterJobScope, TriggerStore } from '@zero-os/observe'
import type { TriggerConversationAnswer, TriggerConversationTurn } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { type RouterActor, type RouterJobPrincipals, fingerprint } from './router-job-principal'
import type { RouterJobs } from './router-jobs'
import type { RouterTurnActions } from './router-loop-tools'
import type { RouterRepositoryLookup } from './router-repositories'
import { authorizeRouterJobContinuation, jobReply, repositoryReply } from './router-work-reply'

export interface RouterWorkIntegrations {
  repositories?: Pick<RouterRepositoryLookup, 'list' | 'accessKey'>
  delegatedJobs?: RouterJobs
  principals?: RouterJobPrincipals
  checkout?: (repository: string, actor: RouterActor) => Promise<string | null>
}

type WorkAccess = NonNullable<TriggerConversationAnswer['workAccess']>
function validAccess(access: WorkAccess, actor: RouterActor, work: RouterWorkIntegrations) {
  const current = work.principals?.current(actor, access.github)
  return !!current && fingerprint(current) === access.key
}

export function visibleWorkTurn(
  turn: TriggerConversationTurn,
  actor: RouterActor,
  scope: RouterJobScope,
  work: RouterWorkIntegrations,
): TriggerConversationTurn {
  const answer = turn.answer
  if (!answer) return turn
  const { workAccess, ...visible } = answer
  if (!workAccess) return turn
  if (!validAccess(workAccess, actor, work)) {
    return {
      ...turn,
      question: '此前的授权对话',
      answer: { text: '这条记录的授权已变更。请在当前授权下重新提问。' },
    }
  }
  if (visible.job && work.delegatedJobs && work.principals) {
    try {
      const audience = work.principals.capture(actor, !!visible.job.repository)
      const job = work.delegatedJobs.get(scope, visible.job.id, audience, visible.job.attempt)
      const oldText = jobReply(visible.job)
      const text = visible.text.includes(oldText)
        ? visible.text.replace(oldText, () => jobReply(job))
        : jobReply(job)
      return { ...turn, answer: { ...visible, job, text } }
    } catch (error) {
      if (!(error instanceof TriggerAgentError)) throw error
      return { ...turn, answer: { text: '这项派工的记录已不可用。' } }
    }
  }
  return { ...turn, answer: visible }
}

export function createRouterWorkTurn(
  work: RouterWorkIntegrations,
  store: TriggerStore,
  scope: RouterJobScope,
  actor: RouterActor,
  turn: TriggerConversationTurn,
  history: readonly TriggerConversationTurn[],
  authorized: () => boolean,
) {
  const { repositories, delegatedJobs, principals, checkout } = work
  const previous = history
    .filter((item) => item.status === 'completed' && item.answer)
    .slice(-8)
    .flatMap((item) => item.answer?.workAccess ?? [])
  let access =
    previous.find((a) => a.github && validAccess(a, actor, work)) ??
    previous.find((a) => validAccess(a, actor, work))
  let verified: TriggerConversationAnswer | undefined
  function record(receipt: Pick<TriggerConversationAnswer, 'repositories' | 'job'>) {
    const data = { ...verified, ...receipt }
    const text = [
      data.repositories && repositoryReply(data.repositories),
      data.job && jobReply(data.job),
    ]
      .filter(Boolean)
      .join('\n\n')
    verified = { ...data, text }
  }
  const guard = (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!authorized() || (access && !validAccess(access, actor, work)))
      throw new TriggerAgentError('授权已变化，请重新提问。')
  }
  function pin(github: boolean, signal: AbortSignal) {
    guard(signal)
    if (!principals) throw new TriggerAgentError('执行服务尚未就绪。')
    const audience = principals.capture(actor, github)
    if (github || !access) access = { github, key: fingerprint(audience) }
    return audience
  }
  function jobAudience(id: number, signal: AbortSignal) {
    const stored = store.jobs.get(scope, id)
    if (!stored) throw new TriggerAgentError('在当前 Router 对话中找不到这个工作任务。')
    return pin(!!stored.repository, signal)
  }
  const actions: RouterTurnActions = {
    ...(repositories &&
      principals && {
        listGithubRepositories: async (page, signal) => {
          pin(true, signal)
          const data = await repositories.list(actor, signal, page)
          guard(signal)
          record({ repositories: data })
          return data
        },
      }),
    ...(delegatedJobs &&
      principals && {
        delegateTask: async (target, signal) => {
          const audience = pin(!!target.repository, signal)
          if (
            target.executor === 'codex' &&
            (!target.repository || !(await checkout?.(target.repository, actor)))
          )
            throw new TriggerAgentError(
              '此入口没有该仓库的 Codex 工作区授权。请先在 ZeRo 本机配置对应检出目录。',
            )
          guard(signal)
          const job = delegatedJobs.submit(scope, turn.requestId, {
            ...target,
            audience,
            instruction: turn.question,
          })
          record({ job })
          return job
        },
        getTaskStatus: async (id, signal) => {
          const job = delegatedJobs.get(scope, id, jobAudience(id, signal))
          record({ job })
          return job
        },
        continueTask: async (id, signal) => {
          const audience = jobAudience(id, signal)
          const original = delegatedJobs.get(scope, id, audience)
          authorizeRouterJobContinuation(turn.question, original.executor)
          if (
            original.executor === 'codex' &&
            (!original.repository || !(await checkout?.(original.repository, actor)))
          )
            throw new TriggerAgentError('此入口的 Codex 工作区授权已变更。')
          guard(signal)
          const job = delegatedJobs.continue(scope, id, turn.requestId, turn.question, audience)
          record({ job })
          return job
        },
      }),
  }
  return {
    actions,
    verified: (result?: TriggerConversationAnswer) => {
      if (!verified) return undefined
      // Router Agent formats multi-tool successes/errors; only host callbacks can attach receipts.
      return result?.repositories || result?.job ? { ...verified, text: result.text } : verified
    },
    protect(answer: TriggerConversationAnswer) {
      guard()
      return access ? { ...answer, workAccess: access } : answer
    },
  }
}
