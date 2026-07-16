import { describe, expect, test } from 'bun:test'
import type { BackgroundToolCompletionEvent, HandleMessageOptions } from '@zero-os/core'
import type { ChannelAdapter, StreamAdapter } from '../channels/adapter'
import { createBackgroundToolCompletionDeliveryHandler } from '../message/background-delivery'
import { createAssistantTextMessage } from './message-handler-harness'

function createBackgroundEvent(): BackgroundToolCompletionEvent {
  return {
    task: {
      id: 'task_bg',
      sessionId: 'sess_bg',
      toolName: 'bash',
      toolUseId: 'call_bg',
      inputSummary: '{}',
      status: 'success',
      startedAt: '2026-07-07T00:00:00.000Z',
    },
    xml: '<system_event type="background_tool.completed" />',
    channelBinding: {
      source: 'feishu',
      channelName: 'feishu',
      channelId: 'chat_bg',
      deliveryChannelId: 'chat_bg',
      participantId: 'ou_bg',
    },
  }
}

function createSessionManager() {
  return {
    isCurrentSessionForChannel: (
      source: string,
      channelId: string,
      channelName: string | undefined,
      sessionId: string,
      participantId?: string,
    ) =>
      source === 'feishu' &&
      channelId === 'chat_bg' &&
      channelName === 'feishu' &&
      sessionId === 'sess_bg' &&
      participantId === 'ou_bg',
  }
}

describe('background tool completion delivery', () => {
  test('streams background continuation output to a new channel message', async () => {
    const calls: Array<{ name: string; chatId: string; messageId?: string | number }> = []
    const updates: string[] = []
    const completes: string[] = []
    const replies: string[] = []
    const streaming: StreamAdapter = {
      update: async (text) => {
        updates.push(text)
      },
      complete: async (text) => {
        completes.push(text)
      },
      abort: async () => {},
    }
    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId, text) => {
        replies.push(text)
      },
      showTyping: async (chatId, messageId) => {
        calls.push({ name: 'showTyping', chatId, messageId })
        return null
      },
      createStreaming: async (chatId, messageId) => {
        calls.push({ name: 'createStreaming', chatId, messageId })
        return streaming
      },
    }

    const handler = createBackgroundToolCompletionDeliveryHandler({
      channelAdapters: new Map([['feishu', channelAdapter]]),
      sessionManager: createSessionManager(),
    })

    const handled = await handler(
      createBackgroundEvent(),
      async (options?: HandleMessageOptions) => {
        options?.onTextDelta?.('final answer', { role: 'assistant', turnId: 'turn_bg' })
        return [createAssistantTextMessage('final answer', 'sess_bg')]
      },
    )

    expect(handled).toBe(true)
    expect(calls).toEqual([
      { name: 'showTyping', chatId: 'chat_bg', messageId: undefined },
      { name: 'createStreaming', chatId: 'chat_bg', messageId: undefined },
    ])
    expect(updates).toEqual(['final answer'])
    expect(completes).toEqual(['final answer'])
    expect(replies).toEqual([])
  })

  test('falls back to a plain message when streaming is unavailable', async () => {
    const replies: Array<{ chatId: string; text: string; messageId?: string | number }> = []
    const channelAdapter: ChannelAdapter = {
      reply: async (chatId, text, messageId) => {
        replies.push({ chatId, text, messageId })
      },
      showTyping: async () => null,
      createStreaming: async () => null,
    }

    const handler = createBackgroundToolCompletionDeliveryHandler({
      channelAdapters: new Map([['feishu', channelAdapter]]),
      sessionManager: createSessionManager(),
    })

    const handled = await handler(createBackgroundEvent(), async () => [
      createAssistantTextMessage('plain final answer', 'sess_bg'),
    ])

    expect(handled).toBe(true)
    expect(replies).toEqual([
      { chatId: 'chat_bg', text: 'plain final answer', messageId: undefined },
    ])
  })
})
