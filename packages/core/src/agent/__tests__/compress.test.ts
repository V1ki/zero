import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { generateId, now } from '@zero-os/shared'
import type { Message } from '@zero-os/shared'
import { compressConversation } from '../compress'

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: generateId(),
    sessionId: 'test-session',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

const mockAdapter = {
  apiType: 'mock',
  async complete() {
    return {
      id: 'test',
      content: [{ type: 'text' as const, text: 'Summary of conversation' }],
      stopReason: 'end_turn' as const,
      usage: { input: 100, output: 50 },
      model: 'mock',
    }
  },
  async *stream() {},
  async healthCheck() {
    return true
  },
} satisfies ProviderAdapter

describe('compressConversation', () => {
  test('returns messages unchanged when nothing to compress', async () => {
    // Few messages + large budget = no compression needed
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
      makeMessage('user', 'How are you?'),
      makeMessage('assistant', 'I am fine.'),
    ]

    const result = await compressConversation(messages, 100_000, mockAdapter, 'test-session')

    expect(result.summary).toBe('')
    expect(result.retainedMessages.length).toBe(messages.length)
    expect(result.stats.messagesBefore).toBe(messages.length)
    expect(result.stats.messagesAfter).toBe(messages.length)
    expect(result.stats.tokensBefore).toBe(result.stats.tokensAfter)
  })

  test('compresses when many messages exceed small budget', async () => {
    // Create 20 messages (10 turns) with substantial text
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const text = `Message number ${i}: ${'x'.repeat(200)}`
      messages.push(makeMessage(role as 'user' | 'assistant', text))
    }

    // Use a very small budget to force compression
    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // Compression should have happened
    expect(result.summary).toBe('Summary of conversation')
    expect(result.stats.messagesAfter).toBeLessThan(result.stats.messagesBefore)
    expect(result.stats.messagesBefore).toBe(20)
  })

  test('retained messages include summary as first message', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Turn ${i}: ${'y'.repeat(200)}`))
    }

    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // When compression occurs, first retained message should be the summary
    if (result.summary !== '') {
      const firstMsg = result.retainedMessages[0]
      expect(firstMsg.role).toBe('user')
      expect(firstMsg.content[0].type).toBe('text')
      const textBlock = firstMsg.content[0] as { type: 'text'; text: string }
      expect(textBlock.text).toContain('[以下是之前对话的摘要]')
      expect(textBlock.text).toContain('Summary of conversation')
      expect(textBlock.text).toContain('[摘要结束，以下是最近的对话]')
    }
  })

  test('stats are accurate', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'z'.repeat(200)}`))
    }

    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // messagesBefore should be the original count
    expect(result.stats.messagesBefore).toBe(20)

    // messagesAfter should equal the actual retained array length
    expect(result.stats.messagesAfter).toBe(result.retainedMessages.length)

    // tokensAfter should be less than tokensBefore (compression reduced tokens)
    expect(result.stats.tokensAfter).toBeLessThan(result.stats.tokensBefore)

    // tokensBefore and tokensAfter should both be positive
    expect(result.stats.tokensBefore).toBeGreaterThan(0)
    expect(result.stats.tokensAfter).toBeGreaterThan(0)
  })

  test('adds compression meta to the summary request', async () => {
    let seenMeta: import('@zero-os/shared').CompletionRequest['meta'] | undefined
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'z'.repeat(200)}`))
    }

    const adapter = {
      ...mockAdapter,
      async complete(request) {
        seenMeta = request.meta
        return {
          id: 'test',
          content: [{ type: 'text' as const, text: 'Summary of conversation' }],
          stopReason: 'end_turn' as const,
          usage: { input: 100, output: 50 },
          model: 'mock',
        }
      },
    } satisfies ProviderAdapter

    await compressConversation(messages, 100, adapter, 'test-session', {
      parentSessionId: 'parent-session',
    })

    expect(seenMeta).toEqual({
      sessionId: 'test-session',
      purpose: 'compression',
      parentSessionId: 'parent-session',
    })
  })
})
