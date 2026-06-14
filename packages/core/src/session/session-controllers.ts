import type { ListedModelPool, ModelRegistry, ModelRouter, ResolvedModel } from '@zero-os/model'
import type {
  ChannelCapabilities,
  Message,
  ReasoningEffort,
  Session as SessionData,
  TimelineCompactionBlock,
} from '@zero-os/shared'
import { now } from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'
import type { ToolRegistry } from '../tool/registry'
import type {
  SessionConversationState,
  SessionTailRollbackResult,
} from './session-conversation-state'
import { SessionStaticContextProvider } from './session-static-context'
import type { ReasoningEffortUpdateResult, SessionDeps } from './session-types'

export interface SessionModelListGroup {
  model: string
  members?: string[]
}

export interface SessionControllerBundle {
  channelContext: SessionChannelContextController
  clientState: SessionClientStateController
  runtimeRefresh: SessionRuntimeRefreshCoordinator
  staticContext: SessionStaticContextProvider
  tailRepair: SessionTailRepairController
}

export function createSessionControllers(options: {
  data: SessionData
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  conversation: SessionConversationState
  getAgentConfig(): AgentConfig | null
  getActiveModel(): ResolvedModel | undefined
  canRefreshAgent(): boolean
  isTurnInProgress(): boolean
  reinitializeAgent(): void
  persistState(): void
}): SessionControllerBundle {
  const refs: {
    runtimeRefresh?: SessionRuntimeRefreshCoordinator
    staticContext?: SessionStaticContextProvider
  } = {}

  const channelContext = new SessionChannelContextController({
    data: options.data,
    persistState: () => options.persistState(),
    requestAgentRefresh: () => getRuntimeRefresh(refs).requestRefresh(),
    onCapabilitiesChanged: () => getStaticContext(refs).invalidatePrompt(),
  })

  const staticContext = new SessionStaticContextProvider({
    data: options.data,
    modelRouter: options.modelRouter,
    toolRegistry: options.toolRegistry,
    deps: options.deps,
    getAgentConfig: () => options.getAgentConfig(),
    getActiveModel: () => options.getActiveModel(),
    getChannelCapabilities: () => channelContext.getCapabilities(),
  })
  refs.staticContext = staticContext

  const clientState = new SessionClientStateController({
    data: options.data,
    modelRouter: options.modelRouter,
    deps: options.deps,
    conversation: options.conversation,
    staticContext,
    persistState: () => options.persistState(),
  })

  const tailRepair = new SessionTailRepairController({
    data: options.data,
    deps: options.deps,
    conversation: options.conversation,
    isTurnInProgress: () => options.isTurnInProgress(),
    persistState: () => options.persistState(),
  })

  const runtimeRefresh = new SessionRuntimeRefreshCoordinator({
    deps: options.deps,
    canRefreshAgent: () => options.canRefreshAgent(),
    isTurnInProgress: () => options.isTurnInProgress(),
    reinitializeAgent: () => options.reinitializeAgent(),
  })
  refs.runtimeRefresh = runtimeRefresh

  return {
    channelContext,
    clientState,
    runtimeRefresh,
    staticContext,
    tailRepair,
  }
}

export class SessionChannelContextController {
  private capabilities?: ChannelCapabilities

  constructor(
    private readonly options: {
      data: SessionData
      persistState(): void
      requestAgentRefresh(): void
      onCapabilitiesChanged(): void
    },
  ) {}

  setCapabilities(capabilities: ChannelCapabilities): void {
    this.capabilities = capabilities
    this.options.onCapabilitiesChanged()
  }

  getCapabilities(): ChannelCapabilities | undefined {
    return this.capabilities
  }

  ensure(channelId: string, channelName?: string, participantId?: string): void {
    ensureSessionChannelContext({
      data: this.options.data,
      channelId,
      channelName,
      participantId,
      persistState: this.options.persistState,
      requestAgentRefresh: this.options.requestAgentRefresh,
    })
  }
}

export class SessionClientStateController {
  constructor(
    private readonly options: {
      data: SessionData
      modelRouter: ModelRouter
      deps: SessionDeps
      conversation: SessionConversationState
      staticContext: SessionStaticContextProvider
      persistState(): void
    },
  ) {}

  listModels(): string[] {
    return this.options.modelRouter
      .getRegistry()
      .listModels()
      .map((model) => `${model.providerName}/${model.modelName}`)
  }

  listModelGroups(): SessionModelListGroup[] {
    return listSessionModelGroups(this.options.modelRouter.getRegistry())
  }

  getReasoningEffort(): ReasoningEffort | undefined {
    return this.options.data.reasoningEffort
  }

  setReasoningEffort(effort?: ReasoningEffort): ReasoningEffortUpdateResult {
    return updateSessionReasoningEffort({
      data: this.options.data,
      deps: this.options.deps,
      effort,
      persistState: () => this.options.persistState(),
    })
  }

  getSystemPrompt(): string {
    return this.options.staticContext.getLastSystemPrompt()
  }

  getMessages(): Message[] {
    return this.options.conversation.getMessagesSnapshot()
  }

  getTimelineCompactionBlocks(): TimelineCompactionBlock[] {
    return this.options.conversation.getTimelineCompactionBlocksSnapshot()
  }
}

interface SessionRuntimeRefreshCoordinatorOptions {
  deps: SessionDeps
  canRefreshAgent(): boolean
  isTurnInProgress(): boolean
  reinitializeAgent(): void
}

export class SessionRuntimeRefreshCoordinator {
  private pendingAgentRefresh = false

  constructor(private readonly options: SessionRuntimeRefreshCoordinatorOptions) {}

  clearPending(): void {
    this.pendingAgentRefresh = false
  }

  applyPending(): void {
    if (!this.pendingAgentRefresh) return
    this.pendingAgentRefresh = false
    this.options.reinitializeAgent()
  }

  requestRefresh(): void {
    if (!this.options.canRefreshAgent()) return
    if (this.options.isTurnInProgress()) {
      this.pendingAgentRefresh = true
      return
    }
    this.options.reinitializeAgent()
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.options.deps.taskClosureModel = taskClosureModel
    this.requestRefresh()
  }

  setContextCompactionModels(models: { contextCompactionModel?: string }): void {
    this.options.deps.contextCompactionModel = models.contextCompactionModel
    this.requestRefresh()
  }
}

export class SessionTailRepairController {
  constructor(
    private readonly options: {
      data: SessionData
      deps: SessionDeps
      conversation: SessionConversationState
      isTurnInProgress(): boolean
      persistState(): void
    },
  ) {}

  rollbackTailMessages(
    count: number,
    options: { dryRun?: boolean; reason?: string } = {},
  ): SessionTailRollbackResult {
    return this.options.conversation.rollbackTailMessages({
      count,
      dryRun: options.dryRun,
      reason: options.reason,
      isTurnInProgress: () => this.options.isTurnInProgress(),
      onApplied: ({ removeCount, reason }) => {
        this.options.data.updatedAt = now()
        this.options.persistState()
        this.options.deps.bus?.emit('session:update', {
          sessionId: this.options.data.id,
          event: 'message_tail_rollback',
          messageCount: this.options.conversation.messageCount,
          removedCount: removeCount,
          reason: reason ?? null,
        })
      },
    })
  }
}

function updateSessionReasoningEffort(options: {
  data: SessionData
  deps: SessionDeps
  effort?: ReasoningEffort
  persistState(): void
}): ReasoningEffortUpdateResult {
  if (options.data.reasoningEffort === options.effort) {
    return {
      changed: false,
      message: options.effort
        ? `Thinking effort already set to ${options.effort} for this session.`
        : 'Thinking effort already using provider default for this session.',
    }
  }

  options.data.reasoningEffort = options.effort
  options.data.updatedAt = now()
  options.persistState()

  options.deps.bus?.emit('session:update', {
    sessionId: options.data.id,
    event: 'reasoning_effort_changed',
    reasoningEffort: options.effort ?? null,
  })

  return {
    changed: true,
    message: options.effort
      ? `Thinking effort set to ${options.effort} for this session.`
      : 'Thinking effort reset to provider default for this session.',
  }
}

function ensureSessionChannelContext(options: {
  data: SessionData
  channelId: string
  channelName?: string
  participantId?: string
  persistState(): void
  requestAgentRefresh(): void
}): boolean {
  if (
    options.data.channelId === options.channelId &&
    options.data.channelName === options.channelName &&
    options.data.participantId === options.participantId
  ) {
    return false
  }

  options.data.channelId = options.channelId
  options.data.channelName = options.channelName
  options.data.participantId = options.participantId
  options.data.updatedAt = now()
  options.persistState()

  options.requestAgentRefresh()
  return true
}

function listSessionModelGroups(registry: ModelRegistry): SessionModelListGroup[] {
  const pools = registry.listModelPools()
  const poolNames = new Set(pools.map((pool) => pool.name))
  const memberNames = new Set(pools.flatMap((pool) => pool.members.map((member) => member.model)))

  const groupedPools = pools.map((pool) => ({
    model: pool.name,
    members: formatPoolMembers(pool),
  }))

  const standaloneModels = registry
    .listModels()
    .map((model) => `${model.providerName}/${model.modelName}`)
    .filter((model) => !poolNames.has(model) && !memberNames.has(model))
    .map((model) => ({ model }))

  return [...groupedPools, ...standaloneModels]
}

function formatPoolMembers(pool: ListedModelPool): string[] {
  return pool.members.map((member) => member.model)
}

function getRuntimeRefresh(refs: {
  runtimeRefresh?: SessionRuntimeRefreshCoordinator
}): SessionRuntimeRefreshCoordinator {
  if (!refs.runtimeRefresh) throw new Error('Session runtime refresh controller is not initialized')
  return refs.runtimeRefresh
}

function getStaticContext(refs: {
  staticContext?: SessionStaticContextProvider
}): SessionStaticContextProvider {
  if (!refs.staticContext) throw new Error('Session static context controller is not initialized')
  return refs.staticContext
}
