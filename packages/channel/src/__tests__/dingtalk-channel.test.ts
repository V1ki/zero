import { describe, expect, test } from 'bun:test'
import { type DWClientDownStream, type EventAckData, TOPIC_ROBOT } from 'dingtalk-stream'
import type { IncomingMessage } from '../base'
import {
  DingtalkChannel,
  DingtalkIncomingMessageBuilder,
  type DingtalkStreamClient,
} from '../dingtalk'

function robotPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'cid_1',
    conversationType: '2',
    msgId: 'msg_1',
    msgtype: 'text',
    text: { content: 'hello' },
    senderStaffId: 'staff_1',
    senderId: 'sender_1',
    senderNick: 'Alice',
    sessionWebhook: 'https://example.test/sessionWebhook',
    sessionWebhookExpiredTime: Date.now() + 60_000,
    createAt: 1_700_000_000_000,
    robotCode: 'robot_1',
    ...overrides,
  }
}

function downstream(data: unknown, messageId = 'stream_msg_1'): DWClientDownStream {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'app_1',
      connectionId: 'conn_1',
      contentType: 'application/json',
      messageId,
      time: String(Date.now()),
      topic: TOPIC_ROBOT,
    },
    data: JSON.stringify(data),
  }
}

class FakeDingtalkClient implements DingtalkStreamClient {
  connected = false
  callback: ((message: DWClientDownStream) => void) | undefined
  eventCallback: ((message: DWClientDownStream) => EventAckData) | undefined
  acks: Array<{ messageId: string; result: unknown }> = []

  registerCallbackListener(
    _eventId: string,
    callback: (message: DWClientDownStream) => void,
  ): DingtalkStreamClient {
    this.callback = callback
    return this
  }

  registerAllEventListener(
    callback: (message: DWClientDownStream) => EventAckData,
  ): DingtalkStreamClient {
    this.eventCallback = callback
    return this
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  disconnect(): void {
    this.connected = false
  }

  async getAccessToken(): Promise<string> {
    return 'token_1'
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acks.push({ messageId, result })
  }
}

describe('DingtalkIncomingMessageBuilder', () => {
  test('parses text robot messages into IncomingMessage', async () => {
    const builder = new DingtalkIncomingMessageBuilder()

    const message = await builder.build(robotPayload())

    expect(message).toMatchObject({
      channelType: 'dingtalk',
      senderId: 'staff_1',
      content: 'hello',
      metadata: {
        chatId: 'cid_1',
        messageId: 'msg_1',
        sessionWebhook: 'https://example.test/sessionWebhook',
        robotCode: 'robot_1',
      },
    })
  })

  test('downloads rich text image elements into image attachments', async () => {
    const builder = new DingtalkIncomingMessageBuilder({
      downloadMedia: async (request) => {
        expect(request).toEqual({
          downloadCode: 'pic_code_1',
          robotCode: 'robot_1',
          fileName: undefined,
          mediaType: 'image/png',
        })
        return {
          buffer: Buffer.from('image-bytes'),
          mediaType: 'image/png',
        }
      },
    })

    const message = await builder.build(
      robotPayload({
        msgtype: 'richText',
        text: undefined,
        richText: [
          { type: 'text', text: 'look' },
          { type: 'picture', pictureDownloadCode: 'pic_code_1' },
        ],
      }),
    )

    expect(message?.content).toBe('look')
    expect(message?.images).toEqual([
      {
        mediaType: 'image/png',
        data: Buffer.from('image-bytes').toString('base64'),
      },
    ])
  })

  test('parses recall events into message_recalled events', () => {
    const builder = new DingtalkIncomingMessageBuilder()

    const message = builder.buildRecalled({
      eventType: 'bot_message_recall',
      conversationId: 'cid_1',
      recallMsgId: 'msg_1',
      recallTime: 1_700_000_001_000,
      operatorId: 'staff_1',
    })

    expect(message).toEqual({
      channelType: 'dingtalk',
      eventType: 'message_recalled',
      senderId: 'staff_1',
      content: '',
      timestamp: '2023-11-14T22:13:21.000Z',
      metadata: {
        eventType: 'message_recalled',
        chatId: 'cid_1',
        messageId: 'msg_1',
        recallTime: '2023-11-14T22:13:21.000Z',
        recallType: 'bot_message_recall',
      },
    })
  })
})

describe('DingtalkChannel', () => {
  test('acknowledges stream callbacks, dispatches messages, and replies through sessionWebhook', async () => {
    const client = new FakeDingtalkClient()
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
    const channel = new DingtalkChannel({
      clientId: 'client_id',
      clientSecret: 'client_secret',
      clientFactory: () => client,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof fetch,
    })
    const handled: IncomingMessage[] = []
    channel.setMessageHandler(async (message) => {
      handled.push(message)
    })

    await channel.start()
    client.callback?.(downstream(robotPayload()))
    await Promise.resolve()
    await Promise.resolve()

    expect(client.acks).toEqual([
      {
        messageId: 'stream_msg_1',
        result: { status: 'SUCCESS' },
      },
    ])
    expect(handled).toHaveLength(1)
    expect(handled[0]?.content).toBe('hello')

    await channel.reply('cid_1', '# done', 'msg_1')

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe('https://example.test/sessionWebhook')
    expect(fetchCalls[0]?.init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': 'token_1',
    })
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      msgtype: 'markdown',
      markdown: {
        title: 'done',
        text: '# done',
      },
    })
  })

  test('uploads images and returns DingTalk media ids', async () => {
    const client = new FakeDingtalkClient()
    const channel = new DingtalkChannel({
      clientId: 'client_id',
      clientSecret: 'client_secret',
      clientFactory: () => client,
      fetch: (async () => {
        return new Response(JSON.stringify({ mediaId: 'media_1' }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    await channel.start()

    await expect(channel.uploadImage(Buffer.from('image'))).resolves.toBe('media_1')
  })
})
