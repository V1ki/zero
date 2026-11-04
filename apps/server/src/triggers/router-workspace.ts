import type { TriggerStore } from '@zero-os/observe'
import {
  type GithubInvestigationAction,
  type RouterWorkspaceSnapshot,
  type RouterWorkspaceTask,
  type TriggerConversationAnswer,
  type TriggerConversationScope,
  type TriggerConversationTurn,
  type TriggerRoutingSettingsSnapshot,
  isRouterSurfaceAction,
  matchesRouterSurfaceAction,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { type GithubInvestigator, InvestigationError } from './investigation'
import { MandateInputError } from './mandate-input'
import type { createRouterAgent } from './router-agent'
import type { RouterCommissionService } from './router-commission'
import { buildRouterReplySurface, buildRouterSurface } from './router-surface'
import type { TriggerRoutingRuntime } from './routing-runtime'

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
type Routing = Pick<TriggerRoutingRuntime, 'getConfig' | 'saveConfig' | 'listTargets' | 'process'>

export class RouterWorkspaceService {
  private started = false
  private readonly stop = new AbortController()
  private readonly jobs = new Set<Promise<void>>()

  constructor(
    private readonly store: TriggerStore,
    private readonly routing: Routing,
    private readonly ask: ReturnType<typeof createRouterAgent>,
    private readonly integrations: {
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
  }

  async close() {
    this.stop.abort()
    await Promise.allSettled(this.jobs)
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
    const turns = this.store.conversations.list(scope)
    const target = context.settings.settings.weixinTarget
    const weixinAvailable =
      !!target &&
      turns.some((turn) => turn.answer?.proposal?.value === 'weixin') &&
      this.routing
        .listTargets()
        .some((option) => option.channelId === target.channelId && option.peerId === target.peerId)
    return {
      ...context,
      surface: buildRouterSurface(
        scope,
        context.event,
        context.route,
        context.settings.settings,
        !context.task && context.event && this.integrations.investigator
          ? this.integrations.investigator.available(context.event)
          : [],
        context.task,
      ),
      turns: turns.map((turn) => ({
        ...turn,
        surface: turn.answer
          ? buildRouterReplySurface(
              scope,
              turn.id,
              turn.answer,
              context.settings.revision,
              weixinAvailable,
              turn.answer.commission && this.commission?.status('web', turn.answer.commission.code),
            )
          : null,
      })),
    }
  }

  private requireReady() {
    if (!this.started || this.stop.signal.aborted)
      throw new RouterWorkspaceError(503, 'Router 服务正在启动或关闭，请稍后重试。')
  }

  async message(scope: Scope, requestId: string, question: string, retry = false) {
    this.requireReady()
    const context = this.context(scope)
    if (context.task && !context.task.active)
      throw new RouterWorkspaceError(409, '此任务已归档，只能查看已有对话。')
    const claim = this.store.conversations.begin(scope, requestId, question, retry)
    if (claim.kind === 'busy')
      throw new RouterWorkspaceError(409, '这段对话还有一条正在处理的提问。')
    if (claim.kind === 'conflict') throw new RouterWorkspaceError(409, '请求编号已用于其他操作。')
    if (claim.kind === 'started') {
      const work = this.answer(context, claim.turn, claim.attempt)
      this.jobs.add(work)
      try {
        await work
      } finally {
        this.jobs.delete(work)
      }
    }
    return this.get(scope)
  }

  private async answer(
    context: ReturnType<RouterWorkspaceService['context']>,
    turn: TriggerConversationTurn,
    attempt: number,
  ) {
    const { scope, event, route, settings, task } = context
    const conversations = this.store.conversations
    try {
      const action = (Object.keys(inspectionQuestions) as GithubInvestigationAction[]).find(
        (key) => inspectionQuestions[key] === turn.question,
      )
      if (!task && action && event) {
        const investigator = this.integrations.investigator
        if (!investigator) throw new InvestigationError('GitHub 调查当前不可用。')
        const investigation = await investigator.inspect(event, action, this.stop.signal)
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
      const proposed =
        scope === 'general' && this.commission
          ? await this.commission.prepare('web', turn.requestId, turn.question, this.stop.signal)
          : null
      const reply =
        proposed ??
        (await this.ask(
          {
            sessionId: typeof scope === 'string' ? `router-${scope}` : `router-event-${scope}`,
            task,
            question: turn.question,
            history: conversations.list(scope, 20, turn.id),
            event,
            route,
            settings: settings.settings,
            subscriptions: {
              github: sources.github.repositories.filter((r) => r.enabled).length,
              wxarc: sources.wxarc.sessions.filter((s) => s.enabled).length,
            },
          },
          this.stop.signal,
        ))
      if (task && !this.context(scope).task?.active) {
        conversations.fail(scope, turn.requestId, attempt, '这项任务的委托或来源授权已撤销。')
        throw new RouterWorkspaceError(409, '这项任务的委托或来源授权已撤销。')
      }
      // Pin confirmation to the snapshot the Agent actually saw, even if preferences changed mid-turn.
      const answer =
        task && (reply.proposal || reply.commission)
          ? { text: '任务对话用于跟进当前委托。若要修改全局设置，请打开 Router 主对话。' }
          : reply.proposal
            ? { ...reply, proposalRevision: settings.revision }
            : reply
      if (!conversations.finish(scope, turn.requestId, attempt, answer))
        throw new RouterWorkspaceError(409, '本次回答已失效，请刷新对话。')
    } catch (error) {
      if (error instanceof RouterWorkspaceError) throw error
      const detail =
        error instanceof TriggerAgentError ||
        error instanceof MandateInputError ||
        error instanceof InvestigationError
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
    const snapshot = this.get(scope)
    if (snapshot.task && !snapshot.task.active)
      throw new RouterWorkspaceError(409, '此任务已归档，只能查看已有对话。')
    if (snapshot.task && name !== 'explain_route' && name !== 'suggest_next')
      throw new RouterWorkspaceError(409, '这项操作不属于当前任务对话。')
    const turn = snapshot.turns.find((t) => t.surface?.[0].createSurface.surfaceId === surfaceId)
    const surface = turn?.surface ?? snapshot.surface
    if (!matchesRouterSurfaceAction(surface, raw))
      throw new RouterWorkspaceError(409, '这张卡片上的操作已失效，请刷新后重试。')

    if (name === 'inspect_github' || name === 'compare_runs') {
      return this.message(scope, requestId, inspectionQuestions[name], retry)
    }
    if (name === 'explain_route' || name === 'suggest_next') {
      const subject = turn?.answer ? `针对答复「${turn.answer.text.slice(0, 180)}」，` : ''
      const question =
        name === 'explain_route'
          ? scope === 'general'
            ? '请解释当前通知规则和不同情境下的去向。'
            : snapshot.task
              ? '请结合本委托的规则与最近的投递记录，解释该任务的通知去向。'
              : '请结合这条事件的记录，解释 Router 的决定。'
          : '根据目前已知的信息，接下来可以怎么做？'
      return this.message(scope, requestId, subject + question, retry)
    }
    if (name === 'confirm_mandate') {
      if (scope !== 'general' || !turn?.answer?.commission || !this.commission)
        throw new RouterWorkspaceError(409, '没有可确认的委托草案。')
      await this.commission.confirm('web', turn.answer.commission.code, () => {
        if (
          this.store.conversations.applyActionOnce(scope, requestId, receipt, () => {}) ===
          'conflict'
        )
          throw new RouterWorkspaceError(409, '请求编号已用于其他操作。')
      })
      return this.get(scope)
    }
    const result = this.store.conversations.applyActionOnce(scope, requestId, receipt, () => {
      if (name === 'apply_preference') {
        this.applyPreference(scope, snapshot.settings, turn)
        return
      }
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

  private applyPreference(
    scope: Scope,
    previous: TriggerRoutingSettingsSnapshot,
    turn?: TriggerConversationTurn,
  ) {
    const answer = turn?.answer
    const proposal = answer?.proposal
    if (
      !turn ||
      !proposal ||
      answer.proposalAppliedAt ||
      answer.proposalRevision !== previous.revision
    )
      throw new RouterWorkspaceError(409, '通知规则已更新，请重新提出修改。')
    if (proposal.value === 'weixin') {
      const target = previous.settings.weixinTarget
      if (
        !target ||
        !this.routing
          .listTargets()
          .some(
            (option) => option.channelId === target.channelId && option.peerId === target.peerId,
          )
      ) {
        throw new RouterWorkspaceError(409, '请先在通知配置中绑定可用的微信私聊。')
      }
    }
    this.routing.saveConfig(
      { ...previous.settings, [proposal.key]: proposal.value },
      previous.revision,
    )
    this.store.conversations.markProposalApplied(scope, turn.requestId, new Date().toISOString())
  }
}
