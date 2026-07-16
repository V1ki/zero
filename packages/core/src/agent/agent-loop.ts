import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionRequestMeta,
  CompletionResponse,
  ContentBlock,
  Message,
  ReasoningEffort,
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
import { CONTEXT_PARAMS } from './params'

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
}

export interface AgentLoopConfig {
  adapter: ProviderAdapter
  sessionId: string
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
  buildRequestUserContent?(content: ContentBlock[], ctx: LoopIterationContext): ContentBlock[]
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
  if (adapter.apiType === 'anthropic-deepseek' && reasoningContent && reasoningSignature) {
    content.push({
      type: 'thinking',
      thinking: reasoningContent,
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
    const messages: Message[] = [...conversationHistory]
    const newMessages: Message[] = []
    const ctx: LoopIterationContext = {
      messages,
      newMessages,
      iteration: 0,
      userMessage,
      state: {},
    }

    const userMsg = userMessageEntry ?? this.buildUserMessage(userMessage, userImages)
    this.notifyNewMessage(userMsg, ctx)

    const requestUserContent =
      this.hooks.buildRequestUserContent?.(userMsg.content, ctx) ?? userMsg.content
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

      while (response.content.length === 0) {
        this.config.logger.warn('llm_empty_response', {
          sessionId: this.config.sessionId,
          stopReason: response.stopReason,
          retryCount: emptyResponseRetryCount,
        })

        if (response.stopReason !== 'end_turn') {
          throw new Error(`LLM returned empty response (stopReason=${response.stopReason})`)
        }

        const decision =
          this.hooks.onEmptyResponse?.(emptyResponseRetryCount, ctx) ??
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

      if (response.stopReason !== 'tool_use') {
        const endTurnDecision = await this.hooks.onEndTurn?.(response, ctx)
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

      if (this.hooks.shouldInterrupt?.(ctx)) {
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

  private notifyNewMessage(message: Message, ctx: LoopIterationContext): void {
    ctx.newMessages.push(message)
    this.hooks.onNewMessage?.(message, ctx)
  }

  private async complete(
    request: CompletionRequest,
    ctx: LoopIterationContext,
  ): Promise<CompletionResponse> {
    return completeAgentLoopRequest({
      config: this.config,
      hooks: this.hooks,
      request,
      ctx,
    })
  }
}

interface CompleteAgentLoopRequestOptions {
  config: AgentLoopConfig
  hooks: AgentLoopHooks
  request: CompletionRequest
  ctx: LoopIterationContext
}

async function completeAgentLoopRequest({
  config,
  hooks,
  request,
  ctx,
}: CompleteAgentLoopRequestOptions): Promise<CompletionResponse> {
  hooks.onCompletionStart?.(request, ctx)
  const startedAt = Date.now()

  try {
    const response =
      config.stream === false
        ? await config.adapter.complete({ ...request, stream: false })
        : await completeWithStreamFallback({ config, hooks, request, ctx })

    hooks.onCompletionEnd?.(request, response, Date.now() - startedAt, ctx)
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
}: CompleteAgentLoopRequestOptions): Promise<CompletionResponse> {
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

  for (const block of options.response.content) {
    if (block.type !== 'tool_use') continue

    options.hooks.onToolCallStart?.(block.name, block.id, block.input, options.ctx)
    const startedAt = Date.now()

    const malformedInputError =
      typeof block.input.__parse_error === 'string' ? block.input.__parse_error : undefined

    if (malformedInputError) {
      const result = buildToolFailure(
        `Tool input JSON was malformed (likely truncated by max_tokens). ${malformedInputError}. Please retry with shorter content or split into multiple calls.`,
      )
      toolResultBlocks.push(buildToolResultBlock(block.id, result))
      options.hooks.onToolCallEnd?.(
        block.name,
        block.id,
        block.input,
        result,
        Date.now() - startedAt,
        options.ctx,
      )
      continue
    }

    if (!options.config.toolExecutor.has(block.name)) {
      const result = buildToolFailure(`Unknown tool: ${block.name}`)
      toolResultBlocks.push(buildToolResultBlock(block.id, result))
      options.hooks.onToolCallEnd?.(
        block.name,
        block.id,
        block.input,
        result,
        Date.now() - startedAt,
        options.ctx,
      )
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

    toolResultBlocks.push(buildToolResultBlock(block.id, result))
    options.hooks.onToolCallEnd?.(
      block.name,
      block.id,
      block.input,
      result,
      Date.now() - startedAt,
      options.ctx,
    )
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
