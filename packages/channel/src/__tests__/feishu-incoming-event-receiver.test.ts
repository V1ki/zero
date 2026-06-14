import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '../base'
import { FeishuIncomingEventReceiver } from '../feishu'

function feishuPayload(messageId: string) {
  return {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: messageId,
      chat_id: 'chat_1',
      chat_type: 'group',
      message_type: 'text',
      create_time: '1000',
      content: JSON.stringify({ text: 'hello' }),
    },
  }
}

function incoming(messageId: string): IncomingMessage {
  return {
    channelType: 'feishu',
    senderId: 'ou_1',
    content: 'hello',
    timestamp: new Date(1000).toISOString(),
    metadata: { messageId },
  }
}

describe('FeishuIncomingEventReceiver', () => {
  test('dedupes message ids before building and dispatching', async () => {
    let buildCount = 0
    let handledCount = 0
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'feishu',
      incomingBuilder: {
        build: async () => {
          buildCount++
          return incoming('msg_1')
        },
      },
    })
    receiver.setMessageHandler(async () => {
      handledCount++
    })

    await receiver.handle(feishuPayload('msg_1'))
    await receiver.handle(feishuPayload('msg_1'))

    expect(buildCount).toBe(1)
    expect(handledCount).toBe(1)
  })

  test('does not await the async message handler', async () => {
    let releaseHandler: (() => void) | undefined
    let handlerCompleted = false
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'feishu',
      incomingBuilder: { build: async () => incoming('msg_2') },
    })
    receiver.setMessageHandler(async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve
      })
      handlerCompleted = true
    })

    await receiver.handle(feishuPayload('msg_2'))

    expect(handlerCompleted).toBe(false)

    releaseHandler?.()
    await Promise.resolve()

    expect(handlerCompleted).toBe(true)
  })

  test('reset clears duplicate tracking', async () => {
    let handledCount = 0
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'feishu',
      incomingBuilder: { build: async () => incoming('msg_3') },
    })
    receiver.setMessageHandler(async () => {
      handledCount++
    })

    await receiver.handle(feishuPayload('msg_3'))
    await receiver.handle(feishuPayload('msg_3'))
    receiver.reset()
    await receiver.handle(feishuPayload('msg_3'))

    expect(handledCount).toBe(2)
  })
})
