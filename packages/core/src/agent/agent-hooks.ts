import { createHash } from 'node:crypto'
import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  RequestMemoryInjectionEntry,
  RequestToolResultEntry,
  Tracer,
  UsagePurpose,
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  ModelPricing,
  SecretFilter,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import type {
  AgentLoopHooks,
  AgentLoopJournal,
  AgentLoopModule,
  FailedToolAttempt,
  QueueTaken,
} from './agent-loop'
import type { AgentTraceRecorder } from './agent-trace'
import {
  cloneMemoryInjections,
  extractTextFromMessage,
  filterContent,
  filterToolInput,
  filterTraceValue,
  stringifyTraceData,
  toRequestToolResults,
} from './agent-trace'
import type { AgentConfig, AgentContext, AgentObservability } from './agent-types'
import { retrieveMemoriesWithDecision } from './memory-retrieval'
import { CONTEXT_PARAMS } from './params'
import { wrapMemoryInjection } from './prompt'
import { type QueuedInjectionTrace, buildLoopUserMessage, formatAppliedQueuedIntent } from './queue'
import { attachLargeToolUseEvidence } from './tool-evidence'
import { artifactizeToolOutput } from './truncate'

export interface CreateAgentLoopHooksOptions {
  config: AgentConfig
  adapter: ProviderAdapter
  toolContext: ToolContext
  obs: AgentObservability
  context: AgentContext
  userMessage: string
  onNewMessage?: (msg: Message) => void
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  turnIndex: number
  rootSpanId?: string
  executionState: {
    currentRequestId?: string
    currentTraceSpanId?: string
  }
  requestPurposeRef: { current: UsagePurpose }
  traceRecorder: AgentTraceRecorder
}

function isMissingDeepSeekSignedThinkingError(error: unknown): boolean {
  return toErrorMessage(error).includes('missing signed thinking content')
}

function endMemoryNudgeSpan(options: {
  tracer?: Pick<Tracer, 'endSpan'>
  spanId?: string
  status: 'success' | 'error'
  memoryWritten: boolean
  metadata?: Record<string, unknown>
}): void {
  if (!options.spanId) return
  options.tracer?.endSpan(options.spanId, options.status, {
    memoryWritten: options.memoryWritten,
    ...(options.metadata ?? {}),
  })
}

class AgentMemoryNudgeController {
  private count = 0
  private memoryWriteSucceededThisTurn = false
  private activeSpanId: string | undefined
  private activeIteration: number | undefined
  private responseParts: string[] = []

  constructor(
    private readonly deps: {
      sessionId: string
      agentName: string
      tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
      baseUsagePurpose: UsagePurpose
      requestPurposeRef: { current: UsagePurpose }
    },
  ) {}

  get isActive(): boolean {
    return this.count > 0
  }

  get nudgeCount(): number {
    return this.count
  }

  get memoryWritten(): boolean {
    return this.memoryWriteSucceededThisTurn
  }

  markMemoryWriteSucceeded(): void {
    this.memoryWriteSucceededThisTurn = true
  }

  begin(iteration: number, parentSpanId?: string): void {
    this.count++
    this.activeIteration = iteration
    this.responseParts = []
    this.activeSpanId =
      this.deps.tracer?.startSpan(this.deps.sessionId, 'memory_nudge', parentSpanId, {
        kind: 'closure_decision',
        agentName: this.deps.agentName,
        data: {
          memoryNudge: {
            prompt: MEMORY_NUDGE_PROMPT,
            iteration,
          },
        },
        metadata: {
          purpose: 'memory_nudge',
          iteration,
        },
      })?.id ?? this.activeSpanId
    this.syncRequestPurpose()
  }

  /**
   * Keep the nudge model's answer on the trace span. Nudge replies never reach
   * the session transcript (onNewMessage suppresses them while active), so the
   * span is the only place the answer can be inspected from later.
   */
  recordResponseText(text: string): void {
    if (text.trim() === '') return
    this.responseParts.push(text)
  }

  interrupt(metadata: Record<string, unknown> = { interruptReason: 'pending_queue' }): boolean {
    const wasActive = this.isActive
    this.endSpan('error', metadata)
    if (wasActive) {
      this.count = 0
    }
    this.syncRequestPurpose()
    return wasActive
  }

  completeSuccess(metadata?: Record<string, unknown>): void {
    this.endSpan('success', metadata)
    this.count = 0
    this.syncRequestPurpose()
  }

  completeError(error: unknown): void {
    this.endSpan('error', { error: toErrorMessage(error) })
    this.count = 0
    this.syncRequestPurpose()
  }

  private endSpan(status: 'success' | 'error', metadata?: Record<string, unknown>): void {
    if (!this.activeSpanId) return
    if (this.responseParts.length > 0) {
      this.deps.tracer?.updateSpan(this.activeSpanId, {
        data: {
          memoryNudge: {
            ...(this.activeIteration === undefined ? {} : { iteration: this.activeIteration }),
            response: this.responseParts.join('\n'),
          },
        },
      })
    }
    endMemoryNudgeSpan({
      tracer: this.deps.tracer,
      spanId: this.activeSpanId,
      status,
      memoryWritten: this.memoryWriteSucceededThisTurn,
      metadata,
    })
    this.activeSpanId = undefined
    this.activeIteration = undefined
    this.responseParts = []
  }

  private syncRequestPurpose(): void {
    this.deps.requestPurposeRef.current = this.isActive
      ? 'memory_nudge'
      : this.deps.baseUsagePurpose
  }
}

export function createAgentLoopHooks(options: CreateAgentLoopHooksOptions): {
  hooks: AgentLoopHooks
  /** loop 写 step、tool、消息事件的入口;没有事件流句柄时为 undefined */
  journal: AgentLoopJournal | undefined
  /** 当前模型请求的 trace span,压缩记在它下面 */
  requestSpanId(): string | undefined
  /** 还没搬出的会话功能(记忆、trace)在模块扩展点上的部分,按这个顺序放进模块数组 */
  modules: AgentLoopModule[]
} {
  const {
    config,
    adapter,
    toolContext,
    obs,
    context,
    userMessage,
    turnIndex,
    rootSpanId,
    executionState,
    requestPurposeRef,
    traceRecorder,
  } = options

  const baseUsagePurpose = obs.usagePurpose ?? 'agent_loop'
  const memoryNudge = new AgentMemoryNudgeController({
    sessionId: toolContext.sessionId,
    agentName: config.name,
    tracer: obs.tracer,
    baseUsagePurpose,
    requestPurposeRef,
  })

  const handleCompletionErrorLogged = (error: unknown) => {
    memoryNudge.completeError(error)
  }

  // 排队消息进入请求的事实:trace 记下它和拼进来的原文的长度
  let pendingQueuedInjection: QueuedInjectionTrace | undefined
  let appliedQueuedIntentText: string | undefined

  const llmRequestHooks = createAgentLLMRequestHooks({
    config,
    toolContext,
    obs,
    userMessage,
    turnIndex,
    rootSpanId,
    executionState,
    traceRecorder,
    initialMemoryInjections: context.requestMemoryInjections,
    onCompletionErrorLogged: handleCompletionErrorLogged,
    queueTrace: {
      getPendingInjection: () => pendingQueuedInjection,
      clearPendingInjection: () => {
        pendingQueuedInjection = undefined
      },
    },
  })

  const toolCallHooks = createAgentToolCallHooks({
    config,
    toolContext,
    obs,
    executionState,
    getCurrentRequestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
    markMemoryWriteSucceeded: () => {
      memoryNudge.markMemoryWriteSucceeded()
    },
  })
  const memoryNudgeResponseHooks = createAgentMemoryNudgeResponseHandlers({
    getCurrentRequestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
    memoryNudge,
    obs,
    onTextDelta: options.onTextDelta,
    toolContext,
    turnIndex,
  })

  const hooks: AgentLoopHooks = {
    onNewMessage: (message) => {
      // 消息事件由 loop 在这之前写入:转给调用方的是 canonical 消息,记忆提醒阶段的是 request/message
      if (!memoryNudge.isActive) {
        options.onNewMessage?.(message)
      } else {
        if (message.role === 'assistant') {
          const text = extractTextFromMessage(message).trim()
          if (text !== '') {
            memoryNudge.recordResponseText(obs.secretFilter ? obs.secretFilter.filter(text) : text)
          }
        }
      }

      if (message.role === 'assistant') {
        obs.bus?.emit('session:update', {
          sessionId: toolContext.sessionId,
          event: 'assistant_response',
          model: message.model,
        })
      }
    },
    filterAssistantContent: (content) =>
      filterAssistantContentWithEvidence({
        content,
        obs,
        requestId: executionState.currentRequestId,
        toolContext,
        traceRecorder,
        traceSpanId: llmRequestHooks.getCurrentRequestSpanId(),
        turnIndex,
      }),
    onCompletionStart: llmRequestHooks.onCompletionStart,
    onCompletionEnd: llmRequestHooks.onCompletionEnd,
    onCompletionError: llmRequestHooks.onCompletionError,
    onInvalidAssistantResponse: memoryNudgeResponseHooks.onInvalidAssistantResponse,
    onTextDelta: memoryNudgeResponseHooks.onTextDelta,
    onToolCallStart: toolCallHooks.onToolCallStart,
    onToolCallEnd: toolCallHooks.onToolCallEnd,
    processToolResults: async (toolResults, failedAttempts) => {
      const processed = await processAgentToolResults({
        toolResults,
        failedAttempts,
        toolNamesByUseId: toolCallHooks.toolNamesByUseId,
        adapter,
        toolContext,
        userMessage,
        identitySummary: context.identityMemory,
        injectedMemoryIds: context.injectedMemoryIds,
        traceRecorder,
        sessionEvents: obs.sessionEvents,
        turnIndex,
        requestId: executionState.currentRequestId,
        trace: {
          tracer: obs.tracer,
          agentName: config.name,
          providerName: obs.providerName,
          modelLabel: obs.modelLabel,
          pricing: obs.pricing,
          secretFilter: obs.secretFilter,
        },
      })

      llmRequestHooks.setRequestToolResults(processed.requestToolResults)
      if (processed.memoryInjections) {
        llmRequestHooks.setPendingMemoryInjections(processed.memoryInjections)
      }
      return {
        toolResultBlocks: processed.toolResultBlocks,
        additionalMessages: processed.additionalMessages,
      }
    },
  }

  const endTurn = createMemoryNudgeDecision({
    config,
    toolContext,
    memoryNudge,
    getCurrentRequestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
  })
  const module: AgentLoopModule = {
    requestOnly: () => (memoryNudge.isActive ? 'memory_nudge' : undefined),
    onQueueTaken: (taken) => {
      if (taken.continuation || taken.injection) memoryNudge.interrupt()
      const intentText = formatAppliedQueuedIntent(taken.queued)
      if (intentText)
        appliedQueuedIntentText = appliedQueuedIntentText
          ? `${appliedQueuedIntentText}\n${intentText}`
          : intentText
      pendingQueuedInjection = taken.injection
      if (!taken.continuation) return
      const phase = queueTracePhase(taken)
      const drainSpan = obs.tracer?.startSpan(
        toolContext.sessionId,
        'queue_gate_drain',
        llmRequestHooks.getCurrentRequestSpanId(),
        {
          kind: 'closure_decision',
          agentName: config.name,
          metadata: {
            phase,
            queueCount: taken.queued.length,
            wasDuringNudge: taken.wasRequestOnly,
            appliedQueuedIntentLength: appliedQueuedIntentText?.length ?? 0,
          },
        },
      )
      if (drainSpan) obs.tracer?.endSpan(drainSpan.id, 'success')
      obs.bus?.emit('session:update', {
        sessionId: toolContext.sessionId,
        event: 'queue_drain_on_interrupt',
        queueCount: taken.queued.length,
        wasDuringNudge: taken.wasRequestOnly,
        phase,
      })
      if (taken.point === 'request_only_empty')
        toolContext.logger.info?.('memory_nudge_interrupted_by_queue', {
          sessionId: toolContext.sessionId,
          phase,
        })
    },
  }
  const memoryNudgeModule: AgentLoopModule = {
    name: 'memory_nudge',
    ...endTurn,
    onEmptyResponse: memoryNudgeResponseHooks.onEmptyResponse,
  }

  return {
    hooks,
    requestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
    modules: [module, memoryNudgeModule],
    journal: obs.sessionEvents && {
      events: obs.sessionEvents,
      modelLabel: obs.modelLabel,
      secretFilter: obs.secretFilter,
      requestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
      toolSpanId: (toolUseId) => toolCallHooks.getToolSpanId(toolUseId),
    },
  }
}

/** 一轮结束时是否开始记忆提醒 */
function createMemoryNudgeDecision({
  config,
  toolContext,
  memoryNudge,
  getCurrentRequestSpanId,
}: {
  config: AgentConfig
  toolContext: ToolContext
  memoryNudge: AgentMemoryNudgeController
  getCurrentRequestSpanId(): string | undefined
}): Required<Pick<AgentLoopModule, 'decideEndTurn'>> {
  const nudge: Required<Pick<AgentLoopModule, 'decideEndTurn'>> = {
    decideEndTurn: (_response, ctx) => {
      const promptMode = config.promptMode ?? 'full'
      if (
        !memoryNudge.memoryWritten &&
        !toolContext.spawnedByRequestId &&
        promptMode === 'full' &&
        ctx.iteration >= CONTEXT_PARAMS.memoryNudge.minIterations &&
        memoryNudge.nudgeCount < CONTEXT_PARAMS.memoryNudge.maxNudgesPerTurn
      ) {
        return {
          action: 'continue',
          continuationMessage: buildLoopUserMessage({
            sessionId: toolContext.sessionId,
            text: MEMORY_NUDGE_PROMPT,
            controlKind: 'memory_nudge',
          }),
          commit: () => memoryNudge.begin(ctx.iteration, getCurrentRequestSpanId()),
        }
      }

      if (memoryNudge.isActive) {
        memoryNudge.completeSuccess()
      }
      return undefined
    },
  }
  return nudge
}

/** 排队检查点在 trace 里的名字,沿用搬出前的叫法:决定之前的检查按让位的模块命名 */
function queueTracePhase(taken: QueueTaken): string {
  if (taken.point === 'end_turn') return 'pre_closure'
  if (taken.point === 'after_evaluation') return 'post_classifier'
  if (taken.point === 'request_only_empty') return 'memory_nudge_empty'
  if (taken.point === 'before_decision') return `pre_${taken.decider}`
  return taken.point
}

interface AgentMemoryNudgeResponseHandlerOptions {
  getCurrentRequestSpanId: () => string | undefined
  memoryNudge: AgentMemoryNudgeController
  obs: Pick<AgentObservability, 'secretFilter' | 'tracer'>
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  toolContext: Pick<ToolContext, 'logger' | 'sessionId'>
  turnIndex: number
}

function createAgentMemoryNudgeResponseHandlers(
  options: AgentMemoryNudgeResponseHandlerOptions,
): Pick<AgentLoopHooks, 'onInvalidAssistantResponse' | 'onTextDelta'> &
  Pick<AgentLoopModule, 'onEmptyResponse'> {
  return {
    onInvalidAssistantResponse: (request, response, error) =>
      handleInvalidAssistantResponse(request, response, error, options),
    onTextDelta: (delta, meta) => {
      if (options.memoryNudge.isActive) return
      options.onTextDelta?.(delta, meta)
    },
    onEmptyResponse: () => handleEmptyResponse(options),
  }
}

function handleInvalidAssistantResponse(
  request: CompletionRequest,
  response: CompletionResponse,
  error: unknown,
  options: AgentMemoryNudgeResponseHandlerOptions,
): { action: 'break' } | undefined {
  if (!options.memoryNudge.isActive || !isMissingDeepSeekSignedThinkingError(error)) {
    return undefined
  }

  const errorMessage = toErrorMessage(error)
  options.toolContext.logger.warn?.('memory_nudge_response_discarded', {
    sessionId: options.toolContext.sessionId,
    responseId: response.id,
    stopReason: response.stopReason,
    reason: errorMessage,
  })
  options.obs.tracer?.logSession?.(
    options.toolContext.sessionId,
    'warn',
    'memory_nudge.response_discarded',
    {
      traceSpanId: options.getCurrentRequestSpanId(),
      turnIndex: options.turnIndex,
      request: filterTraceValue(request, options.obs.secretFilter),
      response: filterTraceValue(response, options.obs.secretFilter),
      reason: errorMessage,
    },
  )

  options.memoryNudge.completeSuccess({
    discardedInvalidResponse: true,
    reason: errorMessage,
  })

  return { action: 'break' }
}

function handleEmptyResponse(
  options: AgentMemoryNudgeResponseHandlerOptions,
): ReturnType<NonNullable<AgentLoopModule['onEmptyResponse']>> {
  if (!options.memoryNudge.isActive) return undefined
  options.memoryNudge.completeSuccess()
  options.toolContext.logger.info?.('memory_nudge_empty_response', {
    sessionId: options.toolContext.sessionId,
  })
  return 'break'
}

interface ProcessAgentToolResultsOptions {
  toolResults: ContentBlock[]
  failedAttempts: FailedToolAttempt[]
  toolNamesByUseId: Map<string, string>
  adapter: ProviderAdapter
  toolContext: Pick<ToolContext, 'sessionId' | 'workDir' | 'logger' | 'memoryRetriever'>
  userMessage: string
  identitySummary?: string
  injectedMemoryIds?: Map<string, string>
  traceRecorder: Pick<AgentTraceRecorder, 'logToolEvidence'>
  sessionEvents?: AgentObservability['sessionEvents']
  turnIndex: number
  requestId?: string
  trace?: {
    tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
    agentName?: string
    providerName?: string
    modelLabel?: string
    pricing?: ModelPricing
    secretFilter?: SecretFilter
  }
}

interface ProcessAgentToolResultsResult {
  toolResultBlocks: ContentBlock[]
  additionalMessages?: Message[]
  requestToolResults: RequestToolResultEntry[]
  memoryInjections?: RequestMemoryInjectionEntry[]
}

async function processAgentToolResults(
  options: ProcessAgentToolResultsOptions,
): Promise<ProcessAgentToolResultsResult> {
  const processedResults = options.toolResults.map((block) => {
    if (block.type !== 'tool_result') return block

    const toolName = options.toolNamesByUseId.get(block.toolUseId) ?? 'unknown_tool'
    const artifactized = artifactizeToolOutput(toolName, block.content, {
      workDir: options.toolContext.workDir,
      sessionId: options.toolContext.sessionId,
      toolUseId: block.toolUseId,
      outputSummary: block.outputSummary,
    })
    const { content, artifactPath, evidence } = artifactized

    if (artifactPath) {
      options.toolContext.logger.info('tool_output_artifactized', {
        tool: toolName,
        originalChars: block.content.length,
        artifactPath,
      })
    }
    if (evidence) {
      options.traceRecorder.logToolEvidence(evidence, {
        source: 'active_tool_result',
        reason: artifactized.evidenceReason ?? 'tool_result_output',
        turnIndex: options.turnIndex,
        requestId: options.requestId,
        artifactPath,
        originalChars: artifactized.originalChars,
        originalTokens: artifactized.originalTokens,
        promptTokenLimit: artifactized.promptTokenLimit,
        thresholdChars: artifactized.thresholdChars,
        inlineContentChars: content.length,
      })
    }
    if (artifactPath) {
      // 持久替换:canonical tool_result 由原文降级为 artifact 引用,落 prune 事件留证
      options.sessionEvents?.append(options.toolContext.sessionId, [
        {
          type: 'compaction/prune',
          data: {
            toolUseId: block.toolUseId,
            from: {
              chars: artifactized.originalChars ?? block.content.length,
              hash: `sha256:${createHash('sha256').update(block.content).digest('hex')}`,
            },
            to: { chars: content.length, mode: 'artifact_ref' },
            evidence,
          },
        },
      ])
    }

    return {
      ...block,
      content,
      ...(evidence ? { evidence } : {}),
    }
  })

  const requestToolResults = toRequestToolResults(processedResults)
  const memoryHintMsg = await buildMemoryHintMessage({
    failedTools: options.failedAttempts,
    userMessage: options.userMessage,
    adapter: options.adapter,
    sessionId: options.toolContext.sessionId,
    memoryRetriever: options.toolContext.memoryRetriever,
    logger: options.toolContext.logger,
    identitySummary: options.identitySummary,
    injectedMemoryIds: options.injectedMemoryIds,
    sessionEvents: options.sessionEvents,
    trace: {
      tracer: options.trace?.tracer,
      agentName: options.trace?.agentName,
      providerName: options.trace?.providerName,
      modelLabel: options.trace?.modelLabel,
      pricing: options.trace?.pricing,
      secretFilter: options.trace?.secretFilter,
    },
  })

  if (!memoryHintMsg) {
    return {
      toolResultBlocks: processedResults,
      requestToolResults,
    }
  }

  return {
    toolResultBlocks: processedResults,
    additionalMessages: [memoryHintMsg],
    requestToolResults,
    memoryInjections: [
      {
        layer: 'layer2',
        source: 'memory_hint',
        formattedText: extractTextFromMessage(memoryHintMsg),
      },
    ],
  }
}

async function buildMemoryHintMessage(options: {
  failedTools: FailedToolAttempt[]
  userMessage: string
  adapter: ProviderAdapter
  sessionId: string
  memoryRetriever?: ToolContext['memoryRetriever']
  logger: ToolContext['logger']
  identitySummary?: string
  injectedMemoryIds?: Map<string, string>
  sessionEvents?: AgentObservability['sessionEvents']
  trace?: {
    tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
    agentName?: string
    providerName?: string
    modelLabel?: string
    pricing?: ModelPricing
    secretFilter?: SecretFilter
  }
}): Promise<Message | undefined> {
  if (options.failedTools.length === 0) return undefined

  const decisionContext = [
    `用户当前请求：${options.userMessage}`,
    '工具执行失败，需要判断是否检索历史经验来辅助恢复。',
    ...options.failedTools.map((tool, index) =>
      [
        `失败工具 ${index + 1}:`,
        `- tool: ${tool.toolName}`,
        `- input: ${stringifyTraceData(tool.input, 1000)}`,
        `- error_summary: ${tool.outputSummary ?? tool.output}`,
      ].join('\n'),
    ),
  ].join('\n')

  const matches = await retrieveMemoriesWithDecision({
    adapter: options.adapter,
    sessionId: options.sessionId,
    memoryRetriever: options.memoryRetriever,
    identitySummary: options.identitySummary,
    userMessage: decisionContext,
    previouslyInjectedIds: options.injectedMemoryIds,
    logger: options.logger,
    failureEvent: 'memory_hint_retrieval_failed',
    sessionEvents: options.sessionEvents,
    layer: 'layer2',
    trace: {
      tracer: options.trace?.tracer,
      agentName: options.trace?.agentName,
      providerName: options.trace?.providerName,
      modelLabel: options.trace?.modelLabel,
      pricing: options.trace?.pricing,
      secretFilter: options.trace?.secretFilter,
      spanName: 'memory_retrieval_decision',
      metadata: {
        layer: 'layer2',
        source: 'memory_hint',
      },
    },
  })
  if (!matches || matches.length === 0) return undefined

  for (const match of matches) {
    options.injectedMemoryIds?.set(match.id, match.title)
  }

  const hint = [
    '<memory_hint>',
    '工具执行失败。以下是相关的历史经验：',
    ...matches
      .slice(0, 3)
      .flatMap((match) => [
        `  <memory id="${escapeXml(match.id)}" type="${escapeXml(match.type)}">`,
        `    <title>${escapeXml(match.title)}</title>`,
        `    <content>${escapeXml(match.content)}</content>`,
        '  </memory>',
      ]),
    '</memory_hint>',
  ].join('\n')
  const notificationText = wrapMemoryInjection('layer2', hint)

  return {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'notification',
    content: [{ type: 'text', text: notificationText }],
    createdAt: now(),
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

interface CreateAgentLLMRequestHooksOptions {
  config: AgentConfig
  toolContext: ToolContext
  obs: AgentObservability
  userMessage: string
  turnIndex: number
  rootSpanId?: string
  executionState: {
    currentRequestId?: string
    currentTraceSpanId?: string
  }
  traceRecorder: AgentTraceRecorder
  initialMemoryInjections?: RequestMemoryInjectionEntry[]
  onCompletionErrorLogged?: (error: unknown) => void
  queueTrace: {
    getPendingInjection(): QueuedInjectionTrace | undefined
    clearPendingInjection(): void
  }
}

interface AgentLLMRequestHooks {
  getCurrentRequestSpanId(): string | undefined
  setRequestToolResults(results: RequestToolResultEntry[]): void
  setPendingMemoryInjections(memoryInjections: RequestMemoryInjectionEntry[]): void
  onCompletionStart: NonNullable<AgentLoopHooks['onCompletionStart']>
  onCompletionEnd: NonNullable<AgentLoopHooks['onCompletionEnd']>
  onCompletionError: NonNullable<AgentLoopHooks['onCompletionError']>
}

function createAgentLLMRequestHooks({
  config,
  toolContext,
  obs,
  userMessage,
  turnIndex,
  rootSpanId,
  executionState,
  traceRecorder,
  initialMemoryInjections,
  onCompletionErrorLogged,
  queueTrace,
}: CreateAgentLLMRequestHooksOptions): AgentLLMRequestHooks {
  let pendingParentRequestId: string | undefined
  let currentRequestToolResults: RequestToolResultEntry[] = []
  let pendingMemoryInjections = cloneMemoryInjections(initialMemoryInjections)
  let currentRequestSpanId: string | undefined

  return {
    getCurrentRequestSpanId: () => currentRequestSpanId,
    setRequestToolResults: (results) => {
      currentRequestToolResults = results
    },
    setPendingMemoryInjections: (memoryInjections) => {
      pendingMemoryInjections = cloneMemoryInjections(memoryInjections)
    },
    onCompletionStart: () => {
      const llmSpan = obs.tracer?.startSpan(toolContext.sessionId, 'llm_request', rootSpanId, {
        kind: 'llm_request',
        agentName: config.name,
        data: {
          turnIndex,
          parentId: pendingParentRequestId,
          spawnedByRequestId: toolContext.spawnedByRequestId,
        },
      })
      currentRequestSpanId = llmSpan?.id
    },
    onCompletionEnd: (request, response, durationMs) => {
      response.model = obs.modelLabel ?? response.model
      executionState.currentRequestId = response.id

      traceRecorder.logLLMRequest({
        request,
        response,
        userPrompt: userMessage,
        durationMs,
        meta: {
          turnIndex,
          parentId: pendingParentRequestId,
        },
        requestToolResults: currentRequestToolResults,
        queuedInjection: queueTrace.getPendingInjection(),
        memoryInjections: pendingMemoryInjections,
        traceSpanId: currentRequestSpanId,
      })

      currentRequestToolResults = []
      queueTrace.clearPendingInjection()
      pendingMemoryInjections = undefined
      pendingParentRequestId = response.stopReason === 'tool_use' ? response.id : undefined
    },
    onCompletionError: (request, error) => {
      obs.tracer?.logSession?.(toolContext.sessionId, 'error', 'llm_request.error', {
        traceSpanId: currentRequestSpanId,
        turnIndex,
        request: filterTraceValue(request, obs.secretFilter),
        error: toErrorMessage(error),
      })

      onCompletionErrorLogged?.(error)

      if (currentRequestSpanId) {
        obs.tracer?.updateSpan(currentRequestSpanId, {
          metadata: {
            error: toErrorMessage(error),
          },
        })
        obs.tracer?.endSpan(currentRequestSpanId, 'error')
      }
    },
  }
}

interface AgentToolCallHookState {
  currentRequestId?: string
  currentTraceSpanId?: string
}

interface CreateAgentToolCallHooksOptions {
  config: AgentConfig
  toolContext: ToolContext
  obs: AgentObservability
  executionState: AgentToolCallHookState
  getCurrentRequestSpanId: () => string | undefined
  markMemoryWriteSucceeded: () => void
}

interface AgentToolCallHooks {
  toolNamesByUseId: Map<string, string>
  getToolSpanId(toolUseId: string): string | undefined
  onToolCallStart: (toolName: string, toolUseId: string, input: Record<string, unknown>) => void
  onToolCallEnd: (
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    result: ToolResult,
  ) => void
}

function createAgentToolCallHooks({
  config,
  toolContext,
  obs,
  executionState,
  getCurrentRequestSpanId,
  markMemoryWriteSucceeded,
}: CreateAgentToolCallHooksOptions): AgentToolCallHooks {
  const toolSpanIds = new Map<string, string>()
  const toolNamesByUseId = new Map<string, string>()

  return {
    toolNamesByUseId,
    getToolSpanId: (toolUseId) => toolSpanIds.get(toolUseId),
    onToolCallStart: (toolName, toolUseId, input) => {
      toolNamesByUseId.set(toolUseId, toolName)
      const filteredToolInput = filterToolInput(input, obs.secretFilter)

      obs.bus?.emit('tool:call', {
        sessionId: toolContext.sessionId,
        tool: toolName,
        toolUseId,
        input: filteredToolInput,
      })

      const toolSpan = obs.tracer?.startSpan(
        toolContext.sessionId,
        `tool:${toolName}`,
        getCurrentRequestSpanId(),
        {
          kind: 'tool_call',
          agentName: config.name,
          data: {
            tool: toolName,
            input: filteredToolInput,
            inputSummary: stringifyTraceData(filteredToolInput),
            requestId: executionState.currentRequestId,
          },
        },
      )

      if (toolSpan?.id) {
        toolSpanIds.set(toolUseId, toolSpan.id)
      }
      executionState.currentTraceSpanId = toolSpan?.id
    },
    onToolCallEnd: (toolName, toolUseId, input, result) => {
      if (toolName === 'memory' && result.success) {
        const action =
          typeof input === 'object' && input !== null && 'action' in input
            ? (input as { action?: unknown }).action
            : undefined
        if (action === 'create' || action === 'update') {
          markMemoryWriteSucceeded()
          const memoryInput = input as {
            id?: string
            type?: string
            title?: string
            updates?: { title?: string }
          }
          obs.sessionEvents?.append(toolContext.sessionId, [
            {
              type: 'memory/recorded',
              data: {
                action,
                memoryId: memoryInput.id,
                memoryType: memoryInput.type,
                title: memoryInput.title ?? memoryInput.updates?.title,
                toolUseId,
              },
            },
          ])
        }
      }

      const toolSpanId = toolSpanIds.get(toolUseId)
      const filteredToolInput = filterToolInput(input, obs.secretFilter)
      // span 只带有界载荷:完整工具 IO 不再重复写入 trace.jsonl/run.log
      const slimResult = slimToolResultForTrace(result)
      if (toolSpanId) {
        obs.tracer?.updateSpan(toolSpanId, {
          data: {
            input: filteredToolInput,
            toolResult: slimResult,
            outputSummary: result.outputSummary,
          },
          metadata: {
            toolUseId,
            toolName,
            input: filteredToolInput,
            result: slimResult,
            outputSummary: result.outputSummary,
          },
        })
        obs.tracer?.endSpan(toolSpanId, result.success ? 'success' : 'error', {
          toolUseId,
          toolName,
          input: filteredToolInput,
          toolResult: slimResult,
          outputSummary: result.outputSummary,
        })
      }
      obs.bus?.emit('tool:result', {
        sessionId: toolContext.sessionId,
        tool: toolName,
        success: result.success,
        outputSummary: result.outputSummary,
        ...(result.success ? {} : { error: result.outputSummary ?? result.output }),
      })

      executionState.currentTraceSpanId = undefined
      toolSpanIds.delete(toolUseId)
    },
  }
}

interface FilterAssistantContentOptions {
  content: Message['content']
  obs: Pick<AgentObservability, 'secretFilter'>
  requestId?: string
  toolContext: Pick<ToolContext, 'sessionId' | 'workDir'>
  traceRecorder: Pick<AgentTraceRecorder, 'logToolEvidence'>
  traceSpanId?: string
  turnIndex: number
}

function filterAssistantContentWithEvidence(
  options: FilterAssistantContentOptions,
): Message['content'] {
  return attachLargeToolUseEvidence(filterContent(options.content, options.obs.secretFilter), {
    workDir: options.toolContext.workDir,
    sessionId: options.toolContext.sessionId,
    onEvidence: (evidence, toolUse) => {
      options.traceRecorder.logToolEvidence(evidence, {
        source: 'active_tool_use',
        reason: 'large_tool_input',
        turnIndex: options.turnIndex,
        traceSpanId: options.traceSpanId,
        requestId: options.requestId,
        originalChars: JSON.stringify(toolUse.input).length,
      })
    },
  })
}

const TOOL_RESULT_PREVIEW_CHARS = 2048

/** span/事件载荷里的工具结果只保留有界预览;完整 IO 由 evidence 文件承载 */
function slimToolResultForTrace(result: ToolResult): Record<string, unknown> {
  const output = result.output ?? ''
  return {
    success: result.success,
    outputSummary: result.outputSummary,
    chars: output.length,
    output:
      output.length > TOOL_RESULT_PREVIEW_CHARS
        ? `${output.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n…[truncated ${output.length - TOOL_RESULT_PREVIEW_CHARS} chars]`
        : output,
    ...(result.backgroundTaskId ? { backgroundTaskId: result.backgroundTaskId } : {}),
  }
}
