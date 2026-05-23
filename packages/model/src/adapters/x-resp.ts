import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ImageBlock,
  StreamEvent,
  TokenUsage,
  ToolResultBlock,
} from '@zero-os/shared'
import type OpenAI from 'openai'
import { getXPremiumAuthorizationScheme, parseXPremiumOAuthSession } from '../auth/x-premium'
import type { XPremiumOAuthSession } from '../auth/x-premium'
import type {
  AdapterConfig,
  OAuthTokenProvider,
  OAuthTokenRefresher,
  ProviderAdapter,
} from './base'

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

interface XResponseSseEvent {
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

const X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS = 2 * 60_000
const X_PREMIUM_MIN_VALIDITY_MS = 60_000
const X_PREMIUM_REAUTH_MESSAGE =
  'X Premium OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login x-premium`.'

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

function splitToolCallId(id: string): { callId: string; itemId: string | undefined } {
  if (id.includes('|')) {
    const [callId, itemId] = id.split('|', 2)
    return { callId, itemId: itemId || undefined }
  }
  return { callId: id, itemId: undefined }
}

function joinToolCallId(callId: string, itemId?: string): string {
  return itemId ? `${callId}|${itemId}` : callId
}

export class XResponsesAdapter implements ProviderAdapter {
  readonly apiType = 'x_responses'
  private baseUrl: string
  private modelId: string
  private oauthToken?: string
  private oauthTokenProvider?: OAuthTokenProvider
  private oauthTokenRefresher?: OAuthTokenRefresher

  constructor(config: AdapterConfig) {
    this.baseUrl = config.baseUrl
    this.modelId = config.modelConfig.modelId
    this.oauthToken = config.oauthToken
    this.oauthTokenProvider = config.oauthTokenProvider
    this.oauthTokenRefresher = config.oauthTokenRefresher
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.requestResponse(req, false)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`X Premium request failed: ${response.status} ${error}`)
    }

    return this.parseResponse((await response.json()) as OpenAI.Responses.Response)
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.requestResponse(req, true)

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`X Premium request failed: ${response.status} ${error}`)
    }

    const toolCallBuffers = new Map<string, { name: string; arguments: string; itemId?: string }>()
    const reasoningBuffers = new Map<string, string>()
    let hadToolUse = false

    for await (const event of this.iterSseEvents(response)) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text_delta', data: { text: event.delta ?? '' } }
      } else if (event.type === 'response.output_item.added') {
        const item = event.item ?? {}
        if (item.type !== 'function_call') continue
        const callId = typeof item.call_id === 'string' ? item.call_id : undefined
        if (!callId) continue
        const itemId = typeof item.id === 'string' ? item.id : undefined
        const name = typeof item.name === 'string' ? item.name : 'unknown_tool'
        toolCallBuffers.set(callId, {
          name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
          itemId,
        })
        hadToolUse = true
        yield { type: 'tool_use_start', data: { id: joinToolCallId(callId, itemId), name } }
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
        if (item.type !== 'function_call') continue
        const callId = typeof item.call_id === 'string' ? item.call_id : undefined
        if (!callId) continue
        const itemId = typeof item.id === 'string' ? item.id : toolCallBuffers.get(callId)?.itemId
        yield { type: 'tool_use_end', data: { id: joinToolCallId(callId, itemId) } }
      } else if (event.type === 'response.completed') {
        const completed = event.response as
          | { model?: string; status?: string; usage?: ResponseUsageLike }
          | undefined
        yield {
          type: 'done',
          data: {
            finishReason: hadToolUse || completed?.status !== 'completed' ? 'tool_calls' : 'stop',
            model: completed?.model,
            usage: completed?.usage ? this.parseUsage(completed.usage) : undefined,
          },
        }
      }
    }
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

  private async requestResponse(req: CompletionRequest, stream: boolean): Promise<Response> {
    const session = await this.getSession()
    let response = await this.sendRequest(req, session, stream)

    if (response.status !== 401 || !this.oauthTokenRefresher) {
      return response
    }

    await this.oauthTokenRefresher('unauthorized')
    response = await this.sendRequest(req, this.getRequiredSession(), stream)
    return response
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
    const base = this.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`
  }

  private buildBody(req: CompletionRequest, stream: boolean) {
    const tools = req.tools ? this.convertTools(req.tools) : undefined

    return {
      model: this.stripModel(req.model ?? this.modelId),
      input: this.buildInput(req),
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: this.buildReasoningConfig(req),
      max_output_tokens: req.maxTokens,
      stream,
      store: false,
    }
  }

  private stripModel(model: string): string {
    return model.startsWith('x-premium/') ? model.slice('x-premium/'.length) : model
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

        for (const result of toolResults) {
          if (!pairedCallIds.has(result.toolUseId)) continue
          const { callId: outputCallId } = splitToolCallId(result.toolUseId)
          input.push({
            type: 'function_call_output',
            call_id: outputCallId,
            output: this.normalizeToolOutput(result.content, result.outputSummary),
          })
        }

        const toolImageParts = toolResults
          .filter((result) => pairedCallIds.has(result.toolUseId))
          .flatMap(toolResultImages)
        const allImageParts = [...imageParts, ...toolImageParts]

        if (textParts || allImageParts.length > 0) {
          if (allImageParts.length > 0) {
            const parts: OpenAI.Responses.ResponseInputContent[] = []
            if (textParts) parts.push({ type: 'input_text', text: textParts })
            for (const img of allImageParts) {
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

  private async *iterSseEvents(response: Response): AsyncIterable<XResponseSseEvent> {
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
          yield JSON.parse(data) as XResponseSseEvent
        } catch {}
      }
    }
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
          input: this.safeJsonParse(item.arguments || '{}'),
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

    return {
      id: response.id,
      content,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
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
      input: Math.max(totalInput - (cacheWrite ?? 0) - (cacheRead ?? 0), 0),
      output: usage?.output_tokens ?? 0,
      cacheWrite,
      cacheRead,
      reasoning: usage?.output_tokens_details?.reasoning_tokens,
    }
  }

  private async getSession(): Promise<XPremiumOAuthSession> {
    let session = this.readSession()
    if (!session) {
      throw new Error(
        'X Premium OAuth credentials not found. Please run `bun zero provider login x-premium`.',
      )
    }

    if (
      this.isSessionExpiring(session, X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS) &&
      this.oauthTokenRefresher
    ) {
      await this.oauthTokenRefresher('expiring')
      session = this.getRequiredSession()
    }

    if (this.isSessionExpiring(session, X_PREMIUM_MIN_VALIDITY_MS)) {
      throw new Error(X_PREMIUM_REAUTH_MESSAGE)
    }

    return session
  }

  private getRequiredSession(): XPremiumOAuthSession {
    const session = this.readSession()
    if (!session) {
      throw new Error(
        'X Premium OAuth credentials not found. Please run `bun zero provider login x-premium`.',
      )
    }
    if (this.isSessionExpiring(session, X_PREMIUM_MIN_VALIDITY_MS)) {
      throw new Error(X_PREMIUM_REAUTH_MESSAGE)
    }
    return session
  }

  private readSession(): XPremiumOAuthSession | null {
    return parseXPremiumOAuthSession(this.oauthTokenProvider?.() ?? this.oauthToken)
  }

  private isSessionExpiring(session: XPremiumOAuthSession, minValidityMs: number): boolean {
    return Date.now() >= session.expiresAt - minValidityMs
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

  private safeJsonParse(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value || '{}') as Record<string, unknown>
    } catch {
      return { raw: value }
    }
  }
}
