import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '@zero-os/channel'
import type { ChannelAdapter } from '../channels/adapter'
import { handleChannelMessage } from '../message/handler'
import {
  type SessionHandleMessageOptions,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

describe('handleChannelMessage files', () => {
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

    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        senderId: 'ou_test',
        content: '[文件: report.pdf] 已下载到: /tmp/report.pdf',
        images: [{ mediaType: 'image/png', data: 'abc123' }],
        files: [
          {
            fileName: 'report.pdf',
            localPath: '/tmp/report.pdf',
            size: 2048,
          },
        ],
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter),
    )

    if (!handledContent) {
      throw new Error('expected session.handleMessage content')
    }

    expect(
      handledContent ===
        '[文件: report.pdf] 已下载到: /tmp/report.pdf\n\n📎 文件「report.pdf」已下载到: /tmp/report.pdf (2.0 KB)',
    ).toBe(true)
    expect(handledImages).toEqual([{ mediaType: 'image/png', data: 'abc123' }])
  })
})
