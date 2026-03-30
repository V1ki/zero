import { describe, expect, test } from 'bun:test'
import type { ContentBlock, Message } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import {
  buildQueuedInjectionText,
  buildQueuedInjectionTrace,
  CONTINUATION_PROMPT,
  type QueuedMessage,
  formatAppliedQueuedIntent,
  formatQueuedMessages,
  injectQueuedMessages,
  injectQueuedMessagesWithTrace,
  isTaskComplete,
} from '../queue'

function makeUserMessage(content: ContentBlock[]): Message {
  return {
    id: generateId(),
    sessionId: 'test',
    role: 'user',
    messageType: 'message',
    content,
    createdAt: now(),
  }
}

describe('formatQueuedMessages', () => {
  test('returns empty string for empty array', () => {
    expect(formatQueuedMessages([])).toBe('')
  })

  test('single message wraps in <queued_message> tag', () => {
    const msgs: QueuedMessage[] = [{ content: 'hello', timestamp: '2026-03-03T10:30:00Z' }]
    const result = formatQueuedMessages(msgs)
    expect(result).toContain('<queued_message>')
    expect(result).toContain('</queued_message>')
    expect(result).toContain('hello')
  })

  test('single message prevents asking for continue', () => {
    const msgs: QueuedMessage[] = [{ content: 'ping', timestamp: '2026-03-03T10:30:00Z' }]
    const result = formatQueuedMessages(msgs)
    expect(result).toContain('不要因为这条消息向用户请求“继续”')
    expect(result).toContain('状态查询')
  })

  test('multiple messages wraps in <queued_messages count="N">', () => {
    const msgs: QueuedMessage[] = [
      { content: 'msg1', timestamp: '2026-03-03T10:30:00Z' },
      { content: 'msg2', timestamp: '2026-03-03T10:31:00Z' },
    ]
    const result = formatQueuedMessages(msgs)
    expect(result).toContain('<queued_messages count="2">')
    expect(result).toContain('</queued_messages>')
  })

  test('multiple messages includes timestamps [HH:MM]', () => {
    const msgs: QueuedMessage[] = [
      { content: 'msg1', timestamp: '2026-03-03T10:30:00Z' },
      { content: 'msg2', timestamp: '2026-03-03T14:05:00Z' },
    ]
    const result = formatQueuedMessages(msgs)
    expect(result).toContain('[10:30]')
    expect(result).toContain('[14:05]')
  })

  test('over 5 messages shows omission note', () => {
    const msgs: QueuedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      content: `msg${i}`,
      timestamp: `2026-03-03T10:${String(i).padStart(2, '0')}:00Z`,
    }))
    const result = formatQueuedMessages(msgs)
    expect(result).toContain('[还有 3 条早期消息已省略]')
    expect(result).toContain('count="8"')
  })
})

describe('buildQueuedInjectionText', () => {
  test('reuses the queued message injection formatting', () => {
    const queued: QueuedMessage[] = [{ content: 'hello', timestamp: '2026-03-03T10:30:00Z' }]

    expect(buildQueuedInjectionText(queued)).toBe(formatQueuedMessages(queued))
  })
})

describe('formatAppliedQueuedIntent', () => {
  test('returns empty string for empty array', () => {
    expect(formatAppliedQueuedIntent([])).toBe('')
  })

  test('returns plain content for a single queued message', () => {
    expect(
      formatAppliedQueuedIntent([{ content: '追加约束', timestamp: '2026-03-03T10:30:00Z' }]),
    ).toBe('追加约束')
  })

  test('formats multiple messages as timestamped plain text without XML wrappers', () => {
    const result = formatAppliedQueuedIntent([
      { content: 'msg1', timestamp: '2026-03-03T10:30:00Z' },
      { content: 'msg2', timestamp: '2026-03-03T10:31:00Z' },
    ])

    expect(result).toBe('[10:30] msg1\n[10:31] msg2')
    expect(result).not.toContain('<queued_message>')
    expect(result).not.toContain('<queued_messages')
  })
})

describe('injectQueuedMessages', () => {
  test('appends text block to existing content', () => {
    const original = makeUserMessage([{ type: 'text', text: 'original' }])
    const queued: QueuedMessage[] = [{ content: 'queued msg', timestamp: '2026-03-03T10:30:00Z' }]
    const result = injectQueuedMessages(original, queued)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: 'text', text: 'original' })
    expect(result.content[1]).toHaveProperty('type', 'text')
    expect((result.content[1] as { type: 'text'; text: string }).text).toContain('queued msg')
  })

  test('does not mutate original message', () => {
    const original = makeUserMessage([{ type: 'text', text: 'original' }])
    const contentRef = original.content
    const queued: QueuedMessage[] = [{ content: 'queued', timestamp: '2026-03-03T10:30:00Z' }]
    injectQueuedMessages(original, queued)
    expect(original.content).toBe(contentRef)
    expect(original.content).toHaveLength(1)
  })

  test('returns original when queued is empty', () => {
    const original = makeUserMessage([{ type: 'text', text: 'hi' }])
    const result = injectQueuedMessages(original, [])
    expect(result).toBe(original)
  })
})

describe('buildQueuedInjectionTrace', () => {
  test('captures count and formatted text for injected messages', () => {
    const trace = buildQueuedInjectionTrace([
      { content: 'queued msg', timestamp: '2026-03-03T10:30:00Z' },
      { content: 'follow-up', timestamp: '2026-03-03T10:31:00Z' },
    ])

    expect(trace).toBeDefined()
    expect(trace?.count).toBe(2)
    expect(trace?.formattedText).toContain('<queued_messages count="2">')
    expect(trace?.messages).toEqual([
      {
        timestamp: '2026-03-03T10:30:00Z',
        content: 'queued msg',
        imageCount: 0,
        mediaTypes: [],
      },
      {
        timestamp: '2026-03-03T10:31:00Z',
        content: 'follow-up',
        imageCount: 0,
        mediaTypes: [],
      },
    ])
  })

  test('records image metadata without persisting raw image data', () => {
    const trace = buildQueuedInjectionTrace([
      {
        content: 'see image',
        timestamp: '2026-03-03T10:30:00Z',
        images: [
          { mediaType: 'image/png', data: 'raw-base64-1' },
          { mediaType: 'image/jpeg', data: 'raw-base64-2' },
        ],
      },
    ])

    expect(trace?.messages[0]).toEqual({
      timestamp: '2026-03-03T10:30:00Z',
      content: 'see image',
      imageCount: 2,
      mediaTypes: ['image/png', 'image/jpeg'],
    })
    expect(JSON.stringify(trace)).not.toContain('raw-base64')
  })
})

describe('injectQueuedMessagesWithTrace', () => {
  test('returns both updated message and trace payload', () => {
    const original = makeUserMessage([{ type: 'text', text: 'original' }])
    const queued: QueuedMessage[] = [{ content: 'queued msg', timestamp: '2026-03-03T10:30:00Z' }]
    const result = injectQueuedMessagesWithTrace(original, queued)

    expect(result.message.content).toHaveLength(2)
    expect(result.trace).toEqual({
      count: 1,
      formattedText: formatQueuedMessages(queued),
      messages: [
        {
          timestamp: '2026-03-03T10:30:00Z',
          content: 'queued msg',
          imageCount: 0,
          mediaTypes: [],
        },
      ],
    })
  })

  test('returns original message and no trace when queue is empty', () => {
    const original = makeUserMessage([{ type: 'text', text: 'hi' }])
    const result = injectQueuedMessagesWithTrace(original, [])

    expect(result.message).toBe(original)
    expect(result.trace).toBeUndefined()
  })
})

describe('isTaskComplete', () => {
  test('returns true when text contains "已完成"', () => {
    const content: ContentBlock[] = [{ type: 'text', text: '任务已完成，文件已保存。' }]
    expect(isTaskComplete(content)).toBe(true)
  })

  test('returns false when content has tool_use block', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: '已完成' },
      { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/tmp' } },
    ]
    expect(isTaskComplete(content)).toBe(false)
  })
})

describe('CONTINUATION_PROMPT', () => {
  test('contains <system_notice> tag', () => {
    expect(CONTINUATION_PROMPT).toContain('<system_notice>')
    expect(CONTINUATION_PROMPT).toContain('</system_notice>')
    expect(CONTINUATION_PROMPT).toContain('不要向用户请求“继续”')
  })
})
