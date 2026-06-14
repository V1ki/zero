import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter } from '../channels/adapter'
import { MessageProgressDelivery } from '../message/progress'

function assistantMessage(id: string, text: string): Message {
  return {
    id,
    sessionId: 'sess_test',
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date('2026-03-29T00:00:00.000Z').toISOString(),
  }
}

describe('MessageProgressDelivery', () => {
  test('sends non-streaming progress replies with dedupe and original reply target', async () => {
    const replies: Array<{ chatId: string; text: string; replyTo?: string | number }> = []
    const channelAdapter: ChannelAdapter = {
      reply: async (chatId, text, replyTo) => {
        replies.push({ chatId, text, replyTo })
      },
      showTyping: async () => null,
    }

    const delivery = new MessageProgressDelivery({
      streaming: null,
      channelAdapter,
      channelName: 'feishu',
      chatId: 'chat_test',
      messageId: 'incoming_msg',
      canDeliverToCurrentSession: () => true,
    })

    delivery.onProgress(assistantMessage('progress_1', 'working'))
    delivery.onProgress(assistantMessage('progress_duplicate', 'working'))
    delivery.onProgress(assistantMessage('progress_2', 'done soon'))

    expect(replies).toEqual([
      { chatId: 'chat_test', text: 'working', replyTo: 'incoming_msg' },
      { chatId: 'chat_test', text: 'done soon', replyTo: undefined },
    ])
    expect(delivery.lastSentMsgId).toBe('progress_2')
  })

  test('streams progress text until text deltas take over', async () => {
    const updates: string[] = []
    const streaming: StreamAdapter = {
      update: async (text) => {
        updates.push(text)
      },
      complete: async () => {},
      abort: async () => {},
    }
    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => null,
    }

    const delivery = new MessageProgressDelivery({
      streaming,
      channelAdapter,
      channelName: 'feishu',
      chatId: 'chat_test',
      messageId: 'incoming_msg',
      canDeliverToCurrentSession: () => true,
    })

    delivery.onProgress(assistantMessage('progress_1', 'thinking'))
    await delivery.flush()

    delivery.onProgress(assistantMessage('progress_duplicate', 'thinking'))
    await delivery.flush()

    delivery.onTextDelta?.(' final answer', { turnId: 'turn_1' })
    await delivery.flush()

    delivery.onProgress(assistantMessage('progress_after_delta', 'ignored progress'))
    await delivery.flush()

    expect(updates).toEqual(['thinking', 'thinking final answer'])
    expect(delivery.streamText).toBe('thinking final answer')
    expect(delivery.lastSentMsgId).toBe('progress_after_delta')
  })

  test('rotates streaming sessions between assistant turns', async () => {
    const events: string[] = []
    const createStream = (label: string): StreamAdapter => ({
      update: async (text) => {
        events.push(`${label}:update:${text}`)
      },
      complete: async (text) => {
        events.push(`${label}:complete:${text}`)
      },
      abort: async () => {},
    })
    const initialStreaming = createStream('initial')
    const nextStreaming = createStream('next')
    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => null,
      createStreaming: async (chatId, replyToMessageId) => {
        events.push(`create:${chatId}:${replyToMessageId}`)
        return nextStreaming
      },
    }

    const delivery = new MessageProgressDelivery({
      streaming: initialStreaming,
      channelAdapter,
      channelName: 'feishu',
      chatId: 'chat_test',
      messageId: 'incoming_msg',
      canDeliverToCurrentSession: () => true,
    })

    delivery.onTextDelta?.('first', { turnId: 'turn_1' })
    await delivery.flush()
    delivery.onTextDelta?.('second', { turnId: 'turn_2' })
    await delivery.flush()

    expect(events).toEqual([
      'initial:update:first',
      'initial:complete:first',
      'create:chat_test:incoming_msg',
      'next:update:second',
    ])
    expect(delivery.streaming).toBe(nextStreaming)
    expect(delivery.streamText).toBe('second')
  })
})
