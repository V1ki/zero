import { describe, expect, test } from 'bun:test'
import type { ImageBlock, Message } from '@zero-os/shared'
import type { ChannelAdapter } from '../channels/adapter'
import {
  collectAssistantImageBlocks,
  prepareImageBlockDelivery,
  sendFallbackImageBlocks,
} from '../message/replies'

function imageBlock(data: string): ImageBlock {
  return { type: 'image', data, mediaType: 'image/png' }
}

function message(role: Message['role'], content: Message['content']): Message {
  return {
    id: `${role}_msg`,
    sessionId: 'sess_test',
    role,
    messageType: 'message',
    content,
    createdAt: new Date('2026-03-29T00:00:00.000Z').toISOString(),
  }
}

describe('message image helpers', () => {
  test('collects assistant image blocks only', () => {
    const assistantImage = imageBlock('aW1nMQ==')
    const userImage = imageBlock('aW1nMg==')

    expect(
      collectAssistantImageBlocks([
        message('assistant', [{ type: 'text', text: 'hello' }, assistantImage]),
        message('user', [userImage]),
      ]),
    ).toEqual([assistantImage])
  })

  test('prepares uploaded image markdown and keeps failed image blocks for fallback', async () => {
    const uploadedImage = imageBlock('dXBsb2FkZWQ=')
    const failedImage = imageBlock('ZmFpbGVk')
    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => null,
      uploadImage: async (buffer) =>
        buffer.toString('base64') === uploadedImage.data ? { markdownRef: 'img://one' } : null,
    }

    const result = await prepareImageBlockDelivery({
      imageBlocks: [uploadedImage, failedImage],
      shouldEmbedImageBlocks: true,
      channelAdapter,
      channelName: 'test',
    })

    expect(result.imageMarkdownSuffix).toBe('\n\n![image-1](img://one)')
    expect(result.failedImageBlocks).toEqual([failedImage])
  })

  test('sends fallback image blocks only when delivery is allowed', async () => {
    const sent: string[] = []
    const fallbackImage = imageBlock('ZmFsbGJhY2s=')
    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => null,
      sendImage: async (_chatId, buffer) => {
        sent.push(buffer.toString('base64'))
      },
    }

    await sendFallbackImageBlocks({
      imageBlocks: [fallbackImage],
      channelAdapter,
      chatId: 'chat_test',
      channelName: 'test',
      canDeliver: false,
    })
    await sendFallbackImageBlocks({
      imageBlocks: [fallbackImage],
      channelAdapter,
      chatId: 'chat_test',
      channelName: 'test',
      canDeliver: true,
    })

    expect(sent).toEqual([fallbackImage.data])
  })
})
