import type { StreamEvent, TokenUsage } from '@zero-os/shared'
import type OpenAI from 'openai'
import type { ChatGptSseEvent } from './openai-resp-chatgpt-events'
import { joinToolCallId } from './openai-resp-input'
import { type ResponseUsageLike, getResponsesReasoningSummaryKey } from './openai-resp-parse'

type OpenAIResponsesStreamEvent = OpenAI.Responses.ResponseStreamEvent | ChatGptSseEvent
type DoneReasonMode = 'tool_state' | 'response_status' | 'tool_or_response_status'

interface OpenAIResponsesStreamMapperOptions {
  doneReasonMode: DoneReasonMode
  parseUsage(usage?: ResponseUsageLike | null): TokenUsage
}

interface ResponsesSseIteratorOptions {
  requireCompleted?: boolean
  signal?: AbortSignal
}

interface ResponsesStreamErrorOptions {
  retryable: boolean
  status?: number
  requestId?: string
  errorType?: string
}

export class ResponsesStreamError extends Error {
  readonly retryable: boolean
  readonly status?: number
  readonly request_id?: string
  readonly error_type?: string

  constructor(message: string, options: ResponsesStreamErrorOptions) {
    super(message)
    this.name = 'ResponsesStreamError'
    this.retryable = options.retryable
    this.status = options.status
    this.request_id = options.requestId
    this.error_type = options.errorType
  }
}

export async function* iterResponsesSseEvents(
  response: Response,
  options: ResponsesSseIteratorOptions = {},
): AsyncIterable<ChatGptSseEvent> {
  const reader = response.body?.getReader()
  if (!reader) {
    if (options.requireCompleted) {
      throw buildPrematureStreamEndError('body was empty')
    }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let sawCompleted = false
  const cancelReader = () => {
    void reader.cancel(options.signal?.reason).catch(() => {})
  }

  if (options.signal?.aborted) {
    cancelReader()
  } else {
    options.signal?.addEventListener('abort', cancelReader, { once: true })
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const event = parseResponsesSseEvent(rawEvent)
        if (!event) continue
        if (options.requireCompleted) {
          const terminalError = buildTerminalStreamError(event)
          if (terminalError) throw terminalError
        }

        yield event
        if (event.type === 'response.completed') {
          sawCompleted = true
          return
        }
      }
    }

    buffer += decoder.decode()
    const tailEvent = parseResponsesSseEvent(buffer)
    if (tailEvent) {
      if (options.requireCompleted) {
        const terminalError = buildTerminalStreamError(tailEvent)
        if (terminalError) throw terminalError
      }

      yield tailEvent
      if (tailEvent.type === 'response.completed') {
        sawCompleted = true
        return
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }

  if (options.requireCompleted && !sawCompleted) {
    throw buildPrematureStreamEndError('stream closed before response.completed')
  }
}

function parseResponsesSseEvent(rawEvent: string): ChatGptSseEvent | undefined {
  const data = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim()

  if (!data || data === '[DONE]') return undefined

  try {
    return JSON.parse(data) as ChatGptSseEvent
  } catch {
    return undefined
  }
}

function buildTerminalStreamError(event: ChatGptSseEvent): ResponsesStreamError | undefined {
  if (event.type === 'response.incomplete') {
    const details = getRecordValue(event.response ?? {}, 'incomplete_details')
    const reason = details ? getRecordString(details, 'reason') : undefined
    return new ResponsesStreamError(`ChatGPT response incomplete: ${reason ?? 'unknown reason'}`, {
      retryable: true,
      errorType: 'response_incomplete',
    })
  }

  if (event.type !== 'response.failed') return undefined

  const response = event.response ?? {}
  const error = getRecordValue(response, 'error') ?? {}
  const code = getRecordString(error, 'code') ?? getRecordString(error, 'type')
  const message = getRecordString(error, 'message') ?? code ?? 'unknown error'
  const status = getRecordNumber(error, 'status') ?? getRecordNumber(response, 'status_code')
  const requestId = getRecordString(response, 'id')

  return new ResponsesStreamError(`ChatGPT response failed: ${message}`, {
    retryable: !isNonRetryableResponseFailure(code),
    status,
    requestId,
    errorType: code ?? 'response_failed',
  })
}

function buildPrematureStreamEndError(reason: string): ResponsesStreamError {
  return new ResponsesStreamError(`ChatGPT response ${reason}`, {
    retryable: true,
    errorType: 'response_stream_ended',
  })
}

function isNonRetryableResponseFailure(code?: string): boolean {
  return (
    code !== undefined &&
    [
      'bio_policy',
      'content_policy_violation',
      'context_length_exceeded',
      'insufficient_quota',
      'invalid_prompt',
      'invalid_request_error',
      'usage_not_included',
    ].includes(code)
  )
}

export async function* mapOpenAIResponsesStreamEvents(
  events: AsyncIterable<OpenAIResponsesStreamEvent>,
  options: OpenAIResponsesStreamMapperOptions,
): AsyncIterable<StreamEvent> {
  const reasoningBuffers = new Map<string, string>()
  const toolCallBuffers = new Map<string, { name: string; arguments: string; itemId?: string }>()
  let hadToolUse = false

  for await (const event of events) {
    if (event.type === 'response.output_text.delta') {
      yield { type: 'text_delta', data: { text: getEventString(event, 'delta') } }
    } else if (event.type === 'response.output_item.added') {
      const item = getEventItem(event)
      if (item.type === 'function_call') {
        const callId = getRecordString(item, 'call_id')
        if (!callId) continue
        const itemId = getRecordString(item, 'id')
        const name = getRecordString(item, 'name') ?? 'unknown_tool'
        const compositeId = joinToolCallId(callId, itemId)
        toolCallBuffers.set(callId, {
          name,
          arguments: getRecordString(item, 'arguments') ?? '',
          itemId,
        })
        hadToolUse = true
        yield { type: 'tool_use_start', data: { id: compositeId, name } }
      }
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      const key = getResponsesReasoningSummaryKey(event)
      const delta = getEventString(event, 'delta')
      if (!delta) continue
      if (key) {
        reasoningBuffers.set(key, `${reasoningBuffers.get(key) ?? ''}${delta}`)
      }
      yield { type: 'reasoning_delta', data: { text: delta } }
    } else if (event.type === 'response.reasoning_summary_text.done') {
      const key = getResponsesReasoningSummaryKey(event)
      const text = getEventString(event, 'text')
      if (!text) continue
      if (key) {
        if ((reasoningBuffers.get(key) ?? '').length > 0) continue
        reasoningBuffers.set(key, text)
      }
      yield { type: 'reasoning_delta', data: { text } }
    } else if (event.type === 'response.function_call_arguments.delta') {
      const callId = getEventString(event, 'call_id')
      const delta = getEventString(event, 'delta')
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
      const callId = getEventString(event, 'call_id')
      const toolCall = callId ? toolCallBuffers.get(callId) : undefined
      const args = getEventString(event, 'arguments')
      if (toolCall && args) {
        toolCall.arguments = args
      }
    } else if (event.type === 'response.output_item.done') {
      const item = getEventItem(event)
      if (item.type === 'function_call') {
        const callId = getRecordString(item, 'call_id')
        if (!callId) continue
        const itemId = getRecordString(item, 'id') ?? toolCallBuffers.get(callId)?.itemId
        yield { type: 'tool_use_end', data: { id: joinToolCallId(callId, itemId) } }
      }
    } else if (event.type === 'response.completed') {
      const response = getEventResponse(event)
      const usage = getRecordValue<ResponseUsageLike>(response, 'usage')
      yield {
        type: 'done',
        data: {
          finishReason: resolveDoneFinishReason(options.doneReasonMode, response, hadToolUse),
          model: getRecordString(response, 'model'),
          usage: usage ? options.parseUsage(usage) : undefined,
        },
      }
    }
  }
}

function resolveDoneFinishReason(
  mode: DoneReasonMode,
  response: Record<string, unknown>,
  hadToolUse: boolean,
): 'stop' | 'tool_calls' {
  if (mode === 'response_status') {
    return response.status === 'completed' ? 'stop' : 'tool_calls'
  }
  if (mode === 'tool_or_response_status') {
    return hadToolUse || response.status !== 'completed' ? 'tool_calls' : 'stop'
  }
  return hadToolUse ? 'tool_calls' : 'stop'
}

function getEventItem(event: OpenAIResponsesStreamEvent): Record<string, unknown> {
  return getRecordValue(event as Record<string, unknown>, 'item') ?? {}
}

function getEventResponse(event: OpenAIResponsesStreamEvent): Record<string, unknown> {
  return getRecordValue(event as Record<string, unknown>, 'response') ?? {}
}

function getEventString(event: OpenAIResponsesStreamEvent, key: string): string {
  return getRecordString(event as Record<string, unknown>, key) ?? ''
}

function getRecordValue<T extends Record<string, unknown>>(
  record: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = record[key]
  return value && typeof value === 'object' ? (value as T) : undefined
}

function getRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}
