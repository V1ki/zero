import { describe, expect, test } from 'bun:test'
import { type DWClientDownStream, type EventAckData, TOPIC_ROBOT } from 'dingtalk-stream'
import type { IncomingMessage } from '../base'
import {
  DingtalkChannel,
  DingtalkIncomingMessageBuilder,
  type DingtalkStreamClient,
} from '../dingtalk'
import { DingtalkTaskCards } from '../dingtalk/task-cards'

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
        routerDirect: false,
        messageId: 'msg_1',
        sessionWebhook: 'https://example.test/sessionWebhook',
        robotCode: 'robot_1',
      },
    })
  })

  test('Router direct input requires a same-organization staff DM', async () => {
    const builder = new DingtalkIncomingMessageBuilder()
    const dm = { conversationType: '1', chatbotCorpId: 'corp', senderCorpId: 'corp' }
    for (const [overrides, verified] of [
      [dm, true],
      [{ ...dm, conversationType: '2' }, false],
      [{ ...dm, senderCorpId: 'other' }, false],
      [{ ...dm, senderStaffId: undefined }, false],
    ] as const)
      expect((await builder.build(robotPayload(overrides)))?.metadata?.routerDirect).toBe(verified)
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

  test.each(['top-level', 'nested', 'encoded'] as const)(
    'passes authored rich text from %s without the quoted card or image caption',
    async (mode) => {
      const parts = [
        { text: '还要处理' },
        { type: 'text', text: '哪一项？' },
        { type: 'picture', content: '附件预览中的命令' },
      ]
      const msg = await new DingtalkIncomingMessageBuilder().build(
        robotPayload({
          msgtype: 'richText',
          text: undefined,
          ...(mode === 'top-level'
            ? { richText: parts }
            : {
                content:
                  mode === 'encoded' ? JSON.stringify({ richText: parts }) : { richText: parts },
              }),
          repliedMsg: { msgId: 'original', content: { text: '旧卡片中的要求' } },
        }),
      )
      expect(msg).toMatchObject({
        commandText: '',
        dialogText: '还要处理哪一项？',
        reference: { messageId: 'original', text: '旧卡片中的要求' },
      })
    },
  )

  test('injects quoted reply text from Stream payload into incoming content', async () => {
    const builder = new DingtalkIncomingMessageBuilder()

    const message = await builder.build(
      robotPayload({
        msgId: 'msg_followup',
        text: { content: '继续处理这个' },
        originalMsgId: 'msg_quoted_original',
        isReplyMsg: true,
        repliedMsg: {
          msgId: 'msg_quoted',
          msgType: 'text',
          senderId: 'sender_quoted',
          content: { text: '上一条用户消息' },
        },
      }),
    )

    expect(message?.reference).toEqual({ messageId: 'msg_quoted', text: '上一条用户消息' })
    expect(message?.content).toBe('> 引用: 上一条用户消息\n继续处理这个')
    expect(message?.commandText).toBe('继续处理这个')
    expect(message?.metadata).toMatchObject({
      messageId: 'msg_followup',
      originalMsgId: 'msg_quoted_original',
      parentId: 'msg_quoted',
      quotedMessageId: 'msg_quoted',
      quotedMessageType: 'text',
      quotedSenderId: 'sender_quoted',
      isReplyMsg: true,
    })
  })

  test('recognizes quoted reply payloads nested in DingTalk callback extensions', async () => {
    const builder = new DingtalkIncomingMessageBuilder()

    const message = await builder.build(
      robotPayload({
        text: { content: '好的' },
        replyContext: {
          isReplyMsg: true,
          originalMsgId: 'msg_quoted_original',
          repliedMsg: {
            msgId: 'msg_quoted',
            content: { text: '需要释放 xmind pro' },
          },
        },
      }),
    )

    expect(message?.content).toBe('> 引用: 需要释放 xmind pro\n好的')
    expect(message?.metadata).toMatchObject({
      originalMsgId: 'msg_quoted_original',
      parentId: 'msg_quoted',
      quotedMessageId: 'msg_quoted',
      isReplyMsg: true,
    })
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
  test('does not advertise native quote-reply support', () => {
    const channel = new DingtalkChannel({
      clientId: 'client_id',
      clientSecret: 'client_secret',
    })

    const caps = channel.getCapabilities()

    expect(caps.threadReply).toBe(false)
    expect(caps.markdownNotes).toContain('does not expose Feishu-style native quote-reply UI')
  })

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

    const reply = '**建议先修复再合并。**\n\n隔离测试复现了账号切换。'
    await channel.reply('cid_1', reply, 'msg_1')

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe('https://example.test/sessionWebhook')
    expect(fetchCalls[0]?.init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': 'token_1',
    })
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      msgtype: 'markdown',
      markdown: {
        title: '建议先修复再合并。',
        text: reply,
      },
    })
  })

  test('fails replies when DingTalk returns a business error with HTTP 200', async () => {
    const client = new FakeDingtalkClient()
    const channel = new DingtalkChannel({
      clientId: 'client_id',
      clientSecret: 'client_secret',
      clientFactory: () => client,
      fetch: (async () => {
        return new Response(JSON.stringify({ errcode: 310000, errmsg: 'invalid webhook' }), {
          status: 200,
        })
      }) as unknown as typeof fetch,
    })
    channel.setMessageHandler(async () => {})

    await channel.start()
    client.callback?.(downstream(robotPayload()))
    await Promise.resolve()
    await Promise.resolve()

    await expect(channel.reply('cid_1', 'hello', 'msg_1')).rejects.toThrow(
      'code=310000, message=invalid webhook',
    )
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

describe('DingTalk final delivery authorization', () => {
  test.each(['1', '2'])(
    'sends one plain inbox reminder to the bound peer of type %s',
    async (conversationType) => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = []
      let response: Record<string, unknown> = { processQueryKey: 'receipt-3' }
      const cards = new DingtalkTaskCards({
        dbPath: ':memory:',
        account: 'app',
        robotCode: 'robot',
        apiBaseUrl: 'https://fixture.invalid',
        templateId: 'optional.schema',
        getToken: async () => 'isolated',
        fetch: Object.assign(
          async (url: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
            return Response.json(response)
          },
          { preconnect() {} },
        ),
      })
      try {
        const source = robotPayload({
          conversationType,
          chatbotCorpId: 'corp',
          senderCorpId: 'corp',
        })
        cards.remember(source)
        expect(cards.listDirectPeers()).toEqual(
          conversationType === '1' ? [{ peerId: 'cid_1', actorId: 'staff_1' }] : [],
        )
        const content = 'ZeRo 监听 #4\n发布失败'
        const send = (operator: string, maySend = () => true) =>
          cards.sendListenerReminder(
            'cid_1',
            operator,
            content,
            new AbortController().signal,
            maySend,
          )
        expect((await send('wrong-staff')).status).toBe('rejected')
        let grantChecks = 0
        expect((await send('staff_1', () => ++grantChecks === 1)).status).toBe('rejected')
        expect(calls).toHaveLength(0)
        expect(await send('staff_1')).toEqual({ status: 'accepted', receipt: 'receipt-3' })
        const direct = conversationType === '1'
        expect(calls[0]).toEqual({
          url: `https://fixture.invalid/v1.0/robot/${direct ? 'oToMessages/batchSend' : 'groupMessages/send'}`,
          body: {
            robotCode: 'robot',
            msgKey: 'sampleText',
            msgParam: JSON.stringify({ content }),
            ...(direct ? { userIds: ['staff_1'] } : { openConversationId: 'cid_1' }),
          },
        })
        response = {}
        expect((await send('staff_1')).status).toBe('unknown')
        response = { processQueryKey: 'receipt', filteredStaffIdList: ['staff_1'] }
        expect((await send('staff_1')).status).toBe('rejected')
        expect(calls).toHaveLength(3)
        response = { processQueryKey: 'direct-receipt' }
        const manual = await cards.sendDirectReminder(
          'cid_1',
          'staff_1',
          '处理 DeepSeek 的充值',
          new AbortController().signal,
          () => true,
        )
        if (direct) {
          expect(manual).toEqual({ status: 'accepted', receipt: 'direct-receipt' })
          expect(calls[3]?.body).toEqual({
            robotCode: 'robot',
            msgKey: 'sampleText',
            msgParam: JSON.stringify({ content: '处理 DeepSeek 的充值' }),
            userIds: ['staff_1'],
          })
        } else {
          expect(manual.status).toBe('rejected')
          expect(calls).toHaveLength(3)
        }
      } finally {
        cards.close()
      }
    },
  )

  for (const templateId of [undefined, 'fixture.schema']) {
    test(`does not post a ${templateId ? 'native card' : 'Markdown reminder'} after revocation during token acquisition`, async () => {
      const token = Promise.withResolvers<string>()
      let authorized = true
      let requests = 0
      const cards = new DingtalkTaskCards({
        dbPath: ':memory:',
        account: 'app',
        robotCode: 'local',
        apiBaseUrl: 'https://fixture.invalid',
        templateId,
        getToken: () => token.promise,
        onAction: async () => true,
        fetch: Object.assign(
          async () => {
            requests++
            throw new Error('No network write is authorized')
          },
          { preconnect() {} },
        ),
      })
      try {
        cards.remember(robotPayload({ senderCorpId: 'corp', chatbotCorpId: 'corp' }))
        const payload = {
          id: 'delivery',
          digest: false,
          entries: [{ taskId: 1, title: '任务', summary: '摘要' }],
        }
        const sending = cards.send(
          'cid_1',
          'staff_1',
          payload,
          new AbortController().signal,
          () => authorized,
        )
        authorized = false
        token.resolve('test-token')
        await expect(sending).rejects.toMatchObject({ name: 'DingtalkCardError', uncertain: false })
        expect(requests).toBe(0)
      } finally {
        cards.close()
      }
    })
  }
})

test('DingTalk publication card keeps the Agent title and returns its verified action to Router', async () => {
  const requests: Array<Record<string, unknown>> = []
  const callbacks: unknown[] = []
  const cards = new DingtalkTaskCards({
    dbPath: ':memory:',
    account: 'app',
    robotCode: 'robot',
    apiBaseUrl: 'https://fixture.invalid',
    templateId: 'existing.schema',
    getToken: async () => 'fixture-token',
    onPublication: async (event) => {
      callbacks.push(event)
      return true
    },
    fetch: Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        return Response.json({
          success: true,
          result: {
            outTrackId: body.outTrackId,
            deliverResults: [{ spaceType: 'IM_ROBOT', spaceId: 'staff_1', success: true }],
          },
        })
      },
      { preconnect() {} },
    ),
  })
  try {
    cards.remember(
      robotPayload({
        conversationType: '1',
        senderStaffId: 'staff_1',
        chatbotCorpId: 'corp',
        senderCorpId: 'corp',
      }),
    )
    const deliveryId = `publication-${'b'.repeat(64)}-dingtalk`
    const result = await cards.sendPresentation(
      'cid_1',
      'staff_1',
      deliveryId,
      {
        title: '仍需验证',
        text: '已有线索，但没有修复证据。',
        actions: [{ id: 'acknowledge', label: '确认' }],
      },
      new AbortController().signal,
      () => true,
    )
    expect(result.status).toBe('accepted')
    expect(cards.publicationReceipt('cid_1', 'staff_1', deliveryId)).toBe(result.receipt!)
    expect(cards.publicationReceipt('cid_1', 'other', deliveryId)).toBeNull()
    expect(cards.publicationReceipt('cid_1', 'staff_1', deliveryId + '-other')).toBeNull()
    const request = requests[0] as {
      outTrackId: string
      cardData: {
        cardParamMap: {
          title: string
          summary: string
          flowStatus: string
          status: string
          tasks: string
        }
      }
    }
    expect(request.cardData.cardParamMap.flowStatus).toBe('3')
    expect(request.cardData.cardParamMap.status).toBe('')
    expect(request.cardData.cardParamMap.title).toBe('仍需验证')
    expect(request.cardData.cardParamMap.summary).toBe('已有线索，但没有修复证据。')
    const event = downstream({
      outTrackId: request.outTrackId,
      type: 'actionCallback',
      userId: 'staff_1',
      corpId: 'corp',
      userIdType: 1,
      spaceType: 'IM_ROBOT',
      spaceId: 'staff_1',
      content: JSON.stringify({ cardPrivateData: { actionIds: ['ack'] } }),
    })
    expect(await cards.handle(event)).toBe(true)
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toMatchObject({
      deliveryId,
      actionId: 'acknowledge',
      actorId: 'staff_1',
      peerId: 'cid_1',
    })
    expect(
      await cards.handle(downstream({ ...JSON.parse(event.data), userId: 'another-user' })),
    ).toBe(false)
  } finally {
    cards.close()
  }
})

for (const bodyAccepted of [true, false]) {
  test(`AI card delivery requires body acknowledgement (${bodyAccepted}) and never recreates a partial card`, async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const cards = new DingtalkTaskCards({
      dbPath: ':memory:',
      account: 'app',
      robotCode: 'robot',
      apiBaseUrl: 'https://fixture.invalid',
      templateId: 'ai.schema',
      streamingKey: 'summary',
      getToken: async () => 'fixture-token',
      onPublication: async () => true,
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          calls.push({ url: String(url), body })
          if (String(url).endsWith('/streaming'))
            return Response.json({ success: true, result: bodyAccepted })
          return Response.json({
            success: true,
            result: {
              outTrackId: body.outTrackId,
              deliverResults: [{ spaceType: 'IM_ROBOT', spaceId: 'staff_1', success: true }],
            },
          })
        },
        { preconnect() {} },
      ),
    })
    try {
      cards.remember(
        robotPayload({
          conversationType: '1',
          senderStaffId: 'staff_1',
          chatbotCorpId: 'corp',
          senderCorpId: 'corp',
        }),
      )
      const send = () =>
        cards.sendPresentation(
          'cid_1',
          'staff_1',
          `publication-${'c'.repeat(64)}-dingtalk`,
          {
            title: '检查结果',
            text: '**结论**\n\n[依据](https://example.com/evidence)',
            actions: [],
          },
          new AbortController().signal,
          () => true,
        )
      expect((await send()).status).toBe(bodyAccepted ? 'accepted' : 'unknown')
      expect(calls).toHaveLength(2)
      expect(calls[1]?.body).toMatchObject({
        outTrackId: calls[0]?.body.outTrackId,
        key: 'summary',
        content: '**结论**\n\n[依据](https://example.com/evidence)',
        isFull: true,
        isFinalize: true,
        isError: false,
      })
      expect((await send()).status).toBe(bodyAccepted ? 'accepted' : 'unknown')
      expect(calls).toHaveLength(2)
    } finally {
      cards.close()
    }
  })
}
