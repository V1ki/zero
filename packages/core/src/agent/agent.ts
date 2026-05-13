import { createHash } from 'node:crypto'
import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import { computeCost } from '@zero-os/model'
import type {
  ClosureLogEntryInput,
  MetricsDB,
  RequestMemoryInjectionEntry,
  RequestToolCallEntry,
  RequestToolResultEntry,
  SnapshotEntry,
  TaskClosureClassifierResponse,
  Tracer,
  UsagePurpose,
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  CompressionResult,
  ContentBlock,
  ControlKind,
  Message,
  ReasoningEffort,
  SecretFilter,
  ToolContext,
  ToolDefinition,
  ToolEvidence,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import type { ToolRegistry } from '../tool/registry'
import { AgentLoop, type AgentLoopHooks, type ToolExecutor } from './agent-loop'
import { allocateBudget, shouldCompress } from './budget'
import {
  type EpisodeCompactionTraceEvent,
  estimateConversationTokens,
  prepareConversationHistory,
} from './context'
import { attachLargeToolUseEvidence } from './evidence'
import { retrieveMemoriesWithDecision } from './memory-retrieval'
import { CONTEXT_PARAMS } from './params'
import { wrapMemoryInjection } from './prompt'
import {
  CONTINUATION_PROMPT,
  type QueuedInjectionTrace,
  type QueuedMessage,
  buildQueuedInjectionText,
  buildQueuedInjectionTrace,
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
  extractAssistantTail,
  extractAssistantText,
  hasAssistantText,
  parseTaskClosureDecision,
} from './task-closure'
import { artifactizeToolOutput } from './truncate'
import type { ToolEvidenceReason } from './truncate'

interface FailedToolAttempt {
  toolUseId: string
  toolName: string
  input: unknown
  output: string
  outputSummary?: string
}

function cloneMemoryInjections(
  memoryInjections?: RequestMemoryInjectionEntry[],
): RequestMemoryInjectionEntry[] | undefined {
  if (!memoryInjections || memoryInjections.length === 0) return undefined
  return memoryInjections.map((memoryInjection) => ({ ...memoryInjection }))
}

function isMissingDeepSeekSignedThinkingError(error: unknown): boolean {
  return toErrorMessage(error).includes('missing signed thinking content')
}

export interface AgentConfig {
  name: string
  /** High-level role or task intent consumed by the prompt builder, not the rendered system prompt. */
  agentInstruction: string
  identityMemory?: string
  /** Controls which prompt sections are included. Defaults to 'full'. */
  promptMode?: import('@zero-os/shared').PromptMode
}

export interface AgentContext {
  systemPrompt: string
  identityMemory?: string
  /** Dynamic context (<system-reminder>) injected into user message for the API only, not stored. */
  dynamicContext?: string
  /** Local image files saved for text-only models to delegate to a vision sub-agent. */
  imageDelegationFiles?: Array<{ path: string; mediaType: string }>
  /** Request-scoped memory injections for observability and UI trace previews. */
  requestMemoryInjections?: RequestMemoryInjectionEntry[]
  /** Session-scoped memory ids already injected in prior layer1/layer2 retrievals. */
  injectedMemoryIds?: Map<string, string>
  conversationHistory: Message[]
  tools: ToolDefinition[]
  maxContext?: number
  maxOutput?: number
  reasoningEffort?: ReasoningEffort
}

/**
 * Optional observability dependencies for the agent.
 */
export interface AgentObservability {
  metrics?: MetricsDB
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'> & {
    logSession?: Tracer['logSession']
  }
  secretFilter?: SecretFilter
  bus?: {
    emit(topic: string, data: Record<string, unknown>): void
  }
  /** Provider name for logging, e.g. "openai-codex" */
  providerName?: string
  /** Provider-qualified model label, e.g. "chatgpt/gpt-5.4" */
  modelLabel?: string
  /** ModelPricing from config for cost calculation */
  pricing?: import('@zero-os/shared').ModelPricing
  closurePricing?: import('@zero-os/shared').ModelPricing
  closureProviderName?: string
  closureModelLabel?: string
  usagePurpose?: UsagePurpose
  parentSessionId?: string
  getCurrentSnapshotId?: () => string | undefined
  onContextCompressed?: (event: {
    summary: string
    stats: CompressionResult['stats']
    decisionContext: NonNullable<SnapshotEntry['decisionContext']>
  }) => void
}

/**
 * Agent execution engine — runs the tool use loop.
 */
interface TaskClosureClassifierRequest {
  system: string
  prompt: string
  maxTokens: number
}

interface TaskClosureEvaluation {
  decision: TaskClosureDecision | null
  eventPayload: SessionTaskClosureEvent | null
  traceSpanId?: string
  traceSpanStatus?: 'success' | 'error'
}

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
      reason: 'invalid_classifier_output' | 'classifier_failed'
      failureStage: 'parse_classifier_response' | 'request_classifier'
      classifierRequest: TaskClosureClassifierRequest
      classifierResponse?: TaskClosureClassifierResponse
      classifierResponseRaw?: string
      error?: string
    }

export class Agent {
  private config: AgentConfig
  private adapter: ProviderAdapter
  private closureAdapter: ProviderAdapter
  private toolRegistry: ToolRegistry
  private toolContext: ToolContext
  private obs: AgentObservability

  constructor(
    config: AgentConfig,
    adapter: ProviderAdapter,
    toolRegistry: ToolRegistry,
    toolContext: ToolContext,
    obs: AgentObservability = {},
    closureAdapter?: ProviderAdapter,
  ) {
    this.config = config
    this.adapter = adapter
    this.closureAdapter = closureAdapter ?? adapter
    this.toolRegistry = toolRegistry
    this.toolContext = toolContext
    this.obs = obs
  }

  /**
   * Run the agent's tool-use loop until completion or max loops reached.
   */
  async run(
    context: AgentContext,
    userMessage: string,
    userImages?: Array<{ mediaType: string; data: string }>,
    onNewMessage?: (msg: Message) => void,
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void,
    shouldInterrupt?: () => boolean,
    getQueuedMessages?: () => QueuedMessage[],
    requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
  ): Promise<Message[]> {
    const turnIndex = requestLogMeta?.turnIndex ?? 1
    const episodeCompactionEvents: EpisodeCompactionTraceEvent[] = []
    const history = prepareConversationHistory(context.conversationHistory, {
      requireThinkingForToolUse: this.adapter.apiType === 'anthropic-deepseek',
      enableEpisodeCompaction: true,
      evidenceWorkDir: this.toolContext.workDir,
      sessionId: this.toolContext.sessionId,
      onEpisodeCompaction: (event) => episodeCompactionEvents.push(event),
    })
    let emittedMessageCount = 0

    const rootSpan = this.obs.tracer?.startSpan(
      this.toolContext.sessionId,
      `turn:${this.config.name}`,
      this.toolContext.currentTraceSpanId,
      {
        kind: 'turn',
        agentName: this.config.name,
        data: { turnIndex },
      },
    )

    for (const event of episodeCompactionEvents) {
      this.recordEpisodeCompactionTrace(event, rootSpan?.id, turnIndex)
    }

    const systemParts: string[] = [context.systemPrompt]
    if (context.identityMemory) systemParts.push(context.identityMemory)
    const system = systemParts.join('\n\n')

    const executionState = {
      currentRequestId: undefined as string | undefined,
      currentTraceSpanId: undefined as string | undefined,
    }
    const requestPurposeRef: { current: UsagePurpose } = {
      current: this.obs.usagePurpose ?? 'agent_loop',
    }

    try {
      const loop = new AgentLoop(
        {
          adapter: this.adapter,
          sessionId: this.toolContext.sessionId,
          toolExecutor: this.createToolExecutor(executionState),
          system,
          tools: context.tools,
          maxOutputTokens: context.maxOutput ?? 16384,
          reasoningEffort: context.reasoningEffort,
          stream: true,
          logger: this.toolContext.logger,
          transientRetryDelayMs: this.transientRetryDelayMs.bind(this),
          getMeta: () => ({
            sessionId: this.toolContext.sessionId,
            purpose: requestPurposeRef.current,
            ...(this.obs.parentSessionId ? { parentSessionId: this.obs.parentSessionId } : {}),
          }),
        },
        this.createHooks({
          context,
          userMessage,
          onNewMessage: (message) => {
            emittedMessageCount++
            onNewMessage?.(message)
          },
          onTextDelta,
          shouldInterrupt,
          getQueuedMessages,
          turnIndex,
          rootSpanId: rootSpan?.id,
          system,
          executionState,
          requestPurposeRef,
        }),
      )

      const newMessages = await loop.run(
        userMessage,
        history,
        userImages,
        requestLogMeta?.userMessageEntry,
      )

      if (rootSpan) {
        this.obs.tracer?.endSpan(rootSpan.id, 'success', {
          messageCount: emittedMessageCount,
        })
      }

      return newMessages
    } catch (error) {
      if (rootSpan) {
        this.obs.tracer?.endSpan(rootSpan.id, 'error', {
          error: toErrorMessage(error),
          messageCount: emittedMessageCount,
        })
      }
      throw error
    }
  }

  /** Backoff delay for transient retries. Override in tests to avoid real waits. */
  protected transientRetryDelayMs(attempt: number): number {
    return Math.min(5_000 * 2 ** (attempt - 1), 60_000) // 5s, 10s, 20s, 40s, 60s cap
  }

  private createToolExecutor(executionState: {
    currentRequestId?: string
    currentTraceSpanId?: string
  }): ToolExecutor {
    return {
      has: (toolName) => this.toolRegistry.has(toolName),
      execute: async (toolName, toolUseId, input) => {
        const tool = this.toolRegistry.get(toolName)
        if (!tool) {
          throw new Error(`Unknown tool: ${toolName}`)
        }

        const runningToolHandle = this.toolContext.runningToolRegistry?.register({
          toolUseId,
          toolName,
          abortable: toolName === 'bash',
        })
        const toolContext: ToolContext = {
          ...this.toolContext,
          currentRequestId: executionState.currentRequestId,
          currentTraceSpanId: executionState.currentTraceSpanId,
          currentToolUseId: toolUseId,
          tracer: this.toolContext.tracer,
        }

        const result = await tool.run(toolContext, input)
        runningToolHandle?.markFinished({
          finishedAt: now(),
          cause: 'completed',
          success: result.success,
          outputSummary: result.outputSummary,
        })
        return result
      },
    }
  }

  private createHooks(options: {
    context: AgentContext
    userMessage: string
    onNewMessage?: (msg: Message) => void
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
    shouldInterrupt?: () => boolean
    getQueuedMessages?: () => QueuedMessage[]
    turnIndex: number
    rootSpanId?: string
    system: string
    executionState: {
      currentRequestId?: string
      currentTraceSpanId?: string
    }
    requestPurposeRef: { current: UsagePurpose }
  }): AgentLoopHooks {
    let continuationCount = 0
    let taskClosureRetryCount = 0
    let memoryNudgeCount = 0
    let hadQueuedMessages = false
    let memoryWriteSucceededThisTurn = false
    let pendingParentRequestId: string | undefined
    let currentRequestToolResults: RequestToolResultEntry[] = []
    let pendingQueuedInjection: QueuedInjectionTrace | undefined
    let pendingQueuedAppliedCallbacks: Array<() => void> = []
    let appliedQueuedIntentText: string | undefined
    let pendingMemoryInjections = cloneMemoryInjections(options.context.requestMemoryInjections)
    let currentRequestSpanId: string | undefined
    let activeMemoryNudgeSpanId: string | undefined

    const toolSpanIds = new Map<string, string>()
    const toolNamesByUseId = new Map<string, string>()
    const baseUsagePurpose = this.obs.usagePurpose ?? 'agent_loop'

    const syncRequestPurpose = () => {
      options.requestPurposeRef.current = memoryNudgeCount > 0 ? 'memory_nudge' : baseUsagePurpose
    }

    const appendAppliedQueuedIntent = (queued: QueuedMessage[]) => {
      const intentText = formatAppliedQueuedIntent(queued)
      if (!intentText) return
      appliedQueuedIntentText = appliedQueuedIntentText
        ? `${appliedQueuedIntentText}\n${intentText}`
        : intentText
    }

    const trackQueuedAppliedCallbacks = (queued: QueuedMessage[]) => {
      for (const message of queued) {
        if (message.onApplied) {
          pendingQueuedAppliedCallbacks.push(message.onApplied)
        }
      }
    }

    const notifyQueuedApplied = () => {
      if (pendingQueuedAppliedCallbacks.length === 0) return

      const callbacks = pendingQueuedAppliedCallbacks
      pendingQueuedAppliedCallbacks = []
      for (const callback of callbacks) {
        try {
          callback()
        } catch (error) {
          this.toolContext.logger.warn('queued_message_applied_callback_failed', {
            sessionId: this.toolContext.sessionId,
            error: toErrorMessage(error),
          })
        }
      }
    }

    const interruptMemoryNudge = () => {
      const wasDuringNudge = memoryNudgeCount > 0
      if (activeMemoryNudgeSpanId) {
        this.obs.tracer?.endSpan(activeMemoryNudgeSpanId, 'error', {
          memoryWritten: memoryWriteSucceededThisTurn,
          interruptReason: 'pending_queue',
        })
        activeMemoryNudgeSpanId = undefined
      }
      if (wasDuringNudge) {
        memoryNudgeCount = 0
      }
      syncRequestPurpose()
      return wasDuringNudge
    }

    const finalizeTaskClosureSpan = (
      evaluation: TaskClosureEvaluation,
      assistantMsg: Message | undefined,
      extraMetadata?: Record<string, unknown>,
      extraClosureData?: Record<string, unknown>,
    ) => {
      if (assistantMsg?.role !== 'assistant' || !evaluation.traceSpanId) return

      this.obs.tracer?.updateSpan(evaluation.traceSpanId, {
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
        this.obs.tracer?.endSpan(evaluation.traceSpanId, evaluation.traceSpanStatus)
      }
    }

    const drainPendingQueue = (
      phase: string,
    ): { action: 'continue'; continuationMessage: Message } | null => {
      if (!options.shouldInterrupt?.()) return null

      const queued = options.getQueuedMessages?.() ?? []
      if (queued.length === 0) return null

      const wasDuringNudge = interruptMemoryNudge()

      hadQueuedMessages = true
      appendAppliedQueuedIntent(queued)
      pendingQueuedInjection = buildQueuedInjectionTrace(queued)
      trackQueuedAppliedCallbacks(queued)

      const drainSpan = this.obs.tracer?.startSpan(
        this.toolContext.sessionId,
        'queue_gate_drain',
        currentRequestSpanId,
        {
          kind: 'closure_decision',
          agentName: this.config.name,
          metadata: {
            phase,
            queueCount: queued.length,
            wasDuringNudge,
            appliedQueuedIntentLength: appliedQueuedIntentText?.length ?? 0,
          },
        },
      )
      if (drainSpan) {
        this.obs.tracer?.endSpan(drainSpan.id, 'success')
      }

      this.obs.bus?.emit('session:update', {
        sessionId: this.toolContext.sessionId,
        event: 'queue_drain_on_interrupt',
        queueCount: queued.length,
        wasDuringNudge,
        phase,
      })

      return {
        action: 'continue' as const,
        continuationMessage: this.buildLoopUserMessage(
          buildQueuedInjectionText(queued),
          'queued_injection',
        ),
      }
    }

    return {
      buildRequestUserContent: (content) => {
        const prefix: Message['content'] = []
        if (options.context.dynamicContext) {
          prefix.push({ type: 'text', text: options.context.dynamicContext })
        }
        if (options.context.imageDelegationFiles?.length) {
          prefix.push({
            type: 'text',
            text: buildImageDelegationPrompt(options.context.imageDelegationFiles),
          })
        }
        if (prefix.length === 0) return content
        const requestContent = options.context.imageDelegationFiles?.length
          ? content.filter((block) => block.type !== 'image')
          : content
        return [...prefix, ...requestContent]
      },
      onNewMessage: (message) => {
        if (memoryNudgeCount === 0) {
          options.onNewMessage?.(message)
        }

        if (message.role === 'assistant') {
          this.obs.bus?.emit('session:update', {
            sessionId: this.toolContext.sessionId,
            event: 'assistant_response',
            model: message.model,
          })
        }
      },
      filterAssistantContent: (content) =>
        attachLargeToolUseEvidence(this.filterContent(content), {
          workDir: this.toolContext.workDir,
          sessionId: this.toolContext.sessionId,
          onEvidence: (evidence, toolUse) => {
            this.logToolEvidence(evidence, {
              source: 'active_tool_use',
              reason: 'large_tool_input',
              turnIndex: options.turnIndex,
              traceSpanId: currentRequestSpanId,
              requestId: options.executionState.currentRequestId,
              originalChars: JSON.stringify(toolUse.input).length,
            })
          },
        }),
      onCompletionStart: (_request) => {
        const llmSpan = this.obs.tracer?.startSpan(
          this.toolContext.sessionId,
          'llm_request',
          options.rootSpanId,
          {
            kind: 'llm_request',
            agentName: this.config.name,
            data: {
              turnIndex: options.turnIndex,
              parentId: pendingParentRequestId,
              spawnedByRequestId: this.toolContext.spawnedByRequestId,
            },
          },
        )
        currentRequestSpanId = llmSpan?.id
        this.obs.tracer?.logSession?.(
          this.toolContext.sessionId,
          'debug',
          'llm_request.raw_request',
          {
            traceSpanId: currentRequestSpanId,
            turnIndex: options.turnIndex,
            parentId: pendingParentRequestId,
            request: this.filterTraceValue(_request),
          },
        )
      },
      onCompletionEnd: (request, response, durationMs) => {
        response.model = this.obs.modelLabel ?? response.model
        options.executionState.currentRequestId = response.id

        this.obs.tracer?.logSession?.(
          this.toolContext.sessionId,
          'debug',
          'llm_request.raw_response',
          {
            traceSpanId: currentRequestSpanId,
            turnIndex: options.turnIndex,
            requestId: response.id,
            durationMs,
            response: this.filterTraceValue(response),
          },
        )

        this.logLLMRequest(
          request,
          response,
          options.userMessage,
          durationMs,
          {
            turnIndex: options.turnIndex,
            parentId: pendingParentRequestId,
          },
          currentRequestToolResults,
          pendingQueuedInjection,
          pendingMemoryInjections,
          currentRequestSpanId,
        )

        currentRequestToolResults = []
        notifyQueuedApplied()
        pendingQueuedInjection = undefined
        pendingMemoryInjections = undefined
        pendingParentRequestId = response.stopReason === 'tool_use' ? response.id : undefined
      },
      onCompletionError: (_request, error) => {
        this.obs.tracer?.logSession?.(this.toolContext.sessionId, 'error', 'llm_request.error', {
          traceSpanId: currentRequestSpanId,
          turnIndex: options.turnIndex,
          request: this.filterTraceValue(_request),
          error: toErrorMessage(error),
        })
        if (activeMemoryNudgeSpanId) {
          this.obs.tracer?.endSpan(activeMemoryNudgeSpanId, 'error', {
            error: toErrorMessage(error),
            memoryWritten: memoryWriteSucceededThisTurn,
          })
          activeMemoryNudgeSpanId = undefined
          memoryNudgeCount = 0
        }
        syncRequestPurpose()

        if (currentRequestSpanId) {
          this.obs.tracer?.updateSpan(currentRequestSpanId, {
            metadata: {
              error: toErrorMessage(error),
            },
          })
          this.obs.tracer?.endSpan(currentRequestSpanId, 'error')
        }
      },
      onInvalidAssistantResponse: (request, response, error) => {
        if (memoryNudgeCount === 0 || !isMissingDeepSeekSignedThinkingError(error)) {
          return undefined
        }

        const errorMessage = toErrorMessage(error)
        this.toolContext.logger.warn?.('memory_nudge_response_discarded', {
          sessionId: this.toolContext.sessionId,
          responseId: response.id,
          stopReason: response.stopReason,
          reason: errorMessage,
        })
        this.obs.tracer?.logSession?.(
          this.toolContext.sessionId,
          'warn',
          'memory_nudge.response_discarded',
          {
            traceSpanId: currentRequestSpanId,
            turnIndex: options.turnIndex,
            request: this.filterTraceValue(request),
            response: this.filterTraceValue(response),
            reason: errorMessage,
          },
        )

        if (activeMemoryNudgeSpanId) {
          this.obs.tracer?.endSpan(activeMemoryNudgeSpanId, 'success', {
            discardedInvalidResponse: true,
            memoryWritten: memoryWriteSucceededThisTurn,
            reason: errorMessage,
          })
          activeMemoryNudgeSpanId = undefined
        }
        memoryNudgeCount = 0
        syncRequestPurpose()

        return { action: 'break' as const }
      },
      onTextDelta: (delta, meta) => {
        if (memoryNudgeCount > 0) return
        options.onTextDelta?.(delta, meta)
      },
      onEmptyResponse: (retryCount) => {
        if (memoryNudgeCount > 0) {
          const drain = drainPendingQueue('memory_nudge_empty')
          if (drain) {
            this.toolContext.logger.info?.('memory_nudge_interrupted_by_queue', {
              sessionId: this.toolContext.sessionId,
              phase: 'memory_nudge_empty',
            })
            return drain
          }

          if (activeMemoryNudgeSpanId) {
            this.obs.tracer?.endSpan(activeMemoryNudgeSpanId, 'success', {
              memoryWritten: memoryWriteSucceededThisTurn,
            })
            activeMemoryNudgeSpanId = undefined
          }
          memoryNudgeCount = 0
          syncRequestPurpose()

          this.toolContext.logger.info?.('memory_nudge_empty_response', {
            sessionId: this.toolContext.sessionId,
          })
          return 'break'
        }

        return retryCount < CONTEXT_PARAMS.completion.maxEmptyResponseRetries
      },
      onEndTurn: async (response, ctx) => {
        const gate1 = drainPendingQueue('pre_closure')
        if (gate1) {
          return gate1
        }

        let taskClosureEvaluation: TaskClosureEvaluation = {
          decision: null,
          eventPayload: null,
        }

        const shouldEvaluateTaskClosure =
          !this.toolContext.spawnedByRequestId &&
          memoryNudgeCount === 0 &&
          hasAssistantText(response.content) &&
          extractAssistantTail(response.content).length > 0

        if (shouldEvaluateTaskClosure) {
          taskClosureEvaluation = await this.decideTaskClosure(
            options.userMessage,
            appliedQueuedIntentText,
            ctx.messages,
            response,
            options.context.reasoningEffort,
            currentRequestSpanId,
          )
        }

        const assistantMsg = ctx.messages[ctx.messages.length - 1]
        const gate2 = drainPendingQueue('post_classifier')
        if (gate2) {
          finalizeTaskClosureSpan(
            taskClosureEvaluation,
            assistantMsg,
            {
              discardedDuePendingQueue: true,
              originalAction: taskClosureEvaluation.decision?.action ?? null,
              originalReason: taskClosureEvaluation.decision?.reason ?? null,
            },
            {
              discardedDuePendingQueue: true,
              originalAction: taskClosureEvaluation.decision?.action ?? null,
              originalReason: taskClosureEvaluation.decision?.reason ?? null,
            },
          )
          return gate2
        }

        if (
          assistantMsg?.role === 'assistant' &&
          taskClosureEvaluation.decision?.action === 'block'
        ) {
          assistantMsg.taskClosure = {
            action: 'block',
            reason: taskClosureEvaluation.decision.reason,
          }
        }

        finalizeTaskClosureSpan(taskClosureEvaluation, assistantMsg)

        if (assistantMsg?.role === 'assistant' && taskClosureEvaluation.eventPayload) {
          const sessionEvent: ClosureLogEntryInput & { spanId?: string } = {
            ...taskClosureEvaluation.eventPayload,
            spanId: taskClosureEvaluation.traceSpanId,
            assistantMessageId: assistantMsg.id,
            assistantMessageCreatedAt: assistantMsg.createdAt,
          }

          this.obs.bus?.emit('session:update', sessionEvent)
        }

        if (
          hadQueuedMessages &&
          !isTaskComplete(response.content) &&
          continuationCount < CONTEXT_PARAMS.queue.maxContinuationRetries
        ) {
          continuationCount++
          hadQueuedMessages = false
          return {
            action: 'continue' as const,
            continuationMessage: this.buildLoopUserMessage(CONTINUATION_PROMPT, 'continuation'),
          }
        }

        if (
          taskClosureEvaluation.decision?.action === 'continue' &&
          taskClosureRetryCount < CONTEXT_PARAMS.completion.maxTaskClosureRetries
        ) {
          const gate3 = drainPendingQueue('pre_task_closure_retry')
          if (gate3) {
            return gate3
          }

          taskClosureRetryCount++
          return {
            action: 'continue' as const,
            continuationMessage: this.buildLoopUserMessage(
              buildTaskClosurePrompt(taskClosureEvaluation.decision.reason),
              'task_closure',
            ),
          }
        }

        const promptMode = this.config.promptMode ?? 'full'
        if (
          !memoryWriteSucceededThisTurn &&
          !this.toolContext.spawnedByRequestId &&
          promptMode === 'full' &&
          ctx.iteration >= CONTEXT_PARAMS.memoryNudge.minIterations &&
          memoryNudgeCount < CONTEXT_PARAMS.memoryNudge.maxNudgesPerTurn
        ) {
          const gate4 = drainPendingQueue('pre_memory_nudge')
          if (gate4) {
            return gate4
          }

          memoryNudgeCount++
          activeMemoryNudgeSpanId =
            this.obs.tracer?.startSpan(
              this.toolContext.sessionId,
              'memory_nudge',
              currentRequestSpanId,
              {
                kind: 'closure_decision',
                agentName: this.config.name,
                data: {
                  memoryNudge: {
                    prompt: MEMORY_NUDGE_PROMPT,
                    iteration: ctx.iteration,
                  },
                },
                metadata: {
                  purpose: 'memory_nudge',
                  iteration: ctx.iteration,
                },
              },
            )?.id ?? activeMemoryNudgeSpanId
          syncRequestPurpose()

          return {
            action: 'continue' as const,
            continuationMessage: this.buildLoopUserMessage(MEMORY_NUDGE_PROMPT, 'memory_nudge'),
          }
        }

        if (activeMemoryNudgeSpanId) {
          this.obs.tracer?.endSpan(activeMemoryNudgeSpanId, 'success', {
            memoryWritten: memoryWriteSucceededThisTurn,
          })
          activeMemoryNudgeSpanId = undefined
          memoryNudgeCount = 0
          syncRequestPurpose()
        }

        return { action: 'break' as const }
      },
      onToolCallStart: (toolName, toolUseId, input) => {
        toolNamesByUseId.set(toolUseId, toolName)
        const filteredToolInput = this.filterToolInput(input)

        this.obs.bus?.emit('tool:call', {
          sessionId: this.toolContext.sessionId,
          tool: toolName,
          toolUseId,
          input: filteredToolInput,
        })

        const toolSpan = this.obs.tracer?.startSpan(
          this.toolContext.sessionId,
          `tool:${toolName}`,
          currentRequestSpanId,
          {
            kind: 'tool_call',
            agentName: this.config.name,
            data: {
              tool: toolName,
              input: filteredToolInput,
              inputSummary: this.stringifyTraceData(filteredToolInput),
              requestId: options.executionState.currentRequestId,
            },
          },
        )

        if (toolSpan?.id) {
          toolSpanIds.set(toolUseId, toolSpan.id)
        }
        options.executionState.currentTraceSpanId = toolSpan?.id
        this.obs.tracer?.logSession?.(this.toolContext.sessionId, 'debug', 'tool_call.raw_input', {
          traceSpanId: toolSpan?.id,
          requestId: options.executionState.currentRequestId,
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
            memoryWriteSucceededThisTurn = true
          }
        }

        const toolSpanId = toolSpanIds.get(toolUseId)
        const filteredToolInput = this.filterToolInput(input)
        const filteredToolResult = this.filterTraceValue(result)
        if (toolSpanId) {
          this.obs.tracer?.updateSpan(toolSpanId, {
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
          this.obs.tracer?.endSpan(toolSpanId, result.success ? 'success' : 'error', {
            toolUseId,
            toolName,
            input: filteredToolInput,
            toolResult: filteredToolResult,
            outputSummary: result.outputSummary,
          })
        }
        this.obs.tracer?.logSession?.(
          this.toolContext.sessionId,
          result.success ? 'debug' : 'error',
          'tool_call.raw_result',
          {
            traceSpanId: toolSpanId,
            requestId: options.executionState.currentRequestId,
            tool: toolName,
            toolUseId,
            input: filteredToolInput,
            result: filteredToolResult,
          },
        )

        this.obs.bus?.emit('tool:result', {
          sessionId: this.toolContext.sessionId,
          tool: toolName,
          success: result.success,
          outputSummary: result.outputSummary,
          ...(result.success ? {} : { error: result.outputSummary ?? result.output }),
        })

        options.executionState.currentTraceSpanId = undefined
        toolSpanIds.delete(toolUseId)
      },
      processToolResults: async (toolResults, failedAttempts) => {
        const processedResults = toolResults.map((block) => {
          if (block.type !== 'tool_result') return block

          const toolName = toolNamesByUseId.get(block.toolUseId) ?? 'unknown_tool'
          const artifactized = artifactizeToolOutput(toolName, block.content, {
            workDir: this.toolContext.workDir,
            sessionId: this.toolContext.sessionId,
            toolUseId: block.toolUseId,
            outputSummary: block.outputSummary,
          })
          const { content, artifactPath, evidence } = artifactized

          if (artifactPath) {
            this.toolContext.logger.info('tool_output_artifactized', {
              tool: toolName,
              originalChars: block.content.length,
              artifactPath,
            })
          }
          if (evidence) {
            this.logToolEvidence(evidence, {
              source: 'active_tool_result',
              reason: artifactized.evidenceReason ?? 'tool_result_output',
              turnIndex: options.turnIndex,
              requestId: options.executionState.currentRequestId,
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

        currentRequestToolResults = this.toRequestToolResults(processedResults)

        const memoryHintMsg = await this.buildMemoryHintMessage(
          failedAttempts,
          options.userMessage,
          options.context.identityMemory,
          options.context.injectedMemoryIds,
        )

        if (!memoryHintMsg) {
          return {
            toolResultBlocks: processedResults,
          }
        }

        pendingMemoryInjections = [
          {
            layer: 'layer2',
            source: 'memory_hint',
            formattedText: this.extractTextFromMessage(memoryHintMsg),
          },
        ]

        return {
          toolResultBlocks: processedResults,
          additionalMessages: [memoryHintMsg],
        }
      },
      afterToolResults: async (ctx) => {
        if (options.context.maxContext && options.context.maxOutput) {
          const budget = allocateBudget(options.context.maxContext, options.context.maxOutput)
          const currentTokens = estimateConversationTokens(ctx.messages)

          if (shouldCompress(currentTokens, budget.conversation)) {
            const { compressConversation } = await import('./compress')
            const result = await compressConversation(
              ctx.messages,
              budget.conversation,
              this.adapter,
              this.toolContext.sessionId,
              { parentSessionId: this.obs.parentSessionId },
              {
                tracer: this.obs.tracer,
                parentSpanId: currentRequestSpanId,
                agentName: this.config.name,
                providerName: this.obs.providerName,
                modelLabel: this.obs.modelLabel,
                pricing: this.obs.pricing,
                secretFilter: this.obs.secretFilter,
              },
            )

            ctx.messages.length = 0
            ctx.messages.push(...result.retainedMessages)
            this.obs.onContextCompressed?.({
              summary: result.summary,
              stats: result.stats,
              decisionContext: {
                currentTokens,
                conversationBudget: budget.conversation,
              },
            })
          }
        }

        const queued = options.getQueuedMessages?.() ?? []
        hadQueuedMessages = false
        pendingQueuedInjection = undefined

        if (queued.length > 0 && ctx.messages.length > 0) {
          const lastIdx = ctx.messages.length - 1
          if (ctx.messages[lastIdx].role === 'user') {
            const injected = injectQueuedMessagesWithTrace(ctx.messages[lastIdx], queued)
            ctx.messages[lastIdx] = injected.message
            pendingQueuedInjection = injected.trace
            hadQueuedMessages = injected.trace !== undefined
            appendAppliedQueuedIntent(queued)
            trackQueuedAppliedCallbacks(queued)
            if (hadQueuedMessages) {
              interruptMemoryNudge()
            }
          }
        }
      },
      shouldInterrupt: () => !!options.shouldInterrupt?.() && !hadQueuedMessages,
    }
  }

  private buildLoopUserMessage(text: string, controlKind: ControlKind): Message {
    return {
      id: generateId(),
      sessionId: this.toolContext.sessionId,
      role: 'user',
      messageType: 'control',
      controlKind,
      content: [{ type: 'text', text }],
      createdAt: now(),
    }
  }

  private async decideTaskClosure(
    userMessage: string,
    appliedQueuedIntentText: string | undefined,
    messages: Message[],
    response: CompletionResponse,
    reasoningEffort: ReasoningEffort | undefined,
    parentSpanId?: string,
  ): Promise<TaskClosureEvaluation> {
    const taskClosureSpan = this.obs.tracer?.startSpan(
      this.toolContext.sessionId,
      'task_closure_decision',
      parentSpanId,
      {
        kind: 'closure_decision',
        agentName: this.config.name,
      },
    )

    const endSkipped = (skipReason: string): TaskClosureEvaluation => {
      if (taskClosureSpan) {
        this.obs.tracer?.endSpan(taskClosureSpan.id, 'success', {
          called: false,
          skipReason,
          stopReason: response.stopReason,
        })
      }
      return {
        decision: null,
        eventPayload: null,
        traceSpanId: taskClosureSpan?.id,
        traceSpanStatus: undefined,
      }
    }

    if (response.stopReason === 'tool_use') return endSkipped('tool_use')
    if (!hasAssistantText(response.content)) return endSkipped('no_assistant_text')

    const assistantText = extractAssistantText(response.content)
    const assistantTail = extractAssistantTail(response.content)
    if (!assistantText || !assistantTail) return endSkipped('empty_assistant_tail')

    const promptContext = buildTaskClosurePromptContext(messages)
    const prompt = buildTaskClosureDecisionPrompt(
      userMessage,
      assistantText,
      assistantTail,
      promptContext,
      appliedQueuedIntentText,
    )
    const classifierRequest: TaskClosureClassifierRequest = {
      system: TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
      prompt,
      maxTokens: 800,
    }

    const classifierMessage: Message = {
      id: generateId(),
      sessionId: this.toolContext.sessionId,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: prompt }],
      createdAt: now(),
    }

    try {
      const result = await this.closureAdapter.complete({
        messages: [classifierMessage],
        system: classifierRequest.system,
        stream: false,
        maxTokens: classifierRequest.maxTokens,
        reasoningEffort,
        meta: {
          sessionId: this.toolContext.sessionId,
          purpose: 'task_closure',
          ...(this.obs.parentSessionId ? { parentSessionId: this.obs.parentSessionId } : {}),
        },
      })

      const text = extractAssistantText(result.content)
      const parsedDecision = parseTaskClosureDecision(text)
      const validDecision = parsedDecision

      if (validDecision) {
        if (taskClosureSpan) {
          this.obs.tracer?.updateSpan(taskClosureSpan.id, {
            data: {
              closure: {
                event: 'task_closure_decision',
                action: validDecision.action,
                reason: validDecision.reason,
                classifierRequest,
                classifierResponse: result,
              },
            },
            metadata: {
              called: true,
              classifierModel: result.model,
              action: validDecision.action,
              reason: validDecision.reason,
              classifierRequest,
            },
          })
        }

        return {
          decision: validDecision,
          eventPayload: {
            event: 'task_closure_decision',
            sessionId: this.toolContext.sessionId,
            action: validDecision.action,
            reason: validDecision.reason,
            classifierRequest,
            classifierResponse: result,
          },
          traceSpanId: taskClosureSpan?.id,
          traceSpanStatus: 'success',
        }
      }

      if (taskClosureSpan) {
        this.obs.tracer?.updateSpan(taskClosureSpan.id, {
          kind: 'closure_failed',
          name: 'task_closure_failed',
          data: {
            closure: {
              event: 'task_closure_failed',
              reason: 'invalid_classifier_output',
              failureStage: 'parse_classifier_response',
              classifierRequest,
              classifierResponse: result,
              classifierResponseRaw: text,
            },
          },
          metadata: {
            called: true,
            classifierModel: result.model,
            reason: 'invalid_classifier_output',
            failureStage: 'parse_classifier_response',
            classifierRequest,
            classifierResponseRaw: text,
          },
        })
      }

      return {
        decision: null,
        eventPayload: {
          event: 'task_closure_failed',
          sessionId: this.toolContext.sessionId,
          reason: 'invalid_classifier_output',
          failureStage: 'parse_classifier_response',
          classifierRequest,
          classifierResponse: result,
          classifierResponseRaw: text,
        },
        traceSpanId: taskClosureSpan?.id,
        traceSpanStatus: 'error',
      }
    } catch (error) {
      this.toolContext.logger.warn('task_closure_classifier_failed', {
        sessionId: this.toolContext.sessionId,
        error: toErrorMessage(error),
      })
      const errorMessage = toErrorMessage(error)
      if (taskClosureSpan) {
        this.obs.tracer?.updateSpan(taskClosureSpan.id, {
          kind: 'closure_failed',
          name: 'task_closure_failed',
          data: {
            closure: {
              event: 'task_closure_failed',
              reason: 'classifier_failed',
              failureStage: 'request_classifier',
              classifierRequest,
              error: errorMessage,
            },
          },
          metadata: {
            called: true,
            reason: 'classifier_failed',
            failureStage: 'request_classifier',
            classifierRequest,
            error: errorMessage,
          },
        })
      }
      return {
        decision: null,
        eventPayload: {
          event: 'task_closure_failed',
          sessionId: this.toolContext.sessionId,
          reason: 'classifier_failed',
          failureStage: 'request_classifier',
          classifierRequest,
          error: errorMessage,
        },
        traceSpanId: taskClosureSpan?.id,
        traceSpanStatus: 'error',
      }
    }
  }

  /**
   * Log an LLM request to the observability layer.
   */
  private recordEpisodeCompactionTrace(
    event: EpisodeCompactionTraceEvent,
    parentSpanId: string | undefined,
    turnIndex: number,
  ): void {
    const payload = this.filterTraceValue({
      ...event,
      turnIndex,
      agentName: this.config.name,
    }) as Record<string, unknown>
    const span = this.obs.tracer?.startSpan(
      this.toolContext.sessionId,
      'episode_compaction',
      parentSpanId,
      {
        kind: 'context_compaction',
        agentName: this.config.name,
        data: {
          compaction: payload,
        },
        metadata: {
          turnIndex,
          strategy: event.strategy,
          episodesCreated: event.episodesCreated,
          evidenceCount: event.evidenceCount,
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter,
        },
      },
    )

    this.obs.tracer?.logSession?.(
      this.toolContext.sessionId,
      'info',
      'context_compaction.episode',
      {
        traceSpanId: span?.id,
        ...payload,
      },
    )

    for (const evidence of event.evidence) {
      this.logToolEvidence(evidence, {
        source: 'episode_compaction',
        reason: 'replay_compaction',
        turnIndex,
        traceSpanId: span?.id,
        compactionId: event.workingStateId,
      })
    }

    if (span) {
      this.obs.tracer?.endSpan(span.id, 'success', {
        turnIndex,
        episodesCreated: event.episodesCreated,
        evidenceCount: event.evidenceCount,
      })
    }
  }

  private logToolEvidence(
    evidence: ToolEvidence,
    meta: {
      source: 'active_tool_use' | 'active_tool_result' | 'episode_compaction'
      reason: ToolEvidenceReason | 'large_tool_input' | 'replay_compaction' | 'tool_result_output'
      turnIndex: number
      traceSpanId?: string
      requestId?: string
      compactionId?: string
      artifactPath?: string
      originalChars?: number
      originalTokens?: number
      promptTokenLimit?: number
      thresholdChars?: number
      inlineContentChars?: number
    },
  ): void {
    const payload = this.filterTraceValue({
      traceSpanId: meta.traceSpanId,
      requestId: meta.requestId,
      compactionId: meta.compactionId,
      source: meta.source,
      reason: meta.reason,
      turnIndex: meta.turnIndex,
      tool: evidence.toolName,
      toolUseId: evidence.toolUseId,
      artifactPath: meta.artifactPath,
      originalChars: meta.originalChars,
      originalTokens: meta.originalTokens,
      promptTokenLimit: meta.promptTokenLimit,
      thresholdChars: meta.thresholdChars,
      inlineContentChars: meta.inlineContentChars,
      evidence: {
        kind: evidence.kind,
        sessionId: evidence.sessionId,
        toolUseId: evidence.toolUseId,
        toolName: evidence.toolName,
        path: evidence.path,
        chars: evidence.chars,
        bytes: evidence.bytes,
        sha256: evidence.sha256,
        createdAt: evidence.createdAt,
        summary: evidence.summary,
        strategy: evidence.strategy,
        writeStatus: evidence.writeStatus,
      },
    }) as Record<string, unknown>

    this.obs.tracer?.logSession?.(
      this.toolContext.sessionId,
      'info',
      'tool_evidence.persisted',
      payload,
    )
    this.toolContext.logger.info('tool_evidence_persisted', payload)
  }

  private logLLMRequest(
    request: CompletionRequest,
    response: CompletionResponse,
    userPrompt: string,
    durationMs: number,
    meta: {
      turnIndex: number
      parentId?: string
    },
    requestToolResults: RequestToolResultEntry[],
    queuedInjection?: QueuedInjectionTrace,
    memoryInjections?: RequestMemoryInjectionEntry[],
    traceSpanId?: string,
  ): void {
    const cost = computeCost(response.usage, this.obs.pricing)
    const filter = this.obs.secretFilter
    const requestMetadata = this.buildRequestMetadata(request)
    const snapshotId = this.obs.getCurrentSnapshotId?.()
    const responseText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    const toolCalls = this.extractToolCalls(response.content)
    const toolUseCount = toolCalls.length
    const safeUserPrompt = filter ? filter.filter(userPrompt) : userPrompt
    const safeResponseText = filter ? filter.filter(responseText) : responseText
    const safeReasoningContent = response.reasoningContent
      ? filter
        ? filter.filter(response.reasoningContent)
        : response.reasoningContent
      : undefined
    const safeQueuedInjection = this.filterQueuedInjection(queuedInjection)
    const safeMemoryInjections = this.filterMemoryInjections(memoryInjections)

    if (traceSpanId) {
      this.obs.tracer?.updateSpan(traceSpanId, {
        data: {
          request: {
            id: response.id,
            turnIndex: meta.turnIndex,
            parentId: meta.parentId,
            sessionId: this.toolContext.sessionId,
            agentName: this.config.name,
            spawnedByRequestId: this.toolContext.spawnedByRequestId,
            snapshotId,
            model: this.obs.modelLabel ?? response.model,
            provider: this.obs.providerName ?? 'unknown',
            userPrompt: safeUserPrompt,
            response: safeResponseText,
            reasoningContent: safeReasoningContent,
            stopReason: response.stopReason,
            toolUseCount,
            toolCalls,
            toolResults: requestToolResults,
            ...(safeQueuedInjection ? { queuedInjection: safeQueuedInjection } : {}),
            ...(safeMemoryInjections ? { memoryInjections: safeMemoryInjections } : {}),
            toolNames: requestMetadata.toolNames,
            toolDefinitionsHash: requestMetadata.toolDefinitionsHash,
            systemHash: requestMetadata.systemHash,
            staticPrefixHash: requestMetadata.staticPrefixHash,
            messageCount: request.messages.length,
            tokens: {
              input: response.usage.input,
              output: response.usage.output,
              cacheWrite: response.usage.cacheWrite,
              cacheRead: response.usage.cacheRead,
              reasoning: response.usage.reasoning,
            },
            cost,
            durationMs,
          },
        },
        metadata: {
          requestId: response.id,
          toolNames: requestMetadata.toolNames,
          toolDefinitionsHash: requestMetadata.toolDefinitionsHash,
          systemHash: requestMetadata.systemHash,
          staticPrefixHash: requestMetadata.staticPrefixHash,
        },
      })
      this.obs.tracer?.endSpan(traceSpanId, 'success')
    }
  }

  private filterQueuedInjection(
    queuedInjection?: QueuedInjectionTrace,
  ): QueuedInjectionTrace | undefined {
    if (!queuedInjection) return undefined

    const filter = this.obs.secretFilter
    if (!filter) return queuedInjection

    return {
      ...queuedInjection,
      formattedText: filter.filter(queuedInjection.formattedText),
      messages: queuedInjection.messages.map((message) => ({
        ...message,
        content: filter.filter(message.content),
      })),
    }
  }

  private filterMemoryInjections(
    memoryInjections?: RequestMemoryInjectionEntry[],
  ): RequestMemoryInjectionEntry[] | undefined {
    if (!memoryInjections || memoryInjections.length === 0) return undefined

    const filter = this.obs.secretFilter
    if (!filter) return cloneMemoryInjections(memoryInjections)

    return memoryInjections.map((memoryInjection) => ({
      ...memoryInjection,
      formattedText: filter.filter(memoryInjection.formattedText),
    }))
  }

  private buildRequestMetadata(request: CompletionRequest): {
    toolNames: string[]
    toolDefinitionsHash?: string
    systemHash?: string
    staticPrefixHash?: string
  } {
    const toolNames = request.tools?.map((tool) => tool.name) ?? []
    const toolDefinitionsHash =
      request.tools && request.tools.length > 0 ? this.hashValue(request.tools) : undefined
    const systemHash = request.system ? this.hashValue(request.system) : undefined
    const staticPrefixHash =
      request.system || request.tools?.length
        ? this.hashValue({
            system: request.system,
            tools: request.tools ?? [],
          })
        : undefined

    return {
      toolNames,
      toolDefinitionsHash,
      systemHash,
      staticPrefixHash,
    }
  }

  private extractTextFromMessage(message: Message): string {
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }

  private hashValue(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }

  private extractToolCalls(content: ContentBlock[]): RequestToolCallEntry[] {
    return content.flatMap((block) => {
      if (block.type !== 'tool_use') return []
      return [
        {
          id: block.id,
          name: block.name,
          input: this.filterToolInput(block.input),
          evidence: block.evidence,
        },
      ]
    })
  }

  private toRequestToolResults(content: ContentBlock[]): RequestToolResultEntry[] {
    return content.flatMap((block) => {
      if (block.type !== 'tool_result') return []
      return [
        {
          type: 'tool_result',
          toolUseId: block.toolUseId,
          content: block.content,
          isError: block.isError,
          outputSummary: block.outputSummary,
          evidence: block.evidence,
        },
      ]
    })
  }

  private async buildMemoryHintMessage(
    failedTools: FailedToolAttempt[],
    userMessage: string,
    identitySummary?: string,
    injectedMemoryIds?: Map<string, string>,
  ): Promise<Message | undefined> {
    if (failedTools.length === 0) return undefined

    const decisionContext = [
      `用户当前请求：${userMessage}`,
      '工具执行失败，需要判断是否检索历史经验来辅助恢复。',
      ...failedTools.map((tool, index) =>
        [
          `失败工具 ${index + 1}:`,
          `- tool: ${tool.toolName}`,
          `- input: ${this.stringifyTraceData(tool.input, 1000)}`,
          `- error_summary: ${tool.outputSummary ?? tool.output}`,
        ].join('\n'),
      ),
    ].join('\n')

    const matches = await retrieveMemoriesWithDecision({
      adapter: this.adapter,
      sessionId: this.toolContext.sessionId,
      memoryRetriever: this.toolContext.memoryRetriever,
      identitySummary,
      userMessage: decisionContext,
      previouslyInjectedIds: injectedMemoryIds,
      logger: this.toolContext.logger,
      failureEvent: 'memory_hint_retrieval_failed',
      trace: {
        tracer: this.obs.tracer,
        agentName: this.config.name,
        providerName: this.obs.providerName,
        modelLabel: this.obs.modelLabel,
        pricing: this.obs.pricing,
        secretFilter: this.obs.secretFilter,
        spanName: 'memory_retrieval_decision',
        metadata: {
          layer: 'layer2',
          source: 'memory_hint',
        },
      },
    })
    if (!matches || matches.length === 0) return undefined

    for (const match of matches) {
      injectedMemoryIds?.set(match.id, match.title)
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
      sessionId: this.toolContext.sessionId,
      role: 'user',
      messageType: 'notification',
      content: [{ type: 'text', text: notificationText }],
      createdAt: now(),
    }
  }

  private filterToolInput(input: Record<string, unknown>): Record<string, unknown> {
    const filtered = this.filterToolInputValue(input)
    return filtered && typeof filtered === 'object' && !Array.isArray(filtered)
      ? (filtered as Record<string, unknown>)
      : {}
  }

  private filterTraceValue(value: unknown): unknown {
    return this.filterToolInputValue(value)
  }

  private stringifyTraceData(value: unknown, maxLength = 500): string {
    try {
      const serialized = JSON.stringify(value)
      if (!serialized) return ''
      return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized
    } catch {
      return ''
    }
  }

  private filterToolInputValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.obs.secretFilter ? this.obs.secretFilter.filter(value) : value
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.filterToolInputValue(item))
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
          key,
          this.filterToolInputValue(nestedValue),
        ]),
      )
    }

    return value
  }
  /**
   * Filter secrets from content blocks.
   */
  private filterContent(content: ContentBlock[]): ContentBlock[] {
    const filter = this.obs.secretFilter
    if (!filter) return content

    return content.map((block) => {
      if (block.type === 'text') {
        return { ...block, text: filter.filter(block.text) }
      }
      if (block.type === 'thinking') {
        const thinking = filter.filter(block.thinking)
        return thinking === block.thinking ? block : { ...block, thinking, signature: undefined }
      }
      return block
    })
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
