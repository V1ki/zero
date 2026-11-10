import { createHash } from 'node:crypto'
import type { RouterImScope, TriggerStore } from '@zero-os/observe'
import {
  type CommissionOperator,
  type GithubInvestigation,
  type GithubInvestigationAction,
  type MandatePlatform,
  type RouterWorkspaceSnapshot,
  type RouterWorkspaceTask,
  type TriggerConversationAnswer,
  type TriggerConversationScope,
  type TriggerConversationTurn,
  botRoutingPreferences,
  isRouterSurfaceAction,
  matchesRouterSurfaceAction,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { type GithubInvestigator, InvestigationError } from './investigation'
import type { RouterAgentInput, createRouterAgent } from './router-agent'
import type { RouterCommissionService } from './router-commission'
import { routerImScope } from './router-job-principal'
import { buildRouterReplySurface, buildRouterSurface } from './router-surface'
import { jobReply } from './router-work-reply'
import {
  type RouterWorkIntegrations,
  createRouterWorkTurn,
  visibleWorkTurn,
} from './router-work-turn'
import type { TriggerRoutingRuntime } from './routing-runtime'
import type { TaskMessage } from './task-bridge'

export class RouterWorkspaceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}

const inspectionQuestions = {
  inspect_github: '查看本条 GitHub 事件的原始作业或 PR 详情。',
  compare_runs: '对比这条 GitHub 事件此前的工作流运行。',
} satisfies Record<GithubInvestigationAction, string>

type Scope = TriggerConversationScope
type CardAction = GithubInvestigationAction | 'explain_route' | 'suggest_next' | 'choose_option'
/** An option of a decision on one job step, as rendered by this server. */
interface DecisionChoice {
  jobId: number
  attempt: number
  option: number
}
interface ImTurn {
  scope: RouterImScope
  actor: CommissionOperator
  platform: MandatePlatform
  authorized: () => boolean
}
type Routing = Pick<TriggerRoutingRuntime, 'getConfig' | 'listPersonalBots' | 'process'> &
  Partial<Pick<TriggerRoutingRuntime, 'previewCurrentRoute'>>

/**
 * Turns leave the server only with the fields the current Router still renders. Stored answers
 * from removed chat features (reminders, preference proposals, mandate drafts, repository pages)
 * and server-only fields such as `workAccess` and `reminder.audienceKey` are dropped here, so such
 * a turn reads as its stored text.
 */
function publicTurn(turn: TriggerConversationTurn): TriggerConversationTurn {
  if (!turn.answer) return turn
  const { toolSteps, investigation, job, text, intent, points } = turn.answer
  return {
    ...turn,
    answer: {
      text,
      ...(toolSteps && { toolSteps }),
      ...(investigation && { investigation }),
      ...(job && { job }),
      ...(intent && { intent }),
      ...(points && { points }),
    },
  }
}

export class RouterWorkspaceService {
  private started = false
  private readonly stop = new AbortController()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly imTurns = new Map<RouterImScope, Promise<string | null>>()

  constructor(
    private readonly store: TriggerStore,
    private readonly routing: Routing,
    private readonly ask: ReturnType<typeof createRouterAgent>,
    private readonly integrations: RouterWorkIntegrations & {
      investigator?: GithubInvestigator
      commission?: RouterCommissionService
    } = {},
  ) {}

  get commission() {
    return this.integrations.commission
  }

  start() {
    if (this.started || this.stop.signal.aborted) return
    this.store.conversations.recoverInterrupted()
    this.started = true
    this.integrations.delegatedJobs?.start()
  }

  async close() {
    this.stop.abort()
    await Promise.allSettled([...this.jobs, this.integrations.delegatedJobs?.close()])
  }

  listEvents(limit?: number, beforeId?: number) {
    return this.store.listWorkspaceEvents(limit, beforeId)
  }

  private context(scope: Scope) {
    const settings = this.routing.getConfig()
    if (typeof scope === 'string' && scope !== 'general') {
      const id = Number(scope.slice(5))
      if (!Number.isSafeInteger(id) || id < 1 || scope !== `task-${id}`)
        throw new RouterWorkspaceError(404, '找不到这个委托任务。')
      const detail = this.store.mandates.getTask(id)
      if (!detail) throw new RouterWorkspaceError(404, '找不到这个委托任务。')
      const event = this.store.getInboxItem(detail.latestInboxId)
      const catalog = this.store.mandates.getSettings().settings
      // An old task remains visible locally even after its mandate ID is reused for a new audience.
      const mandate = detail.active
        ? catalog.mandates.find((m) => m.id === detail.mandateId)
        : undefined
      const project = mandate && catalog.projects.find((p) => p.id === mandate.projectId)
      const task: RouterWorkspaceTask = {
        id,
        mandateId: detail.mandateId,
        name: mandate?.name ?? detail.title,
        purpose: mandate?.purpose ?? '',
        source: event?.source ?? null,
        sourceScope: event?.scope ?? '',
        eventCount: detail.eventCount,
        active: !!(
          mandate?.enabled &&
          event &&
          this.store.getStreamStartedAt(
            `${event.source}:${event.source === 'github' ? event.scope.toLowerCase() : event.scope}`,
          )
        ),
        authorizedDestinations: [...new Set(mandate?.targets.map((t) => t.platform) ?? [])],
        archiveAuthorized: !!mandate?.archive,
        paused: detail.paused,
        policy: { ...project?.policy, ...mandate?.policy },
        deadline: mandate?.deadline ?? null,
        urgent: mandate?.urgent ?? false,
        matches: detail.matches.slice(0, 12).map(({ inboxId, status, summary, effects }) => ({
          inboxId,
          status,
          summary,
          effects: effects.map(({ kind, status, destination, reason, dueAt }) => ({
            kind,
            status,
            destination,
            reason,
            dueAt,
          })),
        })),
      }
      return { scope, task, event, route: null, settings }
    }
    const event = scope === 'general' ? null : this.store.getInboxItem(scope)
    if (scope !== 'general' && !event) throw new RouterWorkspaceError(404, '找不到这条收件箱事件。')
    return { scope, event, route: event ? this.store.routing.get(event.id) : null, settings }
  }

  get(scope: Scope): RouterWorkspaceSnapshot {
    const context = this.context(scope)
    const turns = this.store.conversations
      .list(scope)
      .map((entry) =>
        publicTurn(
          scope === 'general' ? visibleWorkTurn(entry, 'web', scope, this.integrations) : entry,
        ),
      )
    const bots = scope === 'general' ? this.routing.listPersonalBots() : []
    const settings = botRoutingPreferences(context.settings.settings)
    return {
      ...context,
      settings: { revision: context.settings.revision, settings },
      route: context.route ? { ...context.route, weixinTarget: null, deliveryTarget: null } : null,
      surface: buildRouterSurface(
        scope,
        context.event,
        context.route,
        settings,
        !context.task && context.event && this.integrations.investigator
          ? this.integrations.investigator.available(context.event)
          : [],
        context.task,
        bots,
      ),
      turns: turns.map((turn) => ({
        ...turn,
        surface: turn.answer ? buildRouterReplySurface(scope, turn.id, turn.answer) : null,
      })),
    }
  }

  private requireReady() {
    if (!this.started || this.stop.signal.aborted)
      throw new RouterWorkspaceError(503, 'Router 服务正在启动或关闭，请稍后重试。')
  }

  private async track<T>(work: Promise<T>) {
    this.jobs.add(work)
    try {
      return await work
    } finally {
      this.jobs.delete(work)
    }
  }

  async message(scope: Scope, requestId: string, question: string, retry = false) {
    return this.runTurn(scope, requestId, question, retry)
  }

  /** Authenticated IM transport only. Public workspace URLs cannot select these private threads. */
  async handleIm(input: TaskMessage, authorized: () => boolean): Promise<string | null> {
    if (!input.isDirect || !input.messageId.trim() || !input.peerId.trim() || !input.actorId.trim())
      return null
    const mayUse = () => this.started && !this.stop.signal.aborted && authorized()
    if (!mayUse()) return null
    const actor: CommissionOperator = {
      platform: input.platform,
      channelId: input.channelId,
      peerId: input.peerId,
      operatorId: input.actorId,
    }
    const scope = routerImScope(actor)
    const requestId = createHash('sha256')
      .update(JSON.stringify([scope, input.messageId]))
      .digest('hex')
    const question = input.text.trim()
    // Sequence messages from one peer while letting other conversations run independently.
    const prior = this.imTurns.get(scope)
    const run = async () => {
      if (!mayUse()) return null
      const conversations = this.store.conversations
      if (
        !question ||
        question.length > 2000 ||
        /\p{Cc}/u.test(question.replace(/[\t\r\n]/g, ''))
      ) {
        return conversations.applyActionOnce(scope, requestId, 'invalid-text', () => {}) ===
          'applied'
          ? '请发一条不超过 2000 字的文字消息给 Router。'
          : null
      }
      const claim = conversations.begin(scope, requestId, question)
      if (claim.kind !== 'started') return null
      try {
        await this.answer(this.context('general'), claim.turn, claim.attempt, undefined, {
          scope,
          actor,
          platform: input.platform,
          authorized: mayUse,
        })
      } catch (error) {
        if (!(error instanceof RouterWorkspaceError)) throw error
        return mayUse() ? error.message : null
      }
      if (!mayUse()) return null
      const saved = conversations.get(scope, requestId)
      const answer = saved && visibleWorkTurn(saved, actor, scope, this.integrations).answer
      if (!answer) return null
      return [answer.text, ...(answer.points ?? [])].join('\n')
    }
    const job = prior ? prior.then(run, run) : run()
    this.imTurns.set(scope, job)
    try {
      return await this.track(job)
    } finally {
      if (this.imTurns.get(scope) === job) this.imTurns.delete(scope)
    }
  }

  private async runTurn(
    scope: Scope,
    requestId: string,
    question: string,
    retry: boolean,
    cardAction?: CardAction,
    choice?: DecisionChoice,
  ) {
    this.requireReady()
    const context = this.context(scope)
    if (context.task && !context.task.active)
      throw new RouterWorkspaceError(409, '此任务已归档，只能查看已有对话。')
    const claim = this.store.conversations.begin(scope, requestId, question, retry)
    if (claim.kind === 'busy')
      throw new RouterWorkspaceError(409, '这段对话还有一条正在处理的提问。')
    if (claim.kind === 'conflict') throw new RouterWorkspaceError(409, '请求编号已用于其他操作。')
    if (claim.kind === 'started')
      await this.track(
        this.answer(context, claim.turn, claim.attempt, cardAction, undefined, choice),
      )
    return this.get(scope)
  }

  private async answer(
    context: ReturnType<RouterWorkspaceService['context']>,
    turn: TriggerConversationTurn,
    attempt: number,
    cardAction?: CardAction,
    im?: ImTurn,
    choice?: DecisionChoice,
  ) {
    const { event, route, settings, task } = context
    const scope = im?.scope ?? context.scope
    const conversations = this.store.conversations
    const toolSteps: NonNullable<TriggerConversationAnswer['toolSteps']> = []
    const history = conversations.list(scope, 20, turn.id)
    const actor = im?.actor ?? 'web'
    const personalScope = im?.scope ?? 'general'
    const mainUserTurn = context.scope === 'general' && !cardAction
    const work =
      context.scope === 'general'
        ? createRouterWorkTurn(
            this.integrations,
            this.store,
            personalScope,
            actor,
            turn,
            history,
            () => !this.stop.signal.aborted && (!im || im.authorized()),
          )
        : undefined
    try {
      if (cardAction === 'choose_option') {
        // The click is answered from stored records alone; no Router model call is made.
        if (!work || !choice || im) throw new TriggerAgentError('这项操作不属于当前对话。')
        const job = await work.chooseOption(choice, this.stop.signal)
        const answer = work.protect({ job, text: jobReply(job) })
        if (!conversations.finish(scope, turn.requestId, attempt, answer))
          throw new RouterWorkspaceError(409, '本次操作已失效，请刷新对话。')
        return
      }
      if (!task && (cardAction === 'inspect_github' || cardAction === 'compare_runs') && event) {
        const investigator = this.integrations.investigator
        if (!investigator) throw new InvestigationError('GitHub 调查当前不可用。')
        const investigation = await investigator.inspect(event, cardAction, this.stop.signal)
        const answer: TriggerConversationAnswer = {
          investigation,
          text:
            investigation.kind === 'jobs'
              ? '已核对本次尝试的作业和步骤。仅凭失败位置无法确定根因。'
              : investigation.kind === 'history'
                ? '已核对这次运行可比较的历史记录。'
                : '已核对该 PR 和触发事件的原评论。',
        }
        if (!conversations.finish(scope, turn.requestId, attempt, answer))
          throw new RouterWorkspaceError(409, '本次调查已失效，请刷新对话。')
        return
      }
      const sources = this.store.getSettings().settings
      let investigation: GithubInvestigation | undefined
      const previewRoute = !task && this.routing.previewCurrentRoute?.bind(this.routing)
      const investigator = !task && event && this.integrations.investigator
      const actions: NonNullable<RouterAgentInput['actions']> = {
        ...(mainUserTurn && work?.actions),
        onToolStep(name, ok) {
          if (toolSteps.length < 8) toolSteps.push({ name, ok })
        },
        ...(previewRoute && { previewRoute }),
        ...(investigator &&
          event &&
          investigator.available(event).length > 0 && {
            inspectGithub: async (action, signal) => {
              if (!investigator.available(event).includes(action))
                throw new InvestigationError('当前事件未提供此项调查。')
              investigation = await investigator.inspect(event, action, signal)
              return investigation
            },
          }),
      }
      const result = await this.ask(
        {
          sessionId: typeof scope === 'string' ? `router-${scope}` : `router-event-${scope}`,
          ...(im && { imPlatform: im.platform }),
          actions,
          task,
          question: turn.question,
          history: history.map((saved) =>
            publicTurn(
              work ? visibleWorkTurn(saved, actor, personalScope, this.integrations) : saved,
            ),
          ),
          event,
          route,
          settings: botRoutingPreferences(settings.settings),
          personalBots: task ? [] : this.routing.listPersonalBots(),
          subscriptions: {
            github: sources.github.repositories.filter((r) => r.enabled).length,
            wxarc: sources.wxarc.sessions.filter((s) => s.enabled).length,
          },
        },
        this.stop.signal,
      )
      if (im && !im.authorized()) throw new TriggerAgentError('机器人授权已变更。')
      // Model output cannot mint receipts, investigation findings or tool history.
      const answer: TriggerConversationAnswer = work?.verified(result) ?? {
        text: result.text,
        ...(result.intent && { intent: result.intent }),
        ...(result.points && { points: result.points }),
        ...(investigation && { investigation }),
      }
      if (task && !this.context(context.scope).task?.active) {
        conversations.fail(scope, turn.requestId, attempt, '这项任务的委托或来源授权已撤销。')
        throw new RouterWorkspaceError(409, '这项任务的委托或来源授权已撤销。')
      }
      if (
        !conversations.finish(scope, turn.requestId, attempt, {
          ...(work?.protect(answer) ?? answer),
          toolSteps,
        })
      )
        throw new RouterWorkspaceError(409, '本次回答已失效，请刷新对话。')
    } catch (error) {
      if (error instanceof RouterWorkspaceError) throw error
      const completedWork = work?.verified()
      if (work && completedWork && (!im || im.authorized())) {
        try {
          const answer = work.protect(completedWork)
          if (conversations.finish(scope, turn.requestId, attempt, { ...answer, toolSteps })) return
        } catch (accessError) {
          if (!(accessError instanceof TriggerAgentError)) throw accessError
        }
      }
      const detail =
        error instanceof TriggerAgentError || error instanceof InvestigationError
          ? error.message
          : 'Router 未能完成回答，请重试。'
      conversations.fail(scope, turn.requestId, attempt, detail)
      throw new RouterWorkspaceError(502, detail)
    }
  }

  async action(scope: Scope, requestId: string, raw: unknown, retry = false) {
    this.requireReady()
    if (!isRouterSurfaceAction(raw)) throw new RouterWorkspaceError(400, '无效的卡片操作。')
    const { name, surfaceId, sourceComponentId } = raw.action
    const receipt = JSON.stringify([surfaceId, sourceComponentId, name])
    const saved = this.store.conversations.getActionIdentity(scope, requestId)
    if (saved !== null) {
      if (saved !== receipt) throw new RouterWorkspaceError(409, '请求编号已用于其他操作。')
      return this.get(scope)
    }
    // An answered decision no longer renders its buttons; replaying the same click returns its turn.
    const answered = name === 'choose_option' && this.store.conversations.get(scope, requestId)
    if (answered && answered.status !== 'failed' && answered.question.startsWith('选择：'))
      return this.get(scope)
    const snapshot = this.get(scope)
    if (snapshot.task && !snapshot.task.active)
      throw new RouterWorkspaceError(409, '此任务已归档，只能查看已有对话。')
    if (snapshot.task && name !== 'explain_route' && name !== 'suggest_next')
      throw new RouterWorkspaceError(409, '这项操作不属于当前任务对话。')
    const turn = snapshot.turns.find((t) => t.surface?.[0].createSurface.surfaceId === surfaceId)
    const surface = turn?.surface ?? snapshot.surface
    if (!matchesRouterSurfaceAction(surface, raw))
      throw new RouterWorkspaceError(409, '这张卡片上的操作已失效，请刷新后重试。')

    if (name === 'choose_option') {
      const job = turn?.answer?.job
      const index = Number(sourceComponentId.slice('btn-choose_option-'.length))
      const decision = job?.status === 'completed' && !job.continued && job.report?.decision
      const option = decision ? decision.options[index] : undefined
      if (scope !== 'general' || !job || option === undefined)
        throw new RouterWorkspaceError(409, '这个问题已经回答过或已失效，请刷新后查看。')
      return this.runTurn(scope, requestId, `选择：${option}`, retry, name, {
        jobId: job.id,
        attempt: job.attempt,
        option: index,
      })
    }
    if (name === 'inspect_github' || name === 'compare_runs') {
      return this.runTurn(scope, requestId, inspectionQuestions[name], retry, name)
    }
    if (name === 'explain_route' || name === 'suggest_next') {
      const subject = turn?.answer ? `针对第 ${turn.id} 条答复，` : ''
      const question =
        name === 'explain_route'
          ? scope === 'general'
            ? '请解释当前通知规则和不同情境下的去向。'
            : snapshot.task
              ? '请结合本委托的规则与最近的投递记录，解释该任务的通知去向。'
              : '请结合这条事件的记录，解释 Router 的决定。'
          : '根据目前已知的信息，接下来可以怎么做？'
      return this.runTurn(scope, requestId, subject + question, retry, name)
    }
    const result = this.store.conversations.applyActionOnce(scope, requestId, receipt, () => {
      if (
        typeof scope !== 'number' ||
        name !== 'process_event' ||
        this.routing.process(scope) !== 'accepted'
      )
        throw new RouterWorkspaceError(409, '当前事件无法再次提交。')
    })
    if (result === 'conflict') throw new RouterWorkspaceError(409, '请求编号已用于其他操作。')
    return this.get(scope)
  }
}
