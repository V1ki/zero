import { describe, expect, test } from 'bun:test'
import type { TelegramChannel } from '@zero-os/channel'
import { TelegramAdapter } from '../telegram-adapter'

describe('TelegramAdapter', () => {
  test('createStreaming returns null when streaming is disabled', async () => {
    const adapter = new TelegramAdapter({} as TelegramChannel, { streaming: false })

    const stream = await adapter.createStreaming('123', 456)

    expect(stream).toBeNull()
  })
})
