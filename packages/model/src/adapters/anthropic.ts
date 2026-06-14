import Anthropic from '@anthropic-ai/sdk'
import {
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type ImageBlock,
  type StreamEvent,
  type TokenUsage,
  type ToolResultBlock,
  hasSignedThinkingBlock,
  isSignedThinkingBlock,
} from '@zero-os/shared'
import { type ClaudeOAuthSession, parseClaudeOAuthSession } from '../auth/claude'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'
import { resolveImageBlock } from './image'

const REQUEST_CACHE_CONTROL = { type: 'ephemeral' } as const
const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/
const DEEPSEEK_DEFAULT_EFFORT = 'high' as const
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CODE_BETA =
  'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24'
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.97 (external, cli)'
const CLAUDE_CODE_OUTPUT_EFFORT = 'high'
const CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS = 5 * 60_000
const CLAUDE_MIN_VALIDITY_MS = 60_000
const CLAUDE_MISSING_CREDENTIALS_MESSAGE =
  'Claude OAuth credentials not found. Please run `bun zero provider login anthropic`.'
const CLAUDE_REAUTH_MESSAGE =
  'Claude OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login anthropic`.'

/**
 * Anthropic Messages API adapter.
 * Supports Claude model family.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly apiType: string = 'anthropic_messages'
  private client: Anthropic
  private baseUrl: string
  private modelId: string
  private isOAuthClient: boolean
  private apiKey?: string
  private oauthTokenProvider?: OAuthTokenProvider
  private oauthTokenRefresher?: OAuthTokenRefresher
  private oauthSession: ClaudeOAuthSessionManager<Anthropic>

  constructor(config: AdapterConfig) {
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
    this.oauthTokenProvider = config.oauthTokenProvider
    this.oauthTokenRefresher = config.oauthTokenRefresher
    this.isOAuthClient = Boolean(config.oauthToken)
    this.client = this.createClient(resolveAnthropicOAuthAccessToken(config.oauthToken))
    this.oauthSession = new ClaudeOAuthSessionManager({
      initialToken: config.oauthToken,
      tokenProvider: this.oauthTokenProvider,
      tokenRefresher: this.oauthTokenRefresher,
      getBaseClient: () => this.client,
      createClient: (accessToken) => this.createClient(accessToken),
    })
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

    yield* mapAnthropicStreamEvents(stream)
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
    return buildAnthropicRequest(req, {
      modelId: this.modelId,
      isOAuthClient: this.isOAuthClient,
      session: this.oauthSession.readSession(),
      requireThinkingForToolUse: this.shouldRequireThinkingForToolUse(),
      buildThinkingConfig: (request) => this.buildThinkingConfig(request),
      buildOutputConfig: (request, session) => this.buildOutputConfig(request, session),
    })
  }

  private buildSystem(system?: string): Anthropic.TextBlockParam[] | undefined {
    return buildAnthropicSystem(this.isOAuthClient, system)
  }

  private parseContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
    return parseAnthropicContent(content, this.shouldIncludeThinkingBlocksInContent())
  }

  private extractReasoningContent(content: Anthropic.ContentBlock[]): string | undefined {
    return extractAnthropicReasoningContent(content)
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
    req: CompletionRequest,
    _session?: ClaudeOAuthSession | null,
  ): Anthropic.OutputConfig | undefined {
    if (!this.isOAuthClient) return undefined
    const effort =
      req.reasoningEffort === 'xhigh' ? 'max' : (req.reasoningEffort ?? CLAUDE_CODE_OUTPUT_EFFORT)
    return { effort }
  }

  private mapStopReason(reason: string | null): CompletionResponse['stopReason'] {
    return mapAnthropicStopReason(reason)
  }

  private createClient(oauthAccessToken?: string): Anthropic {
    return createAnthropicClient({
      baseUrl: this.baseUrl,
      isOAuthClient: this.isOAuthClient,
      apiKey: this.apiKey,
      oauthAccessToken,
    })
  }

  private buildRequestOptions(
    req: CompletionRequest,
    _session?: ClaudeOAuthSession,
  ): Anthropic.RequestOptions | undefined {
    return buildAnthropicRequestOptions(this.isOAuthClient, req)
  }

  private async withOauthRetry<T>(
    request: (client: Anthropic, session?: ClaudeOAuthSession) => Promise<T>,
  ): Promise<T> {
    return this.oauthSession.withRetry(request)
  }
}

export class AnthropicDeepSeekAdapter extends AnthropicAdapter {
  override readonly apiType = 'anthropic-deepseek'

  protected override shouldIncludeThinkingBlocksInContent(): boolean {
    return true
  }

  protected override shouldRequireThinkingForToolUse(): boolean {
    return true
  }

  protected override buildThinkingConfig(_req: CompletionRequest): Anthropic.ThinkingConfigParam {
    return { type: 'enabled' } as Anthropic.ThinkingConfigParam
  }

  protected override buildOutputConfig(req: CompletionRequest): Anthropic.OutputConfig {
    return { effort: normalizeDeepSeekEffort(req.reasoningEffort) }
  }
}

function resolveAnthropicOAuthAccessToken(rawValue: string | undefined): string | undefined {
  return parseClaudeOAuthSession(rawValue)?.accessToken ?? rawValue
}

function normalizeDeepSeekEffort(
  effort: CompletionRequest['reasoningEffort'],
): NonNullable<Anthropic.OutputConfig['effort']> {
  if (effort === 'xhigh') return 'max'
  return effort ?? DEEPSEEK_DEFAULT_EFFORT
}

class ClaudeOAuthSessionManager<Client> {
  private readonly isOAuthClient: boolean

  constructor(
    private readonly options: {
      initialToken?: string
      tokenProvider?: OAuthTokenProvider
      tokenRefresher?: OAuthTokenRefresher
      getBaseClient: () => Client
      createClient: (accessToken?: string) => Client
    },
  ) {
    this.isOAuthClient = Boolean(options.initialToken)
  }

  readSession(): ClaudeOAuthSession | null {
    return parseClaudeOAuthSession(this.options.tokenProvider?.() ?? this.options.initialToken)
  }

  async withRetry<T>(
    request: (client: Client, session?: ClaudeOAuthSession) => Promise<T>,
  ): Promise<T> {
    if (!this.isOAuthClient) {
      return request(this.options.getBaseClient())
    }

    if (!this.readSession() && !this.options.tokenProvider && !this.options.tokenRefresher) {
      return request(this.options.getBaseClient())
    }

    let session = await this.getSession()

    try {
      return await request(this.getClientForSession(session), session)
    } catch (error) {
      if (!isUnauthorizedError(error) || !this.options.tokenRefresher) {
        throw error
      }

      await this.options.tokenRefresher('unauthorized')
      session = this.getRequiredSession()
      return request(this.getClientForSession(session), session)
    }
  }

  private getClientForSession(session: ClaudeOAuthSession): Client {
    if (!this.options.tokenProvider && !this.options.tokenRefresher) {
      return this.options.getBaseClient()
    }

    return this.options.createClient(session.accessToken)
  }

  private async getSession(): Promise<ClaudeOAuthSession> {
    const session = this.readSession()
    if (!session) {
      throw new Error(CLAUDE_MISSING_CREDENTIALS_MESSAGE)
    }

    if (isClaudeSessionExpiring(session, CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS)) {
      try {
        await this.options.tokenRefresher?.('expiring')
      } catch (error) {
        if (isClaudeSessionExpiring(session, CLAUDE_MIN_VALIDITY_MS)) {
          throw error
        }
      }
    }

    return this.getRequiredSession()
  }

  private getRequiredSession(): ClaudeOAuthSession {
    const session = this.readSession()
    if (!session) {
      throw new Error(CLAUDE_MISSING_CREDENTIALS_MESSAGE)
    }

    if (isClaudeSessionExpiring(session, CLAUDE_MIN_VALIDITY_MS)) {
      throw new Error(CLAUDE_REAUTH_MESSAGE)
    }

    return session
  }
}

function isClaudeSessionExpiring(session: ClaudeOAuthSession, minValidityMs: number): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const withStatus = error as { status?: number; response?: { status?: number } }
  return withStatus.status === 401 || withStatus.response?.status === 401
}

interface AnthropicClientOptions {
  baseUrl: string
  isOAuthClient: boolean
  apiKey?: string
  oauthAccessToken?: string
}

function createAnthropicClient({
  baseUrl,
  isOAuthClient,
  apiKey,
  oauthAccessToken,
}: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    apiKey: isOAuthClient ? null : (apiKey ?? 'dummy'),
    authToken: oauthAccessToken ?? null,
    baseURL: baseUrl,
    ...(isOAuthClient && {
      defaultQuery: {
        beta: 'true',
      },
      defaultHeaders: {
        'anthropic-beta': CLAUDE_CODE_BETA,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': CLAUDE_CODE_USER_AGENT,
        'x-app': 'cli',
      },
    }),
  })
}

function buildAnthropicSystem(
  isOAuthClient: boolean,
  system?: string,
): Anthropic.TextBlockParam[] | undefined {
  const blocks: Anthropic.TextBlockParam[] = []

  if (isOAuthClient) {
    blocks.push({
      type: 'text',
      text: CLAUDE_CODE_SYSTEM_PROMPT,
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

interface AnthropicRequestOptions {
  modelId: string
  isOAuthClient: boolean
  session?: ClaudeOAuthSession | null
  requireThinkingForToolUse: boolean
  buildThinkingConfig(req: CompletionRequest): Anthropic.ThinkingConfigParam | undefined
  buildOutputConfig(
    req: CompletionRequest,
    session?: ClaudeOAuthSession | null,
  ): Anthropic.OutputConfig | undefined
}

function buildAnthropicRequest(
  req: CompletionRequest,
  options: AnthropicRequestOptions,
): Anthropic.MessageCreateParamsNonStreaming {
  const thinking = options.buildThinkingConfig(req)
  const outputConfig = options.buildOutputConfig(req, options.session)
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model ?? options.modelId,
    cache_control: REQUEST_CACHE_CONTROL,
    system: buildAnthropicSystem(options.isOAuthClient, req.system),
    messages: convertAnthropicMessages(req, {
      requireThinkingForToolUse: options.requireThinkingForToolUse,
    }),
    tools: convertAnthropicTools(req.tools),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    max_tokens: req.maxTokens ?? 4096,
  }

  if (options.isOAuthClient && req.meta?.sessionId) {
    const userIdentity: Record<string, string> = {
      session_id: req.meta.sessionId,
    }
    if (options.session?.account?.accountUuid) {
      userIdentity.account_uuid = options.session.account.accountUuid
    }
    request.metadata = {
      user_id: JSON.stringify(userIdentity),
    }
  }

  return request
}

function buildAnthropicRequestOptions(
  isOAuthClient: boolean,
  req: CompletionRequest,
): Anthropic.RequestOptions | undefined {
  if (!isOAuthClient || !req.meta?.sessionId) {
    return undefined
  }

  return {
    headers: {
      'x-claude-code-session-id': req.meta.sessionId,
    },
  }
}

function parseAnthropicContent(
  content: Anthropic.ContentBlock[],
  includeThinkingBlocks: boolean,
): ContentBlock[] {
  const blocks: ContentBlock[] = []

  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking' && includeThinkingBlocks) {
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

function extractAnthropicReasoningContent(content: Anthropic.ContentBlock[]): string | undefined {
  const thinkingParts = content
    .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
    .map((block) => block.thinking.trim())
    .filter((text) => text.length > 0)

  if (thinkingParts.length === 0) return undefined
  return thinkingParts.join('\n')
}

function mapAnthropicStopReason(reason: string | null): CompletionResponse['stopReason'] {
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

async function* mapAnthropicStreamEvents(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncIterable<StreamEvent> {
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
      } else if (delta.type === 'signature_delta') {
        yield { type: 'reasoning_signature', data: { signature: delta.signature } }
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

export interface AnthropicMessageConversionOptions {
  requireThinkingForToolUse?: boolean
}

export function convertAnthropicMessages(
  req: CompletionRequest,
  options: AnthropicMessageConversionOptions = {},
): Anthropic.MessageParam[] {
  const raw: Anthropic.MessageParam[] = []
  const pairedCallIds = collectPairedToolCallIds(req, options)

  for (const msg of req.messages) {
    if (msg.role === 'user') {
      const parts: Anthropic.ContentBlockParam[] = []
      const hadOriginalContent = msg.content.length > 0
      for (const block of msg.content) {
        if (block.type === 'text') {
          if (block.text.trim().length > 0) {
            parts.push({ type: 'text', text: block.text })
          }
        } else if (block.type === 'image') {
          const image = resolveImageBlock(block)
          if (!image) continue
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType as Anthropic.Base64ImageSource['media_type'],
              data: image.data,
            },
          })
        } else if (block.type === 'tool_result') {
          if (!pairedCallIds.has(block.toolUseId)) continue
          parts.push({
            type: 'tool_result',
            tool_use_id: sanitizeAnthropicToolId(block.toolUseId),
            content: buildAnthropicToolResultContent(block),
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
          if (options.requireThinkingForToolUse && !isSignedThinkingBlock(block)) continue
          parts.push(convertAnthropicThinkingBlock(block))
        } else if (block.type === 'tool_use') {
          if (!pairedCallIds.has(block.id)) continue
          parts.push({
            type: 'tool_use',
            id: sanitizeAnthropicToolId(block.id),
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

  return mergeConsecutiveAnthropicMessages(raw)
}

export function convertAnthropicTools(
  tools: CompletionRequest['tools'],
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }))
}

function collectPairedToolCallIds(
  req: CompletionRequest,
  options: AnthropicMessageConversionOptions,
): Set<string> {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of req.messages) {
    const assistantHasThinking =
      msg.role === 'assistant' &&
      (options.requireThinkingForToolUse
        ? hasSignedThinkingBlock(msg.content)
        : msg.content.some(
            (block) => block.type === 'thinking' && block.thinking.trim().length > 0,
          ))
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        if (options.requireThinkingForToolUse && !assistantHasThinking) continue
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

function buildAnthropicToolResultContent(
  block: ToolResultBlock,
): Anthropic.ToolResultBlockParam['content'] {
  const images = toolResultImages(block).flatMap((image) => {
    const resolved = resolveImageBlock(image)
    return resolved ? [resolved] : []
  })
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

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

function convertAnthropicThinkingBlock(
  block: Extract<ContentBlock, { type: 'thinking' }>,
): Anthropic.ThinkingBlockParam {
  const payload = {
    type: 'thinking',
    thinking: block.thinking,
    ...(block.signature ? { signature: block.signature } : {}),
  }
  return payload as Anthropic.ThinkingBlockParam
}

function mergeConsecutiveAnthropicMessages(
  raw: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
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

function sanitizeAnthropicToolId(id: string): string {
  if (ANTHROPIC_TOOL_ID_RE.test(id)) return id
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}
