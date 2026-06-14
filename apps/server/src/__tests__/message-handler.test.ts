import { describe, expect, test } from 'bun:test'
import type { ChannelAdapter } from '../channels/adapter'
import { handleChannelMessage } from '../message/handler'
import {
  createAssistantTextMessage,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

describe('handleChannelMessage', () => {
  test('continues processing when typing indicator fails', async () => {
    const calls: string[] = []
    const replies: string[] = []

    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (content: string) => {
        calls.push(`handleMessage:${content}`)
        return [createAssistantTextMessage('handled')]
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId, text) => {
        replies.push(text)
      },
      showTyping: async () => {
        calls.push('showTyping')
        throw new Error('reaction failed')
      },
    }

    await handleChannelMessage(
      createIncomingMessage({
        content: 'hello after typing failure',
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter),
    )

    expect(calls).toEqual(['showTyping', 'handleMessage:hello after typing failure'])
    expect(replies).toEqual(['handled'])
  })
})
