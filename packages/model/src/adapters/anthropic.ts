import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ImageBlock,
  StreamEvent,
  TokenUsage,
  ToolResultBlock,
} from '@zero-os/shared'
import { type ClaudeOAuthSession, parseClaudeOAuthSession } from '../auth/claude'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'

const CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS = 5 * 60_000
const CLAUDE_MIN_VALIDITY_MS = 60_000
const CLAUDE_MISSING_CREDENTIALS_MESSAGE =
  'Claude OAuth credentials not found. Please run `bun zero provider login anthropic`.'
const CLAUDE_REAUTH_MESSAGE =
  'Claude OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login anthropic`.'

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

/**
 * Anthropic Messages API adapter.
 * Supports Claude model family.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly apiType: string = 'anthropic_messages'
  private static readonly REQUEST_CACHE_CONTROL = { type: 'ephemeral' } as const
  private static readonly TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/
  private static readonly CLAUDE_CODE_SYSTEM_PROMPT =
    "You are Claude Code, Anthropic's official CLI for Claude."
  private static readonly CLAUDE_CODE_BETA =
    'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24'
  private static readonly CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.97 (external, cli)'
  private static readonly CLAUDE_CODE_OUTPUT_EFFORT = 'high'
  private client: Anthropic
  private baseUrl: string
  private modelId: string
  private isOAuthClient: boolean
  private apiKey?: string
  private oauthToken?: string
  private oauthTokenProvider?: OAuthTokenProvider
  private oauthTokenRefresher?: OAuthTokenRefresher

  constructor(config: AdapterConfig) {
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
    this.oauthToken = config.oauthToken
    this.oauthTokenProvider = config.oauthTokenProvider
    this.oauthTokenRefresher = config.oauthTokenRefresher
    this.isOAuthClient = Boolean(config.oauthToken)
    this.client = this.createClient(this.extractOauthAccessToken(config.oauthToken))
    this.modelId = config.modelConfig.modelId
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.withOauthRetry((client, session) =>
      client.messages.create(this.buildRequest(req), this.buildRequestOptions(req, session)),
    )

    return {
      id: response.id,
      content: this.parseContent(response.content),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheWrite: response.usage.cache_creation_input_tokens ?? undefined,
        cacheRead: response.usage.cache_read_input_tokens ?? undefined,
      },
      model: response.model,
      reasoningContent: this.extractReasoningContent(response.content),
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const stream = await this.withOauthRetry((client, session) =>
      client.messages.create(
        {
          ...this.buildRequest(req),
          stream: true,
        },
        this.buildRequestOptions(req, session),
      ),
    )

    let streamModel: string | undefined
    let streamUsage: TokenUsage | undefined
    let streamStopReason: string | undefined
    const toolBlockIds = new Map<number, string>()

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as unknown as Record<string, unknown>
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', data: { text: delta.text } }
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'reasoning_delta', data: { text: delta.thinking } }
        } else if (delta.type === 'input_json_delta') {
          yield { type: 'tool_use_delta', data: { arguments: delta.partial_json } }
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block as unknown as Record<string, unknown>
        if (block.type === 'tool_use') {
          const toolId = typeof block.id === 'string' ? block.id : undefined
          if (typeof event.index === 'number' && toolId) {
            toolBlockIds.set(event.index, toolId)
          }
          yield {
            type: 'tool_use_start',
            data: { id: toolId, name: block.name },
          }
        }
      } else if (event.type === 'content_block_stop') {
        const toolId = typeof event.index === 'number' ? toolBlockIds.get(event.index) : undefined
        if (toolId) {
          toolBlockIds.delete(event.index)
          yield { type: 'tool_use_end', data: { id: toolId } }
        }
      } else if (event.type === 'message_start') {
        const msg = event.message
        if (msg?.model) {
          streamModel = msg.model
        }
        if (msg?.usage) {
          streamUsage = {
            input: msg.usage.input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
            cacheWrite: msg.usage.cache_creation_input_tokens ?? undefined,
            cacheRead: msg.usage.cache_read_input_tokens ?? undefined,
          }
        }
      } else if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          streamStopReason = event.delta.stop_reason
        }
        if (event.usage?.output_tokens) {
          streamUsage = {
            ...streamUsage,
            input: streamUsage?.input ?? 0,
            output: event.usage.output_tokens,
          }
        }
      } else if (event.type === 'message_stop') {
        yield {
          type: 'done',
          data: { model: streamModel, usage: streamUsage, finishReason: streamStopReason },
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.withOauthRetry((client) =>
        client.messages.create({
          model: this.modelId,
          system: this.buildSystem(),
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      )
      return response.content.length > 0
    } catch {
      return false
    }
  }

  private buildRequest(req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
    const session = this.readClaudeSession()
    const thinking = this.buildThinkingConfig(req)
    const outputConfig = this.buildOutputConfig(req, session)
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model ?? this.modelId,
      cache_control: AnthropicAdapter.REQUEST_CACHE_CONTROL,
      system: this.buildSystem(req.system),
      messages: this.convertMessages(req),
      tools: req.tools ? this.convertTools(req.tools) : undefined,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      max_tokens: req.maxTokens ?? 4096,
    }

    if (this.isOAuthClient) {
      if (req.meta?.sessionId) {
        const userIdentity: Record<string, string> = {
          session_id: req.meta.sessionId,
        }
        if (session?.account?.accountUuid) {
          userIdentity.account_uuid = session.account.accountUuid
        }
        request.metadata = {
          user_id: JSON.stringify(userIdentity),
        }
      }
    }

    return request
  }

  private buildSystem(system?: string): Anthropic.TextBlockParam[] | undefined {
    const blocks: Anthropic.TextBlockParam[] = []

    if (this.isOAuthClient) {
      blocks.push({
        type: 'text',
        text: AnthropicAdapter.CLAUDE_CODE_SYSTEM_PROMPT,
      })
    }

    if (system) {
      blocks.push({
        type: 'text',
        text: system,
      })
    }

    return blocks.length > 0 ? blocks : undefined
  }

  private sanitizeToolId(id: string): string {
    if (AnthropicAdapter.TOOL_ID_RE.test(id)) return id
    return id.replace(/[^a-zA-Z0-9_-]/g, '-')
  }

  private convertMessages(req: CompletionRequest): Anthropic.MessageParam[] {
    const raw: Anthropic.MessageParam[] = []
    const pairedCallIds = this.collectPairedToolCallIds(req)

    for (const msg of req.messages) {
      if (msg.role === 'user') {
        const parts: Anthropic.ContentBlockParam[] = []
        const hadOriginalContent = msg.content.length > 0
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            parts.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.mediaType as Anthropic.Base64ImageSource['media_type'],
                data: block.data,
              },
            })
          } else if (block.type === 'tool_result') {
            if (!pairedCallIds.has(block.toolUseId)) continue
            parts.push({
              type: 'tool_result',
              tool_use_id: this.sanitizeToolId(block.toolUseId),
              content: this.buildToolResultContent(block),
              is_error: block.isError,
            })
          }
        }
        if (parts.length > 0 || !hadOriginalContent) {
          raw.push({ role: 'user', content: parts })
        }
      } else if (msg.role === 'assistant') {
        const parts: Anthropic.ContentBlockParam[] = []
        const hadOriginalContent = msg.content.length > 0
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'thinking') {
            parts.push(this.convertThinkingBlock(block))
          } else if (block.type === 'tool_use') {
            if (!pairedCallIds.has(block.id)) continue
            parts.push({
              type: 'tool_use',
              id: this.sanitizeToolId(block.id),
              name: block.name,
              input: block.input,
            })
          }
        }
        if (parts.length > 0 || !hadOriginalContent) {
          raw.push({ role: 'assistant', content: parts })
        }
      }
    }

    // Merge consecutive same-role messages (Anthropic API requires strict alternation)
    const messages: Anthropic.MessageParam[] = []
    for (const msg of raw) {
      const prev = messages[messages.length - 1]
      if (prev && prev.role === msg.role) {
        const prevContent = Array.isArray(prev.content) ? prev.content : []
        const curContent = Array.isArray(msg.content) ? msg.content : []
        prev.content = [...prevContent, ...curContent] as Anthropic.ContentBlockParam[]
      } else {
        messages.push(msg)
      }
    }

    return messages
  }

  /**
   * Keep only tool calls that have a matching tool result in history.
   * This avoids replaying interrupted tool turns back into Anthropic.
   */
  private collectPairedToolCallIds(req: CompletionRequest): Set<string> {
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of req.messages) {
      const assistantHasThinking =
        msg.role === 'assistant' &&
        msg.content.some((block) => block.type === 'thinking' && block.thinking.trim().length > 0)
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          if (this.shouldRequireThinkingForToolUse() && !assistantHasThinking) continue
          toolUseIds.add(block.id)
        } else if (block.type === 'tool_result') {
          toolResultIds.add(block.toolUseId)
        }
      }
    }

    const paired = new Set<string>()
    for (const id of toolUseIds) {
      if (toolResultIds.has(id)) {
        paired.add(id)
      }
    }
    return paired
  }

  private buildToolResultContent(
    block: ToolResultBlock,
  ): Anthropic.ToolResultBlockParam['content'] {
    const images = toolResultImages(block)
    if (images.length === 0) return block.content

    const content: Anthropic.ToolResultBlockParam['content'] = []
    const text = block.content.trim().length > 0 ? block.content : block.outputSummary
    if (text && text.trim().length > 0) {
      content.push({ type: 'text', text })
    }
    for (const image of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType as Anthropic.Base64ImageSource['media_type'],
          data: image.data,
        },
      })
    }
    return content
  }

  private convertTools(tools: CompletionRequest['tools']): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }))
  }

  private parseContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
    const blocks: ContentBlock[] = []

    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking' && this.shouldIncludeThinkingBlocksInContent()) {
        blocks.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        })
      } else if (block.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    return blocks
  }

  private convertThinkingBlock(
    block: Extract<ContentBlock, { type: 'thinking' }>,
  ): Anthropic.ThinkingBlockParam {
    const payload = {
      type: 'thinking',
      thinking: block.thinking,
      ...(block.signature ? { signature: block.signature } : {}),
    }
    return payload as Anthropic.ThinkingBlockParam
  }

  private extractReasoningContent(content: Anthropic.ContentBlock[]): string | undefined {
    const thinkingParts = content
      .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
      .map((block) => block.thinking.trim())
      .filter((text) => text.length > 0)

    if (thinkingParts.length === 0) return undefined
    return thinkingParts.join('\n')
  }

  protected shouldIncludeThinkingBlocksInContent(): boolean {
    return false
  }

  protected shouldRequireThinkingForToolUse(): boolean {
    return false
  }

  protected buildThinkingConfig(
    _req: CompletionRequest,
  ): Anthropic.ThinkingConfigParam | undefined {
    return {
      type: 'adaptive',
    }
  }

  protected buildOutputConfig(
    _req: CompletionRequest,
    _session?: ClaudeOAuthSession | null,
  ): Anthropic.OutputConfig | undefined {
    if (!this.isOAuthClient) return undefined
    return { effort: AnthropicAdapter.CLAUDE_CODE_OUTPUT_EFFORT }
  }

  private mapStopReason(reason: string | null): CompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
        return 'end_turn'
      case 'tool_use':
        return 'tool_use'
      case 'max_tokens':
        return 'max_tokens'
      default:
        return 'end_turn'
    }
  }

  private createClient(oauthAccessToken?: string): Anthropic {
    return new Anthropic({
      apiKey: this.isOAuthClient ? null : (this.apiKey ?? 'dummy'),
      authToken: oauthAccessToken ?? null,
      baseURL: this.baseUrl,
      ...(this.isOAuthClient && {
        defaultQuery: {
          beta: 'true',
        },
        defaultHeaders: {
          'anthropic-beta': AnthropicAdapter.CLAUDE_CODE_BETA,
          'anthropic-dangerous-direct-browser-access': 'true',
          'user-agent': AnthropicAdapter.CLAUDE_CODE_USER_AGENT,
          'x-app': 'cli',
        },
      }),
    })
  }

  private buildRequestOptions(
    req: CompletionRequest,
    _session?: ClaudeOAuthSession,
  ): Anthropic.RequestOptions | undefined {
    if (!this.isOAuthClient || !req.meta?.sessionId) {
      return undefined
    }

    return {
      headers: {
        'x-claude-code-session-id': req.meta.sessionId,
      },
    }
  }

  private async withOauthRetry<T>(
    request: (client: Anthropic, session?: ClaudeOAuthSession) => Promise<T>,
  ): Promise<T> {
    if (!this.isOAuthClient) {
      return request(this.client)
    }

    if (!this.readClaudeSession() && !this.oauthTokenProvider && !this.oauthTokenRefresher) {
      return request(this.client)
    }

    let session = await this.getClaudeSession()

    try {
      return await request(this.getClientForSession(session), session)
    } catch (error) {
      if (!this.isUnauthorizedError(error) || !this.oauthTokenRefresher) {
        throw error
      }

      await this.oauthTokenRefresher('unauthorized')
      session = this.getRequiredClaudeSession()
      return request(this.getClientForSession(session), session)
    }
  }

  private getClientForSession(session: ClaudeOAuthSession): Anthropic {
    if (!this.oauthTokenProvider && !this.oauthTokenRefresher) {
      return this.client
    }

    return this.createClient(session.accessToken)
  }

  private async getClaudeSession(): Promise<ClaudeOAuthSession> {
    const session = this.readClaudeSession()
    if (!session) {
      throw new Error(CLAUDE_MISSING_CREDENTIALS_MESSAGE)
    }

    if (
      this.isClaudeSessionExpiring(session, CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS) &&
      this.oauthTokenRefresher
    ) {
      try {
        await this.oauthTokenRefresher('expiring')
      } catch (error) {
        if (this.isClaudeSessionExpiring(session, CLAUDE_MIN_VALIDITY_MS)) {
          throw error
        }
      }
    }

    return this.getRequiredClaudeSession()
  }

  private getRequiredClaudeSession(): ClaudeOAuthSession {
    const session = this.readClaudeSession()
    if (!session) {
      throw new Error(CLAUDE_MISSING_CREDENTIALS_MESSAGE)
    }

    if (this.isClaudeSessionExpiring(session, CLAUDE_MIN_VALIDITY_MS)) {
      throw new Error(CLAUDE_REAUTH_MESSAGE)
    }

    return session
  }

  private readClaudeSession(): ClaudeOAuthSession | null {
    return parseClaudeOAuthSession(this.oauthTokenProvider?.() ?? this.oauthToken)
  }

  private extractOauthAccessToken(rawValue: string | undefined): string | undefined {
    return parseClaudeOAuthSession(rawValue)?.accessToken ?? rawValue
  }

  private isClaudeSessionExpiring(session: ClaudeOAuthSession, minValidityMs: number): boolean {
    return Date.now() >= session.expiresAt - minValidityMs
  }

  private isUnauthorizedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false

    const withStatus = error as { status?: number; response?: { status?: number } }
    return withStatus.status === 401 || withStatus.response?.status === 401
  }
}
