import type { ModelRouter, ModelSwitchResult, ResolvedModel } from '@zero-os/model'
import type { SessionDB } from '@zero-os/observe'
import type {
  ChannelCapabilities,
  Message,
  MessageChannelSource,
  ReasoningEffort,
  RunningToolAbortRequestStatus,
  Session as SessionData,
  SessionSource,
  TimelineCompactionBlock,
  ToolLogger,
} from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import type { Agent, AgentConfig } from '../agent/agent'
import type { AgentSnapshot } from '../agent/agent-control'
import { allocateBudget } from '../agent/budget'
import { estimateConversationTokens } from '../agent/context'
import type { ToolRegistry } from '../tool/registry'
import type { BackgroundToolCompletionEvent } from './background-tool-tasks'
import {
  SessionAgentRuntimeController,
  type SessionAgentRuntimeInitOptions,
} from './session-agent-controller'
import {
  type SessionControllerBundle,
  type SessionModelListGroup,
  createSessionControllers,
} from './session-controllers'
import {
  SessionConversationState,
  type SessionMessageRecallResult,
  type SessionTailRollbackResult,
} from './session-conversation-state'
import { isTopLevelUserTurn } from './session-messages'
import { persistSessionMetadata, persistSessionState } from './session-persistence'
import { createRestoredSessionRuntime } from './session-restore'
import { allocateUniqueSessionId, createSessionLogger } from './session-runtime'
import { SessionSnapshotRecorder, buildSessionSnapshotContext } from './session-snapshots'
import type { SessionSnapshotContext } from './session-snapshots'
import type { SessionStaticContext } from './session-static-context'
import { processSessionMessageTurn } from './session-turn'
import { type SessionTurnHealth, SessionTurnRuntime } from './session-turn-runtime'
import type {
  HandleMessageOptions,
  ReasoningEffortUpdateResult,
  SessionDeps,
} from './session-types'

export type { SessionTailRollbackRemovedMessage } from './session-messages'
export type { SessionModelListGroup } from './session-controllers'
export type { SessionTailRollbackResult } from './session-conversation-state'
export type {
  HandleMessageOptions,
  ReasoningEffortUpdateResult,
  SessionDeps,
} from './session-types'

/**
 * Session — manages the lifecycle of a single conversation.
 */
export class Session {
  readonly data: SessionData
  private modelRouter: ModelRouter
  private toolRegistry: ToolRegistry
  private activeModel: ResolvedModel | undefined
  private deps: SessionDeps
  private logger: ToolLogger
  private agentRuntime: SessionAgentRuntimeController
  private controllers: SessionControllerBundle
  private conversation: SessionConversationState
  private turnRuntime = new SessionTurnRuntime()
  private snapshotRecorder: SessionSnapshotRecorder

  constructor(
    source: SessionSource,
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    deps: SessionDeps = {},
    initialModel?: string,
    sessionId?: string,
  ) {
    const sessionState = createSessionData({
      source,
      modelRouter,
      initialModel,
      sessionId,
      sessionDb: deps.sessionDb,
    })
    this.data = sessionState.data
    this.modelRouter = modelRouter
    this.toolRegistry = toolRegistry
    this.activeModel = sessionState.activeModel
    this.deps = deps
    this.conversation = new SessionConversationState()
    this.logger = createSessionLogger({
      sessionId: this.data.id,
      tracer: this.deps.tracer,
      secretFilter: this.deps.secretFilter,
    })
    this.agentRuntime = new SessionAgentRuntimeController({
      data: this.data,
      modelRouter: this.modelRouter,
      toolRegistry: this.toolRegistry,
      deps: this.deps,
      logger: this.logger,
      onBackgroundToolCompletion: (event) => this.handleBackgroundToolCompletion(event),
    })
    this.snapshotRecorder = new SessionSnapshotRecorder({
      sessionId: this.data.id,
      observability: this.deps.observability,
      tracer: this.deps.tracer,
      getAgentName: () => this.getAgentName(),
    })
    this.controllers = createSessionControllers({
      data: this.data,
      modelRouter: this.modelRouter,
      toolRegistry: this.toolRegistry,
      deps: this.deps,
      conversation: this.conversation,
      getAgentConfig: () => this.agentRuntime.getAgentConfig(),
      getActiveModel: () => this.activeModel,
      canRefreshAgent: () => this.agentRuntime.canRefresh(),
      isTurnInProgress: () => this.isTurnInProgress(),
      reinitializeAgent: () => this.reinitializeAgent(),
      persistState: () => this.persistState(),
    })

    // Emit session:create event
    this.deps.bus?.emit('session:create', {
      sessionId: this.data.id,
      source,
      model: this.data.currentModel,
    })

    // Persist session metadata to DB
    persistSessionMetadata({
      sessionDb: this.deps.sessionDb,
      data: this.data,
    })
  }

  /**
   * Initialize the agent for this session.
   */
  /**
   * Set channel capabilities to be injected into the agent's system prompt.
   * Call before initAgent() or handleMessage() so the agent knows what the channel supports.
   */
  setChannelCapabilities(capabilities: ChannelCapabilities): void {
    this.controllers.channelContext.setCapabilities(capabilities)
  }

  setBackgroundToolCompletionHandler(
    handler: SessionDeps['backgroundToolCompletionHandler'],
  ): void {
    this.deps.backgroundToolCompletionHandler = handler
  }

  isAgentInitialized(): boolean {
    return this.agentRuntime.isInitialized()
  }

  initAgent(config: AgentConfig): void {
    this.controllers.staticContext.resetForAgentConfig()
    this.agentRuntime.init(config, this.buildAgentRuntimeInitOptions())
    this.controllers.runtimeRefresh.clearPending()

    // Persist session with agent config
    persistSessionMetadata({
      sessionDb: this.deps.sessionDb,
      data: this.data,
      agentConfig: config,
      systemPrompt: this.controllers.staticContext.getLastSystemPrompt() || undefined,
    })
  }

  /**
   * Handle a user message.
   */
  async handleMessage(content: string, options?: HandleMessageOptions): Promise<Message[]> {
    return handleSessionMessageEntry({
      content,
      handleOptions: options,
      agent: this.agentRuntime.getAgent(),
      turnRuntime: this.turnRuntime,
      messages: this.conversation.messages,
      sessionData: this.data,
      deps: this.deps,
      logger: this.logger,
      applyPendingAgentRefresh: () => this.controllers.runtimeRefresh.applyPending(),
      processMessage: (message, turnOptions) => this.processMessage(message, turnOptions),
      persistState: () => this.persistState(),
    })
  }

  private async handleBackgroundToolCompletion(
    event: BackgroundToolCompletionEvent,
  ): Promise<void> {
    const run = (options?: HandleMessageOptions) =>
      this.handleMessage(event.xml, {
        ...options,
        messageType: 'control',
        controlKind: 'background_tool_completed',
      })

    const handled = await this.deps.backgroundToolCompletionHandler?.(event, run)
    if (handled) return

    await run()
  }

  async evaluateSessionMemory(prompt: string): Promise<void> {
    if (!this.agentRuntime.isInitialized()) return

    await evaluateSessionMemoryTurn({
      sessionId: this.data.id,
      agentName: this.getAgentName(),
      prompt,
      deps: this.deps,
      handleMessage: (message) => this.handleMessage(message),
    })
  }

  private getAgentName(): string {
    return this.agentRuntime.getAgentName()
  }

  private ensureStaticContext(): SessionStaticContext {
    return this.controllers.staticContext.ensure()
  }

  private getCurrentSnapshotContext(
    toolNames = this.controllers.staticContext.getCachedToolNames(),
  ): SessionSnapshotContext | null {
    return buildSessionSnapshotContext({
      activeModel: this.activeModel,
      modelRouter: this.modelRouter,
      systemPrompt: this.controllers.staticContext.getLastSystemPrompt(),
      toolNames,
      identityMemory: this.deps.identityMemory,
    })
  }

  private async processMessage(
    content: string,
    options?: HandleMessageOptions,
  ): Promise<Message[]> {
    const newMessages = await processSessionMessageTurn({
      content,
      options,
      sessionData: this.data,
      agent: this.agentRuntime.getAgent(),
      activeModel: this.activeModel,
      lastAgentConfig: this.agentRuntime.getAgentConfig(),
      deps: this.deps,
      logger: this.logger,
      modelRouter: this.modelRouter,
      staticContext: this.controllers.staticContext,
      snapshotRecorder: this.snapshotRecorder,
      messages: this.conversation.messages,
      timelineCompactionBlocks: this.conversation.timelineCompactionBlocks,
      injectedMemoryIds: this.conversation.injectedMemoryIds,
      getAgentName: () => this.getAgentName(),
      getCurrentSnapshotContext: (toolNames) => this.getCurrentSnapshotContext(toolNames),
      turnRuntime: this.turnRuntime,
      setTimelineCompactionBlocks: (blocks) => {
        this.conversation.replaceTimelineCompactionBlocks(blocks)
      },
    })

    // Emit session:update
    this.deps.bus?.emit('session:update', {
      sessionId: this.data.id,
      event: 'message_handled',
      messageCount: this.conversation.messageCount,
    })

    return newMessages
  }

  /**
   * Handle session commands (/new, /model, etc.).
   */
  async switchModel(target: string): Promise<ModelSwitchResult> {
    return switchSessionModel({
      target,
      data: this.data,
      modelRouter: this.modelRouter,
      deps: this.deps,
      messages: this.conversation.messages,
      lastAgentConfig: this.agentRuntime.getAgentConfig(),
      snapshotRecorder: this.snapshotRecorder,
      setActiveModel: (model) => {
        this.activeModel = model
      },
      reinitializeAgent: () => this.reinitializeAgent(),
      ensureStaticContext: () => this.ensureStaticContext(),
      getCurrentSnapshotContext: (toolNames) => this.getCurrentSnapshotContext(toolNames),
      persistState: () => this.persistState(),
    })
  }

  listModels(): string[] {
    return this.controllers.clientState.listModels()
  }

  listModelGroups(): SessionModelListGroup[] {
    return this.controllers.clientState.listModelGroups()
  }

  getReasoningEffort(): ReasoningEffort | undefined {
    return this.controllers.clientState.getReasoningEffort()
  }

  setReasoningEffort(effort?: ReasoningEffort): ReasoningEffortUpdateResult {
    return this.controllers.clientState.setReasoningEffort(effort)
  }

  rollbackTailMessages(
    count: number,
    options: { dryRun?: boolean; reason?: string } = {},
  ): SessionTailRollbackResult {
    return this.controllers.tailRepair.rollbackTailMessages(count, options)
  }

  markExternalMessageRecalled(options: {
    source: MessageChannelSource
    recalledAt: string
    recallType?: string
  }): SessionMessageRecallResult {
    const result = this.conversation.markExternalMessageRecalled(options)
    if (result.changed) {
      this.turnRuntime.removeQueuedMessagesBySource(options.source)
      this.data.updatedAt = now()
      this.deps.bus?.emit('session:update', {
        sessionId: this.data.id,
        event: 'message_recalled',
        messageCount: this.conversation.messageCount,
        messageId: result.messageId,
      })
      this.persistState()
    }
    return result
  }

  private reinitializeAgent(): void {
    this.agentRuntime.reinitialize(this.buildAgentRuntimeInitOptions())
  }

  private buildAgentRuntimeInitOptions(): SessionAgentRuntimeInitOptions {
    return {
      activeModel: this.activeModel,
      getCurrentSnapshotId: () => this.snapshotRecorder.getCurrentSnapshotId(),
      onContextCompressed: (event) => {
        this.snapshotRecorder.logCompressionSnapshot(
          this.getCurrentSnapshotContext(),
          event.summary,
          event.stats,
          event.decisionContext,
        )
      },
    }
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.controllers.runtimeRefresh.setTaskClosureModel(taskClosureModel)
  }

  setContextCompactionModels(models: {
    contextCompactionModel?: string
  }): void {
    this.controllers.runtimeRefresh.setContextCompactionModels(models)
  }

  private persistState(): void {
    persistSessionState({
      sessionDb: this.deps.sessionDb,
      data: this.data,
      messages: this.conversation.messages,
      timelineCompactionBlocks: this.conversation.timelineCompactionBlocks,
      agentConfig: this.agentRuntime.getAgentConfig(),
      systemPrompt: this.controllers.staticContext.getLastSystemPrompt() || undefined,
    })
  }

  /**
   * Restore a session from persisted data (bypasses constructor side-effects).
   */
  static restore(
    data: SessionData,
    messages: Message[],
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    deps: SessionDeps = {},
    systemPrompt?: string,
    timelineCompactionBlocks: TimelineCompactionBlock[] = [],
  ): Session {
    const session = Object.create(Session.prototype) as Session
    Object.assign(
      session,
      createRestoredSessionRuntime({
        data,
        messages,
        modelRouter,
        toolRegistry,
        deps,
        timelineCompactionBlocks,
        getAgentName: () => session.getAgentName(),
        onBackgroundToolCompletion: (event) => session.handleBackgroundToolCompletion(event),
      }),
    )
    session.controllers = createSessionControllers({
      data: session.data,
      modelRouter: session.modelRouter,
      toolRegistry: session.toolRegistry,
      deps: session.deps,
      conversation: session.conversation,
      getAgentConfig: () => session.agentRuntime.getAgentConfig(),
      getActiveModel: () => session.activeModel,
      canRefreshAgent: () => session.agentRuntime.canRefresh(),
      isTurnInProgress: () => session.isTurnInProgress(),
      reinitializeAgent: () => session.reinitializeAgent(),
      persistState: () => session.persistState(),
    })
    session.controllers.staticContext.setLastSystemPrompt(systemPrompt ?? '')
    session.snapshotRecorder.restoreFromLogger()
    return session
  }

  getAgentConfig(): AgentConfig | null {
    return this.agentRuntime.getAgentConfig()
  }

  getSystemPrompt(): string {
    return this.controllers.clientState.getSystemPrompt()
  }

  getMessages(): Message[] {
    return this.controllers.clientState.getMessages()
  }

  getTimelineCompactionBlocks(): TimelineCompactionBlock[] {
    return this.controllers.clientState.getTimelineCompactionBlocks()
  }

  get currentSnapshotId(): string | undefined {
    return this.snapshotRecorder.getCurrentSnapshotId()
  }

  abortRunningTool(toolUseId: string): RunningToolAbortRequestStatus {
    return this.agentRuntime.abortRunningTool(this.conversation.messages, toolUseId)
  }

  getSubAgentSnapshot(): AgentSnapshot[] {
    return this.agentRuntime.getSubAgentSnapshot()
  }

  restoreSubAgentSnapshot(snapshot: AgentSnapshot[]): void {
    this.agentRuntime.restoreSubAgentSnapshot(snapshot)
  }

  ensureChannelContext(channelId: string, channelName?: string, participantId?: string): void {
    this.controllers.channelContext.ensure(channelId, channelName, participantId)
  }

  isTurnInProgress(): boolean {
    return this.turnRuntime.isTurnInProgress()
  }

  getTurnHealth(): Readonly<SessionTurnHealth> {
    return this.turnRuntime.getHealth()
  }

  isTurnStalled(idleTimeoutMs: number): boolean {
    return this.turnRuntime.isStalled(idleTimeoutMs)
  }

  requestTurnAbort(): boolean {
    return this.turnRuntime.requestAbort()
  }

  waitForTurnComplete(): Promise<void> {
    return this.turnRuntime.waitForTurnComplete()
  }

  static isTopLevelUserTurn(message: Message): boolean {
    return isTopLevelUserTurn(message)
  }
}

interface CreateSessionDataInput {
  source: SessionSource
  modelRouter: ModelRouter
  initialModel?: string
  sessionId?: string
  sessionDb?: SessionDB
}

interface CreateSessionDataResult {
  data: SessionData
  activeModel: ResolvedModel | undefined
}

function createSessionData({
  source,
  modelRouter,
  initialModel,
  sessionId,
  sessionDb,
}: CreateSessionDataInput): CreateSessionDataResult {
  const activeModel = initialModel
    ? (modelRouter.resolveModel(initialModel) ??
      modelRouter.getDefaultModel() ??
      modelRouter.getCurrentModel())
    : (modelRouter.getDefaultModel() ?? modelRouter.getCurrentModel())
  const modelLabel = activeModel ? modelRouter.getModelLabel(activeModel) : 'unknown'
  const data: SessionData = {
    id: sessionId ?? allocateUniqueSessionId(source, { sessionDb }),
    createdAt: now(),
    updatedAt: now(),
    source,
    currentModel: modelLabel,
    reasoningEffort: undefined,
    modelHistory: [
      {
        model: modelLabel,
        from: now(),
        to: null,
      },
    ],
    tags: [],
  }

  return { data, activeModel }
}

async function handleSessionMessageEntry(options: {
  content: string
  handleOptions?: HandleMessageOptions
  agent: Agent | null
  turnRuntime: SessionTurnRuntime
  messages: Message[]
  sessionData: SessionData
  deps: SessionDeps
  logger: ToolLogger
  applyPendingAgentRefresh(): void
  processMessage(content: string, options?: HandleMessageOptions): Promise<Message[]>
  persistState(): void
}): Promise<Message[]> {
  if (!options.agent) {
    throw new Error('Agent not initialized. Call initAgent() first.')
  }

  if (options.turnRuntime.isTurnInProgress()) {
    options.turnRuntime.queueMessage({
      content: options.content,
      images: options.handleOptions?.images,
      source: options.handleOptions?.source,
      messageType: options.handleOptions?.messageType,
      controlKind: options.handleOptions?.controlKind,
      messages: options.messages,
      data: options.sessionData,
      persistState: options.persistState,
      emitSessionUpdate: (event) => options.deps.bus?.emit('session:update', event),
      onApplied: options.handleOptions?.onQueuedMessageApplied,
    })
    return []
  }

  const lockId = await options.turnRuntime.acquireTurn()

  try {
    options.applyPendingAgentRefresh()
    return await options.processMessage(options.content, options.handleOptions)
  } finally {
    options.turnRuntime.releaseTurn(lockId)
    const leakState = options.turnRuntime.getLeakState()
    if (leakState.queueLength > 0 || leakState.interruptFlag) {
      options.logger.warn('queued_messages_leaked_after_turn', {
        sessionId: options.sessionData.id,
        queueLength: leakState.queueLength,
        interruptFlag: leakState.interruptFlag,
      })
    }
    options.persistState()
  }
}

async function switchSessionModel(options: {
  target: string
  data: SessionData
  modelRouter: ModelRouter
  deps: SessionDeps
  messages: Message[]
  lastAgentConfig: AgentConfig | null
  snapshotRecorder: SessionSnapshotRecorder
  setActiveModel(model: ResolvedModel): void
  reinitializeAgent(): void
  ensureStaticContext(): SessionStaticContext
  getCurrentSnapshotContext(toolNames?: string[]): SessionSnapshotContext | null
  persistState(): void
}): Promise<ModelSwitchResult> {
  const oldModel = options.data.currentModel
  const result = options.modelRouter.selectModel(options.target)
  if (!result.success || !result.model) {
    return result
  }

  const nextModelLabel = options.modelRouter.getModelLabel(result.model)
  options.setActiveModel(result.model)
  options.data.currentModel = nextModelLabel
  if (options.data.modelHistory.length > 0) {
    options.data.modelHistory[options.data.modelHistory.length - 1].to = now()
  }
  options.data.modelHistory.push({ model: nextModelLabel, from: now(), to: null })
  options.data.updatedAt = now()
  options.deps.persistModelPreference?.(nextModelLabel)

  options.deps.bus?.emit('model:switch', {
    sessionId: options.data.id,
    from: oldModel,
    to: nextModelLabel,
  })

  options.reinitializeAgent()
  if (options.lastAgentConfig) {
    const { toolNames } = options.ensureStaticContext()
    const context = options.getCurrentSnapshotContext(toolNames)
    if (context) {
      options.snapshotRecorder.writeSnapshot('model_switch', context)
    }
  }

  if (options.messages.length > 0) {
    const newBudget = allocateBudget(
      result.model.modelConfig.maxContext,
      result.model.modelConfig.maxOutput,
    )
    const currentTokens = estimateConversationTokens(options.messages)
    if (currentTokens > newBudget.conversation) {
      const { compressConversation } = await import('../agent/compress')
      const compResult = await compressConversation(
        options.messages,
        newBudget.conversation,
        result.model.adapter,
        options.data.id,
        {},
        {
          tracer: options.deps.tracer,
          agentName: options.lastAgentConfig?.name,
          providerName: result.model.providerName,
          modelLabel: options.modelRouter.getModelLabel(result.model),
          pricing: result.model.modelConfig.pricing,
          secretFilter: options.deps.secretFilter,
        },
      )
      options.messages.length = 0
      options.messages.push(...compResult.retainedMessages)
      options.snapshotRecorder.logCompressionSnapshot(
        options.getCurrentSnapshotContext(),
        compResult.summary,
        compResult.stats,
        {
          currentTokens,
          conversationBudget: newBudget.conversation,
        },
      )
    }
  }

  options.persistState()
  return result
}

async function evaluateSessionMemoryTurn(options: {
  sessionId: string
  agentName: string
  prompt: string
  deps: SessionDeps
  handleMessage: (prompt: string) => Promise<unknown>
}): Promise<void> {
  const traceSpan = options.deps.tracer?.startSpan(
    options.sessionId,
    'session_evaluate',
    undefined,
    {
      kind: 'turn',
      agentName: options.agentName,
      data: {
        sessionEvaluate: {
          prompt: options.prompt,
        },
      },
    },
  )

  try {
    await options.handleMessage(options.prompt)
    if (traceSpan) {
      options.deps.tracer?.endSpan(traceSpan.id, 'success')
    }
  } catch (error) {
    if (traceSpan) {
      options.deps.tracer?.endSpan(traceSpan.id, 'error', {
        error: toErrorMessage(error),
      })
    }
    throw error
  }
}
