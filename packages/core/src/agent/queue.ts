import type { ContentBlock, ControlKind, Message, MessageChannelSource } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'

export interface QueuedMessage {
  content: string
  images?: Array<{ mediaType: string; data: string }>
  timestamp: string
  source?: MessageChannelSource
  onApplied?: () => void
}

export interface QueuedInjectionTraceMessage {
  timestamp: string
  content: string
  imageCount: number
  mediaTypes: string[]
}

export interface QueuedInjectionTrace {
  count: number
  formattedText: string
  messages: QueuedInjectionTraceMessage[]
}

export interface QueuedMessageInjectionResult {
  message: Message
  trace?: QueuedInjectionTrace
}

export function buildLoopUserMessage(options: {
  sessionId: string
  text: string
  controlKind: ControlKind
}): Message {
  return {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'control',
    controlKind: options.controlKind,
    content: [{ type: 'text', text: options.text }],
    createdAt: now(),
  }
}

/**
 * Format queued messages into XML-wrapped text for injection.
 * Single message: <queued_message> tag
 * Multiple messages: <queued_messages count="N"> tag with timestamps
 * Over maxRetain: earliest messages summarized
 */
export function formatQueuedMessages(messages: QueuedMessage[]): string {
  if (messages.length === 0) return ''

  const maxRetain = CONTEXT_PARAMS.queue.maxRetainMessages

  if (messages.length === 1) {
    return `<queued_message>
以下是你执行任务期间用户发来的消息。
如果这是状态查询，用 1-2 句简短回应后继续当前任务。
如果这是补充约束，将其纳入后续执行并继续当前任务。
如果这是停止、暂停、审计或明确禁止继续的请求，在当前工具结束后的下一个安全检查点停止新增工具调用，并汇报当前进度与恢复点。
不要因为这条消息向用户请求“继续”或额外许可。
---
${messages[0].content}
</queued_message>`
  }

  // Multiple messages
  let retained = messages
  let omittedNote = ''
  if (messages.length > maxRetain) {
    const omitted = messages.length - maxRetain
    omittedNote = `[还有 ${omitted} 条早期消息已省略]\n`
    retained = messages.slice(-maxRetain)
  }

  const formatted = retained
    .map((m) => {
      const time = m.timestamp.slice(11, 16) // HH:MM
      return `[${time}] ${m.content}`
    })
    .join('\n')

  return `<queued_messages count="${messages.length}">
以下是你执行任务期间用户发来的 ${messages.length} 条消息。
请统一简短回应，吸收其中仍然有效的约束。
如果消息只是状态查询或补充说明，回应后继续当前任务。
如果消息包含停止、暂停、审计或明确禁止继续的请求，在当前工具结束后的下一个安全检查点停止新增工具调用，并汇报当前进度与恢复点。
不要把回应这些消息变成向用户请求“继续”或额外许可。
---
${omittedNote}${formatted}
</queued_messages>`
}

export function buildQueuedInjectionText(messages: QueuedMessage[]): string {
  return formatQueuedMessages(messages)
}

export function formatAppliedQueuedIntent(messages: QueuedMessage[]): string {
  if (messages.length === 0) return ''
  if (messages.length === 1) return messages[0].content

  return messages
    .map((message) => {
      const time = message.timestamp.slice(11, 16)
      return `[${time}] ${message.content}`
    })
    .join('\n')
}

export function buildQueuedInjectionTrace(
  messages: QueuedMessage[],
): QueuedInjectionTrace | undefined {
  if (messages.length === 0) return undefined

  return {
    count: messages.length,
    formattedText: buildQueuedInjectionText(messages),
    messages: messages.map((message) => ({
      timestamp: message.timestamp,
      content: message.content,
      imageCount: message.images?.length ?? 0,
      mediaTypes: Array.from(new Set((message.images ?? []).map((image) => image.mediaType))),
    })),
  }
}

/**
 * Inject formatted queued messages into the last user message as a text block.
 * Returns a new Message (does not mutate the original).
 */
export function injectQueuedMessagesWithTrace(
  lastUserMsg: Message,
  queued: QueuedMessage[],
): QueuedMessageInjectionResult {
  const trace = buildQueuedInjectionTrace(queued)
  if (!trace) return { message: lastUserMsg }

  const newContent: ContentBlock[] = [
    ...lastUserMsg.content,
    { type: 'text', text: trace.formattedText },
  ]

  for (const q of queued) {
    if (q.images?.length) {
      for (const img of q.images) {
        newContent.push({ type: 'image', mediaType: img.mediaType, data: img.data })
      }
    }
  }

  return {
    message: { ...lastUserMsg, content: newContent },
    trace,
  }
}

export function injectQueuedMessages(lastUserMsg: Message, queued: QueuedMessage[]): Message {
  return injectQueuedMessagesWithTrace(lastUserMsg, queued).message
}

/**
 * Continuation prompt to re-engage the model after it responds to queued messages
 * but the original task is not yet complete.
 */
export const CONTINUATION_PROMPT = `<system_notice>
当前任务尚未完成。除非最近消息明确要求停止、暂停、审计或禁止继续，否则请直接继续执行。
不要向用户请求“继续”“确认继续”或额外许可。
当前进度可参考上方的工具调用历史。
</system_notice>`

/**
 * Check if the assistant's response indicates task completion.
 * Returns true if the content has only text blocks (no tool_use)
 * and contains a completion signal word.
 */
export function isTaskComplete(content: ContentBlock[]): boolean {
  const hasToolUse = content.some((b) => b.type === 'tool_use')
  if (hasToolUse) return false

  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')

  const completionSignals = [
    '已完成',
    '完成了',
    '任务结束',
    '重构完成',
    '修改完成',
    '处理完成',
    'done',
    'completed',
    'finished',
  ]
  return completionSignals.some((signal) => text.includes(signal))
}
