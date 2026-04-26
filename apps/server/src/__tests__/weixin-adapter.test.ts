import { describe, expect, test } from 'bun:test'
import { WeixinAdapter } from '../weixin-adapter'

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

  test('showTyping returns a handle with no-op clear', async () => {
    const fake = {
      sendTypingIndicator: async () => {},
    } as unknown as import('@zero-os/channel').WeixinChannel
    const adapter = new WeixinAdapter(fake)
    const handle = await adapter.showTyping('peer')
    expect(handle).not.toBeNull()
    await handle?.clear()
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
