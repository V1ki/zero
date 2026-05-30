import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ImageBlock,
  StreamEvent,
  TokenUsage,
  ToolResultBlock,
} from '@zero-os/shared'
import OpenAI from 'openai'
import { getChatGptAuthorizationScheme, parseChatGptOAuthSession } from '../auth/chatgpt'
import type { ChatGptOAuthSession } from '../auth/chatgpt'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'
import { resolveImageBlock } from './image'

type ResponseUsageLike = Partial<OpenAI.Responses.ResponseUsage> & {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
    cached_tokens_details?: {
      cache_creation_input_tokens?: number
    }
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

interface ChatGptSseEvent {
  type?: string
  delta?: string
  text?: string
  call_id?: string
  arguments?: string
  item_id?: string
  summary_index?: number
  item?: Record<string, unknown>
  response?: Record<string, unknown>
}

const DEFAULT_CHATGPT_INSTRUCTIONS = 'You are a helpful assistant.'
const CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
const CHATGPT_MIN_VALIDITY_MS = 60_000
const CHATGPT_REAUTH_MESSAGE =
  'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.'

/** Split a composite tool call ID (`call_xxx|fc_yyy`) into its two parts. */
function splitToolCallId(id: string): { callId: string; itemId: string | undefined } {
  if (id.includes('|')) {
    const [callId, itemId] = id.split('|', 2)
    return { callId, itemId: itemId || undefined }
  }
  return { callId: id, itemId: undefined }
}

/** Join call_id and item id (fc_*) into a composite ID for internal use. */
function joinToolCallId(callId: string, itemId?: string): string {
  return itemId ? `${callId}|${itemId}` : callId
}

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
  private baseUrl: string
  private oauthToken?: string
  private oauthTokenProvider?: OAuthTokenProvider
  private oauthTokenRefresher?: OAuthTokenRefresher

  constructor(config: AdapterConfig) {
    this.isChatGptProvider =
      config.managedOAuthProvider === 'chatgpt' || config.providerName === 'chatgpt'
    this.baseUrl = config.baseUrl
    this.oauthToken = config.oauthToken
    this.oauthTokenProvider = config.oauthTokenProvider
    this.oauthTokenRefresher = config.oauthTokenRefresher
    this.client = this.isChatGptProvider
      ? null
      : new OpenAI({
          apiKey: config.apiKey ?? 'dummy',
          baseURL: config.baseUrl.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`,
        })
    this.modelId = config.modelConfig.modelId
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
    const input = this.buildInput(req)
    const tools = req.tools ? this.convertTools(req.tools) : undefined

    const response = await client.create({
      model: req.model ?? this.modelId,
      input,
      tools,
      reasoning: this.buildReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream: false,
    })

    return this.parseResponse(response)
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.isChatGptProvider) {
      yield* this.streamFromChatGpt(req)
      return
    }

    const client = this.getResponsesClient()
    const input = this.buildInput(req)
    const tools = req.tools ? this.convertTools(req.tools) : undefined

    const stream = await client.create({
      model: req.model ?? this.modelId,
      input,
      tools,
      reasoning: this.buildReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream: true,
    })

    const reasoningBuffers = new Map<string, string>()
    const toolCallBuffers = new Map<string, { name: string; arguments: string; itemId?: string }>()
    let hadToolUse = false

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text_delta', data: { text: event.delta } }
      } else if (event.type === 'response.output_item.added') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          const itemId = typeof item.id === 'string' ? item.id : undefined
          const name = typeof item.name === 'string' ? item.name : 'unknown_tool'
          const compositeId = joinToolCallId(callId, itemId)
          toolCallBuffers.set(callId, {
            name,
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
            itemId,
          })
          hadToolUse = true
          yield { type: 'tool_use_start', data: { id: compositeId, name } }
        }
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        const key = this.getReasoningSummaryKey(event)
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (!delta) continue
        if (key) {
          reasoningBuffers.set(key, `${reasoningBuffers.get(key) ?? ''}${delta}`)
        }
        yield { type: 'reasoning_delta', data: { text: delta } }
      } else if (event.type === 'response.reasoning_summary_text.done') {
        const key = this.getReasoningSummaryKey(event)
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text) continue
        if (key) {
          if ((reasoningBuffers.get(key) ?? '').length > 0) continue
          reasoningBuffers.set(key, text)
        }
        yield { type: 'reasoning_delta', data: { text } }
      } else if (event.type === 'response.function_call_arguments.delta') {
        const callId =
          typeof (event as ChatGptSseEvent).call_id === 'string'
            ? (event as ChatGptSseEvent).call_id
            : undefined
        const delta = typeof event.delta === 'string' ? event.delta : ''
        const toolCall = callId ? toolCallBuffers.get(callId) : undefined
        if (toolCall) {
          toolCall.arguments += delta
        }
        const compositeId = callId
          ? joinToolCallId(callId, toolCallBuffers.get(callId)?.itemId)
          : undefined
        yield {
          type: 'tool_use_delta',
          data: { ...(compositeId ? { id: compositeId } : {}), arguments: delta },
        }
      } else if (event.type === 'response.function_call_arguments.done') {
        const callId =
          typeof (event as ChatGptSseEvent).call_id === 'string'
            ? (event as ChatGptSseEvent).call_id
            : undefined
        const toolCall = callId ? toolCallBuffers.get(callId) : undefined
        if (toolCall && typeof event.arguments === 'string') {
          toolCall.arguments = event.arguments
        }
      } else if (event.type === 'response.output_item.done') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          const itemId = typeof item.id === 'string' ? item.id : toolCallBuffers.get(callId)?.itemId
          yield { type: 'tool_use_end', data: { id: joinToolCallId(callId, itemId) } }
        }
      } else if (event.type === 'response.completed') {
        const usage = event.response?.usage
        yield {
          type: 'done',
          data: {
            finishReason: hadToolUse ? 'tool_calls' : 'stop',
            model: event.response?.model,
            usage: usage ? this.parseUsage(usage) : undefined,
          },
        }
      }
    }
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
    const events = await this.fetchChatGptEvents(req)
    return this.parseChatGptCompletion(events)
  }

  private async *streamFromChatGpt(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.requestChatGptResponse(req)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`ChatGPT request failed: ${response.status} ${error}`)
    }

    const toolCallBuffers = new Map<string, { name: string; arguments: string; itemId?: string }>()
    const reasoningBuffers = new Map<string, string>()

    for await (const event of this.iterSseEvents(response)) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text_delta', data: { text: event.delta ?? '' } }
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        const key = this.getReasoningSummaryKey(event)
        const delta = event.delta ?? ''
        if (!delta) continue
        if (key) {
          reasoningBuffers.set(key, `${reasoningBuffers.get(key) ?? ''}${delta}`)
        }
        yield { type: 'reasoning_delta', data: { text: delta } }
      } else if (event.type === 'response.reasoning_summary_text.done') {
        const key = this.getReasoningSummaryKey(event)
        const text = event.text ?? ''
        if (!text) continue
        if (key) {
          if ((reasoningBuffers.get(key) ?? '').length > 0) continue
          reasoningBuffers.set(key, text)
        }
        yield { type: 'reasoning_delta', data: { text } }
      } else if (event.type === 'response.output_item.added') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          const itemId = typeof item.id === 'string' ? item.id : undefined
          const name = typeof item.name === 'string' ? item.name : 'unknown_tool'
          const compositeId = joinToolCallId(callId, itemId)
          toolCallBuffers.set(callId, {
            name,
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
            itemId,
          })
          yield { type: 'tool_use_start', data: { id: compositeId, name } }
        }
      } else if (event.type === 'response.function_call_arguments.delta') {
        const callId = typeof event.call_id === 'string' ? event.call_id : undefined
        const delta = event.delta ?? ''
        const toolCall = callId ? toolCallBuffers.get(callId) : undefined
        if (toolCall) {
          toolCall.arguments += delta
        }
        const compositeId = callId
          ? joinToolCallId(callId, toolCallBuffers.get(callId)?.itemId)
          : undefined
        yield {
          type: 'tool_use_delta',
          data: { ...(compositeId ? { id: compositeId } : {}), arguments: delta },
        }
      } else if (event.type === 'response.function_call_arguments.done') {
        const callId = typeof event.call_id === 'string' ? event.call_id : undefined
        const toolCall = callId ? toolCallBuffers.get(callId) : undefined
        if (toolCall && typeof event.arguments === 'string') {
          toolCall.arguments = event.arguments
        }
      } else if (event.type === 'response.output_item.done') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          const itemId = typeof item.id === 'string' ? item.id : toolCallBuffers.get(callId)?.itemId
          yield { type: 'tool_use_end', data: { id: joinToolCallId(callId, itemId) } }
        }
      } else if (event.type === 'response.completed') {
        const usage = event.response?.usage
        yield {
          type: 'done',
          data: {
            finishReason: event.response?.status === 'completed' ? 'stop' : 'tool_calls',
            model: event.response?.model,
            usage: usage ? this.parseUsage(usage) : undefined,
          },
        }
      }
    }
  }

  private buildInput(req: CompletionRequest): OpenAI.Responses.ResponseInputItem[] {
    const input: OpenAI.Responses.ResponseInputItem[] = []
    const pairedCallIds = this.collectPairedToolCallIds(req)

    if (req.system) {
      input.push({
        role: 'system',
        content: req.system,
      })
    }

    for (const msg of req.messages) {
      if (msg.role === 'user') {
        const textParts = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
        const imageParts = msg.content.filter(isImageBlock)

        const toolResults = msg.content.filter(isToolResultBlock)
        if (toolResults.length > 0) {
          for (const result of toolResults) {
            if (!pairedCallIds.has(result.toolUseId)) continue
            const { callId: outputCallId } = splitToolCallId(result.toolUseId)
            input.push({
              type: 'function_call_output',
              call_id: outputCallId,
              output: this.normalizeToolOutput(result.content, result.outputSummary),
            })
          }
        }

        const toolImageParts = toolResults
          .filter((result) => pairedCallIds.has(result.toolUseId))
          .flatMap(toolResultImages)
        const allImageParts = [...imageParts, ...toolImageParts]
        const resolvedImages = allImageParts.flatMap((image) => {
          const resolved = resolveImageBlock(image)
          return resolved ? [resolved] : []
        })

        if (textParts || resolvedImages.length > 0) {
          if (resolvedImages.length > 0) {
            const parts: OpenAI.Responses.ResponseInputContent[] = []
            if (textParts) parts.push({ type: 'input_text', text: textParts })
            for (const img of resolvedImages) {
              const { mediaType, data } = img
              parts.push({
                type: 'input_image',
                detail: 'auto',
                image_url: `data:${mediaType};base64,${data}`,
              })
            }
            input.push({ role: 'user', content: parts })
          } else {
            input.push({ role: 'user', content: textParts })
          }
        }
      } else if (msg.role === 'assistant') {
        const textParts = msg.content.filter((b) => b.type === 'text')
        const toolUses = msg.content.filter((b) => b.type === 'tool_use')

        if (textParts.length > 0) {
          input.push({
            role: 'assistant',
            content: textParts.map((b) => (b as { text: string }).text).join('\n'),
          })
        }

        for (const tu of toolUses) {
          const block = tu as { id: string; name: string; input: Record<string, unknown> }
          if (!pairedCallIds.has(block.id)) continue
          const { callId, itemId } = splitToolCallId(block.id)
          input.push({
            type: 'function_call',
            id: itemId ?? `fc_${callId}`,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.input),
          })
        }
      }
    }

    return input
  }

  private buildChatGptBody(req: CompletionRequest) {
    const tools = req.tools ? this.convertTools(req.tools) : undefined

    return {
      model: this.stripChatGptModel(req.model ?? this.modelId),
      store: false,
      stream: true,
      instructions: req.system?.trim() || DEFAULT_CHATGPT_INSTRUCTIONS,
      input: this.buildInput({ ...req, system: undefined }),
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: this.buildReasoningConfig(req),
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: this.computePromptCacheKey(req),
      service_tier: 'priority',
    }
  }

  private stripChatGptModel(model: string): string {
    return model.startsWith('chatgpt/') ? model.slice('chatgpt/'.length) : model
  }

  private async fetchChatGptEvents(req: CompletionRequest): Promise<ChatGptSseEvent[]> {
    const response = await this.requestChatGptResponse(req)

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

  private async requestChatGptResponse(req: CompletionRequest): Promise<Response> {
    const session = await this.getChatGptSession()
    let response = await this.sendChatGptRequest(req, session)

    if (response.status !== 401 || !this.oauthTokenRefresher) {
      return response
    }

    await this.oauthTokenRefresher('unauthorized')
    response = await this.sendChatGptRequest(req, this.getRequiredChatGptSession())
    return response
  }

  private async sendChatGptRequest(
    req: CompletionRequest,
    session: ChatGptOAuthSession,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `${getChatGptAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'zero-os',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildChatGptBody(req)),
    })
  }

  private async *iterSseEvents(response: Response): AsyncIterable<ChatGptSseEvent> {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim()

        if (!data || data === '[DONE]') continue

        try {
          yield JSON.parse(data) as ChatGptSseEvent
        } catch {}
      }
    }
  }

  private parseChatGptCompletion(events: ChatGptSseEvent[]): CompletionResponse {
    const textParts: string[] = []
    const toolCalls = new Map<string, { name: string; arguments: string; itemId?: string }>()
    const reasoningBuffers = new Map<string, string>()
    let responseId: string = crypto.randomUUID()
    let responseModel = this.modelId
    let usage: TokenUsage = { input: 0, output: 0 }
    let hasToolUse = false

    for (const event of events) {
      if (event.type === 'response.output_text.delta') {
        textParts.push(event.delta ?? '')
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        const key = this.getReasoningSummaryKey(event)
        const delta = event.delta ?? ''
        if (!delta) continue
        if (key) {
          reasoningBuffers.set(key, `${reasoningBuffers.get(key) ?? ''}${delta}`)
        }
      } else if (event.type === 'response.reasoning_summary_text.done') {
        const key = this.getReasoningSummaryKey(event)
        const text = event.text ?? ''
        if (!text) continue
        if (key) {
          if ((reasoningBuffers.get(key) ?? '').length === 0) {
            reasoningBuffers.set(key, text)
          }
        } else {
          reasoningBuffers.set(`${reasoningBuffers.size}`, text)
        }
      } else if (event.type === 'response.output_item.added') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          toolCalls.set(callId, {
            name: typeof item.name === 'string' ? item.name : 'unknown_tool',
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
            itemId: typeof item.id === 'string' ? item.id : undefined,
          })
        }
      } else if (event.type === 'response.function_call_arguments.delta') {
        const callId = typeof event.call_id === 'string' ? event.call_id : undefined
        if (callId) {
          const existing = toolCalls.get(callId)
          if (existing) {
            existing.arguments += event.delta ?? ''
          } else {
            toolCalls.set(callId, {
              name: 'unknown_tool',
              arguments: event.delta ?? '',
            })
          }
        }
      } else if (event.type === 'response.function_call_arguments.done') {
        const callId = typeof event.call_id === 'string' ? event.call_id : undefined
        if (callId && typeof event.arguments === 'string') {
          const existing = toolCalls.get(callId)
          if (existing) {
            existing.arguments = event.arguments
          } else {
            toolCalls.set(callId, {
              name: 'unknown_tool',
              arguments: event.arguments,
            })
          }
        }
      } else if (event.type === 'response.output_item.done') {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : undefined
          if (!callId) continue
          const existing = toolCalls.get(callId)
          toolCalls.set(callId, {
            name: typeof item.name === 'string' ? item.name : (existing?.name ?? 'unknown_tool'),
            arguments:
              typeof item.arguments === 'string' ? item.arguments : (existing?.arguments ?? ''),
            itemId: typeof item.id === 'string' ? item.id : existing?.itemId,
          })
        } else if (item.type === 'reasoning') {
          const summaryTexts = this.extractReasoningSummaryTexts(item.summary)
          const itemId = typeof item.id === 'string' ? item.id : undefined
          const alreadyTracked = itemId
            ? Array.from(reasoningBuffers.keys()).some(
                (key) => key === itemId || key.startsWith(`${itemId}:`),
              )
            : false
          if (summaryTexts.length > 0 && !alreadyTracked) {
            reasoningBuffers.set(itemId ?? `${reasoningBuffers.size}`, summaryTexts.join('\n'))
          }
        }
      } else if (event.type === 'response.completed') {
        responseId = typeof event.response?.id === 'string' ? event.response.id : responseId
        responseModel =
          typeof event.response?.model === 'string' ? event.response.model : responseModel
        usage = this.parseUsage(event.response?.usage as ResponseUsageLike | undefined)
      }
    }

    const content: ContentBlock[] = []
    if (textParts.join('')) {
      content.push({ type: 'text', text: textParts.join('') })
    }

    for (const [callId, toolCall] of toolCalls) {
      hasToolUse = true
      content.push({
        type: 'tool_use',
        id: joinToolCallId(callId, toolCall.itemId),
        name: toolCall.name,
        input: this.safeJsonParse(toolCall.arguments),
      })
    }

    return {
      id: responseId,
      content,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      usage,
      model: responseModel,
      reasoningContent: this.joinReasoningBuffers(reasoningBuffers),
    }
  }

  private async getChatGptSession(): Promise<ChatGptOAuthSession> {
    let session = this.readChatGptSession()
    if (!session) {
      throw new Error(
        'ChatGPT OAuth credentials not found. Please run `bun zero provider login chatgpt`.',
      )
    }

    if (
      this.isChatGptSessionExpiring(session, CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS) &&
      this.oauthTokenRefresher
    ) {
      await this.oauthTokenRefresher('expiring')
      session = this.getRequiredChatGptSession()
    }

    if (this.isChatGptSessionExpiring(session, CHATGPT_MIN_VALIDITY_MS)) {
      throw new Error(CHATGPT_REAUTH_MESSAGE)
    }

    return session
  }

  private getRequiredChatGptSession(): ChatGptOAuthSession {
    const session = this.readChatGptSession()
    if (!session) {
      throw new Error(
        'ChatGPT OAuth credentials not found. Please run `bun zero provider login chatgpt`.',
      )
    }
    if (this.isChatGptSessionExpiring(session, CHATGPT_MIN_VALIDITY_MS)) {
      throw new Error(CHATGPT_REAUTH_MESSAGE)
    }
    return session
  }

  private readChatGptSession(): ChatGptOAuthSession | null {
    return parseChatGptOAuthSession(this.oauthTokenProvider?.() ?? this.oauthToken)
  }

  private isChatGptSessionExpiring(session: ChatGptOAuthSession, minValidityMs: number): boolean {
    return Date.now() >= session.expiresAt - minValidityMs
  }

  private safeJsonParse(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value || '{}') as Record<string, unknown>
    } catch {
      return { raw: value }
    }
  }

  private computePromptCacheKey(req: CompletionRequest): string {
    return Bun.hash(
      JSON.stringify({
        system: req.system,
        model: req.model ?? this.modelId,
        messages: req.messages,
        tools: req.tools,
      }),
    ).toString()
  }

  private collectPairedToolCallIds(req: CompletionRequest): Set<string> {
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
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

  private normalizeToolOutput(output: string, outputSummary?: string): string {
    if (output.trim().length > 0) return output
    if (outputSummary && outputSummary.trim().length > 0) return outputSummary
    return '[tool completed with empty output]'
  }

  private convertTools(tools: CompletionRequest['tools']): OpenAI.Responses.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: null,
    }))
  }

  private buildReasoningConfig(
    req: CompletionRequest,
  ): OpenAI.Responses.ResponseCreateParams['reasoning'] {
    return req.reasoningEffort
      ? {
          summary: 'auto',
          effort: req.reasoningEffort as NonNullable<
            NonNullable<OpenAI.Responses.ResponseCreateParams['reasoning']>['effort']
          >,
        }
      : { summary: 'auto' }
  }

  private getReasoningSummaryKey(event: {
    item_id?: string
    summary_index?: number
  }): string | undefined {
    if (typeof event.item_id !== 'string') return undefined
    const summaryIndex = typeof event.summary_index === 'number' ? event.summary_index : 0
    return `${event.item_id}:${summaryIndex}`
  }

  private extractReasoningSummaryTexts(summary: unknown): string[] {
    if (!Array.isArray(summary)) return []
    return summary
      .map((part) => {
        if (!part || typeof part !== 'object') return null
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' && text.trim().length > 0 ? text : null
      })
      .filter((text): text is string => text !== null)
  }

  private joinReasoningBuffers(reasoningBuffers: Map<string, string>): string | undefined {
    const parts = Array.from(reasoningBuffers.values())
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
    if (parts.length === 0) return undefined
    return parts.join('\n')
  }

  private parseResponse(response: OpenAI.Responses.Response): CompletionResponse {
    const content: ContentBlock[] = []
    const reasoningBuffers = new Map<string, string>()
    let hasToolUse = false

    const output = response.output ?? []
    for (const item of output) {
      if (item.type === 'message') {
        const msgContent = item.content ?? []
        for (const part of msgContent) {
          if (part.type === 'output_text') {
            content.push({ type: 'text', text: part.text })
          }
        }
      } else if (item.type === 'function_call') {
        hasToolUse = true
        const fcCallId = item.call_id ?? item.id
        const fcItemId = typeof item.id === 'string' ? item.id : undefined
        content.push({
          type: 'tool_use',
          id: joinToolCallId(fcCallId, fcItemId),
          name: item.name,
          input: JSON.parse(item.arguments || '{}'),
        })
      } else if (item.type === 'reasoning') {
        const summaryTexts = this.extractReasoningSummaryTexts(item.summary)
        if (summaryTexts.length > 0) {
          reasoningBuffers.set(
            typeof item.id === 'string' ? item.id : `${reasoningBuffers.size}`,
            summaryTexts.join('\n'),
          )
        }
      }
    }

    if (content.length === 0 && response.output_text) {
      content.push({ type: 'text', text: response.output_text })
    }

    const stopReason = hasToolUse
      ? 'tool_use'
      : response.status === 'completed'
        ? 'end_turn'
        : 'end_turn'

    return {
      id: response.id,
      content,
      stopReason,
      usage: this.parseUsage(response.usage),
      model: response.model ?? this.modelId,
      reasoningContent: this.joinReasoningBuffers(reasoningBuffers),
    }
  }

  private parseUsage(usage?: ResponseUsageLike | null): TokenUsage {
    const cacheWrite =
      usage?.input_tokens_details?.cached_tokens_details?.cache_creation_input_tokens
    const cacheRead = usage?.input_tokens_details?.cached_tokens
    const totalInput = usage?.input_tokens ?? 0

    return {
      // OpenAI reports cached token details as a subset of input_tokens.
      // Normalize to the same bucket semantics used elsewhere:
      // input = non-cached tail, cacheWrite = newly cached prefix, cacheRead = reused prefix.
      input: Math.max(totalInput - (cacheWrite ?? 0) - (cacheRead ?? 0), 0),
      output: usage?.output_tokens ?? 0,
      cacheWrite,
      cacheRead,
      reasoning: usage?.output_tokens_details?.reasoning_tokens,
    }
  }
}
