import type { CompletionResponse, ContentBlock, TokenUsage } from '@zero-os/shared'
import { joinToolCallId } from './openai-resp-input'
import {
  type ResponseUsageLike,
  extractReasoningSummaryTexts,
  getResponsesReasoningSummaryKey,
  joinReasoningBuffers,
  parseOpenAIResponseUsage,
  parseToolArguments,
} from './openai-resp-parse'

export interface ChatGptSseEvent {
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

export function parseChatGptCompletionEvents(
  events: ChatGptSseEvent[],
  fallbackModel: string,
): CompletionResponse {
  const textParts: string[] = []
  const toolCalls = new Map<string, { name: string; arguments: string; itemId?: string }>()
  const reasoningBuffers = new Map<string, string>()
  let responseId: string = crypto.randomUUID()
  let responseModel = fallbackModel
  let usage: TokenUsage = { input: 0, output: 0 }
  let hasToolUse = false

  for (const event of events) {
    if (event.type === 'response.output_text.delta') {
      textParts.push(event.delta ?? '')
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      const key = getResponsesReasoningSummaryKey(event)
      const delta = event.delta ?? ''
      if (!delta) continue
      if (key) {
        reasoningBuffers.set(key, `${reasoningBuffers.get(key) ?? ''}${delta}`)
      }
    } else if (event.type === 'response.reasoning_summary_text.done') {
      const key = getResponsesReasoningSummaryKey(event)
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
        const summaryTexts = extractReasoningSummaryTexts(item.summary)
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
      usage = parseOpenAIResponseUsage(event.response?.usage as ResponseUsageLike | undefined)
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
      input: parseToolArguments(toolCall.arguments),
    })
  }

  return {
    id: responseId,
    content,
    stopReason: hasToolUse ? 'tool_use' : 'end_turn',
    usage,
    model: responseModel,
    reasoningContent: joinReasoningBuffers(reasoningBuffers),
  }
}
