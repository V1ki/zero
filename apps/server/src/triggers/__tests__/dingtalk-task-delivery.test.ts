import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DingtalkChannel } from '@zero-os/channel'
import type { MandateTarget } from '@zero-os/shared'
import { type DWClientDownStream, TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream'
import { createDingtalkTaskDelivery } from '../dingtalk-task-delivery'
import type { MandateDelivery } from '../mandate-runtime'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function frame(topic: string, data: object, messageId = 'stream-message'): DWClientDownStream {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'local-app',
      connectionId: 'connection',
      contentType: 'application/json',
      messageId,
      time: String(Date.now()),
      topic,
    },
    data: JSON.stringify(data),
  }
}

const payload: MandateDelivery = {
  id: 'activity-1',
  digest: false,
  entries: [{ taskId: 7, matchId: 10, inboxId: 4, title: '发布受阻', summary: '测试构建失败' }],
}
const signal = () => AbortSignal.timeout(3000)

async function fixture(conversationType: '1' | '2', interactive = true) {
  const dir = mkdtempSync(join(tmpdir(), 'zero-task-card-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const spaceType = conversationType === '1' ? 'IM_ROBOT' : 'IM_GROUP'
  const spaceId = conversationType === '1' ? 'staff' : 'cid'
  let resultType = 'accepted'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      expect(req.headers.get('x-acs-dingtalk-access-token')).toBe('isolated-token')
      const body = (await req.json()) as Record<string, unknown>
      const path = new URL(req.url).pathname
      requests.push({ path, body })
      if (req.method === 'PUT' && path === '/v1.0/card/instances') {
        return Response.json({ success: true, result: true })
      }
      if (path.startsWith('/v1.0/robot/')) {
        if (resultType === 'forbidden')
          return Response.json(
            {
              code: 'Forbidden.AccessDenied',
              message: 'private upstream recipient and network data',
              accessDeniedDetail: {
                requiredAccessDeniedPermissionList: ['Robot.Send', 'ignore private text'],
              },
            },
            { status: 403 },
          )
        if (resultType === 'unknown') return Response.json({})
        if (resultType === 'rejected')
          return Response.json({ processQueryKey: 'partial', filteredStaffIdList: ['staff'] })
        return Response.json({ processQueryKey: 'native-receipt' })
      }
      expect(path).toBe('/v1.0/card/instances/createAndDeliver')
      if (resultType === 'unknown') return Response.json({ success: true, result: {} })
      return Response.json({
        success: true,
        result: {
          outTrackId: body.outTrackId,
          deliverResults: [
            {
              spaceId,
              spaceType,
              success: resultType === 'accepted',
            },
          ],
        },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  let authorized = true
  const actions: unknown[] = []
  const channels = new Map<string, DingtalkChannel>()
  const handlers = new Map<string, (data: DWClientDownStream) => void>()
  const incoming = Promise.withResolvers<void>()
  const clicked = Promise.withResolvers<void>()
  const stream = {
    connected: true,
    registerCallbackListener(topic: string, listener: (msg: DWClientDownStream) => void) {
      handlers.set(topic, listener)
      return this
    },
    registerAllEventListener() {
      return this
    },
    async connect() {},
    disconnect() {},
    async getAccessToken() {
      return 'isolated-token'
    },
    socketCallBackResponse(id: string) {
      if (id === 'click') clicked.resolve()
    },
  }
  const build = () =>
    new DingtalkChannel({
      name: 'bot',
      clientId: 'local-app',
      clientSecret: 'local-secret',
      cardTemplateId: interactive ? 'local-test.schema' : undefined,
      robotCode: 'test-robot',
      cardStorePath: join(dir, 'state.sqlite'),
      clientFactory: () => stream,
      apiBaseUrl: server.url.origin,
      async onTaskCardAction(action) {
        actions.push(action)
        return authorized
      },
    })
  let channel = build()
  await channel.start()
  channel.setMessageHandler(async () => incoming.resolve())
  channels.set('bot', channel)
  cleanups.push(() => channel.stop())
  const binding = {
    source: 'dingtalk' as const,
    sessionId: 'session',
    channelId: 'cid',
    channelName: 'bot',
    participantId: 'staff',
    updatedAt: new Date().toISOString(),
  }
  const adapter = createDingtalkTaskDelivery({
    channelDefinitions: new Map([
      [
        'bot',
        {
          name: 'bot',
          type: 'dingtalk',
          configured: true,
          receiveNotifications: false,
          secretRefs: [],
          debug: false,
          keepAlive: true,
        },
      ],
    ]),
    channels,
    sessionManager: { listCurrentBindings: () => [binding] },
  })
  // Only a corporate Stream callback can turn a saved session binding into a task destination.
  expect(adapter.listTargets()).toEqual([])
  expect(adapter.listDirectTargets()).toEqual([])
  handlers.get(TOPIC_ROBOT)?.(
    frame(TOPIC_ROBOT, {
      conversationType,
      conversationId: 'cid',
      senderCorpId: 'org',
      chatbotCorpId: 'org',
      senderStaffId: 'staff',
      msgId: 'incoming',
      msgtype: 'text',
      text: { content: 'listen' },
      sessionWebhook: 'http://expired.invalid',
      sessionWebhookExpiredTime: Date.now() + 15 * 60_000,
    }),
  )
  await incoming.promise
  expect(adapter.listTargets()).toHaveLength(1)
  const target: MandateTarget = {
    platform: 'dingtalk',
    channelId: 'bot',
    peerId: 'cid',
    operatorId: 'staff',
  }
  async function restart() {
    await channel.stop()
    channel = build()
    await channel.start()
    channels.set('bot', channel)
  }
  function action(cardId: string, changes: Record<string, unknown> = {}) {
    return frame(
      TOPIC_CARD,
      {
        type: 'actionCallback',
        userIdType: 1,
        corpId: 'org',
        userId: 'staff',
        spaceId,
        spaceType,
        outTrackId: cardId,
        content: JSON.stringify({ cardPrivateData: { actionIds: ['ack'], params: {} } }),
        ...changes,
      },
      'click',
    )
  }
  return {
    get channel() {
      return channel
    },
    adapter,
    target,
    requests,
    actions,
    handlers,
    clicked: clicked.promise,
    spaceId,
    spaceType,
    restart,
    action,
    revoke() {
      authorized = false
    },
    receipt(mode: string) {
      resultType = mode
    },
  }
}

for (const kind of ['1', '2'] as const) {
  test(`DingTalk ${kind} target survives restart/expired webhook, authorizes scoped card action, updates same card`, async () => {
    const f = await fixture(kind)
    setSystemTime(new Date(Date.now() + 2 * 86_400_000))
    cleanups.push(() => {
      setSystemTime()
    })
    await expect(f.channel.reply('cid', 'unused')).rejects.toThrow(
      'No active DingTalk sessionWebhook',
    )
    await f.restart()
    expect(
      f.adapter.listDirectTargets().map<MandateTarget>(({ label, ...target }) => target),
    ).toEqual(kind === '1' ? [f.target] : [])
    const sent = await f.adapter.send(f.target, payload, signal())
    expect(sent).toMatchObject({ status: 'accepted' })
    if (sent.status !== 'accepted' || !sent.receipt) throw Error('Missing card receipt')
    const cardId = sent.receipt
    const create = f.requests[0].body
    expect(create).toMatchObject({
      cardTemplateId: 'local-test.schema',
      callbackType: 'STREAM',
      outTrackId: cardId,
      openSpaceId: `dtv1.card//${f.spaceType}.${f.spaceId}`,
      userIdType: 1,
      cardData: {
        cardParamMap: { title: '#7 发布受阻', summary: '测试构建失败', status: '待跟进' },
      },
    })
    if (kind === '1')
      expect(create).toMatchObject({
        imRobotOpenSpaceModel: { supportForward: false },
        imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' },
      })
    else
      expect(create).toMatchObject({
        imGroupOpenSpaceModel: { supportForward: false },
        imGroupOpenDeliverModel: { robotCode: 'test-robot' },
      })
    await f.restart()
    expect(await f.adapter.send(f.target, payload, signal())).toEqual(sent)
    expect(f.requests).toHaveLength(1)
    for (const changes of [
      { userId: 'other' },
      { corpId: 'foreign' },
      { spaceId: 'forwarded' },
      { userIdType: 2 },
      { outTrackId: 'other' },
      {
        content: JSON.stringify({
          cardPrivateData: { actionIds: ['ack'], params: { taskId: 987 } },
        }),
      },
    ]) {
      expect(await f.channel.taskCards.handle(f.action(cardId, changes))).toBe(false)
    }
    expect(f.actions).toHaveLength(0)
    f.handlers.get(TOPIC_CARD)?.(f.action(cardId))
    await f.clicked
    expect(f.actions).toEqual([
      { peerId: 'cid', actorId: 'staff', messageId: 'click', cardId, taskId: 7, action: 'ack' },
    ])
    expect(f.requests[1]).toEqual({
      path: '/v1.0/card/instances',
      body: {
        outTrackId: cardId,
        cardUpdateOptions: { updateCardDataByKey: true },
        cardData: { cardParamMap: { status: '已跟进 #7' } },
      },
    })
    f.revoke()
    expect(await f.channel.taskCards.handle(f.action(cardId))).toBe(false)
    expect(f.requests).toHaveLength(2)
  })
}

test('checks per-target receipts, retains uncertainty, retries only explicit failures, and checks digest membership', async () => {
  const f = await fixture('2')
  expect(
    await f.adapter.send({ ...f.target, operatorId: 'else' }, payload, signal()),
  ).toMatchObject({ status: 'rejected' })
  expect(
    await f.adapter.send({ ...f.target, operatorId: undefined }, payload, signal()),
  ).toMatchObject({ status: 'rejected' })
  expect(f.requests).toHaveLength(0)
  f.receipt('unknown')
  expect(await f.adapter.send(f.target, payload, signal())).toMatchObject({ status: 'unknown' })
  await f.restart()
  f.receipt('accepted')
  expect(await f.adapter.send(f.target, payload, signal())).toMatchObject({ status: 'unknown' })
  expect(f.requests).toHaveLength(1)
  const digest = {
    id: 'digest-separate',
    digest: true,
    entries: [...payload.entries, { ...payload.entries[0], taskId: 17 }],
  }
  f.receipt('rejected')
  expect(await f.adapter.send(f.target, digest, signal())).toMatchObject({ status: 'rejected' })
  f.receipt('accepted')
  const sent = await f.adapter.send(f.target, digest, signal())
  expect(sent.status).toBe('accepted')
  if (sent.status !== 'accepted' || !sent.receipt) throw Error('Missing digest receipt')
  expect(f.requests[1].body.outTrackId).toBe(f.requests[2].body.outTrackId)
  expect(await f.channel.taskCards.handle(f.action(sent.receipt))).toBe(false)
  expect(
    await f.channel.taskCards.handle(
      f.action(sent.receipt, {
        content: JSON.stringify({
          cardPrivateData: { actionIds: ['ack'], params: { taskId: '17' } },
        }),
      }),
    ),
  ).toBe(true)
})

test('preserves the provider rejection code without exposing the error body', async () => {
  const f = await fixture('1', false)
  f.receipt('forbidden')
  expect(await f.adapter.send(f.target, payload, signal())).toEqual({
    status: 'rejected',
    reason: '钉钉接口返回 HTTP 403（Forbidden.AccessDenied）。 所需权限 Robot.Send。',
  })
})

test('external task facts cannot add links, mentions or a second task to a Markdown reminder', async () => {
  const f = await fixture('2', false)
  const untrusted = {
    ...payload,
    entries: [
      {
        ...payload.entries[0],
        title: '构建失败 [点此修复](https://example.test/track)',
        summary: '![图片](dingtalk://action/test)\n\n**#任务991** @所有人 <at id="all"/>\u202E',
      },
    ],
  }
  expect((await f.adapter.send(f.target, untrusted, signal())).status).toBe('accepted')
  const { text } = JSON.parse(String(f.requests[0].body.msgParam)) as { text: string }
  const lines = text.split('\n\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toStartWith('**#任务7** 构建失败')
  const facts = lines[0].slice('**#任务7** '.length)
  expect(facts).toContain('点此修复')
  expect(facts).not.toMatch(/[\r\n\[\]<>*@\u202E]|[#＃]任务\d|:\/\//u)
  expect(lines[1]).toBe('在本群 @机器人 并回复「#任务7 进展如何」继续。')
})

test('a full Markdown digest keeps every real task reference and short facts within its byte limit', async () => {
  const f = await fixture('1', false)
  const entries = Array.from({ length: 50 }, (_, index) => ({
    ...payload.entries[0],
    taskId: 1000 + index,
    title: '失败',
    summary: '项目信息😀😀'.repeat(500),
  }))
  expect(
    (await f.adapter.send(f.target, { ...payload, digest: true, entries }, signal())).status,
  ).toBe('accepted')
  const { text } = JSON.parse(String(f.requests[0].body.msgParam)) as { text: string }
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4200)
  expect(text).not.toMatch(/\p{Cs}/u)
  for (const entry of entries) expect(text).toContain(`**#任务${entry.taskId}** 失败 · 项目信息`)
})

for (const kind of ['1', '2'] as const) {
  test(`untemplated DingTalk ${kind} reminder uses one selected target and returns native query key`, async () => {
    const f = await fixture(kind, false)
    expect(f.adapter.listTargets()[0].label).toContain('内置 Markdown')
    expect(f.handlers.has(TOPIC_CARD)).toBe(false)
    await f.restart()
    expect(await f.adapter.send(f.target, payload, signal())).toEqual({
      status: 'accepted',
      receipt: 'native-receipt',
    })
    expect(f.requests[0].path).toBe(
      kind === '1' ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send',
    )
    expect(f.requests[0].body).toEqual({
      robotCode: 'test-robot',
      msgKey: 'sampleMarkdown',
      msgParam: expect.any(String),
      ...(kind === '1' ? { userIds: ['staff'] } : { openConversationId: 'cid' }),
    })
    const { text } = JSON.parse(String(f.requests[0].body.msgParam))
    expect(text).toContain('#任务7')
    expect(text).toContain(kind === '1' ? '本私聊' : '本群')
    await f.restart()
    expect(await f.adapter.send(f.target, payload, signal())).toEqual({
      status: 'accepted',
      receipt: 'native-receipt',
    })
    expect(f.requests.length).toBe(1)
    f.receipt('unknown')
    expect(await f.adapter.send(f.target, { ...payload, id: 'unknown' }, signal())).toMatchObject({
      status: 'unknown',
    })
    f.receipt('rejected')
    if (kind === '1')
      expect(
        await f.adapter.send(f.target, { ...payload, id: 'rejected' }, signal()),
      ).toMatchObject({ status: 'rejected' })
  })
}
