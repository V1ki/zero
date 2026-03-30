import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StreamEvent,
  TokenUsage,
} from '@zero-os/shared'
import type { AdapterConfig, ProviderAdapter } from './base'

/**
 * Anthropic Messages API adapter.
 * Supports Claude model family.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly apiType = 'anthropic_messages'
  private static readonly REQUEST_CACHE_CONTROL = { type: 'ephemeral' } as const
  private static readonly TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/
  private static readonly CLAUDE_CODE_SYSTEM_PROMPT =
    "You are Claude Code, Anthropic's official CLI for Claude."
  private client: Anthropic
  private modelId: string
  private isOAuthClient: boolean

  constructor(config: AdapterConfig) {
    this.isOAuthClient = Boolean(config.oauthToken)
    this.client = new Anthropic({
      apiKey: this.isOAuthClient ? null : (config.apiKey ?? 'dummy'),
      authToken: config.oauthToken ?? null,
      baseURL: config.baseUrl,
      ...(this.isOAuthClient && {
        defaultHeaders: {
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'user-agent': 'claude-cli/0.0.0 (external, cli)',
          'x-app': 'cli',
        },
      }),
    })
    this.modelId = config.modelConfig.modelId
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.client.messages.create(this.buildRequest(req))

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
    const stream = await this.client.messages.create({
      ...this.buildRequest(req),
      stream: true,
    })

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
      const response = await this.client.messages.create({
        model: this.modelId,
        system: this.buildSystem(),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      })
      return response.content.length > 0
    } catch {
      return false
    }
  }

  private buildRequest(req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
    const thinking = this.buildThinkingConfig()

    return {
      model: req.model ?? this.modelId,
      cache_control: AnthropicAdapter.REQUEST_CACHE_CONTROL,
      system: this.buildSystem(req.system),
      messages: this.convertMessages(req),
      tools: req.tools ? this.convertTools(req.tools) : undefined,
      ...(thinking ? { thinking } : {}),
      max_tokens: req.maxTokens ?? 4096,
    }
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

    for (const msg of req.messages) {
      if (msg.role === 'user') {
        const parts: Anthropic.ContentBlockParam[] = []
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
            parts.push({
              type: 'tool_result',
              tool_use_id: this.sanitizeToolId(block.toolUseId),
              content: block.content,
              is_error: block.isError,
            })
          }
        }
        raw.push({ role: 'user', content: parts })
      } else if (msg.role === 'assistant') {
        const parts: Anthropic.ContentBlockParam[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use') {
            parts.push({
              type: 'tool_use',
              id: this.sanitizeToolId(block.id),
              name: block.name,
              input: block.input,
            })
          }
        }
        raw.push({ role: 'assistant', content: parts })
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

  private extractReasoningContent(content: Anthropic.ContentBlock[]): string | undefined {
    const thinkingParts = content
      .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
      .map((block) => block.thinking.trim())
      .filter((text) => text.length > 0)

    if (thinkingParts.length === 0) return undefined
    return thinkingParts.join('\n')
  }

  private buildThinkingConfig(): { type: 'adaptive' } | undefined {
    return {
      type: 'adaptive',
    }
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
}
