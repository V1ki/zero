import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { MemoryRetriever } from '@zero-os/memory'
import type { ListedModelPool, ModelRouter, ModelSwitchResult, ResolvedModel } from '@zero-os/model'
import type {
  MetricsDB,
  ObservabilityStore,
  RequestLogEntry,
  RequestMemoryInjectionEntry,
  SessionDB,
  SnapshotEntry,
  Tracer,
} from '@zero-os/observe'
import type {
  ChannelCapabilities,
  CompressionResult,
  Message,
  ReasoningEffort,
  RunningToolAbortRequestStatus,
  SecretFilter,
  Session as SessionData,
  SessionSource,
  TimelineCompactionBlock,
  ToolDefinition,
  ToolLogger,
} from '@zero-os/shared'
import { Mutex, generateId, generateSessionId, now, toErrorMessage } from '@zero-os/shared'
import { Agent, type AgentConfig, type AgentContext, type AgentObservability } from '../agent/agent'
import { AgentControl, type AgentSnapshot } from '../agent/agent-control'
import { allocateBudget } from '../agent/budget'
import {
  estimateConversationTokens,
  sanitizeConversationHistoryForSignedThinkingToolUse,
} from '../agent/context'
import { retrieveMemoriesWithDecision } from '../agent/memory-retrieval'
import { CONTEXT_PARAMS } from '../agent/params'
import {
  buildDynamicContext,
  buildRetrievedMemoriesBlock,
  buildSystemPrompt,
  wrapMemoryInjection,
} from '../agent/prompt'
import type { QueuedMessage } from '../agent/queue'
import { buildSnapshot } from '../agent/snapshot'
import { loadBootstrapFiles } from '../bootstrap/loader'
import { loadSkills } from '../skill/loader'
import { supportsToolForModel, supportsVision } from '../tool/capabilities'
import type { ToolRegistry } from '../tool/registry'
import { createLiveDocHandle } from './live-doc'
import { SessionRunningToolRegistry } from './running-tool-registry'

/**
 * Dependencies injected into Session for observability, memory, and eventing.
 */
export interface SessionDeps {
  observability?: ObservabilityStore
  metrics?: MetricsDB
  tracer?: Tracer
  secretFilter?: SecretFilter
  secretResolver?: (ref: string) => string | undefined
  memoryRetriever?: MemoryRetriever
  memoryStore?: import('@zero-os/shared').ToolContext['memoryStore']
  identityMemory?: string
  globalIdentity?: string
  agentIdentity?: string
  identityReader?: (agentName: string) => { global: string; agent: string }
  bus?: {
    emit(topic: string, data: Record<string, unknown>): void
  }
  persistModelPreference?: (model: string) => void
  sessionDb?: SessionDB
  schedulerHandle?: import('@zero-os/shared').ToolContext['schedulerHandle']
  scheduleStore?: import('@zero-os/shared').ToolContext['scheduleStore']
  taskClosureModel?: string
  contextCompactionModel?: string
  projectRoot?: string
}

export interface SessionModelListGroup {
  model: string
  members?: string[]
}

function formatPoolMembers(pool: ListedModelPool): string[] {
  return pool.members.map((member) => member.model)
}

/**
 * Options for Session.handleMessage().
 */
export interface HandleMessageOptions {
  /** Called synchronously for every new Message (user, assistant, tool_result). */
  onProgress?: (msg: Message) => void
  /** Called for every assistant text delta when the model supports streaming. */
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  /** Image attachments (base64) to send alongside the text message. */
  images?: Array<{ mediaType: string; data: string }>
  /** Called after a queued message is injected into a later model request and that request returns. */
  onQueuedMessageApplied?: () => void
}

interface ReasoningEffortUpdateResult {
  changed: boolean
  message: string
}

interface SnapshotContext {
  model: string
  systemPrompt: string
  tools: string[]
  identityMemory?: string
}

/**
 * Session — manages the lifecycle of a single conversation.
 */
export class Session {
  readonly data: SessionData
  private messages: Message[] = []
  private timelineCompactionBlocks: TimelineCompactionBlock[] = []
  private modelRouter: ModelRouter
  private toolRegistry: ToolRegistry
  private agent: Agent | null = null
  private activeModel: ResolvedModel | undefined
  private deps: SessionDeps
  private agentControl: AgentControl
  private logger: ToolLogger
  private mutex = new Mutex()
  private interruptFlag = false
  private messageQueue: QueuedMessage[] = []
  private lastAgentConfig: AgentConfig | null = null
  private lastSystemPrompt = ''
  private cachedSystemPrompt: string | null = null
  private cachedToolNames: string[] = []
  private knownSkillNames = new Set<string>()
  private currentSnapshotId?: string
  private lastSnapshotContext: SnapshotContext | null = null
  private nextTurnIndex = 1
  private pendingAgentRefresh = false
  private injectedMemoryIds = new Map<string, string>()
  // P3a: topicKey → 本会话该主题的活文档 memoryId。纯内存态，不进 persistState；
  // 作用域是会话（跨 initAgent 重建有意保留）；restore() 必须重新初始化为空 Map。
  private liveDocs = new Map<string, string>()
  private runningToolRegistry = new SessionRunningToolRegistry()
  /** Channel capabilities for system prompt injection */
  private channelCapabilities?: ChannelCapabilities

  constructor(
    source: SessionSource,
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    deps: SessionDeps = {},
    initialModel?: string,
    sessionId?: string,
  ) {
    const currentModel = initialModel
      ? (modelRouter.resolveModel(initialModel) ??
        modelRouter.getDefaultModel() ??
        modelRouter.getCurrentModel())
      : (modelRouter.getDefaultModel() ?? modelRouter.getCurrentModel())
    const id = sessionId ?? Session.allocateSessionId(source, deps.sessionDb)
    this.data = {
      id,
      createdAt: now(),
      updatedAt: now(),
      source,
      currentModel: currentModel ? modelRouter.getModelLabel(currentModel) : 'unknown',
      reasoningEffort: undefined,
      modelHistory: [
        {
          model: currentModel ? modelRouter.getModelLabel(currentModel) : 'unknown',
          from: now(),
          to: null,
        },
      ],
      tags: [],
    }
    this.modelRouter = modelRouter
    this.toolRegistry = toolRegistry
    this.activeModel = currentModel
    this.deps = deps
    this.logger = {
      info: (event: string, data?: Record<string, unknown>) => {
        const safeData = this.filterLogData(data)
        console.log(`[${this.data.id}] ${event}`, safeData ?? '')
        this.deps.tracer?.logSession(this.data.id, 'info', 'logger.info', {
          logEvent: event,
          ...(safeData ?? {}),
        })
      },
      warn: (event: string, data?: Record<string, unknown>) => {
        const safeData = this.filterLogData(data)
        console.warn(`[${this.data.id}] ${event}`, safeData ?? '')
        this.deps.tracer?.logSession(this.data.id, 'warn', 'logger.warn', {
          logEvent: event,
          ...(safeData ?? {}),
        })
      },
      error: (event: string, data?: Record<string, unknown>) => {
        const safeData = this.filterLogData(data)
        console.error(`[${this.data.id}] ${event}`, safeData ?? '')
        this.deps.tracer?.logSession(this.data.id, 'error', 'logger.error', {
          logEvent: event,
          ...(safeData ?? {}),
        })
      },
    }
    this.agentControl = new AgentControl({
      tracer: this.deps.tracer,
      logger: this.logger,
    })

    // Emit session:create event
    this.deps.bus?.emit('session:create', {
      sessionId: this.data.id,
      source,
      model: this.data.currentModel,
    })

    // Persist session metadata to DB
    this.deps.sessionDb?.saveSession(this.data)
  }

  /**
   * Initialize the agent for this session.
   */
  /**
   * Set channel capabilities to be injected into the agent's system prompt.
   * Call before initAgent() or handleMessage() so the agent knows what the channel supports.
   */
  setChannelCapabilities(capabilities: ChannelCapabilities): void {
    this.channelCapabilities = capabilities
    this.cachedSystemPrompt = null // Force re-build on next turn
  }

  isAgentInitialized(): boolean {
    return !!this.agent
  }

  initAgent(config: AgentConfig): void {
    this.lastAgentConfig = config
    this.cachedSystemPrompt = null
    this.cachedToolNames = []
    this.knownSkillNames.clear()
    const resolved =
      this.activeModel ?? this.modelRouter.getDefaultModel() ?? this.modelRouter.getCurrentModel()
    if (!resolved) {
      throw new Error('No active model available for session.')
    }
    const adapter = resolved.adapter
    const closureResolved = this.deps.taskClosureModel
      ? this.modelRouter.resolveModel(this.deps.taskClosureModel)
      : undefined
    const closureAdapter = closureResolved?.adapter
    const contextCompactionResolved = this.deps.contextCompactionModel
      ? this.modelRouter.resolveModel(this.deps.contextCompactionModel)
      : undefined
    const contextCompactionAdapter = contextCompactionResolved?.adapter

    const projectRoot = this.deps.projectRoot ?? process.cwd()
    const workspacePath = join(projectRoot, '.zero', 'workspace', config.name)
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true })
    }

    const observabilityHandle =
      this.deps.observability && this.deps.metrics
        ? {
            logEvent: this.deps.observability.logEvent.bind(this.deps.observability),
            recordOperation: this.deps.metrics.recordOperation.bind(this.deps.metrics),
          }
        : undefined

    this.agentControl.setInstrumentation(this.deps.tracer, this.logger)

    const toolContext = {
      sessionId: this.data.id,
      currentModel: this.modelRouter.getModelLabel(resolved),
      workDir: workspacePath,
      projectRoot,
      logger: this.logger,
      tracer: this.deps.tracer,
      secretFilter: this.deps.secretFilter,
      observability: observabilityHandle,
      secretResolver: this.deps.secretResolver,
      memoryRetriever: this.deps.memoryRetriever,
      memoryStore: this.deps.memoryStore,
      channelBinding: this.data.channelId
        ? {
            source: this.data.source,
            channelName: this.data.channelName ?? this.data.source,
            channelId: this.data.channelId,
            participantId: this.data.participantId,
            deliveryChannelId: this.data.channelId,
          }
        : undefined,
      schedulerHandle: this.deps.schedulerHandle,
      scheduleStore: this.deps.scheduleStore,
      agentControl: this.agentControl,
      runningToolRegistry: this.runningToolRegistry,
      liveDocHandle: CONTEXT_PARAMS.memory.liveDocEnabled
        ? createLiveDocHandle(this.liveDocs, this.deps.memoryStore)
        : undefined,
    }

    const agentObs: AgentObservability = {
      metrics: this.deps.metrics,
      tracer: this.deps.tracer,
      secretFilter: this.deps.secretFilter,
      bus: this.deps.bus,
      providerName: resolved?.providerName,
      modelLabel: this.modelRouter.getModelLabel(resolved),
      pricing: resolved?.modelConfig.pricing,
      closureProviderName: closureResolved?.providerName,
      closureModelLabel: closureResolved
        ? this.modelRouter.getModelLabel(closureResolved)
        : undefined,
      closurePricing: closureResolved?.modelConfig.pricing,
      contextCompactionProviderName: contextCompactionResolved?.providerName,
      contextCompactionModelLabel: contextCompactionResolved
        ? this.modelRouter.getModelLabel(contextCompactionResolved)
        : undefined,
      contextCompactionPricing: contextCompactionResolved?.modelConfig.pricing,
      getCurrentSnapshotId: () => this.currentSnapshotId,
      onContextCompressed: (event) => {
        this.logCompressionSnapshot(event.summary, event.stats, event.decisionContext)
      },
    }

    this.agent = new Agent(
      config,
      adapter,
      this.toolRegistry,
      toolContext,
      agentObs,
      closureAdapter,
      contextCompactionAdapter,
    )
    this.pendingAgentRefresh = false

    // Persist session with agent config
    this.deps.sessionDb?.saveSession(
      this.data,
      JSON.stringify(config),
      this.lastSystemPrompt || undefined,
    )
  }

  /**
   * Handle a user message.
   */
  async handleMessage(content: string, options?: HandleMessageOptions): Promise<Message[]> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initAgent() first.')
    }

    // If another message is already processing, queue it instead of blocking
    if (this.mutex.isLocked()) {
      const timestamp = now()
      this.messageQueue.push({
        content,
        images: options?.images,
        timestamp,
        onApplied: options?.onQueuedMessageApplied,
      })
      this.messages.push(this.makeUserMessage(content, timestamp, options?.images, 'queued'))
      this.data.updatedAt = timestamp
      this.persistState()
      this.interruptFlag = true
      this.deps.bus?.emit('session:update', {
        sessionId: this.data.id,
        event: 'message_queued',
        messageCount: this.messages.length,
      })
      return []
    }

    const lockId = generateId()
    await this.mutex.acquire(lockId)
    this.interruptFlag = false

    try {
      if (this.pendingAgentRefresh) {
        this.pendingAgentRefresh = false
        this.reinitializeAgent()
      }
      return await this.processMessage(content, options)
    } finally {
      this.mutex.release(lockId)
      if (this.messageQueue.length > 0 || this.interruptFlag) {
        this.logger.warn('queued_messages_leaked_after_turn', {
          sessionId: this.data.id,
          queueLength: this.messageQueue.length,
          interruptFlag: this.interruptFlag,
        })
      }
      this.persistState()
    }
  }

  async evaluateSessionMemory(prompt: string): Promise<void> {
    if (!this.agent) return

    const traceSpan = this.deps.tracer?.startSpan(this.data.id, 'session_evaluate', undefined, {
      kind: 'turn',
      agentName: this.getAgentName(),
      data: {
        sessionEvaluate: {
          prompt,
        },
      },
    })

    try {
      await this.handleMessage(prompt)
      if (traceSpan) {
        this.deps.tracer?.endSpan(traceSpan.id, 'success')
      }
    } catch (error) {
      if (traceSpan) {
        this.deps.tracer?.endSpan(traceSpan.id, 'error', {
          error: toErrorMessage(error),
        })
      }
      throw error
    }
  }

  private static sameStringArray(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  private static snapshotContextFromEntry(entry?: SnapshotEntry): SnapshotContext | null {
    if (!entry?.model || !entry.systemPrompt) {
      return null
    }

    return {
      model: entry.model,
      systemPrompt: entry.systemPrompt,
      tools: entry.tools ?? [],
      identityMemory: entry.identityMemory,
    }
  }

  private getCurrentModelLabel(): string | undefined {
    const resolved =
      this.activeModel ?? this.modelRouter.getDefaultModel() ?? this.modelRouter.getCurrentModel()
    return resolved ? this.modelRouter.getModelLabel(resolved) : undefined
  }

  private getAgentName(): string {
    return this.lastAgentConfig?.name ?? 'zero'
  }

  private getToolNames(tools: ToolDefinition[]): string[] {
    return tools.map((tool) => tool.name)
  }

  private ensureStaticContext(): {
    currentModel: ResolvedModel | undefined
    tools: ToolDefinition[]
    toolNames: string[]
    systemPrompt: string
    projectRoot: string
    workspacePath: string
  } {
    const currentModel = this.activeModel
    const tools = this.getToolDefinitionsForModel(currentModel)
    const toolNames = this.getToolNames(tools)
    const agentName = this.getAgentName()
    const projectRoot = this.deps.projectRoot ?? process.cwd()
    const workspacePath = join(projectRoot, '.zero', 'workspace', agentName)

    if (!this.cachedSystemPrompt || !Session.sameStringArray(toolNames, this.cachedToolNames)) {
      const identity = this.deps.identityReader?.(agentName)
      const globalIdentity = identity?.global ?? this.deps.globalIdentity ?? ''
      const agentIdentity = identity?.agent ?? this.deps.agentIdentity ?? ''
      const promptMode = this.lastAgentConfig?.promptMode ?? 'full'

      const globalSkills = loadSkills(join(projectRoot, '.zero', 'skills'))
      const workspaceSkills = loadSkills(join(workspacePath, 'skills'))
      const skills = [...globalSkills, ...workspaceSkills]
      const bootstrapFiles = loadBootstrapFiles(workspacePath, promptMode)

      const runtimeInfo = {
        agentId: agentName,
        sessionId: this.data.id,
        host: hostname(),
        os: `${process.platform} (${process.arch})`,
        model: currentModel ? this.modelRouter.getModelLabel(currentModel) : undefined,
        shell: process.env.SHELL ?? 'zsh',
        channel: this.data.source,
        projectRoot,
        channelCapabilities: this.channelCapabilities,
      }

      this.cachedSystemPrompt = buildSystemPrompt({
        agentName,
        agentDescription:
          this.lastAgentConfig?.agentInstruction || '擅长 TypeScript 全栈开发，使用 Bun 运行时。',
        tools,
        skills,
        globalIdentity,
        agentIdentity,
        workspacePath,
        projectRoot,
        promptMode,
        bootstrapFiles,
        runtimeInfo,
      })
      this.cachedToolNames = [...toolNames]

      for (const skill of skills) this.knownSkillNames.add(skill.name)
    }

    const systemPrompt = this.cachedSystemPrompt
    this.lastSystemPrompt = systemPrompt

    return {
      currentModel,
      tools,
      toolNames,
      systemPrompt,
      projectRoot,
      workspacePath,
    }
  }

  private getCurrentSnapshotContext(toolNames = this.cachedToolNames): SnapshotContext | null {
    const model = this.getCurrentModelLabel()
    if (!model || !this.lastSystemPrompt) {
      return null
    }

    return {
      model,
      systemPrompt: this.lastSystemPrompt,
      tools: [...toolNames],
      identityMemory: this.deps.identityMemory,
    }
  }

  private writeSnapshot(
    trigger: string,
    context: SnapshotContext,
    extra: Partial<Omit<SnapshotEntry, 'id' | 'sessionId' | 'trigger' | 'ts'>> = {},
  ): string | undefined {
    if (!this.deps.observability) return undefined

    const snapshot = buildSnapshot({
      sessionId: this.data.id,
      trigger,
      model: context.model,
      systemPrompt: context.systemPrompt,
      tools: [...context.tools],
      identityMemory: context.identityMemory,
      parentSnapshot: extra.parentSnapshot ?? this.currentSnapshotId,
      compressedSummary: extra.compressedSummary,
      messagesBefore: extra.messagesBefore,
      messagesAfter: extra.messagesAfter,
      compressedRange: extra.compressedRange,
      decisionContext: extra.decisionContext,
    })

    if (!this.deps.tracer) {
      this.currentSnapshotId = snapshot.id
      this.lastSnapshotContext = {
        model: context.model,
        systemPrompt: context.systemPrompt,
        tools: [...context.tools],
        identityMemory: context.identityMemory,
      }
      return snapshot.id
    }

    const snapshotSpan = this.deps.tracer.startSpan(
      this.data.id,
      `snapshot:${trigger}`,
      undefined,
      {
        kind: 'snapshot',
        agentName: this.getAgentName(),
        data: {
          snapshot: {
            id: snapshot.id,
            sessionId: snapshot.sessionId,
            trigger: snapshot.trigger,
            model: snapshot.model,
            parentSnapshot: snapshot.parentSnapshot,
            systemPrompt: snapshot.systemPrompt,
            tools: snapshot.tools,
            identityMemory: snapshot.identityMemory,
            compressedSummary: snapshot.compressedSummary,
            messagesBefore: snapshot.messagesBefore,
            messagesAfter: snapshot.messagesAfter,
            compressedRange: snapshot.compressedRange,
            decisionContext: snapshot.decisionContext,
          },
        },
      },
    )
    this.deps.tracer.endSpan(snapshotSpan.id, 'success')
    this.currentSnapshotId = snapshot.id
    this.lastSnapshotContext = {
      model: context.model,
      systemPrompt: context.systemPrompt,
      tools: [...context.tools],
      identityMemory: context.identityMemory,
    }
    return snapshot.id
  }

  private ensureCurrentContextSnapshot(toolNames: string[]): void {
    const context = this.getCurrentSnapshotContext(toolNames)
    if (!context) return

    if (!this.currentSnapshotId || !this.lastSnapshotContext) {
      this.writeSnapshot('session_start', context)
      return
    }

    if (
      this.lastSnapshotContext.model === context.model &&
      this.lastSnapshotContext.systemPrompt === context.systemPrompt &&
      this.lastSnapshotContext.identityMemory === context.identityMemory &&
      Session.sameStringArray(this.lastSnapshotContext.tools, context.tools)
    ) {
      return
    }

    const trigger = Session.sameStringArray(this.lastSnapshotContext.tools, context.tools)
      ? 'context_updated'
      : 'tools_changed'
    this.writeSnapshot(trigger, context)
  }

  private logCompressionSnapshot(
    summary: string,
    stats: CompressionResult['stats'],
    decisionContext?: SnapshotEntry['decisionContext'],
  ): void {
    const context = this.getCurrentSnapshotContext()
    if (!context) return

    this.writeSnapshot('context_compression', context, {
      compressedSummary: summary,
      messagesBefore: stats.messagesBefore,
      messagesAfter: stats.messagesAfter,
      compressedRange: stats.compressedRange,
      decisionContext,
    })
  }

  private restoreSnapshotStateFromLogger(): void {
    const lastSnapshot = this.deps.observability?.readSessionSnapshots(this.data.id).at(-1)
    if (!lastSnapshot) return

    this.currentSnapshotId = lastSnapshot.id
    this.lastSnapshotContext = Session.snapshotContextFromEntry(lastSnapshot)
  }

  private async processMessage(
    content: string,
    options?: HandleMessageOptions,
  ): Promise<Message[]> {
    const { currentModel, tools, toolNames, systemPrompt, projectRoot, workspacePath } =
      this.ensureStaticContext()
    this.ensureCurrentContextSnapshot(toolNames)
    const userMessageEntry = this.makeUserMessage(content, now(), options?.images)
    const imageDelegationFiles = supportsVision(currentModel?.modelConfig)
      ? undefined
      : this.saveImagesForDelegation(options?.images, workspacePath)

    // === DYNAMIC: Per-message context ===

    const [newSkills, retrievedMemories] = await Promise.all([
      Promise.resolve().then(() => {
        const globalSkills = loadSkills(join(projectRoot, '.zero', 'skills'))
        const workspaceSkills = loadSkills(join(workspacePath, 'skills'))
        const allSkills = [...globalSkills, ...workspaceSkills]
        const nextSkills = allSkills.filter((s) => !this.knownSkillNames.has(s.name))
        for (const skill of nextSkills) this.knownSkillNames.add(skill.name)
        return nextSkills
      }),
      this.retrieveMemories(content),
    ])

    // Build dynamic context — injected into API request only, not stored in messages
    const dynamicCtx = buildDynamicContext({
      newSkills: newSkills.length > 0 ? newSkills : undefined,
      retrievedMemories,
    })
    const requestMemoryInjections: RequestMemoryInjectionEntry[] | undefined = retrievedMemories
      ? [
          {
            layer: 'layer1',
            source: 'retrieved_memories',
            formattedText: wrapMemoryInjection('layer1', retrievedMemories),
          },
        ]
      : undefined
    const conversationHistory = [...this.messages]

    const context: AgentContext = {
      systemPrompt,
      identityMemory: this.deps.identityMemory,
      dynamicContext: dynamicCtx,
      requestMemoryInjections,
      injectedMemoryIds: this.injectedMemoryIds,
      imageDelegationFiles,
      conversationHistory,
      timelineCompactionBlocks: this.timelineCompactionBlocks,
      onTimelineCompactionBlocksChanged: (blocks) => {
        this.timelineCompactionBlocks = blocks
        this.deps.sessionDb?.saveCompactionBlocks(this.data.id, this.timelineCompactionBlocks)
        this.deps.bus?.emit('session:update', {
          sessionId: this.data.id,
          event: 'timeline_compaction_blocks_updated',
          blockCount: this.timelineCompactionBlocks.filter((block) => block.status === 'active')
            .length,
        })
      },
      tools,
      maxContext: currentModel?.modelConfig.maxContext,
      maxOutput: currentModel?.modelConfig.maxOutput,
      reasoningEffort: this.data.reasoningEffort ?? currentModel?.modelConfig.reasoningEffort,
    }

    // Push messages to session in real-time so getMessages() reflects in-progress state
    const onNewMessage = (msg: Message) => {
      this.messages.push(msg)
      this.data.updatedAt = now()
      options?.onProgress?.(msg)
    }

    const shouldInterrupt = () => this.interruptFlag
    const getQueuedMessages = () => {
      const msgs = [...this.messageQueue]
      this.messageQueue.length = 0
      this.interruptFlag = false
      return msgs
    }
    const agent = this.agent
    if (!agent) {
      throw new Error('Agent not initialized. Call initAgent() first.')
    }

    // Snapshot message count so we can rollback on transient failure
    const messageCountBefore = this.messages.length
    let newMessages: Message[]
    try {
      newMessages = await agent.run(
        context,
        content,
        imageDelegationFiles?.length ? undefined : options?.images,
        onNewMessage,
        options?.onTextDelta,
        shouldInterrupt,
        getQueuedMessages,
        { turnIndex: this.allocateTurnIndex(), userMessageEntry },
      )
    } catch (error) {
      // On failure, preserve completed assistant output when present; otherwise roll back
      // the in-turn user input and keep queued messages for follow-up delivery.
      // This allows partial work to be retained while still keeping failure handling clear.
      // Preserve any 'queued' messages that were pushed concurrently by handleMessage —
      // they belong to the user, not to the failed agent turn.
      let rolledBack = true
      if (this.messages.length > messageCountBefore) {
        const added = this.messages.slice(messageCountBefore)
        const hasCompletedWork = added.some(
          (msg) => msg.role === 'assistant' && msg.messageType === 'message',
        )

        if (!hasCompletedWork) {
          this.messages.length = messageCountBefore
          for (const msg of added) {
            if (msg.messageType === 'queued') {
              this.messages.push(msg)
            }
          }

          this.deps.bus?.emit('session:update', {
            sessionId: this.data.id,
            event: 'message_rollback',
            messageCount: this.messages.length,
          })
        } else {
          rolledBack = false
          this.deps.bus?.emit('session:update', {
            sessionId: this.data.id,
            event: 'message_partial_failure',
            messageCount: this.messages.length,
          })
        }
      }

      if (error instanceof Error) {
        ;(error as Error & { rolledBack?: boolean }).rolledBack = rolledBack
      }
      throw error
    }

    // Emit session:update
    this.deps.bus?.emit('session:update', {
      sessionId: this.data.id,
      event: 'message_handled',
      messageCount: this.messages.length,
    })

    return newMessages
  }

  private async retrieveMemories(userMessage: string): Promise<string | undefined> {
    if ((this.lastAgentConfig?.promptMode ?? 'full') !== 'full') return undefined

    const resolved =
      this.activeModel ?? this.modelRouter.getDefaultModel() ?? this.modelRouter.getCurrentModel()
    if (!resolved) return undefined

    const memories = await retrieveMemoriesWithDecision({
      adapter: resolved.adapter,
      sessionId: this.data.id,
      reasoningEffort: this.data.reasoningEffort ?? resolved.modelConfig.reasoningEffort,
      memoryRetriever: this.deps.memoryRetriever,
      identitySummary: this.deps.identityMemory ?? '',
      userMessage,
      previouslyInjectedIds: this.injectedMemoryIds,
      logger: this.logger,
      failureEvent: 'memory_retrieval_failed',
      trace: {
        tracer: this.deps.tracer,
        agentName: this.getAgentName(),
        providerName: resolved.providerName,
        modelLabel: this.modelRouter.getModelLabel(resolved),
        pricing: resolved.modelConfig.pricing,
        secretFilter: this.deps.secretFilter,
        spanName: 'memory_retrieval_decision',
        metadata: {
          layer: 'layer1',
        },
      },
    })
    if (!memories || memories.length === 0) return undefined

    for (const memory of memories) {
      this.injectedMemoryIds.set(memory.id, memory.title)
    }

    return buildRetrievedMemoriesBlock(memories)
  }

  /**
   * Handle session commands (/new, /model, etc.).
   */
  async switchModel(target: string): Promise<ModelSwitchResult> {
    const oldModel = this.data.currentModel
    const result = this.modelRouter.selectModel(target)
    if (!result.success || !result.model) {
      return result
    }

    const nextModelLabel = this.modelRouter.getModelLabel(result.model)
    this.activeModel = result.model
    this.data.currentModel = nextModelLabel
    if (this.data.modelHistory.length > 0) {
      this.data.modelHistory[this.data.modelHistory.length - 1].to = now()
    }
    this.data.modelHistory.push({ model: nextModelLabel, from: now(), to: null })
    this.data.updatedAt = now()
    this.deps.persistModelPreference?.(nextModelLabel)

    this.deps.bus?.emit('model:switch', {
      sessionId: this.data.id,
      from: oldModel,
      to: nextModelLabel,
    })

    this.reinitializeAgent()
    if (this.lastAgentConfig) {
      const { toolNames } = this.ensureStaticContext()
      const context = this.getCurrentSnapshotContext(toolNames)
      if (context) {
        this.writeSnapshot('model_switch', context)
      }
    }

    if (this.messages.length > 0) {
      const newBudget = allocateBudget(
        result.model.modelConfig.maxContext,
        result.model.modelConfig.maxOutput,
      )
      const currentTokens = estimateConversationTokens(this.messages)
      if (currentTokens > newBudget.conversation) {
        const { compressConversation } = await import('../agent/compress')
        const compResult = await compressConversation(
          this.messages,
          newBudget.conversation,
          result.model.adapter,
          this.data.id,
          {},
          {
            tracer: this.deps.tracer,
            agentName: this.lastAgentConfig?.name,
            providerName: result.model.providerName,
            modelLabel: this.modelRouter.getModelLabel(result.model),
            pricing: result.model.modelConfig.pricing,
            secretFilter: this.deps.secretFilter,
          },
        )
        this.messages.length = 0
        this.messages.push(...compResult.retainedMessages)
        this.logCompressionSnapshot(compResult.summary, compResult.stats, {
          currentTokens,
          conversationBudget: newBudget.conversation,
        })
      }
    }

    this.persistState()
    return result
  }

  listModels(): string[] {
    return this.modelRouter
      .getRegistry()
      .listModels()
      .map((model) => `${model.providerName}/${model.modelName}`)
  }

  listModelGroups(): SessionModelListGroup[] {
    const registry = this.modelRouter.getRegistry()
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

  getReasoningEffort(): ReasoningEffort | undefined {
    return this.data.reasoningEffort
  }

  setReasoningEffort(effort?: ReasoningEffort): ReasoningEffortUpdateResult {
    if (this.data.reasoningEffort === effort) {
      return {
        changed: false,
        message: effort
          ? `Thinking effort already set to ${effort} for this session.`
          : 'Thinking effort already using provider default for this session.',
      }
    }

    this.data.reasoningEffort = effort
    this.data.updatedAt = now()
    this.persistState()

    this.deps.bus?.emit('session:update', {
      sessionId: this.data.id,
      event: 'reasoning_effort_changed',
      reasoningEffort: effort ?? null,
    })

    return {
      changed: true,
      message: effort
        ? `Thinking effort set to ${effort} for this session.`
        : 'Thinking effort reset to provider default for this session.',
    }
  }

  private reinitializeAgent(): void {
    if (!this.agent || !this.lastAgentConfig) return
    this.initAgent(this.lastAgentConfig)
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.deps.taskClosureModel = taskClosureModel
    if (!this.agent || !this.lastAgentConfig) return
    if (this.isTurnInProgress()) {
      this.pendingAgentRefresh = true
      return
    }
    this.reinitializeAgent()
  }

  setContextCompactionModels(models: {
    contextCompactionModel?: string
  }): void {
    this.deps.contextCompactionModel = models.contextCompactionModel
    if (!this.agent || !this.lastAgentConfig) return
    if (this.isTurnInProgress()) {
      this.pendingAgentRefresh = true
      return
    }
    this.reinitializeAgent()
  }

  private persistState(): void {
    this.deps.sessionDb?.saveMessages(this.data.id, this.messages)
    this.deps.sessionDb?.saveCompactionBlocks(this.data.id, this.timelineCompactionBlocks)
    const agentConfig = this.lastAgentConfig
    this.deps.sessionDb?.saveSession(
      this.data,
      agentConfig ? JSON.stringify(agentConfig) : undefined,
      this.lastSystemPrompt || undefined,
    )
  }

  private getToolDefinitionsForModel(model?: ResolvedModel): ToolDefinition[] {
    return this.toolRegistry
      .list()
      .filter((tool) => supportsToolForModel(tool, model?.modelConfig))
      .map((tool) => tool.toDefinition())
  }

  private saveImagesForDelegation(
    images: HandleMessageOptions['images'],
    workspacePath: string,
  ): Array<{ path: string; mediaType: string }> | undefined {
    if (!images?.length) return undefined

    const imageDir = join(workspacePath, 'incoming-images')
    if (!existsSync(imageDir)) {
      mkdirSync(imageDir, { recursive: true })
    }

    return images.map((image, index) => {
      const extension = extensionForMediaType(image.mediaType)
      const filePath = join(imageDir, `${now().replace(/[:.]/g, '-')}-${index + 1}.${extension}`)
      writeFileSync(filePath, Buffer.from(image.data, 'base64'))
      return { path: filePath, mediaType: image.mediaType }
    })
  }

  private makeUserMessage(
    text: string,
    createdAt: string,
    images?: Array<{ mediaType: string; data: string }>,
    messageType: Message['messageType'] = 'message',
  ): Message {
    const content: Message['content'] = []
    if (text.trim().length > 0) {
      content.push({ type: 'text', text })
    }
    if (images?.length) {
      for (const image of images) {
        content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
      }
    }

    return {
      id: generateId(),
      sessionId: this.data.id,
      role: 'user',
      messageType,
      content,
      createdAt,
    }
  }

  private static allocateSessionId(source: SessionSource, sessionDb?: SessionDB): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = generateSessionId(source)
      if (!sessionDb?.getSession(id)) {
        return id
      }
    }

    throw new Error(
      `Unable to allocate unique session ID for source "${source}" after 16 attempts.`,
    )
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
    const normalizedCurrentModel =
      modelRouter.normalizeModelReference(data.currentModel) ?? data.currentModel
    const normalizedHistory = data.modelHistory.map((entry) => ({
      ...entry,
      model: modelRouter.normalizeModelReference(entry.model) ?? entry.model,
    }))
    const activeModel = modelRouter.resolveModel(normalizedCurrentModel)
    const restoredMessages =
      activeModel?.adapter.apiType === 'anthropic-deepseek'
        ? sanitizeConversationHistoryForSignedThinkingToolUse(messages)
        : messages

    const session = Object.create(Session.prototype) as Session
    const logger = {
      info: (event: string, d?: Record<string, unknown>) =>
        console.log(`[${data.id}] ${event}`, d ?? ''),
      warn: (event: string, d?: Record<string, unknown>) =>
        console.warn(`[${data.id}] ${event}`, d ?? ''),
      error: (event: string, d?: Record<string, unknown>) =>
        console.error(`[${data.id}] ${event}`, d ?? ''),
    }
    Object.assign(session, {
      data: {
        ...data,
        currentModel: normalizedCurrentModel,
        modelHistory: normalizedHistory,
        reasoningEffort: data.reasoningEffort,
      },
      messages: restoredMessages,
      timelineCompactionBlocks,
      modelRouter,
      toolRegistry,
      activeModel,
      deps,
      logger,
      agentControl: new AgentControl({
        tracer: deps.tracer,
        logger,
      }),
      mutex: new Mutex(),
      interruptFlag: false,
      messageQueue: [],
      agent: null,
      lastAgentConfig: null,
      lastSystemPrompt: systemPrompt ?? '',
      cachedSystemPrompt: null,
      cachedToolNames: [],
      knownSkillNames: new Set<string>(),
      currentSnapshotId: undefined,
      lastSnapshotContext: null,
      nextTurnIndex: Session.deriveNextTurnIndex(data.id, restoredMessages, deps.observability),
      pendingAgentRefresh: false,
      injectedMemoryIds: new Map<string, string>(),
      liveDocs: new Map<string, string>(),
      runningToolRegistry: new SessionRunningToolRegistry(),
    })
    session.restoreSnapshotStateFromLogger()
    return session
  }

  getAgentConfig(): AgentConfig | null {
    return this.lastAgentConfig
  }

  getSystemPrompt(): string {
    return this.lastSystemPrompt
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  getTimelineCompactionBlocks(): TimelineCompactionBlock[] {
    return [...this.timelineCompactionBlocks]
  }

  abortRunningTool(toolUseId: string): RunningToolAbortRequestStatus {
    const liveEntry = this.runningToolRegistry.get(toolUseId)
    if (liveEntry) {
      return liveEntry.requestAbort('Command aborted by user from Session Detail.')
    }

    const toolName = this.findToolNameByUseId(toolUseId)
    return toolName === 'bash' ? 'already_finished' : 'not_abortable'
  }

  getSubAgentSnapshot(): AgentSnapshot[] {
    return this.agentControl.getSnapshot()
  }

  restoreSubAgentSnapshot(snapshot: AgentSnapshot[]): void {
    this.agentControl.restoreSnapshot(snapshot)
  }

  ensureChannelContext(channelId: string, channelName?: string, participantId?: string): void {
    if (
      this.data.channelId === channelId &&
      this.data.channelName === channelName &&
      this.data.participantId === participantId
    ) {
      return
    }

    this.data.channelId = channelId
    this.data.channelName = channelName
    this.data.participantId = participantId
    this.data.updatedAt = now()
    this.persistState()

    if (!this.agent || !this.lastAgentConfig) return
    if (this.isTurnInProgress()) {
      this.pendingAgentRefresh = true
      return
    }
    this.reinitializeAgent()
  }

  isTurnInProgress(): boolean {
    return this.mutex.isLocked()
  }

  waitForTurnComplete(): Promise<void> {
    return this.mutex.waitForUnlock()
  }

  private allocateTurnIndex(): number {
    const turnIndex = this.nextTurnIndex
    this.nextTurnIndex += 1
    return turnIndex
  }

  private static deriveNextTurnIndex(
    sessionId: string,
    messages: Message[],
    observability?: ObservabilityStore,
  ): number {
    const maxLoggedTurnIndex = Session.findMaxLoggedTurnIndex(
      observability?.readSessionRequests(sessionId) ?? [],
    )
    if (maxLoggedTurnIndex > 0) {
      return maxLoggedTurnIndex + 1
    }

    return Session.countRecoverableUserTurns(messages) + 1
  }

  private static findMaxLoggedTurnIndex(entries: RequestLogEntry[]): number {
    return entries.reduce((max, entry) => {
      return Number.isFinite(entry.turnIndex) ? Math.max(max, entry.turnIndex) : max
    }, 0)
  }

  private static countRecoverableUserTurns(messages: Message[]): number {
    return messages.filter((message) => Session.isTopLevelUserTurn(message)).length
  }

  static isTopLevelUserTurn(message: Message): boolean {
    if (message.role !== 'user') return false
    if (message.messageType !== 'message') return false
    if (message.content.some((block) => block.type === 'tool_result')) return false

    return message.content.some((block) => block.type === 'text' || block.type === 'image')
  }

  private findToolNameByUseId(toolUseId: string): string | undefined {
    for (const message of this.messages) {
      if (message.role !== 'assistant') continue
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        if (block.id === toolUseId && typeof block.name === 'string') {
          return block.name.toLowerCase()
        }
      }
    }

    return undefined
  }

  private filterLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined
    const filtered = this.filterLogValue(data)
    return filtered && typeof filtered === 'object' && !Array.isArray(filtered)
      ? (filtered as Record<string, unknown>)
      : undefined
  }

  private filterLogValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.deps.secretFilter ? this.deps.secretFilter.filter(value) : value
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.filterLogValue(item))
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
          key,
          this.filterLogValue(nestedValue),
        ]),
      )
    }

    return value
  }
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}
