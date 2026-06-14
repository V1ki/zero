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
  private client: OpenAI | null
  private modelId: string
  private isChatGptProvider: boolean
  private chatGptTransport?: ChatGptResponsesTransport

  constructor(config: AdapterConfig) {
    this.isChatGptProvider =
      config.managedOAuthProvider === 'chatgpt' || config.providerName === 'chatgpt'
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
    const response = await transport.requestResponse(req)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`ChatGPT request failed: ${response.status} ${error}`)
    }

    yield* mapOpenAIResponsesStreamEvents(transport.iterSseEvents(response), {
      doneReasonMode: 'response_status',
      parseUsage: parseOpenAIResponseUsage,
    })
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
    const response = await this.requestResponse(req)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`ChatGPT request failed: ${response.status} ${error}`)
    }

    const events: ChatGptSseEvent[] = []
    for await (const event of this.iterSseEvents(response)) {
      events.push(event)
    }
    return events
  }

  async requestResponse(req: CompletionRequest): Promise<Response> {
    const session = await this.getSession()
    let response = await this.sendRequest(req, session)

    if (response.status !== 401 || !this.options.oauthTokenRefresher) {
      return response
    }

    await this.options.oauthTokenRefresher('unauthorized')
    response = await this.sendRequest(req, this.getRequiredSession())
    return response
  }

  async *iterSseEvents(response: Response): AsyncIterable<ChatGptSseEvent> {
    yield* iterResponsesSseEvents(response)
  }

  private stripModel(model: string): string {
    return model.startsWith('chatgpt/') ? model.slice('chatgpt/'.length) : model
  }

  private async sendRequest(
    req: CompletionRequest,
    session: ChatGptOAuthSession,
  ): Promise<Response> {
    return fetch(`${this.options.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `${getChatGptAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'zero-os',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(req)),
    })
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

function isChatGptSessionExpiring(session: ChatGptOAuthSession, minValidityMs: number): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}
