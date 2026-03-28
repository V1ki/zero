import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '@zero-os/channel'
import { CommandRouter } from '@zero-os/core'
import type { ChannelAdapter } from '../channel-adapter'
import { handleChannelMessage, type MessageHandlerDeps } from '../message-handler'

describe('handleChannelMessage', () => {
  const createDefaultDeps = (
    session: {
      data: { id: string }
      isAgentInitialized: () => boolean
      setChannelCapabilities: () => void
      initAgent: () => void
      handleMessage: (content: string, options?: { images?: IncomingMessage['images'] }) => Promise<unknown>
    },
    channelAdapter: ChannelAdapter,
  ) => {
    const sessionManager = {
      getOrCreateForChannel: () => ({ session, isNew: false }),
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
      handleMessage: async (
        content: string,
        options?: { images?: IncomingMessage['images'] },
      ) => {
        handledContent = content
        handledImages = options?.images
        return []
      },
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session, isNew: false }),
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
})
