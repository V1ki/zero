import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  ClosureLogEntryInput,
  RequestMemoryInjectionEntry,
  RequestToolResultEntry,
  TaskClosureClassifierResponse,
  Tracer,
  UsagePurpose,
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ControlKind,
  Message,
  ModelPricing,
  ReasoningEffort,
  SecretFilter,
  ToolContext,
  ToolLogger,
  ToolResult,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import type { AgentLoopHooks, FailedToolAttempt } from './agent-loop'
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
import { allocateBudget, shouldCompress } from './budget'
import { estimateConversationTokens } from './context'
import { retrieveMemoriesWithDecision } from './memory-retrieval'
import { CONTEXT_PARAMS } from './params'
import { wrapMemoryInjection } from './prompt'
import {
  CONTINUATION_PROMPT,
  type QueuedInjectionTrace,
  type QueuedMessage,
  buildQueuedInjectionText,
  buildQueuedInjectionTrace,
  buildLoopUserMessage,
  formatAppliedQueuedIntent,
  injectQueuedMessagesWithTrace,
  isTaskComplete,
} from './queue'
import {
  TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
  type TaskClosureDecision,
  buildTaskClosureDecisionPrompt,
  buildTaskClosurePrompt,
  buildTaskClosurePromptContext,
  extractAssistantText,
  hasAssistantText,
  parseTaskClosureDecision,
} from './task-closure'
import { attachLargeToolUseEvidence } from './tool-evidence'
import { artifactizeToolOutput } from './truncate'

export interface CreateAgentLoopHooksOptions {
  config: AgentConfig
  adapter: ProviderAdapter
  closureAdapter: ProviderAdapter
  toolContext: ToolContext
  obs: AgentObservability
  context: AgentContext
  userMessage: string
  onNewMessage?: (msg: Message) => void
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  shouldInterrupt?: () => boolean
  getQueuedMessages?: () => QueuedMessage[]
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

  constructor(
    private readonly deps: {
      sessionId: string
      agentName: string
      tracer?: Pick<Tracer, 'startSpan' | 'endSpan'>
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
    endMemoryNudgeSpan({
      tracer: this.deps.tracer,
      spanId: this.activeSpanId,
      status,
      memoryWritten: this.memoryWriteSucceededThisTurn,
      metadata,
    })
    this.activeSpanId = undefined
  }

  private syncRequestPurpose(): void {
    this.deps.requestPurposeRef.current = this.isActive
      ? 'memory_nudge'
      : this.deps.baseUsagePurpose
  }
}

class AgentQueueGate {
  private hadQueuedMessages = false
  private pendingQueuedInjection: QueuedInjectionTrace | undefined
  private pendingQueuedAppliedCallbacks: Array<() => void> = []
  private appliedQueuedIntentText: string | undefined

  constructor(
    private readonly deps: {
      sessionId: string
      agentName: string
      logger: ToolLogger
      tracer?: Pick<Tracer, 'startSpan' | 'endSpan'>
      bus?: {
        emit(topic: string, data: Record<string, unknown>): void
      }
      shouldInterrupt?: () => boolean
      getQueuedMessages?: () => QueuedMessage[]
      createControlMessage: (text: string, controlKind: ControlKind) => Message
      interruptMemoryNudge: () => boolean
    },
  ) {}

  get hasQueuedMessages(): boolean {
    return this.hadQueuedMessages
  }

  get pendingInjection(): QueuedInjectionTrace | undefined {
    return this.pendingQueuedInjection
  }

  get appliedIntentText(): string | undefined {
    return this.appliedQueuedIntentText
  }

  resetHadQueuedMessages(): void {
    this.hadQueuedMessages = false
  }

  clearPendingInjection(): void {
    this.pendingQueuedInjection = undefined
  }

  shouldKeepInterrupting(): boolean {
    return !!this.deps.shouldInterrupt?.() && !this.hadQueuedMessages
  }

  notifyAppliedCallbacks(): void {
    if (this.pendingQueuedAppliedCallbacks.length === 0) return

    const callbacks = this.pendingQueuedAppliedCallbacks
    this.pendingQueuedAppliedCallbacks = []
    for (const callback of callbacks) {
      try {
        callback()
      } catch (error) {
        this.deps.logger.warn('queued_message_applied_callback_failed', {
          sessionId: this.deps.sessionId,
          error: toErrorMessage(error),
        })
      }
    }
  }

  drainPendingQueue(
    phase: string,
    currentRequestSpanId?: string,
  ): { action: 'continue'; continuationMessage: Message } | null {
    if (!this.deps.shouldInterrupt?.()) return null

    const queued = this.deps.getQueuedMessages?.() ?? []
    if (queued.length === 0) return null

    const wasDuringNudge = this.deps.interruptMemoryNudge()

    this.hadQueuedMessages = true
    this.appendAppliedQueuedIntent(queued)
    this.pendingQueuedInjection = buildQueuedInjectionTrace(queued)
    this.trackQueuedAppliedCallbacks(queued)

    const drainSpan = this.deps.tracer?.startSpan(
      this.deps.sessionId,
      'queue_gate_drain',
      currentRequestSpanId,
      {
        kind: 'closure_decision',
        agentName: this.deps.agentName,
        metadata: {
          phase,
          queueCount: queued.length,
          wasDuringNudge,
          appliedQueuedIntentLength: this.appliedQueuedIntentText?.length ?? 0,
        },
      },
    )
    if (drainSpan) {
      this.deps.tracer?.endSpan(drainSpan.id, 'success')
    }

    this.deps.bus?.emit('session:update', {
      sessionId: this.deps.sessionId,
      event: 'queue_drain_on_interrupt',
      queueCount: queued.length,
      wasDuringNudge,
      phase,
    })

    return {
      action: 'continue' as const,
      continuationMessage: this.deps.createControlMessage(
        buildQueuedInjectionText(queued),
        'queued_injection',
      ),
    }
  }

  injectQueuedMessagesIntoLastUserMessage(messages: Message[]): void {
    const queued = this.deps.getQueuedMessages?.() ?? []
    this.hadQueuedMessages = false
    this.pendingQueuedInjection = undefined

    if (queued.length === 0 || messages.length === 0) return

    const lastIdx = messages.length - 1
    if (messages[lastIdx].role !== 'user') return

    const injected = injectQueuedMessagesWithTrace(messages[lastIdx], queued)
    messages[lastIdx] = injected.message
    this.pendingQueuedInjection = injected.trace
    this.hadQueuedMessages = injected.trace !== undefined
    this.appendAppliedQueuedIntent(queued)
    this.trackQueuedAppliedCallbacks(queued)
    if (this.hadQueuedMessages) {
      this.deps.interruptMemoryNudge()
    }
  }

  private appendAppliedQueuedIntent(queued: QueuedMessage[]): void {
    const intentText = formatAppliedQueuedIntent(queued)
    if (!intentText) return
    this.appliedQueuedIntentText = this.appliedQueuedIntentText
      ? `${this.appliedQueuedIntentText}\n${intentText}`
      : intentText
  }

  private trackQueuedAppliedCallbacks(queued: QueuedMessage[]): void {
    for (const message of queued) {
      if (message.onApplied) {
        this.pendingQueuedAppliedCallbacks.push(message.onApplied)
      }
    }
  }
}

export function createAgentLoopHooks(options: CreateAgentLoopHooksOptions): AgentLoopHooks {
  const {
    config,
    adapter,
    closureAdapter,
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

  const interruptMemoryNudge = () => {
    return memoryNudge.interrupt()
  }

  const handleCompletionErrorLogged = (error: unknown) => {
    memoryNudge.completeError(error)
  }

  const queueGate = new AgentQueueGate({
    sessionId: toolContext.sessionId,
    agentName: config.name,
    logger: toolContext.logger,
    tracer: obs.tracer,
    bus: obs.bus,
    shouldInterrupt: options.shouldInterrupt,
    getQueuedMessages: options.getQueuedMessages,
    createControlMessage: (text, controlKind) =>
      buildLoopUserMessage({
        sessionId: toolContext.sessionId,
        text,
        controlKind,
      }),
    interruptMemoryNudge,
  })

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
      getPendingInjection: () => queueGate.pendingInjection,
      notifyAppliedCallbacks: () => queueGate.notifyAppliedCallbacks(),
      clearPendingInjection: () => queueGate.clearPendingInjection(),
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
    queueGate,
    toolContext,
    turnIndex,
  })

  return {
    buildRequestUserContent: (content) => buildAgentRequestUserContent(content, context),
    onNewMessage: (message) => {
      if (!memoryNudge.isActive) {
        options.onNewMessage?.(message)
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
    onEmptyResponse: memoryNudgeResponseHooks.onEmptyResponse,
    onEndTurn: createAgentEndTurnHandler({
      config,
      closureAdapter,
      toolContext,
      obs,
      context,
      userMessage,
      queueGate,
      memoryNudge,
      getCurrentRequestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
    }),
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
    afterToolResults: async (ctx) => {
      if (context.maxContext && context.maxOutput) {
        const budget = allocateBudget(context.maxContext, context.maxOutput)
        const currentTokens = estimateConversationTokens(ctx.messages)

        if (shouldCompress(currentTokens, budget.conversation)) {
          const { compressConversation } = await import('./compress')
          const result = await compressConversation(
            ctx.messages,
            budget.conversation,
            adapter,
            toolContext.sessionId,
            { parentSessionId: obs.parentSessionId },
            {
              tracer: obs.tracer,
              parentSpanId: llmRequestHooks.getCurrentRequestSpanId(),
              agentName: config.name,
              providerName: obs.providerName,
              modelLabel: obs.modelLabel,
              pricing: obs.pricing,
              secretFilter: obs.secretFilter,
            },
          )

          ctx.messages.length = 0
          ctx.messages.push(...result.retainedMessages)
          obs.onContextCompressed?.({
            summary: result.summary,
            stats: result.stats,
            decisionContext: {
              currentTokens,
              conversationBudget: budget.conversation,
            },
          })
        }
      }

      queueGate.injectQueuedMessagesIntoLastUserMessage(ctx.messages)
    },
    shouldInterrupt: () => queueGate.shouldKeepInterrupting(),
  }
}

interface CreateAgentEndTurnHandlerOptions {
  config: AgentConfig
  closureAdapter: ProviderAdapter
  toolContext: ToolContext
  obs: AgentObservability
  context: AgentContext
  userMessage: string
  queueGate: AgentQueueGate
  memoryNudge: AgentMemoryNudgeController
  getCurrentRequestSpanId(): string | undefined
}

function createAgentEndTurnHandler({
  config,
  closureAdapter,
  toolContext,
  obs,
  context,
  userMessage,
  queueGate,
  memoryNudge,
  getCurrentRequestSpanId,
}: CreateAgentEndTurnHandlerOptions): NonNullable<AgentLoopHooks['onEndTurn']> {
  let continuationCount = 0
  let taskClosureRetryCount = 0

  return async (response, ctx) => {
    const currentRequestSpanId = getCurrentRequestSpanId()
    const gate1 = queueGate.drainPendingQueue('pre_closure', currentRequestSpanId)
    if (gate1) {
      return gate1
    }

    let taskClosureEvaluation: TaskClosureEvaluation = {
      decision: null,
      eventPayload: null,
    }

    const shouldEvaluateTaskClosure =
      !toolContext.spawnedByRequestId &&
      !memoryNudge.isActive &&
      hasAssistantText(response.content)

    if (shouldEvaluateTaskClosure) {
      taskClosureEvaluation = await decideTaskClosure({
        adapter: closureAdapter,
        sessionId: toolContext.sessionId,
        agentName: config.name,
        logger: toolContext.logger,
        tracer: obs.tracer,
        parentSessionId: obs.parentSessionId,
        userMessage,
        appliedQueuedIntentText: queueGate.appliedIntentText,
        messages: ctx.messages,
        response,
        reasoningEffort: context.reasoningEffort,
        parentSpanId: currentRequestSpanId,
      })
    }

    const assistantMsg = ctx.messages[ctx.messages.length - 1]
    const gate2 = queueGate.drainPendingQueue('post_classifier', currentRequestSpanId)
    if (gate2) {
      finalizeTaskClosureSpan({
        tracer: obs.tracer,
        evaluation: taskClosureEvaluation,
        assistantMsg,
        extraMetadata: {
          discardedDuePendingQueue: true,
          originalAction: taskClosureEvaluation.decision?.action ?? null,
          originalReason: taskClosureEvaluation.decision?.reason ?? null,
        },
        extraClosureData: {
          discardedDuePendingQueue: true,
          originalAction: taskClosureEvaluation.decision?.action ?? null,
          originalReason: taskClosureEvaluation.decision?.reason ?? null,
        },
      })
      return gate2
    }

    if (assistantMsg?.role === 'assistant' && taskClosureEvaluation.decision?.action === 'block') {
      assistantMsg.taskClosure = {
        action: 'block',
        reason: taskClosureEvaluation.decision.reason,
      }
    }

    finalizeTaskClosureSpan({
      tracer: obs.tracer,
      evaluation: taskClosureEvaluation,
      assistantMsg,
    })

    if (assistantMsg?.role === 'assistant' && taskClosureEvaluation.eventPayload) {
      const sessionEvent: ClosureLogEntryInput & { spanId?: string } = {
        ...taskClosureEvaluation.eventPayload,
        spanId: taskClosureEvaluation.traceSpanId,
        assistantMessageId: assistantMsg.id,
        assistantMessageCreatedAt: assistantMsg.createdAt,
      }

      obs.bus?.emit('session:update', sessionEvent)
    }

    if (
      queueGate.hasQueuedMessages &&
      !isTaskComplete(response.content) &&
      continuationCount < CONTEXT_PARAMS.queue.maxContinuationRetries
    ) {
      continuationCount++
      queueGate.resetHadQueuedMessages()
      return {
        action: 'continue' as const,
        continuationMessage: buildLoopUserMessage({
          sessionId: toolContext.sessionId,
          text: CONTINUATION_PROMPT,
          controlKind: 'continuation',
        }),
      }
    }

    if (
      taskClosureEvaluation.decision?.action === 'continue' &&
      taskClosureRetryCount < CONTEXT_PARAMS.completion.maxTaskClosureRetries
    ) {
      const gate3 = queueGate.drainPendingQueue('pre_task_closure_retry', currentRequestSpanId)
      if (gate3) {
        return gate3
      }

      taskClosureRetryCount++
      return {
        action: 'continue' as const,
        continuationMessage: buildLoopUserMessage({
          sessionId: toolContext.sessionId,
          text: buildTaskClosurePrompt(taskClosureEvaluation.decision.reason),
          controlKind: 'task_closure',
        }),
      }
    }

    const promptMode = config.promptMode ?? 'full'
    if (
      !memoryNudge.memoryWritten &&
      !toolContext.spawnedByRequestId &&
      promptMode === 'full' &&
      ctx.iteration >= CONTEXT_PARAMS.memoryNudge.minIterations &&
      memoryNudge.nudgeCount < CONTEXT_PARAMS.memoryNudge.maxNudgesPerTurn
    ) {
      const gate4 = queueGate.drainPendingQueue('pre_memory_nudge', currentRequestSpanId)
      if (gate4) {
        return gate4
      }

      memoryNudge.begin(ctx.iteration, currentRequestSpanId)

      return {
        action: 'continue' as const,
        continuationMessage: buildLoopUserMessage({
          sessionId: toolContext.sessionId,
          text: MEMORY_NUDGE_PROMPT,
          controlKind: 'memory_nudge',
        }),
      }
    }

    if (memoryNudge.isActive) {
      memoryNudge.completeSuccess()
    }

    return { action: 'break' as const }
  }
}

interface TaskClosureClassifierRequest {
  system: string
  prompt: string
  maxTokens: number
}

interface TaskClosureClassifierResult {
  classifierRequest: TaskClosureClassifierRequest
  response: CompletionResponse
  responseText: string
  decision: TaskClosureDecision | null
}

interface PreparedTaskClosureClassifierRequest {
  classifierRequest: TaskClosureClassifierRequest
  classifierMessage: Message
}

type TaskClosureFailedReason = 'invalid_classifier_output' | 'classifier_failed'
type TaskClosureFailureStage = 'parse_classifier_response' | 'request_classifier'

type SessionTaskClosureEvent =
  | {
      sessionId: string
      spanId?: string
      event: 'task_closure_decision'
      action: 'finish' | 'continue' | 'block'
      reason: string
      classifierRequest: TaskClosureClassifierRequest
      classifierResponse?: TaskClosureClassifierResponse
    }
  | {
      sessionId: string
      spanId?: string
      event: 'task_closure_failed'
      reason: TaskClosureFailedReason
      failureStage: TaskClosureFailureStage
      classifierRequest: TaskClosureClassifierRequest
      classifierResponse?: TaskClosureClassifierResponse
      classifierResponseRaw?: string
      error?: string
    }

interface TaskClosureEvaluation {
  decision: TaskClosureDecision | null
  eventPayload: SessionTaskClosureEvent | null
  traceSpanId?: string
  traceSpanStatus?: 'success' | 'error'
}

async function decideTaskClosure(options: {
  adapter: ProviderAdapter
  sessionId: string
  agentName: string
  logger: ToolLogger
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
  parentSessionId?: string
  userMessage: string
  appliedQueuedIntentText: string | undefined
  messages: Message[]
  response: CompletionResponse
  reasoningEffort: ReasoningEffort | undefined
  parentSpanId?: string
}): Promise<TaskClosureEvaluation> {
  const taskClosureSpan = options.tracer?.startSpan(
    options.sessionId,
    'task_closure_decision',
    options.parentSpanId,
    {
      kind: 'closure_decision',
      agentName: options.agentName,
    },
  )

  const endSkipped = (skipReason: string): TaskClosureEvaluation => {
    if (taskClosureSpan) {
      options.tracer?.endSpan(taskClosureSpan.id, 'success', {
        called: false,
        skipReason,
        stopReason: options.response.stopReason,
      })
    }
    return {
      decision: null,
      eventPayload: null,
      traceSpanId: taskClosureSpan?.id,
      traceSpanStatus: undefined,
    }
  }

  if (options.response.stopReason === 'tool_use') return endSkipped('tool_use')
  if (!hasAssistantText(options.response.content)) return endSkipped('no_assistant_text')

  const assistantText = extractAssistantText(options.response.content)
  if (!assistantText) return endSkipped('empty_assistant_text')

  const preparedClassifier = prepareTaskClosureClassifierRequest({
    sessionId: options.sessionId,
    userMessage: options.userMessage,
    appliedQueuedIntentText: options.appliedQueuedIntentText,
    messages: options.messages,
    assistantText,
  })
  const classifierRequest = preparedClassifier.classifierRequest

  try {
    const classifier = await requestTaskClosureDecision({
      adapter: options.adapter,
      sessionId: options.sessionId,
      parentSessionId: options.parentSessionId,
      prepared: preparedClassifier,
      reasoningEffort: options.reasoningEffort,
    })
    const validDecision = classifier.decision

    if (validDecision) {
      return recordTaskClosureDecision({
        tracer: options.tracer,
        traceSpanId: taskClosureSpan?.id,
        sessionId: options.sessionId,
        classifier,
        decision: validDecision,
      })
    }

    return recordInvalidTaskClosureClassifierOutput({
      tracer: options.tracer,
      traceSpanId: taskClosureSpan?.id,
      sessionId: options.sessionId,
      classifier,
    })
  } catch (error) {
    options.logger.warn('task_closure_classifier_failed', {
      sessionId: options.sessionId,
      error: toErrorMessage(error),
    })
    const errorMessage = toErrorMessage(error)
    return recordTaskClosureClassifierFailure({
      tracer: options.tracer,
      traceSpanId: taskClosureSpan?.id,
      sessionId: options.sessionId,
      classifierRequest,
      error: errorMessage,
    })
  }
}

function finalizeTaskClosureSpan(options: {
  tracer?: Pick<Tracer, 'updateSpan' | 'endSpan'>
  evaluation: TaskClosureEvaluation
  assistantMsg: Message | undefined
  extraMetadata?: Record<string, unknown>
  extraClosureData?: Record<string, unknown>
}): void {
  const { tracer, evaluation, assistantMsg, extraMetadata, extraClosureData } = options
  if (assistantMsg?.role !== 'assistant' || !evaluation.traceSpanId) return

  tracer?.updateSpan(evaluation.traceSpanId, {
    data: {
      closure: {
        assistantMessageId: assistantMsg.id,
        assistantMessageCreatedAt: assistantMsg.createdAt,
        ...(extraClosureData ?? {}),
      },
    },
    metadata: {
      assistantMessageId: assistantMsg.id,
      assistantMessageCreatedAt: assistantMsg.createdAt,
      ...(extraMetadata ?? {}),
    },
  })

  if (evaluation.traceSpanStatus) {
    tracer?.endSpan(evaluation.traceSpanId, evaluation.traceSpanStatus)
  }
}

function prepareTaskClosureClassifierRequest(options: {
  sessionId: string
  userMessage: string
  appliedQueuedIntentText: string | undefined
  messages: Message[]
  assistantText: string
}): PreparedTaskClosureClassifierRequest {
  const promptContext = buildTaskClosurePromptContext(options.messages)
  const prompt = buildTaskClosureDecisionPrompt(
    options.userMessage,
    options.assistantText,
    promptContext,
    options.appliedQueuedIntentText,
  )
  const classifierRequest: TaskClosureClassifierRequest = {
    system: TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
    prompt,
    maxTokens: 800,
  }

  const classifierMessage: Message = {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: prompt }],
    createdAt: now(),
  }

  return {
    classifierRequest,
    classifierMessage,
  }
}

async function requestTaskClosureDecision(options: {
  adapter: ProviderAdapter
  sessionId: string
  parentSessionId?: string
  prepared: PreparedTaskClosureClassifierRequest
  reasoningEffort: ReasoningEffort | undefined
}): Promise<TaskClosureClassifierResult> {
  const { classifierMessage, classifierRequest } = options.prepared
  const response = await options.adapter.complete({
    messages: [classifierMessage],
    system: classifierRequest.system,
    stream: false,
    maxTokens: classifierRequest.maxTokens,
    reasoningEffort: options.reasoningEffort,
    meta: {
      sessionId: options.sessionId,
      purpose: 'task_closure',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    },
  })

  const responseText = extractAssistantText(response.content)
  return {
    classifierRequest,
    response,
    responseText,
    decision: parseTaskClosureDecision(responseText),
  }
}

function recordTaskClosureDecision(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifier: TaskClosureClassifierResult
  decision: TaskClosureDecision
}): TaskClosureEvaluation {
  const { classifier, decision } = options

  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      data: {
        closure: {
          event: 'task_closure_decision',
          action: decision.action,
          reason: decision.reason,
          classifierRequest: classifier.classifierRequest,
          classifierResponse: classifier.response,
        },
      },
      metadata: {
        called: true,
        classifierModel: classifier.response.model,
        action: decision.action,
        reason: decision.reason,
        classifierRequest: classifier.classifierRequest,
      },
    })
  }

  return {
    decision,
    eventPayload: {
      event: 'task_closure_decision',
      sessionId: options.sessionId,
      action: decision.action,
      reason: decision.reason,
      classifierRequest: classifier.classifierRequest,
      classifierResponse: classifier.response,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'success',
  }
}

function recordInvalidTaskClosureClassifierOutput(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifier: TaskClosureClassifierResult
}): TaskClosureEvaluation {
  const { classifier } = options

  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      kind: 'closure_failed',
      name: 'task_closure_failed',
      data: {
        closure: {
          event: 'task_closure_failed',
          reason: 'invalid_classifier_output',
          failureStage: 'parse_classifier_response',
          classifierRequest: classifier.classifierRequest,
          classifierResponse: classifier.response,
          classifierResponseRaw: classifier.responseText,
        },
      },
      metadata: {
        called: true,
        classifierModel: classifier.response.model,
        reason: 'invalid_classifier_output',
        failureStage: 'parse_classifier_response',
        classifierRequest: classifier.classifierRequest,
        classifierResponseRaw: classifier.responseText,
      },
    })
  }

  return {
    decision: null,
    eventPayload: {
      event: 'task_closure_failed',
      sessionId: options.sessionId,
      reason: 'invalid_classifier_output',
      failureStage: 'parse_classifier_response',
      classifierRequest: classifier.classifierRequest,
      classifierResponse: classifier.response,
      classifierResponseRaw: classifier.responseText,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'error',
  }
}

function recordTaskClosureClassifierFailure(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifierRequest: TaskClosureClassifierRequest
  error: string
}): TaskClosureEvaluation {
  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      kind: 'closure_failed',
      name: 'task_closure_failed',
      data: {
        closure: {
          event: 'task_closure_failed',
          reason: 'classifier_failed',
          failureStage: 'request_classifier',
          classifierRequest: options.classifierRequest,
          error: options.error,
        },
      },
      metadata: {
        called: true,
        reason: 'classifier_failed',
        failureStage: 'request_classifier',
        classifierRequest: options.classifierRequest,
        error: options.error,
      },
    })
  }

  return {
    decision: null,
    eventPayload: {
      event: 'task_closure_failed',
      sessionId: options.sessionId,
      reason: 'classifier_failed',
      failureStage: 'request_classifier',
      classifierRequest: options.classifierRequest,
      error: options.error,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'error',
  }
}

interface AgentMemoryNudgeResponseHandlerOptions {
  getCurrentRequestSpanId: () => string | undefined
  memoryNudge: AgentMemoryNudgeController
  obs: Pick<AgentObservability, 'secretFilter' | 'tracer'>
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  queueGate: Pick<AgentQueueGate, 'drainPendingQueue'>
  toolContext: Pick<ToolContext, 'logger' | 'sessionId'>
  turnIndex: number
}

function createAgentMemoryNudgeResponseHandlers(
  options: AgentMemoryNudgeResponseHandlerOptions,
): Pick<AgentLoopHooks, 'onEmptyResponse' | 'onInvalidAssistantResponse' | 'onTextDelta'> {
  return {
    onInvalidAssistantResponse: (request, response, error) =>
      handleInvalidAssistantResponse(request, response, error, options),
    onTextDelta: (delta, meta) => {
      if (options.memoryNudge.isActive) return
      options.onTextDelta?.(delta, meta)
    },
    onEmptyResponse: (retryCount) => handleEmptyResponse(retryCount, options),
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
  retryCount: number,
  options: AgentMemoryNudgeResponseHandlerOptions,
): ReturnType<NonNullable<AgentLoopHooks['onEmptyResponse']>> {
  if (options.memoryNudge.isActive) {
    const drain = options.queueGate.drainPendingQueue(
      'memory_nudge_empty',
      options.getCurrentRequestSpanId(),
    )
    if (drain) {
      options.toolContext.logger.info?.('memory_nudge_interrupted_by_queue', {
        sessionId: options.toolContext.sessionId,
        phase: 'memory_nudge_empty',
      })
      return drain
    }

    options.memoryNudge.completeSuccess()

    options.toolContext.logger.info?.('memory_nudge_empty_response', {
      sessionId: options.toolContext.sessionId,
    })
    return 'break'
  }

  return retryCount < CONTEXT_PARAMS.completion.maxEmptyResponseRetries
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
    notifyAppliedCallbacks(): void
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
    onCompletionStart: (request) => {
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
      obs.tracer?.logSession?.(toolContext.sessionId, 'debug', 'llm_request.raw_request', {
        traceSpanId: currentRequestSpanId,
        turnIndex,
        parentId: pendingParentRequestId,
        request: filterTraceValue(request, obs.secretFilter),
      })
    },
    onCompletionEnd: (request, response, durationMs) => {
      response.model = obs.modelLabel ?? response.model
      executionState.currentRequestId = response.id

      obs.tracer?.logSession?.(toolContext.sessionId, 'debug', 'llm_request.raw_response', {
        traceSpanId: currentRequestSpanId,
        turnIndex,
        requestId: response.id,
        durationMs,
        response: filterTraceValue(response, obs.secretFilter),
      })

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
      queueTrace.notifyAppliedCallbacks()
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
      obs.tracer?.logSession?.(toolContext.sessionId, 'debug', 'tool_call.raw_input', {
        traceSpanId: toolSpan?.id,
        requestId: executionState.currentRequestId,
        tool: toolName,
        toolUseId,
        input: filteredToolInput,
      })
    },
    onToolCallEnd: (toolName, toolUseId, input, result) => {
      if (toolName === 'memory' && result.success) {
        const action =
          typeof input === 'object' && input !== null && 'action' in input
            ? (input as { action?: unknown }).action
            : undefined
        if (action === 'create' || action === 'update') {
          markMemoryWriteSucceeded()
        }
      }

      const toolSpanId = toolSpanIds.get(toolUseId)
      const filteredToolInput = filterToolInput(input, obs.secretFilter)
      const filteredToolResult = filterTraceValue(result, obs.secretFilter)
      if (toolSpanId) {
        obs.tracer?.updateSpan(toolSpanId, {
          data: {
            input: filteredToolInput,
            toolResult: filteredToolResult,
            outputSummary: result.outputSummary,
          },
          metadata: {
            toolUseId,
            toolName,
            input: filteredToolInput,
            result: filteredToolResult,
            outputSummary: result.outputSummary,
          },
        })
        obs.tracer?.endSpan(toolSpanId, result.success ? 'success' : 'error', {
          toolUseId,
          toolName,
          input: filteredToolInput,
          toolResult: filteredToolResult,
          outputSummary: result.outputSummary,
        })
      }
      obs.tracer?.logSession?.(
        toolContext.sessionId,
        result.success ? 'debug' : 'error',
        'tool_call.raw_result',
        {
          traceSpanId: toolSpanId,
          requestId: executionState.currentRequestId,
          tool: toolName,
          toolUseId,
          input: filteredToolInput,
          result: filteredToolResult,
        },
      )

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

function buildAgentRequestUserContent(
  content: Message['content'],
  context: Pick<AgentContext, 'dynamicContext' | 'imageDelegationFiles'>,
): Message['content'] {
  const prefix: Message['content'] = []
  if (context.dynamicContext) {
    prefix.push({ type: 'text', text: context.dynamicContext })
  }
  if (context.imageDelegationFiles?.length) {
    prefix.push({
      type: 'text',
      text: buildImageDelegationPrompt(context.imageDelegationFiles),
    })
  }
  if (prefix.length === 0) return content
  const requestContent = context.imageDelegationFiles?.length
    ? content.filter((block) => block.type !== 'image')
    : content
  return [...prefix, ...requestContent]
}

function buildImageDelegationPrompt(files: Array<{ path: string; mediaType: string }>): string {
  const fileLines = files.map(
    (file, index) => `- image ${index + 1}: ${file.path} (${file.mediaType})`,
  )
  return [
    '<image_delegation>',
    '当前模型不能直接看图。以下用户图片已保存为本地文件，可委托支持 vision 的子 agent 分析：',
    ...fileLines,
    '',
    '需要图片理解时，调用 spawn_agent，指定支持 vision 的模型，并设置 tools=["read_image"]。instruction 必须包含：这些图片的绝对路径、用户原始问题、判断标准、相关上下文，以及“只返回文字分析报告”。随后调用 wait_agent，基于子 agent 的文字报告回复用户。不要声称当前模型直接看到了图片。',
    '</image_delegation>',
  ].join('\n')
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
