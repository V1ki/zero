import { describe, expect, test } from 'bun:test'
import type { FeishuStreamingSession } from '@zero-os/channel'
import { createFeishuStreamingAdapter } from '../channels/feishu'

function createStreamingSession(label: string, calls: string[]): FeishuStreamingSession {
  return {
    messageId: label,
    update: async (text: string) => {
      calls.push(`update:${text}`)
    },
    complete: async (text: string) => {
      calls.push(`complete:${text}`)
    },
    abort: async (errorMessage?: string) => {
      calls.push(`abort:${errorMessage ?? ''}`)
    },
    dismiss: async () => {
      calls.push('dismiss')
    },
  }
}

describe('createFeishuStreamingAdapter', () => {
  test('uses reply streaming and releases active sessions on complete', async () => {
    const calls: string[] = []
    const rawSession = createStreamingSession('reply:msg-1', calls)
    const activeStreamingSessions = new Set<FeishuStreamingSession>()
    const adapter = await createFeishuStreamingAdapter({
      feishuChannel: {
        replyStreaming: async (messageId: string) => {
          calls.push(`replyStreaming:${messageId}`)
          return rawSession
        },
        sendStreaming: async (chatId: string) => {
          calls.push(`sendStreaming:${chatId}`)
          return createStreamingSession(`send:${chatId}`, calls)
        },
      },
      activeStreamingSessions,
      chatId: 'chat-1',
      replyToMessageId: 'msg-1',
    })

    expect(activeStreamingSessions.has(rawSession)).toBe(true)
    await adapter.update('hello')
    await adapter.complete('done')

    expect(activeStreamingSessions.has(rawSession)).toBe(false)
    expect(calls).toEqual(['replyStreaming:msg-1', 'update:hello', 'complete:done'])
  })

  test('uses send streaming, dismisses blank final text, and releases on abort', async () => {
    const calls: string[] = []
    const rawSession = createStreamingSession('send:chat-2', calls)
    const activeStreamingSessions = new Set<FeishuStreamingSession>()
    const feishuChannel = {
      replyStreaming: async (messageId: string) => {
        calls.push(`replyStreaming:${messageId}`)
        return createStreamingSession(`reply:${messageId}`, calls)
      },
      sendStreaming: async (chatId: string) => {
        calls.push(`sendStreaming:${chatId}`)
        return rawSession
      },
    }

    const completed = await createFeishuStreamingAdapter({
      feishuChannel,
      activeStreamingSessions,
      chatId: 'chat-2',
    })
    await completed.complete('   ')
    expect(activeStreamingSessions.has(rawSession)).toBe(false)

    const aborted = await createFeishuStreamingAdapter({
      feishuChannel,
      activeStreamingSessions,
      chatId: 'chat-2',
    })
    await aborted.abort('stopped')
    expect(activeStreamingSessions.has(rawSession)).toBe(false)

    expect(calls).toEqual([
      'sendStreaming:chat-2',
      'dismiss',
      'sendStreaming:chat-2',
      'abort:stopped',
    ])
  })
})
