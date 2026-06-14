import type { CompletionResponse, ContentBlock, TokenUsage } from '@zero-os/shared'
import type OpenAI from 'openai'
import { joinToolCallId } from './openai-resp-input'

export type ResponseUsageLike = Partial<OpenAI.Responses.ResponseUsage> & {
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

export function parseToolArguments(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>
  } catch {
    return { raw: value }
  }
}

export function parseOpenAIResponse(
  response: OpenAI.Responses.Response,
  fallbackModel: string,
): CompletionResponse {
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
        input: parseToolArguments(item.arguments || '{}'),
      })
    } else if (item.type === 'reasoning') {
      const summaryTexts = extractReasoningSummaryTexts(item.summary)
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
    usage: parseOpenAIResponseUsage(response.usage),
    model: response.model ?? fallbackModel,
    reasoningContent: joinReasoningBuffers(reasoningBuffers),
  }
}

export function parseOpenAIResponseUsage(usage?: ResponseUsageLike | null): TokenUsage {
  const cacheWrite = usage?.input_tokens_details?.cached_tokens_details?.cache_creation_input_tokens
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

export function getResponsesReasoningSummaryKey(event: {
  item_id?: string
  summary_index?: number
}): string | undefined {
  if (typeof event.item_id !== 'string') return undefined
  const summaryIndex = typeof event.summary_index === 'number' ? event.summary_index : 0
  return `${event.item_id}:${summaryIndex}`
}

export function extractReasoningSummaryTexts(summary: unknown): string[] {
  if (!Array.isArray(summary)) return []
  return summary
    .map((part) => {
      if (!part || typeof part !== 'object') return null
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' && text.trim().length > 0 ? text : null
    })
    .filter((text): text is string => text !== null)
}

export function joinReasoningBuffers(reasoningBuffers: Map<string, string>): string | undefined {
  const parts = Array.from(reasoningBuffers.values())
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
  if (parts.length === 0) return undefined
  return parts.join('\n')
}
