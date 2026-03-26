import { createHash } from 'node:crypto'
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
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  CompressionResult,
  ContentBlock,
  Message,
  SecretFilter,
  TokenUsage,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@zero-os/shared'
import { generateId, generatePrefixedId, now, toErrorMessage } from '@zero-os/shared'
import { EMPTY_RESPONSE_RETRY_PROMPT } from '../constants'
import type { ToolRegistry } from '../tool/registry'
import { allocateBudget, shouldCompress } from './budget'
import { estimateConversationTokens, prepareConversationHistory } from './context'
import { retrieveMemoriesWithDecision } from './memory-retrieval'
import { CONTEXT_PARAMS } from './params'
import {
  CONTINUATION_PROMPT,
  type QueuedInjectionTrace,
  type QueuedMessage,
  injectQueuedMessagesWithTrace,
  isTaskComplete,
} from './queue'
import {
  TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
  TASK_CLOSURE_PROMPT,
  type TaskClosureDecision,
  buildTaskClosureDecisionPrompt,
  buildTaskClosurePromptContext,
  extractAssistantTail,
  extractAssistantText,
  hasAssistantText,
  parseTaskClosureDecision,
} from './task-closure'
import { artifactizeToolOutput } from './truncate'

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

function wrapMemoryInjection(layer: 'layer1' | 'layer2', content: string): string {
  return [`<memory_inject layer="${layer}">`, content, '</memory_inject>'].join('\n')
}

class ToolInputParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputParseError'
  }
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
  /** Request-scoped memory injections for observability and UI trace previews. */
  requestMemoryInjections?: RequestMemoryInjectionEntry[]
  conversationHistory: Message[]
  tools: ToolDefinition[]
  maxContext?: number
  maxOutput?: number
}

/**
 * Optional observability dependencies for the agent.
 */
export interface AgentObservability {
  metrics?: MetricsDB
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
  secretFilter?: SecretFilter
  bus?: {
    emit(topic: string, data: Record<string, unknown>): void
  }
  /** Provider name for logging, e.g. "openai-codex" */
  providerName?: string
  /** Provider-qualified model label, e.g. "openai-codex/gpt-5.4-medium" */
  modelLabel?: string
  /** ModelPricing from config for cost calculation */
  pricing?: import('@zero-os/shared').ModelPricing
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
    requestLogMeta?: { turnIndex?: number },
  ): Promise<Message[]> {
    let continuationCount = 0
    let taskClosureRetryCount = 0
    let emptyResponseRetryCount = 0
    const messages: Message[] = [...prepareConversationHistory(context.conversationHistory)]
    const newMessages: Message[] = []
    const turnIndex = requestLogMeta?.turnIndex ?? 1

    // Start root trace span
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

    // Add user message (text + optional images)
    const userContent: ContentBlock[] = [{ type: 'text', text: userMessage }]
    if (userImages?.length) {
      for (const img of userImages) {
        userContent.push({ type: 'image', mediaType: img.mediaType, data: img.data })
      }
    }
    const userMsg: Message = {
      id: generateId(),
      sessionId: this.toolContext.sessionId,
      role: 'user',
      messageType: 'message',
      content: userContent,
      createdAt: now(),
    }
    newMessages.push(userMsg)
    onNewMessage?.(userMsg)

    // Inject dynamic context into API copy only — stored message stays clean
    if (context.dynamicContext) {
      const enrichedContent: ContentBlock[] = [
        { type: 'text', text: context.dynamicContext },
        ...userContent,
      ]
      messages.push({ ...userMsg, content: enrichedContent })
    } else {
      messages.push(userMsg)
    }

    // Build system prompt (retrieved memories are already in XML System Prompt if using structured builder)
    const systemParts: string[] = [context.systemPrompt]
    if (context.identityMemory) systemParts.push(context.identityMemory)
    const system = systemParts.join('\n\n')

    let hadQueuedMessages = false
    let pendingParentRequestId: string | undefined
    let currentRequestToolResults: RequestToolResultEntry[] = []
    let pendingQueuedInjection: QueuedInjectionTrace | undefined
    let pendingMemoryInjections = cloneMemoryInjections(context.requestMemoryInjections)

    try {
      while (true) {
        const request: CompletionRequest = {
          messages,
          tools: context.tools,
          system,
          stream: true,
          maxTokens: context.maxOutput ?? 16384,
        }

        const llmSpan = this.obs.tracer?.startSpan(
          this.toolContext.sessionId,
          'llm_request',
          rootSpan?.id,
          {
            kind: 'llm_request',
            agentName: this.config.name,
            data: {
              turnIndex,
              parentId: pendingParentRequestId,
              spawnedByRequestId: this.toolContext.spawnedByRequestId,
            },
          },
        )
        const llmStart = Date.now()
        let response: CompletionResponse
        try {
          response = await this.completeWithStreamFallback(request, onTextDelta)
        } catch (error) {
          if (llmSpan) {
            this.obs.tracer?.updateSpan(llmSpan.id, {
              metadata: {
                error: toErrorMessage(error),
              },
            })
            this.obs.tracer?.endSpan(llmSpan.id, 'error')
          }
          throw error
        }
        const llmDurationMs = Date.now() - llmStart

        // Log LLM request to observability
        this.logLLMRequest(
          request,
          response,
          userMessage,
          llmDurationMs,
          {
            turnIndex,
            parentId: pendingParentRequestId,
          },
          currentRequestToolResults,
          pendingQueuedInjection,
          pendingMemoryInjections,
          llmSpan?.id,
        )
        currentRequestToolResults = []
        pendingQueuedInjection = undefined
        pendingMemoryInjections = undefined
        pendingParentRequestId = response.stopReason === 'tool_use' ? response.id : undefined

        if (response.content.length === 0) {
          this.toolContext.logger.warn('llm_empty_response', {
            sessionId: this.toolContext.sessionId,
            stopReason: response.stopReason,
            retryCount: emptyResponseRetryCount,
          })

          if (emptyResponseRetryCount < CONTEXT_PARAMS.completion.maxEmptyResponseRetries) {
            const retryMsg: Message = {
              id: generateId(),
              sessionId: this.toolContext.sessionId,
              role: 'user',
              messageType: 'message',
              content: [{ type: 'text', text: EMPTY_RESPONSE_RETRY_PROMPT }],
              createdAt: now(),
            }
            messages.push(retryMsg)
            newMessages.push(retryMsg)
            emptyResponseRetryCount++
            continue
          }

          throw new Error(`LLM returned empty response (stopReason=${response.stopReason})`)
        }

        emptyResponseRetryCount = 0

        let taskClosureEvaluation: TaskClosureEvaluation = {
          decision: null,
          eventPayload: null,
        }
        // Skip task closure for sub-agents — they complete a specific task and
        // their "end_turn" is normal completion, not conversation closure.
        const isSubAgent = !!this.toolContext.spawnedByRequestId
        const shouldEvaluateTaskClosure =
          !isSubAgent &&
          response.stopReason === 'end_turn' &&
          !hadQueuedMessages &&
          hasAssistantText(response.content) &&
          extractAssistantTail(response.content).length > 0

        if (shouldEvaluateTaskClosure) {
          taskClosureEvaluation = await this.decideTaskClosure(
            userMessage,
            messages,
            response,
            hadQueuedMessages,
            llmSpan?.id,
          )
        }
        const taskClosureDecision = taskClosureEvaluation.decision
        const displayContent = response.content
        const shouldAutoContinueTaskClosure = taskClosureDecision?.action === 'continue'

        // Create assistant message — filter secrets from text blocks
        const filteredContent = this.filterContent(displayContent)

        const assistantMsg: Message = {
          id: generateId(),
          sessionId: this.toolContext.sessionId,
          role: 'assistant',
          messageType: 'message',
          content: filteredContent,
          model: this.obs.modelLabel ?? response.model,
          createdAt: now(),
        }
        messages.push(assistantMsg)
        newMessages.push(assistantMsg)
        onNewMessage?.(assistantMsg)

        if (taskClosureEvaluation.traceSpanId) {
          this.obs.tracer?.updateSpan(taskClosureEvaluation.traceSpanId, {
            data: {
              closure: {
                assistantMessageId: assistantMsg.id,
                assistantMessageCreatedAt: assistantMsg.createdAt,
              },
            },
            metadata: {
              assistantMessageId: assistantMsg.id,
              assistantMessageCreatedAt: assistantMsg.createdAt,
            },
          })
          if (taskClosureEvaluation.traceSpanStatus) {
            this.obs.tracer?.endSpan(
              taskClosureEvaluation.traceSpanId,
              taskClosureEvaluation.traceSpanStatus,
            )
          }
        }

        if (taskClosureEvaluation.eventPayload) {
          const sessionEvent: ClosureLogEntryInput & { spanId?: string } = {
            ...taskClosureEvaluation.eventPayload,
            spanId: taskClosureEvaluation.traceSpanId,
            assistantMessageId: assistantMsg.id,
            assistantMessageCreatedAt: assistantMsg.createdAt,
          }

          this.obs.bus?.emit('session:update', sessionEvent)
        }

        // Emit session update event
        this.obs.bus?.emit('session:update', {
          sessionId: this.toolContext.sessionId,
          event: 'assistant_response',
          model: this.obs.modelLabel ?? response.model,
        })

        // If no tool use, check if continuation is needed after queued message response
        if (response.stopReason !== 'tool_use') {
          if (
            hadQueuedMessages &&
            !isTaskComplete(response.content) &&
            continuationCount < CONTEXT_PARAMS.queue.maxContinuationRetries
          ) {
            // Task not complete after responding to queued messages — inject continuation prompt
            const contMsg: Message = {
              id: generateId(),
              sessionId: this.toolContext.sessionId,
              role: 'user',
              messageType: 'message',
              content: [{ type: 'text', text: CONTINUATION_PROMPT }],
              createdAt: now(),
            }
            messages.push(contMsg)
            newMessages.push(contMsg)
            continuationCount++
            hadQueuedMessages = false
            continue
          }

          if (
            shouldAutoContinueTaskClosure &&
            taskClosureRetryCount < CONTEXT_PARAMS.completion.maxTaskClosureRetries
          ) {
            const contMsg: Message = {
              id: generateId(),
              sessionId: this.toolContext.sessionId,
              role: 'user',
              messageType: 'message',
              content: [{ type: 'text', text: TASK_CLOSURE_PROMPT }],
              createdAt: now(),
            }
            messages.push(contMsg)
            newMessages.push(contMsg)
            taskClosureRetryCount++
            continue
          }

          break
        }

        // Process tool calls
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
        const toolResultBlocks: ContentBlock[] = []
        const failedToolAttempts: FailedToolAttempt[] = []
        const toolContext: ToolContext = {
          ...this.toolContext,
          currentRequestId: response.id,
          tracer: this.toolContext.tracer,
        }

        for (const block of toolUseBlocks) {
          if (block.type !== 'tool_use') continue
          const tool = this.toolRegistry.get(block.name)

          // Emit tool:call event
          this.obs.bus?.emit('tool:call', {
            sessionId: this.toolContext.sessionId,
            tool: block.name,
            toolUseId: block.id,
            input: this.filterToolInput(block.input),
          })

          // Start tool trace span
          const toolSpan = this.obs.tracer?.startSpan(
            this.toolContext.sessionId,
            `tool:${block.name}`,
            llmSpan?.id,
            {
              kind: 'tool_call',
              agentName: this.config.name,
              data: {
                tool: block.name,
                inputSummary: this.stringifyTraceData(this.filterToolInput(block.input)),
                requestId: response.id,
              },
            },
          )
          toolContext.currentTraceSpanId = toolSpan?.id

          // Detect malformed tool input (truncated by max_tokens)
          if (
            block.type === 'tool_use' &&
            block.input &&
            typeof (block.input as Record<string, unknown>).__parse_error === 'string'
          ) {
            const parseError = (block.input as Record<string, unknown>).__parse_error as string
            toolResultBlocks.push({
              type: 'tool_result',
              toolUseId: block.id,
              content: `Tool input JSON was malformed (likely truncated by max_tokens). ${parseError}. Please retry with shorter content or split into multiple calls.`,
              isError: true,
            })
            if (toolSpan) this.obs.tracer?.endSpan(toolSpan.id, 'error')
            this.obs.bus?.emit('tool:result', {
              sessionId: this.toolContext.sessionId,
              tool: block.name,
              success: false,
              error: parseError,
            })
            continue
          }

          if (!tool) {
            toolResultBlocks.push({
              type: 'tool_result',
              toolUseId: block.id,
              content: `Unknown tool: ${block.name}`,
              isError: true,
            })
            if (toolSpan) this.obs.tracer?.endSpan(toolSpan.id, 'error')
            this.obs.bus?.emit('tool:result', {
              sessionId: this.toolContext.sessionId,
              tool: block.name,
              success: false,
              error: `Unknown tool: ${block.name}`,
            })
            continue
          }

          let result: ToolResult
          try {
            result = await tool.run(toolContext, block.input)
          } catch (error) {
            const errorMessage = toErrorMessage(error)
            result = {
              success: false,
              output: errorMessage,
              outputSummary: `Tool execution failed: ${errorMessage.slice(0, 100)}`,
            }
          }

          if (toolSpan) {
            this.obs.tracer?.updateSpan(toolSpan.id, {
              data: {
                outputSummary: result.outputSummary,
              },
              metadata: {
                toolUseId: block.id,
                toolName: block.name,
                input: this.filterToolInput(block.input),
                result: result.outputSummary ?? result.output?.slice(0, 500),
                outputSummary: result.outputSummary,
              },
            })
            this.obs.tracer?.endSpan(toolSpan.id, result.success ? 'success' : 'error', {
              toolUseId: block.id,
              toolName: block.name,
              outputSummary: result.outputSummary,
            })
          }

          // Emit tool:result event
          this.obs.bus?.emit('tool:result', {
            sessionId: this.toolContext.sessionId,
            tool: block.name,
            success: result.success,
            outputSummary: result.outputSummary,
          })

          const { content: truncatedOutput, artifactPath } = artifactizeToolOutput(
            block.name,
            result.output,
            { workDir: this.toolContext.workDir, toolUseId: block.id },
          )
          if (artifactPath) {
            this.toolContext.logger.info('tool_output_artifactized', {
              tool: block.name,
              originalChars: result.output.length,
              artifactPath,
            })
          }
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: block.id,
            content: truncatedOutput,
            isError: !result.success,
            outputSummary: result.outputSummary,
          })
          if (!result.success) {
            failedToolAttempts.push({
              toolUseId: block.id,
              toolName: block.name,
              input: block.input,
              output: result.output,
              outputSummary: result.outputSummary,
            })
          }
        }

        // Add tool results as user message
        if (toolResultBlocks.length > 0) {
          const toolResultMsg: Message = {
            id: generateId(),
            sessionId: this.toolContext.sessionId,
            role: 'user',
            messageType: 'message',
            content: toolResultBlocks,
            createdAt: now(),
          }
          messages.push(toolResultMsg)
          newMessages.push(toolResultMsg)
          onNewMessage?.(toolResultMsg)

          const memoryHintMsg = await this.buildMemoryHintMessage(
            failedToolAttempts,
            userMessage,
            context.identityMemory,
          )
          if (memoryHintMsg) {
            messages.push(memoryHintMsg)
            newMessages.push(memoryHintMsg)
            onNewMessage?.(memoryHintMsg)
            pendingMemoryInjections = [
              {
                layer: 'layer2',
                source: 'memory_hint',
                formattedText: this.extractTextFromMessage(memoryHintMsg),
              },
            ]
          }
        }
        currentRequestToolResults = this.toRequestToolResults(toolResultBlocks)

        // Budget check + compression
        if (context.maxContext && context.maxOutput) {
          const budget = allocateBudget(context.maxContext, context.maxOutput)
          const currentTokens = estimateConversationTokens(messages)
          if (shouldCompress(currentTokens, budget.conversation)) {
            const { compressConversation } = await import('./compress')
            const result = await compressConversation(
              messages,
              budget.conversation,
              this.adapter,
              this.toolContext.sessionId,
            )
            messages.length = 0
            messages.push(...result.retainedMessages)
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

        // Inject queued messages into the last user message (tool result)
        const queued = getQueuedMessages?.() ?? []
        hadQueuedMessages = false
        pendingQueuedInjection = undefined
        if (queued.length > 0 && messages.length > 0) {
          const lastIdx = messages.length - 1
          if (messages[lastIdx].role === 'user') {
            const injected = injectQueuedMessagesWithTrace(messages[lastIdx], queued)
            messages[lastIdx] = injected.message
            pendingQueuedInjection = injected.trace
            hadQueuedMessages = injected.trace !== undefined
          }
        }

        // Yield to pending message if one arrived during tool execution
        if (shouldInterrupt?.() && !hadQueuedMessages) {
          const finalRequest: CompletionRequest = {
            messages,
            system,
            stream: true,
            maxTokens: context.maxOutput ?? 16384,
          }
          const finalLlmSpan = this.obs.tracer?.startSpan(
            this.toolContext.sessionId,
            'llm_request',
            rootSpan?.id,
            {
              kind: 'llm_request',
              agentName: this.config.name,
              data: {
                turnIndex,
                parentId: pendingParentRequestId,
                spawnedByRequestId: this.toolContext.spawnedByRequestId,
              },
            },
          )
          const finalStart = Date.now()
          let finalResponse: CompletionResponse
          try {
            finalResponse = await this.completeWithStreamFallback(finalRequest, onTextDelta)
          } catch (error) {
            if (finalLlmSpan) {
              this.obs.tracer?.updateSpan(finalLlmSpan.id, {
                metadata: {
                  error: toErrorMessage(error),
                },
              })
              this.obs.tracer?.endSpan(finalLlmSpan.id, 'error')
            }
            throw error
          }
          const finalDurationMs = Date.now() - finalStart
          this.logLLMRequest(
            finalRequest,
            finalResponse,
            userMessage,
            finalDurationMs,
            {
              turnIndex,
              parentId: pendingParentRequestId,
            },
            currentRequestToolResults,
            pendingQueuedInjection,
            pendingMemoryInjections,
            finalLlmSpan?.id,
          )
          currentRequestToolResults = []
          pendingQueuedInjection = undefined
          pendingMemoryInjections = undefined
          pendingParentRequestId =
            finalResponse.stopReason === 'tool_use' ? finalResponse.id : undefined

          const finalContent = this.filterContent(finalResponse.content)
          const finalMsg: Message = {
            id: generateId(),
            sessionId: this.toolContext.sessionId,
            role: 'assistant',
            messageType: 'message',
            content: finalContent,
            model: this.obs.modelLabel ?? finalResponse.model,
            createdAt: now(),
          }
          messages.push(finalMsg)
          newMessages.push(finalMsg)
          onNewMessage?.(finalMsg)
          break
        }
      }
    } catch (error) {
      if (rootSpan) {
        this.obs.tracer?.endSpan(rootSpan.id, 'error', {
          error: toErrorMessage(error),
          messageCount: newMessages.length,
        })
      }
      throw error
    }

    // End root trace span
    if (rootSpan) {
      this.obs.tracer?.endSpan(rootSpan.id, 'success', {
        messageCount: newMessages.length,
      })
    }

    return newMessages
  }

  private isTransientError(errorDetails: {
    message: string
    status?: number
    errorType?: string
  }): boolean {
    const transientTypes = ['overloaded_error', 'api_error']
    const transientStatuses = [429, 503, 529]
    if (errorDetails.errorType && transientTypes.includes(errorDetails.errorType)) return true
    if (errorDetails.status && transientStatuses.includes(errorDetails.status)) return true
    return false
  }

  /** Backoff delay for transient retries. Override in tests to avoid real waits. */
  protected transientRetryDelayMs(attempt: number): number {
    return Math.min(5_000 * 2 ** (attempt - 1), 60_000) // 5s, 10s, 20s, 40s, 60s cap
  }

  private async completeWithStreamFallback(
    request: CompletionRequest,
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void,
  ): Promise<CompletionResponse> {
    const maxStreamRetries = 1
    const maxTransientRetries = 3
    let lastStreamErr: unknown
    let transientAttempts = 0
    let emptyStreamAttempts = 0

    for (let attempt = 0; attempt <= maxStreamRetries + maxTransientRetries; attempt++) {
      try {
        const streamed = await this.completeFromStream(request, onTextDelta)
        if (streamed.content.length === 0) {
          throw new Error('stream returned empty content')
        }
        return streamed
      } catch (streamErr) {
        lastStreamErr = streamErr
        const errorDetails = this.getStreamErrorDetails(streamErr)

        // Retry on empty stream content (original logic, limited to maxStreamRetries)
        if (errorDetails.message === 'stream returned empty content') {
          if (emptyStreamAttempts < maxStreamRetries) {
            emptyStreamAttempts++
            this.toolContext.logger.warn('llm_stream_empty_retry', {
              sessionId: this.toolContext.sessionId,
              apiType: this.adapter.apiType,
              attempt: emptyStreamAttempts,
            })
            continue
          }
        }

        // Retry on transient errors (overloaded, 429, 503, 529) with exponential backoff
        if (transientAttempts < maxTransientRetries && this.isTransientError(errorDetails)) {
          transientAttempts++
          const delay = this.transientRetryDelayMs(transientAttempts)
          this.toolContext.logger.warn('llm_stream_transient_retry', {
            sessionId: this.toolContext.sessionId,
            apiType: this.adapter.apiType,
            error: errorDetails.message,
            errorType: errorDetails.errorType,
            status: errorDetails.status,
            requestId: errorDetails.requestId,
            attempt: transientAttempts,
            maxRetries: maxTransientRetries,
            delayMs: delay,
          })
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }

        const fallbackSkipped = this.shouldSkipStreamFallback(streamErr)
        this.toolContext.logger.warn('llm_stream_fallback_to_complete', {
          sessionId: this.toolContext.sessionId,
          apiType: this.adapter.apiType,
          error: errorDetails.message,
          status: errorDetails.status,
          requestId: errorDetails.requestId,
          fallbackSkipped,
        })
        if (fallbackSkipped) {
          throw streamErr
        }
        return await this.adapter.complete({ ...request, stream: false })
      }
    }

    throw lastStreamErr
  }

  private async completeFromStream(
    request: CompletionRequest,
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void,
  ): Promise<CompletionResponse> {
    const stream = this.adapter.stream({ ...request, stream: true })
    const turnId = generatePrefixedId('turn_')
    const responseId = generatePrefixedId('resp_')

    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls = new Map<string, { id: string; name: string; args: string }>()

    let currentToolId: string | null = null
    let stopReason: CompletionResponse['stopReason'] = 'end_turn'
    let usage: TokenUsage | undefined
    let model = request.model ?? 'unknown'

    for await (const event of stream) {
      if (event.type === 'text_delta') {
        const data = this.toRecord(event.data)
        const delta = typeof data.text === 'string' ? data.text : ''
        if (!delta) continue
        textParts.push(delta)
        onTextDelta?.(delta, { role: 'assistant', turnId })
        continue
      }

      if (event.type === 'reasoning_delta') {
        const data = this.toRecord(event.data)
        const delta = typeof data.text === 'string' ? data.text : ''
        if (!delta) continue
        reasoningParts.push(delta)
        continue
      }

      if (event.type === 'tool_use_start') {
        const data = this.toRecord(event.data)
        const id = typeof data.id === 'string' ? data.id : generatePrefixedId('toolu_')
        const name = typeof data.name === 'string' ? data.name : 'unknown_tool'
        currentToolId = id
        toolCalls.set(id, { id, name, args: '' })
        continue
      }

      if (event.type === 'tool_use_delta') {
        const data = this.toRecord(event.data)
        const chunk = typeof data.arguments === 'string' ? data.arguments : ''
        if (!chunk) continue

        const explicitId = typeof data.id === 'string' ? data.id : null
        const targetId = explicitId ?? currentToolId

        if (!targetId) continue
        if (!toolCalls.has(targetId)) {
          toolCalls.set(targetId, { id: targetId, name: 'unknown_tool', args: '' })
        }
        const existing = toolCalls.get(targetId)
        if (existing) {
          existing.args += chunk
        }
        continue
      }

      if (event.type === 'tool_use_end') {
        const data = this.toRecord(event.data)
        const endedId: string | null = typeof data.id === 'string' ? data.id : currentToolId
        if (endedId) currentToolId = endedId === currentToolId ? null : currentToolId
        continue
      }

      if (event.type === 'done') {
        const data = this.toRecord(event.data)
        stopReason = this.mapFinishReason(
          typeof data.finishReason === 'string' ? data.finishReason : undefined,
        )
        usage = this.extractUsage(data.usage)
        if (typeof data.model === 'string') {
          model = data.model
        }
        continue
      }

      if (event.type === 'error') {
        const data = this.toRecord(event.data)
        throw new Error(typeof data.message === 'string' ? data.message : 'Unknown streaming error')
      }
    }

    const content: ContentBlock[] = []
    if (textParts.length > 0) {
      content.push({ type: 'text', text: textParts.join('') })
    }

    for (const tc of toolCalls.values()) {
      let input: Record<string, unknown>
      try {
        input = this.safeParseToolInput(tc.args)
      } catch (e) {
        input = { __parse_error: e instanceof Error ? e.message : 'Malformed tool input JSON' }
      }
      // Empty args with tool call means truncation (LLM started tool_use but args were cut off)
      if (Object.keys(input).length === 0 && !tc.args.trim()) {
        input = {
          __parse_error: `Tool arguments empty (likely truncated by max_tokens, stopReason=${stopReason})`,
        }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      })
    }

    if (!usage) {
      usage = { input: 0, output: 0 }
    }

    if (content.some((b) => b.type === 'tool_use')) {
      stopReason = 'tool_use'
    }

    return {
      id: responseId,
      content,
      stopReason,
      usage,
      model,
      reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('') : undefined,
    }
  }

  private async decideTaskClosure(
    userMessage: string,
    messages: Message[],
    response: CompletionResponse,
    hadQueuedMessages: boolean,
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
    if (hadQueuedMessages) return endSkipped('queued_messages')
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
    )
    const classifierRequest: TaskClosureClassifierRequest = {
      system: TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
      prompt,
      maxTokens: 200,
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

  private mapFinishReason(reason?: string): CompletionResponse['stopReason'] {
    if (!reason) return 'end_turn'
    if (reason === 'tool_use' || reason === 'tool_calls') return 'tool_use'
    if (reason === 'max_tokens' || reason === 'length') return 'max_tokens'
    return 'end_turn'
  }

  private safeParseToolInput(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      throw new ToolInputParseError(
        `Failed to parse tool input JSON (${raw.length} chars, likely truncated by max_tokens)`,
      )
    }
  }

  private extractUsage(value: unknown): TokenUsage | undefined {
    if (!value || typeof value !== 'object') return undefined
    const data = value as Record<string, unknown>
    const input = this.toNumber(data.input) ?? this.toNumber(data.input_tokens)
    const output = this.toNumber(data.output) ?? this.toNumber(data.output_tokens)
    if (input === undefined && output === undefined) return undefined
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheWrite: this.toNumber(data.cacheWrite) ?? this.toNumber(data.cache_creation_input_tokens),
      cacheRead: this.toNumber(data.cacheRead) ?? this.toNumber(data.cache_read_input_tokens),
      reasoning: this.toNumber(data.reasoning) ?? this.toNumber(data.reasoning_tokens),
    }
  }

  private toNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  }

  private getStreamErrorDetails(streamErr: unknown): {
    message: string
    status?: number
    requestId?: string
    errorType?: string
  } {
    const data = this.toRecord(streamErr)
    const message = toErrorMessage(streamErr)
    const anthropicPayload = this.parseAnthropicStreamErrorPayload(message)
    return {
      message,
      status: this.toNumber(data.status),
      requestId:
        typeof data.request_id === 'string'
          ? data.request_id
          : typeof data.requestId === 'string'
            ? data.requestId
            : anthropicPayload?.requestId,
      errorType:
        typeof data.error_type === 'string' ? data.error_type : anthropicPayload?.errorType,
    }
  }

  private shouldSkipStreamFallback(_streamErr: unknown): boolean {
    // Anthropic API: always skip non-streaming fallback.
    // The SDK rejects non-streaming requests estimated >10 min, and network idle
    // timeouts make non-streaming unreliable for long responses regardless.
    if (this.adapter.apiType === 'anthropic_messages') {
      return true
    }

    return false
  }

  private parseAnthropicStreamErrorPayload(
    message: string,
  ): { requestId?: string; errorType?: string } | undefined {
    if (!message.startsWith('{')) {
      return undefined
    }

    try {
      const parsed = JSON.parse(message)
      if (!parsed || typeof parsed !== 'object') {
        return undefined
      }

      const data = parsed as Record<string, unknown>
      const nested = this.toRecord(data.error)
      const requestId = typeof data.request_id === 'string' ? data.request_id : undefined
      const errorType = typeof nested.type === 'string' ? nested.type : undefined

      if (!requestId && !errorType && data.type !== 'error') {
        return undefined
      }

      return { requestId, errorType }
    } catch {
      return undefined
    }
  }

  /**
   * Log an LLM request to the observability layer.
   */
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

    this.obs.metrics?.recordRequest({
      id: response.id,
      sessionId: this.toolContext.sessionId,
      model: this.obs.modelLabel ?? response.model,
      provider: this.obs.providerName ?? 'unknown',
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      cacheWriteTokens: response.usage.cacheWrite,
      cacheReadTokens: response.usage.cacheRead,
      cost,
      durationMs,
      createdAt: now(),
    })
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
        },
      ]
    })
  }

  private async buildMemoryHintMessage(
    failedTools: FailedToolAttempt[],
    userMessage: string,
    identitySummary?: string,
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
