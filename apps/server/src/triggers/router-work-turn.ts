import { createHash } from 'node:crypto'
import type { RouterJobScope, TriggerStore } from '@zero-os/observe'
import { openPullRequestsReply } from '@zero-os/shared'
import type {
  RouterRepositoryTrackingReceipt,
  TriggerConversationAnswer,
  TriggerConversationTurn,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { type RouterActor, type RouterJobPrincipals, fingerprint } from './router-job-principal'
import { type RouterJobs, routerJobReceipt } from './router-jobs'
import type { RouterTurnActions } from './router-loop-tools'

import type { RouterRepositoryLookup } from './router-repositories'
import type { RouterTrackingSelection } from './router-tracking-intent'
import {
  jobReply,
  publicTrackingReceipt,
  repositoryReply,
  trackingReply,
} from './router-work-reply'

export interface RouterWorkIntegrations {
  resolveJobAccess?(
    actor: RouterActor,
    jobId: number,
  ): { scope: RouterJobScope; audience: string } | null
  principalFor?(actor: RouterActor): string | null
  contextScopes?(actor: RouterActor): Array<{ scope: RouterJobScope; actor: RouterActor }>
  repositories?: Pick<RouterRepositoryLookup, 'list' | 'accessKey'> &
    Partial<Pick<RouterRepositoryLookup, 'listOpenPullRequests'>>
  trackRepository?(
    input: RouterTrackingSelection & {
      actor: RouterActor
      scope: RouterJobScope
      audience: string
      requestId: string
    },
    signal: AbortSignal,
    authorized: () => boolean,
  ): Promise<RouterRepositoryTrackingReceipt>
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
  onAccess?: (github: boolean, visible: boolean) => void,
): TriggerConversationTurn {
  const answer = turn.answer
  if (!answer) return turn
  const { workAccess, ...visible } = answer
  if (!workAccess) return turn
  const granted = validAccess(workAccess, actor, work)
  onAccess?.(workAccess.github, granted)
  if (!granted) {
    return {
      ...turn,
      quotedMessage: undefined,
      question: '此前的授权对话',
      answer: { text: '这条记录的授权已变更。请在当前授权下重新提问。' },
    }
  }
  if (visible.job && work.delegatedJobs && work.principals) {
    try {
      const audience = work.principals.capture(actor, !!visible.job.repository)
      const origin = work.resolveJobAccess?.(actor, visible.job.id)
      const job = work.delegatedJobs.get(
        origin?.scope ?? scope,
        visible.job.id,
        origin?.audience ?? audience,
        visible.job.attempt,
      )
      const oldText = jobReply(visible.job)
      const text = visible.text.includes(oldText)
        ? visible.text.replace(oldText, () => jobReply(job))
        : visible.text
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
  source?: {
    eventId?: number
    trackingJobId?: number
    workerResult?: { jobId: number; attempt: number }
    authority: 'user' | 'source'
  },
) {
  const { repositories, delegatedJobs, principals, checkout, trackRepository } = work
  const previous = history
    .filter((item) => item.status === 'completed' && item.answer)
    .flatMap((item) => item.answer?.workAccess ?? [])
  let access =
    previous.find((a) => a.github && validAccess(a, actor, work)) ??
    previous.find((a) => validAccess(a, actor, work))
  let verified: TriggerConversationAnswer | undefined
  function record(
    receipt: Pick<TriggerConversationAnswer, 'repositories' | 'pullRequests' | 'job' | 'tracking'>,
  ) {
    const data = { ...verified, ...receipt }
    const text = [
      data.repositories && repositoryReply(data.repositories),
      data.pullRequests && openPullRequestsReply(data.pullRequests),
      data.job && jobReply(data.job),
      data.tracking && trackingReply(data.tracking),
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
  const principal = work.principalFor?.(actor) ?? scope
  function jobAccess(id: number, signal: AbortSignal) {
    const link = store.ledger.workerLink(id)
    const jobScope =
      link?.principal === principal &&
      (link.scope === 'general' || /^im-[a-f0-9]{64}$/.test(link.scope))
        ? (link.scope as RouterJobScope)
        : scope
    const stored = store.jobs.get(jobScope, id)
    if (!stored) throw new TriggerAgentError('在当前身份下找不到这个工作任务。')
    const audience = pin(!!stored.repository, signal)
    return { scope: jobScope, audience: link?.principal === principal ? link.audience : audience }
  }
  function bind(
    job: { id: number; scope: RouterJobScope; audience: string | null },
    matterId: string,
    handoff?: { fromJobId: number; fromAttempt: number; fromStatus: string },
  ) {
    if (!job.audience) throw new TriggerAgentError('Worker 缺少身份授权。')
    const matter = store.ledger.getMatter(principal, matterId)
    if (!matter || ['paused', 'cancelled', 'completed'].includes(matter.state))
      throw new TriggerAgentError('事项未开放，不能启动或继续 Worker。')
    store.ledger.bindWorker({
      jobId: job.id,
      principal,
      matterId,
      scope: job.scope,
      audience: job.audience,
      eventIds: source?.eventId ? [source.eventId] : [],
      authority: source?.authority ?? 'user',
      handoff,
    })
  }
  const github = principals?.current(actor, true)
  const listOpenPullRequests = repositories?.listOpenPullRequests
  const actions: RouterTurnActions = {
    ...(listOpenPullRequests &&
      github &&
      principals && {
        listOpenPullRequests: async (name, page, signal, pageSize) => {
          pin(true, signal)
          const data = await listOpenPullRequests(actor, name, signal, page, pageSize)
          guard(signal)
          record({ pullRequests: data })
          return data
        },
      }),
    ...(repositories &&
      github &&
      principals && {
        listGithubRepositories: async (page, signal) => {
          pin(true, signal)
          const data = await repositories.list(actor, signal, page)
          guard(signal)
          record({ repositories: data })
          return data
        },
      }),
    ...(trackRepository &&
      github &&
      store.getSettings().settings.github.routerTrackingEnabled &&
      principals && {
        trackRepository: async (selection, signal) => {
          const audience = pin(true, signal)
          const receipt = await trackRepository(
            { ...selection, actor, scope, audience, requestId: turn.requestId },
            signal,
            () =>
              !signal.aborted &&
              authorized() &&
              principals.authorized(scope, audience, selection.repository),
          )
          guard(signal)
          const tracking = publicTrackingReceipt(receipt)
          record({ tracking })
          return tracking
        },
      }),
    ...(delegatedJobs &&
      principals?.current(actor, false) && {
        executorCatalog: delegatedJobs.executorCatalog(!!(github && checkout)),
        delegateTask: async (requested, signal) => {
          let target = requested
          let handoff: { fromJobId: number; fromAttempt: number; fromStatus: string } | undefined
          if (target.handoffFromJobId !== undefined) {
            const origin = jobAccess(target.handoffFromJobId, signal)
            const previous = delegatedJobs.get(
              origin.scope,
              target.handoffFromJobId,
              origin.audience,
            )
            if (store.ledger.workerLink(previous.id)?.matterId !== target.matterId)
              throw new TriggerAgentError('请在原事项内移交 Worker。')
            // Keep the source's repository grant on a transfer even when the new executor
            // only needs to read conclusions already obtained from that repository.
            if (!target.repository && previous.repository)
              target = { ...target, repository: previous.repository }
            handoff = {
              fromJobId: previous.id,
              fromAttempt: previous.attempt,
              fromStatus: previous.status,
            }
          }
          const audience = pin(!!target.repository, signal)
          if (
            target.executor === 'codex' &&
            (!target.repository || !(await checkout?.(target.repository, actor)))
          )
            throw new TriggerAgentError(
              '未能找到当前操作者可用的仓库工作目录，请核对仓库映射和本地检出。',
            )
          guard(signal)
          if (target.matterId && !store.ledger.getMatter(principal, target.matterId))
            throw new TriggerAgentError('请先读取或创建当前身份的事项。')
          const job = delegatedJobs.submit(
            scope,
            createHash('sha256')
              .update(JSON.stringify([turn.requestId, target]))
              .digest('hex'),
            {
              ...target,
              audience,
              instruction: target.instruction ?? turn.question,
            },
            target.matterId ? (job) => bind(job, target.matterId as string, handoff) : undefined,
          )
          const savedHandoff = handoff && store.ledger.workerHandoff(job.id)
          const receipt = savedHandoff ? { ...job, handoff: savedHandoff } : job
          record({ job: receipt })
          return receipt
        },
        findTaskAttempts: (id, query, signal) => {
          const origin = jobAccess(id, signal)
          return delegatedJobs.findAttempts(origin.scope, id, origin.audience, query)
        },
        getTaskStatus: async (id, signal, attempt) => {
          const origin = jobAccess(id, signal)
          const job = delegatedJobs.get(origin.scope, id, origin.audience, attempt)
          record({ job })
          return job
        },
        continueTask: async (id, signal, instruction) => {
          const origin = jobAccess(id, signal)
          const audience = origin.audience
          const original = delegatedJobs.get(origin.scope, id, audience)
          if (
            original.executor === 'codex' &&
            (!original.repository || !(await checkout?.(original.repository, actor)))
          )
            throw new TriggerAgentError('原仓库工作目录已不可用，请核对实际检出状态。')
          guard(signal)
          const reviewed = source?.workerResult
          if (reviewed?.jobId === id) {
            const latest = delegatedJobs.get(origin.scope, id, audience)
            if (latest.attempt > reviewed.attempt)
              throw new TriggerAgentError(
                `第 ${reviewed.attempt} 轮之后已经续办到第 ${latest.attempt} 轮；请核对最新进展，这份旧回执无需重复派工。`,
              )
          }
          // Pre-matter watch jobs share a Worker across several inbox entries.
          // Preserve the selected source and the operator's original words for this continuation.
          if (
            actor === 'web' &&
            source?.authority === 'user' &&
            source.eventId !== undefined &&
            source.trackingJobId === id &&
            !store.ledger.workerLink(id) &&
            store.jobs.get(origin.scope, id)?.kind === 'github-watch'
          ) {
            const step = store.tracking.continueEventWork(
              source.eventId,
              turn.requestId,
              turn.question,
              id,
            )
            delegatedJobs.notify()
            const job = routerJobReceipt(step)
            record({ job })
            return job
          }
          const job = delegatedJobs.continue(
            origin.scope,
            id,
            createHash('sha256')
              .update(JSON.stringify([turn.requestId, id, instruction]))
              .digest('hex'),
            instruction ?? turn.question,
            audience,
            (job) => {
              const link = store.ledger.workerLink(id)
              if (link?.principal === principal) bind(job, link.matterId)
            },
          )
          record({ job })
          return job
        },
      }),
  }
  return {
    actions,
    pinHistory: pin,
    verified: (result?: TriggerConversationAnswer) => {
      if (!verified) return undefined
      // Router Agent formats multi-tool successes/errors; only host callbacks can attach receipts.
      return result ? { ...verified, ...result } : verified
    },
    protect(answer: TriggerConversationAnswer) {
      guard()
      return access ? { ...answer, workAccess: access } : answer
    },
  }
}
