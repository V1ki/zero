import { describe, expect, test } from 'bun:test'
import { WeixinAdapter } from '../channels/weixin'

describe('WeixinAdapter', () => {
  test('reply delegates to channel.sendToChat', async () => {
    const calls: Array<[string, string]> = []
    const fake = {
      sendToChat: async (chatId: string, text: string) => {
        calls.push([chatId, text])
      },
      sendTypingIndicator: async () => {},
    } as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake)
    await adapter.reply('peer', 'hello')
    expect(calls).toEqual([['peer', 'hello']])
  })

  test('createStreaming returns null (no message editing on Weixin)', async () => {
    const fake = {} as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake)
    const stream = await adapter.createStreaming()
    expect(stream).toBeNull()
  })

  test('showTyping starts keepalive and clear sends typing cancel once', async () => {
    const calls: string[] = []
    const fake = {
      sendTypingIndicator: async (chatId: string) => {
        calls.push(`start:${chatId}`)
      },
      clearTypingIndicator: async (chatId: string) => {
        calls.push(`stop:${chatId}`)
      },
    } as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake)
    const handle = await adapter.showTyping('peer')
    expect(handle).not.toBeNull()
    await handle?.clear()
    await handle?.clear()
    expect(calls).toEqual(['start:peer', 'stop:peer'])
  })

  test('showTyping keepalive re-fires on interval until cleared', async () => {
    const calls: string[] = []
    const fake = {
      sendTypingIndicator: async (chatId: string) => {
        calls.push(chatId)
      },
      clearTypingIndicator: async () => {},
    } as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake, 10)
    const handle = await adapter.showTyping('peer')
    await Bun.sleep(45)
    await handle?.clear()
    const countAfterClear = calls.length
    expect(countAfterClear).toBeGreaterThanOrEqual(3) // initial send + at least 2 keepalives
    await Bun.sleep(40)
    expect(calls.length).toBe(countAfterClear)
  })

  test('sendImage delegates to channel.sendAttachment', async () => {
    const calls: Array<[string, Buffer, string, string | undefined]> = []
    const fake = {
      sendAttachment: async (
        chatId: string,
        bytes: Buffer,
        filename: string,
        mimeHint?: string,
      ) => {
        calls.push([chatId, bytes, filename, mimeHint])
        return 'client-id'
      },
    } as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake)
    const image = Buffer.from('png')

    await adapter.sendImage?.('peer', image)

    expect(calls).toEqual([['peer', image, 'image.png', 'image/png']])
  })
})
