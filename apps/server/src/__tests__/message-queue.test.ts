import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '@zero-os/channel'
import type { ChannelAdapter } from '../channels/adapter'
import { handleChannelMessage } from '../message/handler'
import {
  type SessionHandleMessageOptions,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

describe('handleChannelMessage queueing', () => {
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
      createIncomingMessage({
        content: 'queued follow-up',
        timestamp: new Date('2026-03-29T00:00:00.000Z').toISOString(),
        images: [{ mediaType: 'image/png', data: 'img-data' }],
      }),
      createDefaultMessageHandlerDeps(session, channelAdapter),
    )

    expect(handledContent === 'queued follow-up').toBe(true)
    expect(handledImages).toEqual([{ mediaType: 'image/png', data: 'img-data' }])
    expect(calls).toEqual(['handleMessage'])

    queuedMessageApplied?.()
    expect(calls).toEqual(['handleMessage', 'markDone'])
  })
})
