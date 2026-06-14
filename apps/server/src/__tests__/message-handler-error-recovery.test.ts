import { describe, expect, test } from 'bun:test'
import type { ChannelAdapter } from '../channels/adapter'
import { handleChannelMessage } from '../message/handler'
import {
  type SessionHandleMessageOptions,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

describe('handleChannelMessage error recovery', () => {
  test('prompts user to resend when transient failure rolled back', async () => {
    const replies: string[] = []
    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async () => {
        const err = new Error('overloaded_error')
        ;(err as Error & { rolledBack?: boolean }).rolledBack = true
        throw err
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId: string, text: string) => {
        replies.push(text)
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        channelType: 'telegram',
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter, {
        channelType: 'telegram',
        channelName: 'telegram',
      }),
    )

    expect(replies).toContain(
      '⚠️ AI 服务暂时过载（已重试 3 次仍未恢复），消息已回滚。请稍后重新发送。',
    )
  })

  test('prompts user to continue when transient failure kept partial work', async () => {
    const replies: string[] = []
    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async () => {
        const err = new Error('overloaded_error')
        ;(err as Error & { rolledBack?: boolean }).rolledBack = false
        throw err
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId: string, text: string) => {
        replies.push(text)
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        channelType: 'telegram',
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter, {
        channelType: 'telegram',
        channelName: 'telegram',
      }),
    )

    expect(replies).toContain('⚠️ AI 服务暂时过载，已完成的工作已保留。请发送新消息继续。')
  })

  test('prompts user to continue when partial work is kept during non-transient failure', async () => {
    const replies: string[] = []
    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async () => {
        const err = new Error('some non transient failure')
        ;(err as Error & { rolledBack?: boolean }).rolledBack = false
        throw err
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId: string, text: string) => {
        replies.push(text)
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        channelType: 'telegram',
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter, {
        channelType: 'telegram',
        channelName: 'telegram',
      }),
    )

    expect(replies).toContain('处理中断，已完成的工作已保留。请发送新消息继续。')
  })

  test('streaming completes with existing text when partial work is kept (memory_nudge failure)', async () => {
    const replies: string[] = []
    let streamCompleted: string | undefined
    let streamAborted = false
    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (_content: string, options?: SessionHandleMessageOptions) => {
        options?.onTextDelta?.('report content here', { turnId: 'turn_1' })
        const err = new Error('stream returned empty content')
        ;(err as Error & { rolledBack?: boolean }).rolledBack = false
        throw err
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (_chatId: string, text: string) => {
        replies.push(text)
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
      createStreaming: async () => ({
        update: async () => {},
        complete: async (text: string) => {
          streamCompleted = text
        },
        abort: async () => {
          streamAborted = true
        },
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter),
    )

    expect(streamCompleted).toBe('report content here')
    expect(streamAborted).toBe(false)
    expect(replies).toContain('处理中断，已完成的工作已保留。请发送新消息继续。')
  })

  test('streaming aborts when failure fully rolled back', async () => {
    let streamAbortedWith: string | undefined
    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (_content: string, options?: SessionHandleMessageOptions) => {
        options?.onTextDelta?.('partial text', { turnId: 'turn_1' })
        const err = new Error('total failure')
        ;(err as Error & { rolledBack?: boolean }).rolledBack = true
        throw err
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => ({
        clear: async () => {},
      }),
      createStreaming: async () => ({
        update: async () => {},
        complete: async () => {},
        abort: async (msg?: string) => {
          streamAbortedWith = msg
        },
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter),
    )

    expect(streamAbortedWith).toBe('An error occurred processing your message.')
  })
})
