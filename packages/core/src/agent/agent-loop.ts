import { createHash } from 'node:crypto'
import type { ProviderAdapter } from '@zero-os/model'
import type { SessionEventStore } from '@zero-os/observe'
import type {
  CompactionTrigger,
  CompletionRequest,
  CompletionRequestMeta,
  CompletionResponse,
  ContentBlock,
  ContextCheckpoint,
  InjectionContextEventData,
  Message,
  ReasoningEffort,
  RequestEntry,
  RequestMessageEventData,
  SecretFilter,
  StepStopReason,
  ToolDefinition,
  ToolLogger,
  ToolResult,
} from '@zero-os/shared'
import {
  generateId,
  generatePrefixedId,
  hasSignedThinkingBlock,
  now,
  toErrorMessage,
} from '@zero-os/shared'
import { filterToolInput } from './agent-trace'
import { CONTEXT_PARAMS } from './params'
import type { QueuedInjectionTrace, QueuedMessage } from './queue'
import { applyUserInjections, hashRequest } from './request-assembly'

const MAX_TRANSIENT_STREAM_RETRIES = 3
const MAX_TRANSPORT_STREAM_RETRIES = 1

export type ToolExecutionResult = ToolResult

export interface ToolExecutor {
  has(toolName: string): boolean
  execute(
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult>
}

export interface FailedToolAttempt {
  toolUseId: string
  toolName: string
  input: unknown
  output: string
  outputSummary?: string
}

export interface LoopIterationContext {
  messages: Message[]
  newMessages: Message[]
  iteration: number
  userMessage: string
  state: Record<string, unknown>
  /**
   * Every change the loop made to the request messages, in the order it was logged: the messages
   * it appended and the request-only injections. The same entries rebuild a request from the log.
   */
  requestEntries: RequestEntry[]
}

/**
 * A function of an assembly, passed by the caller in `AgentLoopConfig.modules`. Writing the log stays
 * in the base: a module hands the base what belongs in the request, and the base logs and applies it.
 * Modules never hold each other. At one extension point, observers are all called, rewrites are
 * chained in array order, and decisions take the first non-default answer in array order.
 */
export interface AgentLoopModule {
  /** Names the module in the trace, e.g. the queue check before its end-of-turn decision. */
  name?: string
  /**
   * Text placed in front of the loop's first user message, in the request only. The base writes
   * each piece as `injection/context` and applies them in array order.
   */
  requestInjections?(message: Message): Array<Pick<InjectionContextEventData, 'kind' | 'content'>>
  /**
   * A reason while new messages belong to the request only and stay out of the canonical history;
   * the base writes them as `request/message`. Decision: the first module with a reason wins.
   */
  requestOnly?(): RequestMessageEventData['reason'] | undefined
  /**
   * Takes the session's queued messages at a point the base chooses (see `QueuePoint`) and hands
   * back the continuation message that carries them. Decision: the first module that takes wins.
   */
  takeQueued?(point: QueuePoint, ctx: LoopIterationContext): QueueTake | undefined
  /**
   * After tool results: takes the queued messages and hands back the blocks to append to the
   * request's last user message. Decision: the first module that takes wins. The base appends them
   * and writes `injection/context` (`queued_merge`).
   */
  mergeQueued?(last: Message, ctx: LoopIterationContext): QueueMerge | undefined
  /**
   * Rewrite, chained in array order: compacts the canonical messages under pressure at the start of
   * a loop (`turn_start`) and after tool results (`in_turn`), and returns the new checkpoint when it
   * made one. The module writes the compaction events; the base records the checkpoint in
   * `requestEntries` and projects the request from it.
   */
  compact?(
    canonical: Message[],
    trigger: CompactionTrigger,
    checkpoint: ContextCheckpoint | undefined,
  ): Promise<ContextCheckpoint | undefined>
  /** Observer: queued messages were taken into the request. Emitted before the request changes. */
  onQueueTaken?(taken: QueueTaken, ctx: LoopIterationContext): void
  /** Observer: a completion returned and the caller's hooks accepted it. */
  onCompletionEnd?(response: CompletionResponse, ctx: LoopIterationContext): void
  /** Observer, awaited in array order: a response ended the turn. */
  evaluateEndTurn?(response: CompletionResponse, ctx: LoopIterationContext): Promise<void>
  /**
   * Observer: after the evaluation, whether queued messages were taken at that point (then the turn
   * continues with them and no decision is asked).
   */
  settleEndTurn?(response: CompletionResponse, ctx: LoopIterationContext, queueTaken: boolean): void
  /**
   * Decision: the first module that continues the turn wins; `undefined` passes. Before the
   * continuation takes effect the base checks the queue once more; `commit` runs only when the
   * module's continuation is the one the turn takes.
   */
  decideEndTurn?(
    response: CompletionResponse,
    ctx: LoopIterationContext,
  ): EndTurnContinuation | undefined
  /** Decision on an empty response: the first answer that is not `undefined` wins. */
  onEmptyResponse?(
    retryCount: number,
    ctx: LoopIterationContext,
  ): boolean | 'break' | { action: 'continue'; continuationMessage: Message } | undefined
  /** Decision: whether to stop after the next answer; any module saying yes wins. */
  shouldInterrupt?(ctx: LoopIterationContext): boolean
}

/**
 * Where the base looks for queued messages: when a response ends the turn, after the modules
 * evaluated it, before each module's decision, and on an empty response in the request-only phase.
 */
export type QueuePoint = 'end_turn' | 'after_evaluation' | 'before_decision' | 'request_only_empty'

export interface EndTurnContinuation {
  action: 'continue'
  continuationMessage: Message
  commit?(): void
}

export interface QueueTake {
  queued: QueuedMessage[]
  continuationMessage: Message
  /** What the request will carry, for the trace. */
  injection?: QueuedInjectionTrace
}

export interface QueueMerge {
  queued: QueuedMessage[]
  /** Blocks appended to the last user message; none when there is nothing to append. */
  blocks: ContentBlock[]
  injection?: QueuedInjectionTrace
}

/** The fact the base emits when queued messages go into the request. */
export interface QueueTaken {
  point: QueuePoint | 'after_tool_results'
  /** At `before_decision`: the name of the module whose continuation gave way. */
  decider?: string
  queued: QueuedMessage[]
  injection?: QueuedInjectionTrace
  /** True for a continuation message; false when appended to the last user message. */
  continuation: boolean
  /** Whether the request-only phase was on when the messages were taken. */
  wasRequestOnly: boolean
}

/**
 * Where the loop writes its session events. With a journal, every request, tool call and message
 * is written at the moment it happens, to the file of `AgentLoopConfig.sessionId`.
 */
export interface AgentLoopJournal {
  events: Pick<SessionEventStore, 'append' | 'appendMessage'>
  /** Recorded as the model of each `step/start`. */
  modelLabel?: string
  /** Applied to tool input before it is hashed and previewed in `tool/call`. */
  secretFilter?: SecretFilter
  /** Trace span of the request that just started. Read after `onCompletionStart`. */
  requestSpanId?(): string | undefined
  /** Trace span of the tool call that just started. Read after `onToolCallStart`. */
  toolSpanId?(toolUseId: string): string | undefined
}

export interface AgentLoopConfig {
  adapter: ProviderAdapter
  sessionId: string
  journal?: AgentLoopJournal
  modules?: AgentLoopModule[]
  toolExecutor: ToolExecutor
  system: string
  tools: ToolDefinition[]
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  maxIterations?: number
  stream?: boolean
  logger: ToolLogger
  transientRetryDelayMs?: (attempt: number) => number
  meta?: CompletionRequestMeta
  getMeta?: (ctx: LoopIterationContext) => CompletionRequestMeta | undefined
}

export interface AgentLoopHooks {
  /** Continue a provider-truncated response without executing partial tool calls. */
  onTruncatedResponse?(response: CompletionResponse, ctx: LoopIterationContext): Message[]

  onNewMessage?(msg: Message, ctx: LoopIterationContext): void
  filterAssistantContent?(content: ContentBlock[], ctx: LoopIterationContext): ContentBlock[]
  onInvalidAssistantResponse?(
    request: CompletionRequest,
    response: CompletionResponse,
    error: unknown,
    ctx: LoopIterationContext,
  ):
    | Promise<
        { action: 'break' } | { action: 'continue'; continuationMessage: Message } | undefined
      >
    | { action: 'break' }
    | { action: 'continue'; continuationMessage: Message }
    | undefined
  onCompletionStart?(request: CompletionRequest, ctx: LoopIterationContext): void
  onCompletionEnd?(
    request: CompletionRequest,
    response: CompletionResponse,
    durationMs: number,
    ctx: LoopIterationContext,
  ): void
  onCompletionError?(
    request: CompletionRequest,
    error: unknown,
    durationMs: number,
    ctx: LoopIterationContext,
  ): void
  onTextDelta?(
    delta: string,
    meta: { role: 'assistant'; turnId: string },
    ctx: LoopIterationContext,
  ): void
  onEndTurn?(
    response: CompletionResponse,
    ctx: LoopIterationContext,
  ):
    | Promise<{ action: 'break' } | { action: 'continue'; continuationMessage: Message }>
    | { action: 'break' }
    | { action: 'continue'; continuationMessage: Message }
  onToolCallStart?(
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: LoopIterationContext,
  ): void
  onToolCallEnd?(
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    result: ToolExecutionResult,
    durationMs: number,
    ctx: LoopIterationContext,
  ): void
  processToolResults?(
    toolResults: ContentBlock[],
    failedAttempts: FailedToolAttempt[],
    ctx: LoopIterationContext,
  ): Promise<{ toolResultBlocks: ContentBlock[]; additionalMessages?: Message[] }>
  afterToolResults?(ctx: LoopIterationContext): Promise<void>
  shouldInterrupt?(ctx: LoopIterationContext): boolean
  shouldAbort?(ctx: LoopIterationContext): boolean
  onEmptyResponse?(
    retryCount: number,
    ctx: LoopIterationContext,
  ): boolean | 'break' | { action: 'continue'; continuationMessage: Message }
}

interface StreamErrorDetails {
  message: string
  status?: number
  requestId?: string
  errorType?: string
  retryable?: boolean
  failureScope?: string
  code?: string
  outerRetryable?: boolean
}

interface StreamAttemptProgress {
  visibleOutputEmitted: boolean
}

interface CompleteFromStreamOptions {
  adapter: ProviderAdapter
  request: CompletionRequest
  ctx: LoopIterationContext
  progress: StreamAttemptProgress
  onTextDelta?: (
    delta: string,
    meta: { role: 'assistant'; turnId: string },
    ctx: LoopIterationContext,
  ) => void
}

async function completeFromStream({
  adapter,
  request,
  ctx,
  progress,
  onTextDelta,
}: CompleteFromStreamOptions): Promise<CompletionResponse> {
  const stream = adapter.stream({ ...request, stream: true })
  const turnId = generatePrefixedId('turn')
  const responseId = generatePrefixedId('resp')

  const textParts: string[] = []
  const reasoningParts: string[] = []
  const reasoningSignatureParts: string[] = []
  const toolCalls = new Map<string, { id: string; name: string; args: string }>()

  let currentToolId: string | null = null
  let stopReason: CompletionResponse['stopReason'] = 'end_turn'
  let usage = { input: 0, output: 0 }
  let model = request.model ?? 'unknown'

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      const data = toRecord(event.data)
      const delta = typeof data.text === 'string' ? data.text : ''
      if (!delta) continue
      textParts.push(delta)
      progress.visibleOutputEmitted = true
      onTextDelta?.(delta, { role: 'assistant', turnId }, ctx)
      continue
    }

    if (event.type === 'reasoning_delta') {
      const data = toRecord(event.data)
      const delta = typeof data.text === 'string' ? data.text : ''
      if (!delta) continue
      reasoningParts.push(delta)
      continue
    }

    if (event.type === 'reasoning_signature') {
      const data = toRecord(event.data)
      const signature = typeof data.signature === 'string' ? data.signature : ''
      if (!signature) continue
      reasoningSignatureParts.push(signature)
      continue
    }

    if (event.type === 'tool_use_start') {
      const data = toRecord(event.data)
      const id = typeof data.id === 'string' ? data.id : generatePrefixedId('toolu')
      const name = typeof data.name === 'string' ? data.name : 'unknown_tool'
      currentToolId = id
      toolCalls.set(id, { id, name, args: '' })
      continue
    }

    if (event.type === 'tool_use_delta') {
      const data = toRecord(event.data)
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
      const data = toRecord(event.data)
      const endedId: string | null = typeof data.id === 'string' ? data.id : currentToolId
      if (endedId) {
        currentToolId = endedId === currentToolId ? null : currentToolId
      }
      continue
    }

    if (event.type === 'done') {
      const data = toRecord(event.data)
      stopReason = mapFinishReason(
        typeof data.finishReason === 'string' ? data.finishReason : undefined,
      )
      usage = extractUsage(data.usage) ?? usage
      if (typeof data.model === 'string') {
        model = data.model
      }
      continue
    }

    if (event.type === 'error') {
      const data = toRecord(event.data)
      throw new Error(typeof data.message === 'string' ? data.message : 'Unknown streaming error')
    }
  }

  const content: ContentBlock[] = []
  const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join('') : undefined
  const reasoningSignature =
    reasoningSignatureParts.length > 0 ? reasoningSignatureParts.join('') : undefined
  // DeepSeek may stream a signature without any thinking text when it skips visible
  // reasoning before a tool call; persist the block anyway since the signature is
  // required (and sufficient) for the history to be replayable.
  if (adapter.apiType === 'anthropic-deepseek' && reasoningSignature) {
    content.push({
      type: 'thinking',
      thinking: reasoningContent ?? '',
      signature: reasoningSignature,
    })
  }

  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') })
  }

  for (const toolCall of toolCalls.values()) {
    let input: Record<string, unknown>
    try {
      input = safeParseToolInput(toolCall.args)
    } catch (error) {
      input = {
        __parse_error: error instanceof Error ? error.message : 'Malformed tool input JSON',
      }
    }

    if (Object.keys(input).length === 0 && !toolCall.args.trim()) {
      input = {
        __parse_error: `Tool arguments empty (likely truncated by max_tokens, stopReason=${stopReason})`,
      }
    }

    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input,
    })
  }

  if (content.some((block) => block.type === 'tool_use')) {
    stopReason = 'tool_use'
  }

  return {
    id: responseId,
    content,
    stopReason,
    usage,
    model,
    reasoningContent,
  }
}

function getStreamErrorDetails(streamErr: unknown): StreamErrorDetails {
  const data = toRecord(streamErr)
  const message = toErrorMessage(streamErr)
  const anthropicPayload = parseAnthropicStreamErrorPayload(message)

  return {
    message,
    status: toNumber(data.status),
    requestId:
      typeof data.request_id === 'string'
        ? data.request_id
        : typeof data.requestId === 'string'
          ? data.requestId
          : anthropicPayload?.requestId,
    errorType: typeof data.error_type === 'string' ? data.error_type : anthropicPayload?.errorType,
    retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
    failureScope: typeof data.failure_scope === 'string' ? data.failure_scope : undefined,
    code: typeof data.code === 'string' ? data.code : undefined,
    outerRetryable: typeof data.outer_retryable === 'boolean' ? data.outer_retryable : undefined,
  }
}

function isTransientStreamError(errorDetails: StreamErrorDetails, replaySafe: boolean): boolean {
  if (!replaySafe || errorDetails.outerRetryable === false) return false
  const transientTypes = ['overloaded_error', 'api_error']
  const transientStatuses = [429, 503, 529]
  if (errorDetails.retryable === true) return true
  if (errorDetails.errorType && transientTypes.includes(errorDetails.errorType)) return true
  if (errorDetails.status && transientStatuses.includes(errorDetails.status)) return true
  return false
}

function resolveMaxTransientRetries(errorDetails: StreamErrorDetails): number {
  return errorDetails.failureScope === 'transport'
    ? MAX_TRANSPORT_STREAM_RETRIES
    : MAX_TRANSIENT_STREAM_RETRIES
}

function shouldSkipStreamFallback(adapter: ProviderAdapter): boolean {
  return (
    adapter.supportsNonStreamingFallback === false ||
    adapter.apiType === 'anthropic_messages' ||
    adapter.apiType === 'anthropic-deepseek'
  )
}

function mapFinishReason(reason?: string): CompletionResponse['stopReason'] {
  if (!reason) return 'end_turn'
  if (reason === 'tool_use' || reason === 'tool_calls') return 'tool_use'
  if (reason === 'max_tokens' || reason === 'length') return 'max_tokens'
  return 'end_turn'
}

function safeParseToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error(
      `Failed to parse tool input JSON (${raw.length} chars, likely truncated by max_tokens)`,
    )
  }
}

function extractUsage(value: unknown): CompletionResponse['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  const input = toNumber(data.input) ?? toNumber(data.input_tokens)
  const output = toNumber(data.output) ?? toNumber(data.output_tokens)
  if (input === undefined && output === undefined) return undefined

  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheWrite: toNumber(data.cacheWrite) ?? toNumber(data.cache_creation_input_tokens),
    cacheRead: toNumber(data.cacheRead) ?? toNumber(data.cache_read_input_tokens),
    reasoning: toNumber(data.reasoning) ?? toNumber(data.reasoning_tokens),
  }
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function parseAnthropicStreamErrorPayload(
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
    const nested = toRecord(data.error)
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

export class AgentLoop {
  private config: AgentLoopConfig
  private hooks: AgentLoopHooks
  private stepIndex = 0

  constructor(config: AgentLoopConfig, hooks: AgentLoopHooks = {}) {
    this.config = config
    this.hooks = hooks
  }

  async run(
    userMessage: string,
    conversationHistory: Message[],
    userImages?: Array<{ mediaType: string; data: string }>,
    userMessageEntry?: Message,
  ): Promise<Message[]> {
    this.stepIndex = 0
    const messages: Message[] = [...conversationHistory]
    const newMessages: Message[] = []
    const ctx: LoopIterationContext = {
      messages,
      newMessages,
      iteration: 0,
      userMessage,
      state: {},
      requestEntries: [],
    }

    const userMsg = userMessageEntry ?? this.buildUserMessage(userMessage, userImages)
    this.notifyNewMessage(userMsg, ctx)

    const requestUserContent = this.injectIntoFirstUserMessage(userMsg, ctx)
    messages.push(
      requestUserContent === userMsg.content
        ? userMsg
        : { ...userMsg, content: requestUserContent },
    )

    let emptyResponseRetryCount = 0

    iterationLoop: while (this.hasRemainingIterations(ctx.iteration)) {
      ctx.iteration += 1
      const request = this.buildRequest(messages, ctx)
      let response = await this.complete(request, ctx)

      if (response.stopReason === 'max_tokens' && this.hooks.onTruncatedResponse) {
        if (this.hooks.shouldAbort?.(ctx)) break
        for (const message of this.hooks.onTruncatedResponse(response, ctx)) {
          messages.push(message)
          this.notifyNewMessage(message, ctx)
        }
        continue
      }

      while (response.content.length === 0) {
        if (this.hooks.shouldAbort?.(ctx)) {
          break iterationLoop
        }
        this.config.logger.warn('llm_empty_response', {
          sessionId: this.config.sessionId,
          stopReason: response.stopReason,
          retryCount: emptyResponseRetryCount,
        })

        if (response.stopReason !== 'end_turn') {
          throw new Error(`LLM returned empty response (stopReason=${response.stopReason})`)
        }

        const decision =
          this.emptyResponseDecision(emptyResponseRetryCount, ctx) ??
          (emptyResponseRetryCount < CONTEXT_PARAMS.completion.maxEmptyResponseRetries
            ? true
            : 'break')

        if (decision === 'break') {
          break iterationLoop
        }

        if (typeof decision === 'object' && decision.action === 'continue') {
          messages.push(decision.continuationMessage)
          this.notifyNewMessage(decision.continuationMessage, ctx)
          continue iterationLoop
        }

        if (decision === true) {
          emptyResponseRetryCount++
          // Replay the same request inside this iteration without synthesizing conversation history.
          response = await this.complete(request, ctx)
          continue
        }

        throw new Error(`LLM returned empty response (stopReason=${response.stopReason})`)
      }

      emptyResponseRetryCount = 0
      if (this.hooks.shouldAbort?.(ctx)) {
        break
      }

      let assistantMsg: Message
      try {
        assistantMsg = this.buildAssistantMessage(response, ctx)
      } catch (error) {
        const decision = await this.hooks.onInvalidAssistantResponse?.(
          request,
          response,
          error,
          ctx,
        )
        if (decision?.action === 'break') {
          break
        }
        if (decision?.action === 'continue') {
          messages.push(decision.continuationMessage)
          this.notifyNewMessage(decision.continuationMessage, ctx)
          continue
        }
        throw error
      }
      messages.push(assistantMsg)
      this.notifyNewMessage(assistantMsg, ctx)

      if (this.hooks.shouldAbort?.(ctx)) {
        break
      }

      if (response.stopReason !== 'tool_use') {
        const endTurnDecision = await endTurn(this.modules, this.hooks, response, ctx)
        if (!endTurnDecision || endTurnDecision.action === 'break') {
          break
        }

        messages.push(endTurnDecision.continuationMessage)
        this.notifyNewMessage(endTurnDecision.continuationMessage, ctx)
        continue
      }

      const { toolResultBlocks, failedToolAttempts } = await executeAgentLoopToolCalls({
        response,
        config: this.config,
        hooks: this.hooks,
        ctx,
      })
      const processed = this.hooks.processToolResults
        ? await this.hooks.processToolResults(toolResultBlocks, failedToolAttempts, ctx)
        : { toolResultBlocks }

      if (processed.toolResultBlocks.length > 0) {
        const toolResultMsg = this.buildToolResultMessage(processed.toolResultBlocks)
        messages.push(toolResultMsg)
        this.notifyNewMessage(toolResultMsg, ctx)
      }

      for (const additionalMessage of processed.additionalMessages ?? []) {
        messages.push(additionalMessage)
        this.notifyNewMessage(additionalMessage, ctx)
      }

      await this.hooks.afterToolResults?.(ctx)
      this.mergeQueuedIntoRequest(ctx)

      if (this.hooks.shouldAbort?.(ctx)) {
        break
      }

      if (
        this.modules.some((module) => module.shouldInterrupt?.(ctx)) ||
        this.hooks.shouldInterrupt?.(ctx)
      ) {
        const finalRequest = this.buildRequest(messages, ctx)
        const finalResponse = await this.complete(finalRequest, ctx)
        const finalMsg = this.buildAssistantMessage(finalResponse, ctx)
        messages.push(finalMsg)
        this.notifyNewMessage(finalMsg, ctx)
        break
      }
    }

    return newMessages
  }

  private hasRemainingIterations(iterationCount: number): boolean {
    return this.config.maxIterations === undefined || iterationCount < this.config.maxIterations
  }

  private buildRequest(messages: Message[], ctx: LoopIterationContext): CompletionRequest {
    return {
      messages,
      tools: this.config.tools,
      system: this.config.system,
      stream: this.config.stream ?? true,
      maxTokens: this.config.maxOutputTokens ?? 16384,
      reasoningEffort: this.config.reasoningEffort,
      meta: this.config.getMeta?.(ctx) ?? this.config.meta,
    }
  }

  private buildUserMessage(
    userMessage: string,
    userImages?: Array<{ mediaType: string; data: string }>,
  ): Message {
    const content: ContentBlock[] = []
    if (userMessage.trim().length > 0) {
      content.push({ type: 'text', text: userMessage })
    }
    if (userImages?.length) {
      for (const image of userImages) {
        content.push({
          type: 'image',
          mediaType: image.mediaType,
          data: image.data,
        })
      }
    }

    return {
      id: generateId(),
      sessionId: this.config.sessionId,
      role: 'user',
      messageType: 'message',
      content,
      createdAt: now(),
    }
  }

  private buildAssistantMessage(response: CompletionResponse, ctx: LoopIterationContext): Message {
    const content = this.hooks.filterAssistantContent?.(response.content, ctx) ?? response.content
    this.assertValidDeepSeekThinkingContent(content)

    return {
      id: generateId(),
      sessionId: this.config.sessionId,
      role: 'assistant',
      messageType: 'message',
      content,
      model: response.model,
      createdAt: now(),
    }
  }

  private assertValidDeepSeekThinkingContent(content: ContentBlock[]): void {
    if (this.config.adapter.apiType !== 'anthropic-deepseek') return
    if (!content.some((block) => block.type === 'tool_use')) return
    if (hasSignedThinkingBlock(content)) {
      return
    }

    throw new Error(
      'Anthropic DeepSeek tool_use response missing signed thinking content; refusing to persist invalid history',
    )
  }

  private buildToolResultMessage(content: ContentBlock[]): Message {
    return {
      id: generateId(),
      sessionId: this.config.sessionId,
      role: 'user',
      messageType: 'message',
      content,
      createdAt: now(),
    }
  }

  private get modules(): AgentLoopModule[] {
    return this.config.modules ?? []
  }

  private requestOnly(): RequestMessageEventData['reason'] | undefined {
    return requestOnlyReason(this.modules)
  }

  /** After tool results: queued messages appended to the request's last user message, logged. */
  private mergeQueuedIntoRequest(ctx: LoopIterationContext): void {
    const lastIndex = ctx.messages.length - 1
    const last = ctx.messages[lastIndex]
    if (!last) return
    const wasRequestOnly = this.requestOnly() !== undefined
    for (const module of this.modules) {
      const merge = module.mergeQueued?.(last, ctx)
      if (!merge) continue
      if (merge.blocks.length > 0)
        ctx.messages[lastIndex] = { ...last, content: [...last.content, ...merge.blocks] }
      const taken: QueueTaken = {
        point: 'after_tool_results',
        queued: merge.queued,
        injection: merge.injection,
        continuation: false,
        wasRequestOnly,
      }
      for (const observer of this.modules) observer.onQueueTaken?.(taken, ctx)
      if (merge.injection) {
        const injection = {
          kind: 'queued_merge' as const,
          content: merge.injection.formattedText,
          refs: { count: merge.injection.count },
          messageId: last.id,
          blocks: merge.blocks,
        }
        this.config.journal?.events.append(this.config.sessionId, [
          { type: 'injection/context', data: injection },
        ])
        ctx.requestEntries.push({ kind: 'injection', injection })
      }
      return
    }
  }

  private emptyResponseDecision(
    retryCount: number,
    ctx: LoopIterationContext,
  ): ReturnType<NonNullable<AgentLoopHooks['onEmptyResponse']>> | undefined {
    if (requestOnlyReason(this.modules)) {
      const queued = takeQueued(this.modules, 'request_only_empty', ctx)
      if (queued) return { action: 'continue', continuationMessage: queued }
    }
    for (const module of this.modules) {
      const decision = module.onEmptyResponse?.(retryCount, ctx)
      if (decision !== undefined) return decision
    }
    return this.hooks.onEmptyResponse?.(retryCount, ctx)
  }

  /** The first user message as the request carries it: the modules' injections in front, logged. */
  private injectIntoFirstUserMessage(message: Message, ctx: LoopIterationContext): ContentBlock[] {
    const injections = (this.config.modules ?? []).flatMap((module) =>
      (module.requestInjections?.(message) ?? []).map((injection) => ({
        ...injection,
        messageId: message.id,
      })),
    )
    if (injections.length === 0) return message.content
    this.config.journal?.events.append(
      this.config.sessionId,
      injections.map((data) => ({ type: 'injection/context', data })),
    )
    for (const injection of injections) ctx.requestEntries.push({ kind: 'injection', injection })
    return applyUserInjections(message.content, injections)
  }

  private notifyNewMessage(message: Message, ctx: LoopIterationContext): void {
    ctx.newMessages.push(message)
    ctx.requestEntries.push({ kind: 'message', message })
    const { journal, sessionId } = this.config
    if (journal) {
      const reason = this.requestOnly()
      if (reason)
        journal.events.append(sessionId, [{ type: 'request/message', data: { message, reason } }])
      else journal.events.appendMessage(sessionId, message)
    }
    this.hooks.onNewMessage?.(message, ctx)
  }

  private async complete(
    request: CompletionRequest,
    ctx: LoopIterationContext,
  ): Promise<CompletionResponse> {
    this.stepIndex += 1
    return completeAgentLoopRequest({
      config: this.config,
      hooks: this.hooks,
      request,
      ctx,
      stepIndex: this.stepIndex,
    })
  }
}

interface CompleteAgentLoopRequestOptions {
  config: AgentLoopConfig
  hooks: AgentLoopHooks
  request: CompletionRequest
  ctx: LoopIterationContext
  stepIndex: number
}

async function completeAgentLoopRequest({
  config,
  hooks,
  request,
  ctx,
  stepIndex,
}: CompleteAgentLoopRequestOptions): Promise<CompletionResponse> {
  const { journal, sessionId } = config
  hooks.onCompletionStart?.(request, ctx)
  journal?.events.append(sessionId, [
    {
      type: 'step/start',
      data: {
        stepIndex,
        requestSpanId: journal.requestSpanId?.(),
        model: journal.modelLabel,
        messageCount: request.messages.length,
        requestHash: hashRequest({
          system: request.system ?? '',
          toolNames: (request.tools ?? []).map((tool) => tool.name),
          messages: request.messages,
        }),
      },
    },
  ])
  const startedAt = Date.now()

  try {
    const response =
      config.stream === false
        ? await config.adapter.complete({ ...request, stream: false })
        : await completeWithStreamFallback({ config, hooks, request, ctx })

    const durationMs = Date.now() - startedAt
    journal?.events.append(sessionId, [
      {
        type: 'step/end',
        data: {
          stepIndex,
          stopReason: mapStopReason(response.stopReason),
          requestId: response.id,
          usage: response.usage,
          durationMs,
        },
      },
    ])
    hooks.onCompletionEnd?.(request, response, durationMs, ctx)
    for (const module of config.modules ?? []) module.onCompletionEnd?.(response, ctx)
    return response
  } catch (error) {
    hooks.onCompletionError?.(request, error, Date.now() - startedAt, ctx)
    throw error
  }
}

async function completeWithStreamFallback({
  config,
  hooks,
  request,
  ctx,
}: Omit<CompleteAgentLoopRequestOptions, 'stepIndex'>): Promise<CompletionResponse> {
  let transientAttempts = 0

  while (true) {
    const progress: StreamAttemptProgress = { visibleOutputEmitted: false }
    try {
      const streamed = await completeFromStream({
        adapter: config.adapter,
        request,
        ctx,
        progress,
        onTextDelta: hooks.onTextDelta,
      })
      if (streamed.content.length > 0 || shouldSkipStreamFallback(config.adapter)) {
        return streamed
      }

      config.logger.warn('llm_stream_empty_fallback_to_complete', {
        sessionId: config.sessionId,
        apiType: config.adapter.apiType,
      })
      return await config.adapter.complete({ ...request, stream: false })
    } catch (streamErr) {
      const errorDetails = getStreamErrorDetails(streamErr)
      const replaySafe = !progress.visibleOutputEmitted
      const maxTransientRetries = resolveMaxTransientRetries(errorDetails)

      if (
        transientAttempts < maxTransientRetries &&
        isTransientStreamError(errorDetails, replaySafe)
      ) {
        transientAttempts++
        const delay = resolveTransientRetryDelay(config, transientAttempts)
        config.logger.warn('llm_stream_transient_retry', {
          sessionId: config.sessionId,
          apiType: config.adapter.apiType,
          error: errorDetails.message,
          errorType: errorDetails.errorType,
          failureScope: errorDetails.failureScope,
          code: errorDetails.code,
          status: errorDetails.status,
          requestId: errorDetails.requestId,
          replaySafe,
          outerRetryable: errorDetails.outerRetryable,
          attempt: transientAttempts,
          maxRetries: maxTransientRetries,
          delayMs: delay,
        })
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      const fallbackSkipped = !replaySafe || shouldSkipStreamFallback(config.adapter)
      config.logger.warn('llm_stream_fallback_to_complete', {
        sessionId: config.sessionId,
        apiType: config.adapter.apiType,
        error: errorDetails.message,
        errorType: errorDetails.errorType,
        retryable: errorDetails.retryable,
        failureScope: errorDetails.failureScope,
        code: errorDetails.code,
        status: errorDetails.status,
        requestId: errorDetails.requestId,
        replaySafe,
        outerRetryable: errorDetails.outerRetryable,
        attempts: transientAttempts,
        maxRetries: maxTransientRetries,
        fallbackSkipped,
      })
      if (fallbackSkipped) {
        throw streamErr
      }

      return await config.adapter.complete({ ...request, stream: false })
    }
  }
}

function resolveTransientRetryDelay(config: AgentLoopConfig, attempt: number): number {
  return config.transientRetryDelayMs?.(attempt) ?? Math.min(5_000 * 2 ** (attempt - 1), 60_000)
}

/**
 * Writes `tool/call` for a tool call that starts now. The loop writes it for every tool_use; a caller
 * that runs one tool outside a loop (the Router's Codex job) writes it with the same function.
 */
export function journalToolCall(
  journal: AgentLoopJournal,
  sessionId: string,
  call: { id: string; name: string; input: Record<string, unknown> },
): void {
  const input = JSON.stringify(filterToolInput(call.input, journal.secretFilter))
  journal.events.append(sessionId, [
    {
      type: 'tool/call',
      data: {
        toolUseId: call.id,
        name: call.name,
        inputHash: `sha256:${createHash('sha256').update(input).digest('hex')}`,
        inputPreview: input.length > 512 ? `${input.slice(0, 512)}…` : input,
        spanId: journal.toolSpanId?.(call.id),
      },
    },
  ])
}

/** Writes `tool/result` for a tool call that `journalToolCall` recorded. */
export function journalToolResult(
  journal: AgentLoopJournal,
  sessionId: string,
  call: { id: string; name: string },
  result: ToolExecutionResult,
  durationMs: number,
): void {
  journal.events.append(sessionId, [
    {
      type: 'tool/result',
      data: {
        toolUseId: call.id,
        name: call.name,
        status: result.success ? 'success' : 'error',
        durationMs,
        chars: result.output.length,
        summary: result.outputSummary,
      },
    },
  ])
}

interface AgentLoopToolExecutionResult {
  toolResultBlocks: ContentBlock[]
  failedToolAttempts: FailedToolAttempt[]
}

async function executeAgentLoopToolCalls(options: {
  response: CompletionResponse
  config: AgentLoopConfig
  hooks: AgentLoopHooks
  ctx: LoopIterationContext
}): Promise<AgentLoopToolExecutionResult> {
  const toolResultBlocks: ContentBlock[] = []
  const failedToolAttempts: FailedToolAttempt[] = []

  const { journal, sessionId } = options.config

  for (const block of options.response.content) {
    if (block.type !== 'tool_use') continue

    options.hooks.onToolCallStart?.(block.name, block.id, block.input, options.ctx)
    if (journal) journalToolCall(journal, sessionId, block)
    const startedAt = Date.now()
    const end = (result: ToolExecutionResult) => {
      toolResultBlocks.push(buildToolResultBlock(block.id, result))
      const durationMs = Date.now() - startedAt
      options.hooks.onToolCallEnd?.(
        block.name,
        block.id,
        block.input,
        result,
        durationMs,
        options.ctx,
      )
      if (journal) journalToolResult(journal, sessionId, block, result, durationMs)
    }

    const malformedInputError =
      typeof block.input.__parse_error === 'string' ? block.input.__parse_error : undefined

    if (malformedInputError) {
      end(
        buildToolFailure(
          `Tool input JSON was malformed (likely truncated by max_tokens). ${malformedInputError}. Please retry with shorter content or split into multiple calls.`,
        ),
      )
      continue
    }

    if (!options.config.toolExecutor.has(block.name)) {
      end(buildToolFailure(`Unknown tool: ${block.name}`))
      continue
    }

    let result: ToolExecutionResult
    try {
      result = await options.config.toolExecutor.execute(block.name, block.id, block.input)
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      result = {
        success: false,
        output: errorMessage,
        outputSummary: `Tool execution failed: ${errorMessage.slice(0, 100)}`,
      }
    }

    if (!result.success) {
      failedToolAttempts.push({
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
        output: result.output,
        outputSummary: result.outputSummary,
      })
    }

    end(result)
  }

  return { toolResultBlocks, failedToolAttempts }
}

function buildToolResultBlock(toolUseId: string, result: ToolExecutionResult): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId,
    content: result.output,
    ...(result.contentItems && result.contentItems.length > 0
      ? { contentItems: result.contentItems }
      : {}),
    isError: !result.success,
    outputSummary: result.outputSummary,
  }
}

function buildToolFailure(message: string): ToolExecutionResult {
  return {
    success: false,
    output: message,
    outputSummary: message,
  }
}

function mapStopReason(stopReason: string | undefined): StepStopReason {
  if (stopReason === 'tool_use') return 'tool_use'
  if (stopReason === 'aborted' || stopReason === 'interrupted') return 'aborted'
  if (stopReason === 'error' || stopReason === 'max_tokens') return 'error'
  return 'end_turn'
}

function requestOnlyReason(
  modules: AgentLoopModule[],
): RequestMessageEventData['reason'] | undefined {
  for (const module of modules) {
    const reason = module.requestOnly?.()
    if (reason) return reason
  }
  return undefined
}

/** Asks the modules for queued messages; when one takes them, emits the fact before returning. */
function takeQueued(
  modules: AgentLoopModule[],
  point: QueuePoint,
  ctx: LoopIterationContext,
  decider?: string,
): Message | undefined {
  const wasRequestOnly = requestOnlyReason(modules) !== undefined
  for (const module of modules) {
    const take = module.takeQueued?.(point, ctx)
    if (!take) continue
    const taken: QueueTaken = {
      point,
      decider,
      queued: take.queued,
      injection: take.injection,
      continuation: true,
      wasRequestOnly,
    }
    for (const observer of modules) observer.onQueueTaken?.(taken, ctx)
    return take.continuationMessage
  }
  return undefined
}

/**
 * A response ended the turn. Queued messages are checked first; then every module evaluates (in
 * array order, awaited), queued messages are checked again, and every module settles knowing
 * whether they were taken. Otherwise the first module that continues decides: its continuation
 * takes effect unless queued messages arrived meanwhile (checked again, except for a module that
 * takes queued messages itself). The caller's `onEndTurn` hook is asked last.
 */
export async function endTurn(
  modules: AgentLoopModule[],
  hooks: Pick<AgentLoopHooks, 'onEndTurn'>,
  response: CompletionResponse,
  ctx: LoopIterationContext,
): Promise<{ action: 'break' } | { action: 'continue'; continuationMessage: Message } | undefined> {
  const continueWith = (continuationMessage: Message) => ({
    action: 'continue' as const,
    continuationMessage,
  })
  const first = takeQueued(modules, 'end_turn', ctx)
  if (first) return continueWith(first)
  for (const module of modules) await module.evaluateEndTurn?.(response, ctx)
  const afterEvaluation = takeQueued(modules, 'after_evaluation', ctx)
  for (const module of modules) module.settleEndTurn?.(response, ctx, afterEvaluation !== undefined)
  if (afterEvaluation) return continueWith(afterEvaluation)
  for (const module of modules) {
    const decision = module.decideEndTurn?.(response, ctx)
    if (!decision) continue
    const queued = module.takeQueued
      ? undefined
      : takeQueued(modules, 'before_decision', ctx, module.name)
    if (queued) return continueWith(queued)
    decision.commit?.()
    return continueWith(decision.continuationMessage)
  }
  return hooks.onEndTurn?.(response, ctx)
}
