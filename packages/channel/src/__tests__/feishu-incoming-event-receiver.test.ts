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

function feishuRecallPayload(messageId: string) {
  return {
    message_id: messageId,
    chat_id: 'chat_1',
    recall_time: '1000',
    recall_type: 'message_owner',
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

function recalled(messageId: string): IncomingMessage {
  return {
    channelType: 'feishu',
    eventType: 'message_recalled',
    senderId: 'unknown',
    content: '',
    timestamp: new Date(1000).toISOString(),
    metadata: {
      eventType: 'message_recalled',
      chatId: 'chat_1',
      messageId,
      recallTime: new Date(1000).toISOString(),
      recallType: 'message_owner',
    },
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
        buildRecalled: async () => null,
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
      incomingBuilder: { build: async () => incoming('msg_2'), buildRecalled: async () => null },
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
      incomingBuilder: { build: async () => incoming('msg_3'), buildRecalled: async () => null },
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

  test('dispatches recall events without being deduped by the original message id', async () => {
    const handled: IncomingMessage[] = []
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'feishu',
      incomingBuilder: {
        build: async (data) =>
          incoming((data as { message: { message_id: string } }).message.message_id),
        buildRecalled: async (data) => recalled((data as { message_id: string }).message_id),
      },
    })
    receiver.setMessageHandler(async (message) => {
      handled.push(message)
    })

    await receiver.handleReceived(feishuPayload('msg_4'))
    await receiver.handleRecalled(feishuRecallPayload('msg_4'))
    await Promise.resolve()

    expect(handled.map((message) => message.eventType ?? 'message')).toEqual([
      'message',
      'message_recalled',
    ])
    expect(handled[1]?.metadata?.messageId).toBe('msg_4')
  })

  test('skips a receive event when the recall event arrived first', async () => {
    let handledCount = 0
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'feishu',
      incomingBuilder: {
        build: async () => incoming('msg_5'),
        buildRecalled: async () => recalled('msg_5'),
      },
    })
    receiver.setMessageHandler(async () => {
      handledCount++
    })

    await receiver.handleRecalled(feishuRecallPayload('msg_5'))
    await receiver.handleReceived(feishuPayload('msg_5'))
    await Promise.resolve()

    expect(handledCount).toBe(1)
  })
})
