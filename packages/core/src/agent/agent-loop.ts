import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  ToolDefinition,
  ToolLogger,
  ToolResult,
} from '@zero-os/shared'
import { generateId, generatePrefixedId, now, toErrorMessage } from '@zero-os/shared'
import { EMPTY_RESPONSE_RETRY_PROMPT } from '../constants'
import { CONTEXT_PARAMS } from './params'

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
  maxIterations?: number
  stream?: boolean
  logger: ToolLogger
  transientRetryDelayMs?: (attempt: number) => number
}

export interface AgentLoopHooks {
  buildRequestUserContent?(content: ContentBlock[], ctx: LoopIterationContext): ContentBlock[]
  onNewMessage?(msg: Message, ctx: LoopIterationContext): void
  filterAssistantContent?(content: ContentBlock[], ctx: LoopIterationContext): ContentBlock[]
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
  onEmptyResponse?(retryCount: number, ctx: LoopIterationContext): boolean
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

    const userMsg = this.buildUserMessage(userMessage, userImages)
    this.notifyNewMessage(userMsg, ctx)

    const requestUserContent =
      this.hooks.buildRequestUserContent?.(userMsg.content, ctx) ?? userMsg.content
    messages.push(
      requestUserContent === userMsg.content
        ? userMsg
        : { ...userMsg, content: requestUserContent },
    )

    let emptyResponseRetryCount = 0

    while (this.hasRemainingIterations(ctx.iteration)) {
      ctx.iteration += 1
      const request = this.buildRequest(messages)
      const response = await this.complete(request, ctx)

      if (response.content.length === 0) {
        this.config.logger.warn('llm_empty_response', {
          sessionId: this.config.sessionId,
          stopReason: response.stopReason,
          retryCount: emptyResponseRetryCount,
        })

        const shouldRetry =
          this.hooks.onEmptyResponse?.(emptyResponseRetryCount, ctx) ??
          emptyResponseRetryCount < CONTEXT_PARAMS.completion.maxEmptyResponseRetries

        if (shouldRetry) {
          const retryMsg = this.buildPlainUserMessage(EMPTY_RESPONSE_RETRY_PROMPT)
          messages.push(retryMsg)
          this.notifyNewMessage(retryMsg, ctx)
          emptyResponseRetryCount++
          continue
        }

        throw new Error(`LLM returned empty response (stopReason=${response.stopReason})`)
      }

      emptyResponseRetryCount = 0

      const assistantMsg = this.buildAssistantMessage(response, ctx)
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

      const { toolResultBlocks, failedToolAttempts } = await this.executeToolCalls(response, ctx)
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
        const finalRequest = this.buildRequest(messages)
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

  private buildRequest(messages: Message[]): CompletionRequest {
    return {
      messages,
      tools: this.config.tools,
      system: this.config.system,
      stream: this.config.stream ?? true,
      maxTokens: this.config.maxOutputTokens ?? 16384,
    }
  }

  private buildUserMessage(
    userMessage: string,
    userImages?: Array<{ mediaType: string; data: string }>,
  ): Message {
    const content: ContentBlock[] = [{ type: 'text', text: userMessage }]
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

  private buildPlainUserMessage(text: string): Message {
    return {
      id: generateId(),
      sessionId: this.config.sessionId,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text }],
      createdAt: now(),
    }
  }

  private buildAssistantMessage(response: CompletionResponse, ctx: LoopIterationContext): Message {
    const content = this.hooks.filterAssistantContent?.(response.content, ctx) ?? response.content

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
    this.hooks.onCompletionStart?.(request, ctx)
    const startedAt = Date.now()

    try {
      const response =
        this.config.stream === false
          ? await this.config.adapter.complete({ ...request, stream: false })
          : await this.completeWithStreamFallback(request, ctx)

      this.hooks.onCompletionEnd?.(request, response, Date.now() - startedAt, ctx)
      return response
    } catch (error) {
      this.hooks.onCompletionError?.(request, error, Date.now() - startedAt, ctx)
      throw error
    }
  }

  private async executeToolCalls(
    response: CompletionResponse,
    ctx: LoopIterationContext,
  ): Promise<{ toolResultBlocks: ContentBlock[]; failedToolAttempts: FailedToolAttempt[] }> {
    const toolResultBlocks: ContentBlock[] = []
    const failedToolAttempts: FailedToolAttempt[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      this.hooks.onToolCallStart?.(block.name, block.id, block.input, ctx)
      const startedAt = Date.now()

      const malformedInputError =
        typeof block.input.__parse_error === 'string' ? block.input.__parse_error : undefined

      if (malformedInputError) {
        const result = this.buildToolFailure(
          `Tool input JSON was malformed (likely truncated by max_tokens). ${malformedInputError}. Please retry with shorter content or split into multiple calls.`,
        )
        toolResultBlocks.push(this.buildToolResultBlock(block.id, result))
        this.hooks.onToolCallEnd?.(
          block.name,
          block.id,
          block.input,
          result,
          Date.now() - startedAt,
          ctx,
        )
        continue
      }

      if (!this.config.toolExecutor.has(block.name)) {
        const result = this.buildToolFailure(`Unknown tool: ${block.name}`)
        toolResultBlocks.push(this.buildToolResultBlock(block.id, result))
        this.hooks.onToolCallEnd?.(
          block.name,
          block.id,
          block.input,
          result,
          Date.now() - startedAt,
          ctx,
        )
        continue
      }

      let result: ToolExecutionResult
      try {
        result = await this.config.toolExecutor.execute(block.name, block.id, block.input)
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

      toolResultBlocks.push(this.buildToolResultBlock(block.id, result))
      this.hooks.onToolCallEnd?.(
        block.name,
        block.id,
        block.input,
        result,
        Date.now() - startedAt,
        ctx,
      )
    }

    return { toolResultBlocks, failedToolAttempts }
  }

  private buildToolResultBlock(toolUseId: string, result: ToolExecutionResult): ContentBlock {
    return {
      type: 'tool_result',
      toolUseId,
      content: result.output,
      isError: !result.success,
      outputSummary: result.outputSummary,
    }
  }

  private buildToolFailure(message: string): ToolExecutionResult {
    return {
      success: false,
      output: message,
      outputSummary: message,
    }
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

  private transientRetryDelayMs(attempt: number): number {
    return (
      this.config.transientRetryDelayMs?.(attempt) ?? Math.min(5_000 * 2 ** (attempt - 1), 60_000)
    )
  }

  private async completeWithStreamFallback(
    request: CompletionRequest,
    ctx: LoopIterationContext,
  ): Promise<CompletionResponse> {
    const maxStreamRetries = 1
    const maxTransientRetries = 3
    let lastStreamErr: unknown
    let transientAttempts = 0
    let emptyStreamAttempts = 0

    for (let attempt = 0; attempt <= maxStreamRetries + maxTransientRetries; attempt++) {
      try {
        const streamed = await this.completeFromStream(request, ctx)
        if (streamed.content.length === 0) {
          throw new Error('stream returned empty content')
        }
        return streamed
      } catch (streamErr) {
        lastStreamErr = streamErr
        const errorDetails = this.getStreamErrorDetails(streamErr)

        if (errorDetails.message === 'stream returned empty content') {
          if (emptyStreamAttempts < maxStreamRetries) {
            emptyStreamAttempts++
            this.config.logger.warn('llm_stream_empty_retry', {
              sessionId: this.config.sessionId,
              apiType: this.config.adapter.apiType,
              attempt: emptyStreamAttempts,
            })
            continue
          }
        }

        if (transientAttempts < maxTransientRetries && this.isTransientError(errorDetails)) {
          transientAttempts++
          const delay = this.transientRetryDelayMs(transientAttempts)
          this.config.logger.warn('llm_stream_transient_retry', {
            sessionId: this.config.sessionId,
            apiType: this.config.adapter.apiType,
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
        this.config.logger.warn('llm_stream_fallback_to_complete', {
          sessionId: this.config.sessionId,
          apiType: this.config.adapter.apiType,
          error: errorDetails.message,
          status: errorDetails.status,
          requestId: errorDetails.requestId,
          fallbackSkipped,
        })
        if (fallbackSkipped) {
          throw streamErr
        }

        return await this.config.adapter.complete({ ...request, stream: false })
      }
    }

    throw lastStreamErr
  }

  private async completeFromStream(
    request: CompletionRequest,
    ctx: LoopIterationContext,
  ): Promise<CompletionResponse> {
    const stream = this.config.adapter.stream({ ...request, stream: true })
    const turnId = generatePrefixedId('turn')
    const responseId = generatePrefixedId('resp')

    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls = new Map<string, { id: string; name: string; args: string }>()

    let currentToolId: string | null = null
    let stopReason: CompletionResponse['stopReason'] = 'end_turn'
    let usage = { input: 0, output: 0 }
    let model = request.model ?? 'unknown'

    for await (const event of stream) {
      if (event.type === 'text_delta') {
        const data = this.toRecord(event.data)
        const delta = typeof data.text === 'string' ? data.text : ''
        if (!delta) continue
        textParts.push(delta)
        this.hooks.onTextDelta?.(delta, { role: 'assistant', turnId }, ctx)
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
        const id = typeof data.id === 'string' ? data.id : generatePrefixedId('toolu')
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
        if (endedId) {
          currentToolId = endedId === currentToolId ? null : currentToolId
        }
        continue
      }

      if (event.type === 'done') {
        const data = this.toRecord(event.data)
        stopReason = this.mapFinishReason(
          typeof data.finishReason === 'string' ? data.finishReason : undefined,
        )
        usage = this.extractUsage(data.usage) ?? usage
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

    for (const toolCall of toolCalls.values()) {
      let input: Record<string, unknown>
      try {
        input = this.safeParseToolInput(toolCall.args)
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
      reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('') : undefined,
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
      throw new Error(
        `Failed to parse tool input JSON (${raw.length} chars, likely truncated by max_tokens)`,
      )
    }
  }

  private extractUsage(value: unknown): CompletionResponse['usage'] | undefined {
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
    if (this.config.adapter.apiType === 'anthropic_messages') {
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
}
