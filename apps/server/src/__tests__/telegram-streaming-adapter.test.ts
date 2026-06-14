import { describe, expect, test } from 'bun:test'
import type { TelegramChannel } from '@zero-os/channel'
import { createTelegramStreamingAdapter } from '../channels/telegram'

function createTelegramChannelRecorder() {
  const calls: string[] = []
  const telegramChannel = {
    sendRich: async (chatId: string, text: string) => {
      calls.push(`send:${chatId}:${text}`)
      return { message_id: 7 }
    },
    replyRich: async (chatId: string, messageId: number, text: string) => {
      calls.push(`reply:${chatId}:${messageId}:${text}`)
      return { message_id: 9 }
    },
    editRich: async (chatId: string, messageId: number, text: string) => {
      calls.push(`edit:${chatId}:${messageId}:${text}`)
    },
    sendTyping: async (chatId: string) => {
      calls.push(`typing:${chatId}`)
    },
  } satisfies Pick<TelegramChannel, 'sendRich' | 'replyRich' | 'editRich' | 'sendTyping'>

  return { calls, telegramChannel }
}

describe('createTelegramStreamingAdapter', () => {
  test('replies to the incoming message first and edits the streamed message on completion', async () => {
    const { calls, telegramChannel } = createTelegramChannelRecorder()
    const stream = createTelegramStreamingAdapter({
      telegramChannel,
      chatId: '123',
      replyToMessageId: 456,
    })

    await stream.update('chunk')
    await stream.complete('final')

    expect(calls).toEqual(['typing:123', 'reply:123:456:chunk', 'edit:123:9:final'])
  })

  test('sends a new message when no reply target exists', async () => {
    const { calls, telegramChannel } = createTelegramChannelRecorder()
    const stream = createTelegramStreamingAdapter({
      telegramChannel,
      chatId: '123',
    })

    await stream.update('chunk')

    expect(calls).toEqual(['typing:123', 'send:123:chunk'])
  })

  test('keeps streamed text when the final reply is empty', async () => {
    const { calls, telegramChannel } = createTelegramChannelRecorder()
    const stream = createTelegramStreamingAdapter({
      telegramChannel,
      chatId: '123',
    })

    await stream.update('chunk')
    await stream.complete('')

    expect(calls).toEqual(['typing:123', 'send:123:chunk', 'edit:123:7:chunk'])
  })

  test('flushes abort text and ignores blank aborts', async () => {
    const { calls, telegramChannel } = createTelegramChannelRecorder()
    const stream = createTelegramStreamingAdapter({
      telegramChannel,
      chatId: '123',
    })

    await stream.abort('  ')
    await stream.abort('failed')

    expect(calls).toEqual(['send:123:failed'])
  })
})
