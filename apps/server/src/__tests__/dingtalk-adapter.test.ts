import { describe, expect, test } from 'bun:test'
import { DingtalkAdapter } from '../channels/dingtalk'

describe('DingtalkAdapter', () => {
  test('reply delegates to DingTalk channel with reply message id', async () => {
    const calls: Array<[string, string, string | number | undefined]> = []
    const fake = {
      reply: async (chatId: string, text: string, replyToMessageId?: string | number) => {
        calls.push([chatId, text, replyToMessageId])
      },
    } as unknown as import('@zero-os/channel').DingtalkChannel
    const adapter = new DingtalkAdapter(fake)

    await adapter.reply('cid_1', 'hello', 'msg_1')

    expect(calls).toEqual([['cid_1', 'hello', 'msg_1']])
  })

  test('createStreaming returns null because regular DingTalk robot messages are not editable', async () => {
    const fake = {} as unknown as import('@zero-os/channel').DingtalkChannel
    const adapter = new DingtalkAdapter(fake)

    await expect(adapter.createStreaming()).resolves.toBeNull()
  })

  test('uploadImage maps media id to markdown reference', async () => {
    const fake = {
      uploadImage: async () => 'media_1',
    } as unknown as import('@zero-os/channel').DingtalkChannel
    const adapter = new DingtalkAdapter(fake)

    await expect(adapter.uploadImage?.(Buffer.from('image'))).resolves.toEqual({
      markdownRef: 'media_1',
    })
  })
})
