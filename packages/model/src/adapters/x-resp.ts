import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import type OpenAI from 'openai'
import { getXPremiumAuthorizationScheme, parseXPremiumOAuthSession } from '../auth/x-premium'
import type { XPremiumOAuthSession } from '../auth/x-premium'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'
import type { ChatGptSseEvent } from './openai-resp-chatgpt-events'
import {
  buildOpenAIResponsesInput,
  buildOpenAIResponsesReasoningConfig,
  convertOpenAIResponsesTools,
} from './openai-resp-input'
import { parseOpenAIResponse } from './openai-resp-parse'
import { parseOpenAIResponseUsage } from './openai-resp-parse'
import { iterResponsesSseEvents } from './openai-resp-stream'
import { mapOpenAIResponsesStreamEvents } from './openai-resp-stream'

const X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS = 2 * 60_000
const X_PREMIUM_MIN_VALIDITY_MS = 60_000
const X_PREMIUM_REAUTH_MESSAGE =
  'X Premium OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login x-premium`.'
const X_PREMIUM_MISSING_CREDENTIALS_MESSAGE =
  'X Premium OAuth credentials not found. Please run `bun zero provider login x-premium`.'

export class XResponsesAdapter implements ProviderAdapter {
  readonly apiType = 'x_responses'
  private modelId: string
  private transport: XPremiumResponsesTransport

  constructor(config: AdapterConfig) {
    this.modelId = config.modelConfig.modelId
    this.transport = new XPremiumResponsesTransport({
      baseUrl: config.baseUrl,
      modelId: this.modelId,
      oauthToken: config.oauthToken,
      oauthTokenProvider: config.oauthTokenProvider,
      oauthTokenRefresher: config.oauthTokenRefresher,
    })
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.transport.requestResponse(req, false)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`X Premium request failed: ${response.status} ${error}`)
    }

    return parseOpenAIResponse((await response.json()) as OpenAI.Responses.Response, this.modelId)
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.transport.requestResponse(req, true)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`X Premium request failed: ${response.status} ${error}`)
    }

    yield* mapOpenAIResponsesStreamEvents(this.transport.iterSseEvents(response), {
      doneReasonMode: 'tool_or_response_status',
      parseUsage: parseOpenAIResponseUsage,
    })
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.complete({
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
}

interface XPremiumResponsesTransportOptions {
  baseUrl: string
  modelId: string
  oauthToken?: string
  oauthTokenProvider?: OAuthTokenProvider
  oauthTokenRefresher?: OAuthTokenRefresher
}

class XPremiumResponsesTransport {
  constructor(private readonly options: XPremiumResponsesTransportOptions) {}

  async requestResponse(req: CompletionRequest, stream: boolean): Promise<Response> {
    const session = await this.getSession()
    let response = await this.sendRequest(req, session, stream)

    if (response.status !== 401 || !this.options.oauthTokenRefresher) {
      return response
    }

    await this.options.oauthTokenRefresher('unauthorized')
    response = await this.sendRequest(req, this.getRequiredSession(), stream)
    return response
  }

  async *iterSseEvents(response: Response): AsyncIterable<ChatGptSseEvent> {
    yield* iterResponsesSseEvents(response)
  }

  private async sendRequest(
    req: CompletionRequest,
    session: XPremiumOAuthSession,
    stream: boolean,
  ): Promise<Response> {
    return fetch(this.responsesEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `${getXPremiumAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
        accept: stream ? 'text/event-stream' : 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(req, stream)),
    })
  }

  private responsesEndpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`
  }

  private buildBody(req: CompletionRequest, stream: boolean) {
    const tools = req.tools ? convertOpenAIResponsesTools(req.tools) : undefined

    return {
      model: this.stripModel(req.model ?? this.options.modelId),
      input: buildOpenAIResponsesInput(req),
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: buildOpenAIResponsesReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream,
      store: false,
    }
  }

  private stripModel(model: string): string {
    return model.startsWith('x-premium/') ? model.slice('x-premium/'.length) : model
  }

  private async getSession(): Promise<XPremiumOAuthSession> {
    let session = this.readSession()
    if (!session) {
      throw new Error(X_PREMIUM_MISSING_CREDENTIALS_MESSAGE)
    }

    if (isXPremiumSessionExpiring(session, X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS)) {
      await this.options.oauthTokenRefresher?.('expiring')
      session = this.getRequiredSession()
    }

    if (isXPremiumSessionExpiring(session, X_PREMIUM_MIN_VALIDITY_MS)) {
      throw new Error(X_PREMIUM_REAUTH_MESSAGE)
    }

    return session
  }

  private getRequiredSession(): XPremiumOAuthSession {
    const session = this.readSession()
    if (!session) {
      throw new Error(X_PREMIUM_MISSING_CREDENTIALS_MESSAGE)
    }
    if (isXPremiumSessionExpiring(session, X_PREMIUM_MIN_VALIDITY_MS)) {
      throw new Error(X_PREMIUM_REAUTH_MESSAGE)
    }
    return session
  }

  private readSession(): XPremiumOAuthSession | null {
    return parseXPremiumOAuthSession(this.options.oauthTokenProvider?.() ?? this.options.oauthToken)
  }
}

function isXPremiumSessionExpiring(session: XPremiumOAuthSession, minValidityMs: number): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}
