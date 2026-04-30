import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '@zero-os/channel'
import { CommandRouter } from '@zero-os/core'
import type { Message } from '@zero-os/shared'
import type { ChannelAdapter } from '../channel-adapter'
import { type MessageHandlerDeps, handleChannelMessage } from '../message-handler'

describe('handleChannelMessage', () => {
  type SessionHandleMessageOptions = {
    images?: IncomingMessage['images']
    onTextDelta?: (delta: string, meta: { turnId: string }) => void
    onQueuedMessageApplied?: () => void
  }

  const createDefaultDeps = (
    session: {
      data: { id: string }
      isAgentInitialized: () => boolean
      setChannelCapabilities: () => void
      initAgent: () => void
      handleMessage: (content: string, options?: SessionHandleMessageOptions) => Promise<unknown>
    },
    channelAdapter: ChannelAdapter,
  ) => {
    const sessionManager = {
      getOrCreateForChannel: () => ({ session, isNew: false }),
      isCurrentSessionForChannel: (
        _source: unknown,
        _channelId: unknown,
        _channelName: unknown,
        sessionId: string,
      ) => sessionId === session.data.id,
    } as unknown as MessageHandlerDeps['sessionManager']

    const commandRouter = new CommandRouter()

    return {
      channelType: 'feishu' as const,
      channelName: 'feishu',
      agentName: 'ZeRo OS',
      agentInstruction: 'test instruction',
      sessionManager,
      commandRouter,
      channelAdapter,
      isShuttingDown: () => false,
    }
  }

  test('appends downloaded file info before passing content to the session', async () => {
    let handledContent: string | null = null
    let handledImages: IncomingMessage['images'] | undefined

    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (content: string, options?: SessionHandleMessageOptions) => {
        handledContent = content
        handledImages = options?.images
        return []
      },
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session, isNew: false }),
      isCurrentSessionForChannel: (
        _source: unknown,
        _channelId: unknown,
        _channelName: unknown,
        sessionId: string,
      ) => sessionId === session.data.id,
    }

    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    const commandRouter = new CommandRouter()

    await handleChannelMessage(
      {
        channelType: 'feishu',
        senderId: 'ou_test',
        content: '[文件: report.pdf] 已下载到: /tmp/report.pdf',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
        images: [{ mediaType: 'image/png', data: 'abc123' }],
        files: [
          {
            fileName: 'report.pdf',
            localPath: '/tmp/report.pdf',
            size: 2048,
          },
        ],
      },
      {
        channelType: 'feishu',
        channelName: 'feishu',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: sessionManager as unknown as MessageHandlerDeps['sessionManager'],
        commandRouter: commandRouter as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        isShuttingDown: () => false,
      },
    )

    if (!handledContent) {
      throw new Error('expected session.handleMessage content')
    }

    const actualContent = handledContent

    expect(
      actualContent ===
        '[文件: report.pdf] 已下载到: /tmp/report.pdf\n\n📎 文件「report.pdf」已下载到: /tmp/report.pdf (2.0 KB)',
    ).toBe(true)
    expect(handledImages).toEqual([{ mediaType: 'image/png', data: 'abc123' }])
  })

  test('queues in-progress messages without channel feedback', async () => {
    let handledContent: string | null = null
    let handledImages: IncomingMessage['images'] | undefined
    let queuedMessageApplied: (() => void) | undefined
    const calls: string[] = []

    const session = {
      data: { id: 'sess_test' },
      isAgentInitialized: () => true,
      isTurnInProgress: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (content: string, options?: SessionHandleMessageOptions) => {
        calls.push('handleMessage')
        handledContent = content
        handledImages = options?.images
        queuedMessageApplied = options?.onQueuedMessageApplied
        return []
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async () => {
        calls.push('reply')
      },
      showTyping: async () => {
        calls.push('showTyping')
        return {
          clear: async () => {
            calls.push('clearTyping')
          },
        }
      },
      createStreaming: async () => {
        calls.push('createStreaming')
        return {
          update: async () => {
            calls.push('streamUpdate')
          },
          complete: async () => {
            calls.push('streamComplete')
          },
          abort: async () => {
            calls.push('streamAbort')
          },
        }
      },
      markDone: async () => {
        calls.push('markDone')
      },
    }

    await handleChannelMessage(
      {
        channelType: 'feishu' as const,
        senderId: 'user_test',
        content: 'queued follow-up',
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
        images: [{ mediaType: 'image/png', data: 'img-data' }],
      },
      createDefaultDeps(session, channelAdapter),
    )

    expect(handledContent === 'queued follow-up').toBe(true)
    expect(handledImages).toEqual([{ mediaType: 'image/png', data: 'img-data' }])
    expect(calls).toEqual(['handleMessage'])

    queuedMessageApplied?.()
    expect(calls).toEqual(['handleMessage', 'markDone'])
  })

  test('scopes Feishu sessions by sender while replying to the real chat id', async () => {
    const managerCalls: Array<{
      source: string
      channelId: string
      channelName?: string
      participantId?: string
    }> = []
    const currentChecks: Array<{
      channelId: string
      channelName?: string
      sessionId: string
      participantId?: string
    }> = []
    const replies: Array<{ chatId: string; text: string; replyTo?: string | number }> = []
    const session = {
      data: { id: 'sess_alice' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async (): Promise<Message[]> => [
        {
          id: 'msg_assistant',
          sessionId: 'sess_alice',
          role: 'assistant',
          messageType: 'message',
          content: [{ type: 'text', text: 'hello alice' }],
          createdAt: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        },
      ],
    }

    const sessionManager = {
      getOrCreateForChannel: (
        source: string,
        channelId: string,
        channelName?: string,
        participantId?: string,
      ) => {
        managerCalls.push({ source, channelId, channelName, participantId })
        return { session, isNew: false }
      },
      isCurrentSessionForChannel: (
        _source: string,
        channelId: string,
        channelName: string | undefined,
        sessionId: string,
        participantId?: string,
      ) => {
        currentChecks.push({ channelId, channelName, sessionId, participantId })
        return sessionId === session.data.id && participantId === 'ou_alice'
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (chatId, text, replyTo) => {
        replies.push({ chatId, text, replyTo })
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      {
        channelType: 'feishu',
        senderId: 'ou_alice',
        content: 'hello',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'oc_group',
          messageId: 'msg_1',
          chatType: 'group',
        },
      },
      {
        channelType: 'feishu',
        channelName: 'feishu',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: sessionManager as unknown as MessageHandlerDeps['sessionManager'],
        commandRouter: new CommandRouter() as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        isShuttingDown: () => false,
      },
    )

    expect(managerCalls).toEqual([
      {
        source: 'feishu',
        channelId: 'oc_group',
        channelName: 'feishu',
        participantId: 'ou_alice',
      },
    ])
    expect(currentChecks.every((check) => check.participantId === 'ou_alice')).toBe(true)
    expect(replies).toContainEqual({
      chatId: 'oc_group',
      text: 'hello alice',
      replyTo: 'msg_1',
    })
  })

  test('passes metrics into the command context', async () => {
    let seenMetrics: unknown

    const commandRouter = new CommandRouter()
    commandRouter.register({
      name: '/session',
      description: 'probe metrics',
      parse: (content) => (content === '/session' ? {} : null),
      execute: async (_args, ctx) => {
        seenMetrics = ctx.metrics
        return { handled: true, reply: 'ok' }
      },
    })

    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    const metrics = { sessionStats: () => ({ requestCount: 1 }) }

    await handleChannelMessage(
      {
        channelType: 'telegram',
        senderId: 'user_test',
        content: '/session',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      {
        channelType: 'telegram',
        channelName: 'telegram',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: {} as MessageHandlerDeps['sessionManager'],
        commandRouter: commandRouter as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        metrics: metrics as unknown as MessageHandlerDeps['metrics'],
        isShuttingDown: () => false,
      },
    )

    expect(seenMetrics).toBe(metrics)
  })

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
      {
        channelType: 'telegram',
        senderId: 'user_test',
        content: 'hello',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      {
        ...createDefaultDeps(session, channelAdapter),
        channelType: 'telegram',
        channelName: 'telegram',
      },
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
      {
        channelType: 'telegram',
        senderId: 'user_test',
        content: 'hello',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      {
        ...createDefaultDeps(session, channelAdapter),
        channelType: 'telegram',
        channelName: 'telegram',
      },
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
      {
        channelType: 'telegram',
        senderId: 'user_test',
        content: 'hello',
        timestamp: new Date('2026-03-23T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      {
        ...createDefaultDeps(session, channelAdapter),
        channelType: 'telegram',
        channelName: 'telegram',
      },
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
        // Simulate streaming text before failure
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
      {
        channelType: 'feishu' as const,
        senderId: 'user_test',
        content: 'hello',
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      createDefaultDeps(session, channelAdapter),
    )

    // Stream should be completed with the text, not aborted
    expect(streamCompleted).toBe('report content here')
    expect(streamAborted).toBe(false)
    // Error notification should be sent as a separate reply
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
      {
        channelType: 'feishu' as const,
        senderId: 'user_test',
        content: 'hello',
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
        metadata: {
          chatId: 'chat_test',
          messageId: 'msg_test',
        },
      },
      createDefaultDeps(session, channelAdapter),
    )

    expect(streamAbortedWith).toBe('An error occurred processing your message.')
  })
})
