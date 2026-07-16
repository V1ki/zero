import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import OpenAI from 'openai'
import { getChatGptAuthorizationScheme, parseChatGptOAuthSession } from '../auth/chatgpt'
import type { ChatGptOAuthSession } from '../auth/chatgpt'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'
import type { ChatGptSseEvent } from './openai-resp-chatgpt-events'
import { parseChatGptCompletionEvents } from './openai-resp-chatgpt-events'
import {
  buildOpenAIResponsesInput,
  buildOpenAIResponsesReasoningConfig,
  convertOpenAIResponsesTools,
} from './openai-resp-input'
import { parseOpenAIResponse } from './openai-resp-parse'
import { parseOpenAIResponseUsage } from './openai-resp-parse'
import { iterResponsesSseEvents } from './openai-resp-stream'
import { mapOpenAIResponsesStreamEvents } from './openai-resp-stream'

const DEFAULT_CHATGPT_INSTRUCTIONS = 'You are a helpful assistant.'
// Applied independently to each fetch/read wait; this is not a whole-request deadline.
const DEFAULT_CHATGPT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000
const CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
const CHATGPT_MIN_VALIDITY_MS = 60_000
const CHATGPT_REAUTH_MESSAGE =
  'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.'
const CHATGPT_MISSING_CREDENTIALS_MESSAGE =
  'ChatGPT OAuth credentials not found. Please run `bun zero provider login chatgpt`.'

/**
 * OpenAI Responses API adapter.
 * Uses the native Responses API (`client.responses.create()`) for models
 * that support it (e.g., o3, o4-mini, gpt-4.1).
 */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly apiType = 'openai_responses'
  readonly supportsNonStreamingFallback: boolean
  private client: OpenAI | null
  private modelId: string
  private isChatGptProvider: boolean
  private chatGptTransport?: ChatGptResponsesTransport

  constructor(config: AdapterConfig & { chatGptStreamIdleTimeoutMs?: number }) {
    this.isChatGptProvider =
      config.managedOAuthProvider === 'chatgpt' || config.providerName === 'chatgpt'
    this.supportsNonStreamingFallback = !this.isChatGptProvider
    this.client = this.isChatGptProvider
      ? null
      : new OpenAI({
          apiKey: config.apiKey ?? 'dummy',
          baseURL: config.baseUrl.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`,
        })
    this.modelId = config.modelConfig.modelId
    if (this.isChatGptProvider) {
      this.chatGptTransport = new ChatGptResponsesTransport({
        baseUrl: config.baseUrl,
        modelId: this.modelId,
        oauthToken: config.oauthToken,
        oauthTokenProvider: config.oauthTokenProvider,
        oauthTokenRefresher: config.oauthTokenRefresher,
        idleTimeoutMs: resolveChatGptStreamIdleTimeoutMs(config.chatGptStreamIdleTimeoutMs),
      })
    }
  }

  private getResponsesClient(): OpenAI['responses'] {
    if (!this.client) {
      throw new Error('OpenAI responses client is not configured')
    }
    return this.client.responses
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.isChatGptProvider) {
      return this.completeFromChatGpt(req)
    }

    const client = this.getResponsesClient()
    const input = buildOpenAIResponsesInput(req)
    const tools = convertOpenAIResponsesTools(req.tools)

    const response = await client.create({
      model: req.model ?? this.modelId,
      input,
      tools,
      reasoning: buildOpenAIResponsesReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream: false,
    })

    return parseOpenAIResponse(response, this.modelId)
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.isChatGptProvider) {
      yield* this.streamFromChatGpt(req)
      return
    }

    const client = this.getResponsesClient()
    const input = buildOpenAIResponsesInput(req)
    const tools = convertOpenAIResponsesTools(req.tools)

    const stream = await client.create({
      model: req.model ?? this.modelId,
      input,
      tools,
      reasoning: buildOpenAIResponsesReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream: true,
    })

    yield* mapOpenAIResponsesStreamEvents(stream, {
      doneReasonMode: 'tool_state',
      parseUsage: parseOpenAIResponseUsage,
    })
  }

  async healthCheck(): Promise<boolean> {
    if (this.isChatGptProvider) {
      try {
        const response = await this.completeFromChatGpt({
          messages: [],
          stream: false,
          maxTokens: 5,
          system: 'Respond with pong',
          model: this.modelId,
        })
        return response.content.length > 0 || response.stopReason === 'end_turn'
      } catch {
        return false
      }
    }

    try {
      const response = await this.getResponsesClient().create({
        model: this.modelId,
        input: 'ping',
        max_output_tokens: 5,
      })
      return !!response.id
    } catch {
      try {
        const response = await (this.client as OpenAI).chat.completions.create({
          model: this.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        })
        return response.choices.length > 0
      } catch {
        return false
      }
    }
  }

  private async completeFromChatGpt(req: CompletionRequest): Promise<CompletionResponse> {
    const events = await this.getChatGptTransport().fetchEvents(req)
    return parseChatGptCompletionEvents(events, this.modelId)
  }

  private async *streamFromChatGpt(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const transport = this.getChatGptTransport()
    const request = await transport.requestResponse(req)

    try {
      if (!request.response.ok) {
        const error = await request.readText()
        throw buildChatGptHttpError(request.response.status, error)
      }

      yield* mapOpenAIResponsesStreamEvents(request.iterSseEvents(), {
        doneReasonMode: 'response_status',
        parseUsage: parseOpenAIResponseUsage,
      })
    } finally {
      request.close()
    }
  }

  private buildChatGptBody(req: CompletionRequest) {
    return this.getChatGptTransport().buildBody(req)
  }

  private getChatGptTransport(): ChatGptResponsesTransport {
    if (!this.chatGptTransport) {
      throw new Error('ChatGPT responses transport is not configured')
    }
    return this.chatGptTransport
  }
}

interface ChatGptResponsesTransportOptions {
  baseUrl: string
  modelId: string
  oauthToken?: string
  oauthTokenProvider?: OAuthTokenProvider
  oauthTokenRefresher?: OAuthTokenRefresher
  idleTimeoutMs: number
}

class ChatGptResponsesTransport {
  constructor(private readonly options: ChatGptResponsesTransportOptions) {}

  buildBody(req: CompletionRequest) {
    const tools = convertOpenAIResponsesTools(req.tools)

    return {
      model: this.stripModel(req.model ?? this.options.modelId),
      store: false,
      stream: true,
      instructions: req.system?.trim() || DEFAULT_CHATGPT_INSTRUCTIONS,
      input: buildOpenAIResponsesInput({ ...req, system: undefined }),
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: buildOpenAIResponsesReasoningConfig(req),
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: this.computePromptCacheKey(req),
      service_tier: 'priority',
    }
  }

  async fetchEvents(req: CompletionRequest): Promise<ChatGptSseEvent[]> {
    const request = await this.requestResponse(req)

    try {
      if (!request.response.ok) {
        const error = await request.readText()
        throw buildChatGptHttpError(request.response.status, error)
      }

      const events: ChatGptSseEvent[] = []
      for await (const event of request.iterSseEvents()) {
        events.push(event)
      }
      return events
    } finally {
      request.close()
    }
  }

  async requestResponse(req: CompletionRequest): Promise<TimedChatGptResponse> {
    const session = await this.getSession()
    let request = await this.sendRequest(req, session)

    if (request.response.status !== 401 || !this.options.oauthTokenRefresher) {
      return request
    }

    request.close()
    await this.options.oauthTokenRefresher('unauthorized')
    request = await this.sendRequest(req, this.getRequiredSession())
    return request
  }

  private stripModel(model: string): string {
    return model.startsWith('chatgpt/') ? model.slice('chatgpt/'.length) : model
  }

  private async sendRequest(
    req: CompletionRequest,
    session: ChatGptOAuthSession,
  ): Promise<TimedChatGptResponse> {
    const body = JSON.stringify(this.buildBody(req))
    const idleTimer = new ChatGptIdleTimer(this.options.idleTimeoutMs)

    try {
      const response = await idleTimer.waitFor(
        fetch(`${this.options.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            Authorization: `${getChatGptAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
            'chatgpt-account-id': session.accountId,
            'OpenAI-Beta': 'responses=experimental',
            originator: 'zero-os',
            accept: 'text/event-stream',
            'content-type': 'application/json',
          },
          body,
          signal: idleTimer.signal,
        }),
        'ChatGPT request',
      )
      return new TimedChatGptResponse(response, idleTimer)
    } catch (error) {
      const normalized = normalizeChatGptTransportError(
        error,
        'ChatGPT request',
        'request_transport_error',
      )
      idleTimer.close()
      throw normalized
    }
  }

  private async getSession(): Promise<ChatGptOAuthSession> {
    let session = this.readSession()
    if (!session) {
      throw new Error(CHATGPT_MISSING_CREDENTIALS_MESSAGE)
    }

    if (isChatGptSessionExpiring(session, CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS)) {
      await this.options.oauthTokenRefresher?.('expiring')
      session = this.getRequiredSession()
    }

    if (isChatGptSessionExpiring(session, CHATGPT_MIN_VALIDITY_MS)) {
      throw new Error(CHATGPT_REAUTH_MESSAGE)
    }

    return session
  }

  private getRequiredSession(): ChatGptOAuthSession {
    const session = this.readSession()
    if (!session) {
      throw new Error(CHATGPT_MISSING_CREDENTIALS_MESSAGE)
    }
    if (isChatGptSessionExpiring(session, CHATGPT_MIN_VALIDITY_MS)) {
      throw new Error(CHATGPT_REAUTH_MESSAGE)
    }
    return session
  }

  private readSession(): ChatGptOAuthSession | null {
    return parseChatGptOAuthSession(this.options.oauthTokenProvider?.() ?? this.options.oauthToken)
  }

  private computePromptCacheKey(req: CompletionRequest): string {
    return Bun.hash(
      JSON.stringify({
        system: req.system,
        model: req.model ?? this.options.modelId,
        messages: req.messages,
        tools: req.tools,
      }),
    ).toString()
  }
}

class TimedChatGptResponse {
  constructor(
    readonly response: Response,
    private readonly idleTimer: ChatGptIdleTimer,
  ) {}

  async readText(): Promise<string> {
    try {
      return await this.idleTimer.waitFor(this.response.text(), 'ChatGPT response body')
    } catch (error) {
      throw normalizeChatGptTransportError(
        error,
        'ChatGPT response body',
        'response_body_transport_error',
      )
    }
  }

  async *iterSseEvents(): AsyncIterable<ChatGptSseEvent> {
    const iterator = iterResponsesSseEvents(this.response, {
      requireCompleted: true,
      signal: this.idleTimer.signal,
    })[Symbol.asyncIterator]()

    try {
      while (true) {
        const result = await this.idleTimer.waitFor(iterator.next(), 'ChatGPT response stream')
        if (result.done) return
        yield result.value
        if (result.value.type === 'response.completed') return
      }
    } finally {
      try {
        await iterator.return?.()
      } catch {
        // Preserve the transport or protocol error that caused iteration to stop.
      }
      this.close()
    }
  }

  close(): void {
    this.idleTimer.close()
  }
}

class ChatGptIdleTimer {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()

  constructor(private readonly idleTimeoutMs: number) {
    this.signal = this.controller.signal
  }

  waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
    return withChatGptIdleTimeout(promise, this.idleTimeoutMs, label, (error) => this.close(error))
  }

  close(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason)
    }
  }
}

function withChatGptIdleTimeout<T>(
  promise: Promise<T>,
  idleTimeoutMs: number,
  label: string,
  onTimeout: (error: Error) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutError: Error | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = buildChatGptIdleTimeoutError(label, idleTimeoutMs)
      onTimeout(timeoutError)
      reject(timeoutError)
    }, idleTimeoutMs)
  })

  return Promise.race([promise, timeout])
    .catch((error) => {
      throw timeoutError ?? error
    })
    .finally(() => {
      if (timer) clearTimeout(timer)
    })
}

function buildChatGptIdleTimeoutError(label: string, idleTimeoutMs: number): Error {
  return Object.assign(new Error(`${label} idle timed out after ${idleTimeoutMs}ms`), {
    retryable: true,
    error_type: 'stream_idle_timeout',
    failure_scope: 'transport',
  })
}

function normalizeChatGptTransportError(error: unknown, label: string, errorType: string): Error {
  if (
    error instanceof Error &&
    typeof (error as Error & { retryable?: unknown }).retryable === 'boolean'
  ) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const code = getErrorCode(error)
  return Object.assign(new Error(`${label} transport failed: ${message}`, { cause: error }), {
    retryable: true,
    error_type: errorType,
    failure_scope: 'transport',
    ...(code ? { code } : {}),
  })
}

function buildChatGptHttpError(status: number, body: string): Error {
  return Object.assign(new Error(`ChatGPT request failed: ${status} ${body}`), {
    status,
    retryable: status === 408 || status === 429 || status >= 500,
    error_type: 'http_error',
    failure_scope: status === 408 || status === 429 || status >= 500 ? 'provider' : 'request',
  })
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function resolveChatGptStreamIdleTimeoutMs(idleTimeoutMs?: number): number {
  if (idleTimeoutMs === undefined) return DEFAULT_CHATGPT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error('chatGptStreamIdleTimeoutMs must be a positive finite number')
  }
  return idleTimeoutMs
}

function isChatGptSessionExpiring(session: ChatGptOAuthSession, minValidityMs: number): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}
