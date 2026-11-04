import { expect, spyOn, test } from 'bun:test'
import { type Channel, DingtalkChannel, FeishuChannel, WeixinChannel } from '@zero-os/channel'
import { createMandatePlatforms } from '../mandate-platforms'

function weixinFixture(result: 'accepted' | 'uncertain') {
  const messages: string[] = []
  const channel = Object.assign(Object.create(WeixinChannel.prototype), {
    canSendReminderTo: (peer: string) => peer === 'self',
    sendReminderWithReceipt: async (_peer: string, text: string) => {
      messages.push(text)
      return { status: result, reason: 'fixture' }
    },
  })
  const bindings = [
    {
      source: 'weixin',
      channelName: 'personal',
      channelId: 'self',
      sessionId: 'bound',
      updatedAt: new Date().toISOString(),
    },
  ]
  const host = {
    channels: new Map([['personal', channel]]),
    channelDefinitions: new Map([['personal', { type: 'weixin', configured: true }]]),
    sessionManager: { listCurrentBindings: () => bindings },
  } as Parameters<typeof createMandatePlatforms>[0]
  const platforms = createMandatePlatforms(host)
  return { platforms, messages, bindings }
}

test('detached Router bots keep only the authorized verified private task recipient', async () => {
  const feishu = new FeishuChannel({ name: 'feishu', appId: 'fixture', appSecret: 'fixture' })
  const ding = new DingtalkChannel({
    name: 'dingtalk',
    clientId: 'fixture',
    clientSecret: 'fixture',
  })
  for (const channel of [feishu, ding]) spyOn(channel, 'isConnected').mockReturnValue(true)
  feishu.directPeers.recordVerifiedDirect('oc_self', 'ou_self')
  feishu.directPeers.recordVerifiedDirect('oc_other', 'ou_other')
  for (const [conversationId, conversationType] of [
    ['self', '1'],
    ['group', '2'],
  ])
    ding.taskCards.remember({
      conversationId,
      conversationType,
      chatbotCorpId: 'org',
      senderStaffId: 'staff',
      senderCorpId: 'org',
    })
  const feishuSend = spyOn(feishu.router, 'send').mockResolvedValue({
    status: 'accepted',
    receipt: 'om_fixture',
  })
  const dingSend = spyOn(ding.taskCards, 'send').mockResolvedValue('receipt')
  const wx = new WeixinChannel({
    name: 'weixin',
    accountId: 'fixture',
    token: 'fixture',
    homeDir: '/unused',
  })
  spyOn(wx, 'listReminderPeers').mockReturnValue(['wx_self'])
  spyOn(wx, 'sendReminderWithReceipt').mockResolvedValue({ status: 'accepted' })
  const channels = new Map<string, Channel>(
    [wx, feishu, ding].map((channel) => [channel.name, channel]),
  )
  let selected = true
  const platforms = createMandatePlatforms(
    {
      channels,
      sessionManager: { listCurrentBindings: () => [] },
      channelDefinitions: new Map(
        [wx, feishu, ding].map(({ type, name }) => [
          name,
          { type, name, configured: true, receiveNotifications: false, secretRefs: [] },
        ]),
      ),
    },
    (target) => selected && ['wx_self', 'ou_self', 'staff'].includes(target.operatorId ?? ''),
  )
  const targets = platforms.listTargets()
  expect(targets.map((t) => t.peerId)).toEqual(['wx_self', 'oc_self', 'self'])
  const signal = new AbortController().signal
  const payload = {
    id: 'task',
    digest: false,
    entries: [{ taskId: 1, matchId: 1, inboxId: 1, title: 'title', summary: 'summary' }],
  }
  for (const target of targets) {
    expect(platforms.isLiveTarget(target)).toBe(true)
    expect((await platforms.send(target, payload, signal)).status).toBe('accepted')
    expect(platforms.isLiveTarget({ ...target, operatorId: 'stranger' })).toBe(false)
  }
  selected = false
  expect(platforms.listTargets()).toEqual([])
  expect(feishuSend.mock.calls[0][3]?.()).toBe(false)
  expect(dingSend.mock.calls[0][4]?.()).toBe(false)
  for (const target of targets)
    expect((await platforms.send(target, payload, signal)).status).toBe('rejected')
  ding.taskCards.close()
  feishu.directPeers.close()
})

test('matches the current sender binding exactly and never sends to an unbound operator', async () => {
  const { platforms, messages, bindings } = weixinFixture('accepted')
  const target = {
    platform: 'weixin' as const,
    channelId: 'personal',
    peerId: 'self',
    operatorId: 'self',
  }
  const payload = {
    id: 'delivery',
    digest: false,
    entries: [{ taskId: 1, matchId: 1, inboxId: 1, title: '标题', summary: '已确认的摘要' }],
  }
  expect(platforms.isLiveTarget(target)).toBe(true)
  expect(platforms.isLiveTarget({ ...target, operatorId: undefined })).toBe(false)
  expect(platforms.isLiveTarget({ ...target, operatorId: 'another' })).toBe(false)
  expect(
    (
      await platforms.send(
        { ...target, operatorId: 'another' },
        payload,
        new AbortController().signal,
      )
    ).status,
  ).toBe('rejected')
  expect(
    (await platforms.send(target, payload, new AbortController().signal, () => false)).status,
  ).toBe('rejected')
  expect(messages).toEqual([])
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'accepted',
  )
  expect(messages[0]).toContain('#任务1')
  expect(messages[0]).toContain('已确认的摘要')
  bindings.splice(0)
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'rejected',
  )
  expect(messages).toHaveLength(1)
})

test('bounds a digest while retaining every task reference and propagates unknown receipt', async () => {
  const { platforms, messages } = weixinFixture('uncertain')
  const target = platforms.listTargets()[0]
  const entries = Array.from({ length: 50 }, (_, index) => ({
    taskId: index + 1,
    matchId: index + 1,
    inboxId: index + 1,
    title: '标题',
    summary: '内容'.repeat(500),
  }))
  const payload = { id: 'batch', digest: true, entries }
  const cancelled = new AbortController()
  cancelled.abort()
  expect((await platforms.send(target, payload, cancelled.signal)).status).toBe('rejected')
  expect(messages).toHaveLength(0)
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'unknown',
  )
  expect(messages[0].length).toBeLessThan(4000)
  for (const entry of entries) expect(messages[0]).toContain(`#任务${entry.taskId} `)
})

test('the personal bot directory includes configured accounts before they have any conversations', () => {
  const account = {
    type: 'feishu' as const,
    configured: true,
    receiveNotifications: false,
    secretRefs: [],
  }
  const channel = new FeishuChannel({ name: 'connected', appId: 'fixture', appSecret: 'fixture' })
  spyOn(channel, 'isConnected').mockReturnValue(true)
  const platforms = createMandatePlatforms({
    channels: new Map([['connected', channel]]),
    channelDefinitions: new Map([
      ['connected', { ...account, name: '办公机器人' }],
      ['offline', { ...account, name: '第二个机器人' }],
      ['unfinished', { ...account, configured: false, name: '未配置' }],
    ]),
    sessionManager: { listCurrentBindings: () => [] },
  })
  expect(platforms.listPersonalBots()).toEqual([
    { platform: 'feishu', channelId: 'connected', label: '办公机器人', online: true },
    { platform: 'feishu', channelId: 'offline', label: '第二个机器人', online: false },
  ])
  expect(platforms.listPersonalTargets()).toEqual([])
  expect(platforms.listPersonalDirectTargets()).toEqual([])
})

test('personal notifications keep WXARC material local and identify the listener in its chosen chat', async () => {
  const channel = new FeishuChannel({ name: 'office', appId: 'fixture', appSecret: 'fixture' })
  spyOn(channel, 'isConnected').mockReturnValue(true)
  spyOn(channel.directPeers, 'list').mockReturnValue([
    { chatId: 'oc_chat', actorId: 'ou_selected' },
  ])
  const send = spyOn(channel.router, 'sendListenerReminder').mockResolvedValue({
    status: 'accepted',
    receipt: 'receipt',
  })
  const host = {
    channels: new Map([['office', channel]]),
    channelDefinitions: new Map([
      [
        'office',
        {
          type: 'feishu',
          configured: true,
          name: 'office',
          receiveNotifications: false,
          secretRefs: [],
        },
      ],
    ]),
    sessionManager: {
      listCurrentBindings: () => [
        {
          source: 'feishu' as const,
          channelName: 'office',
          channelId: 'oc_legacy',
          participantId: 'ou_selected',
          sessionId: 'session',
          updatedAt: '',
        },
      ],
    },
  } satisfies Parameters<typeof createMandatePlatforms>[0]
  const platforms = createMandatePlatforms(host)
  const [target] = platforms.listPersonalDirectTargets()
  expect(target.peerId).toBe('oc_chat')
  expect(platforms.listPersonalTargets().map((entry) => entry.peerId)).toEqual([
    'oc_legacy',
    'oc_chat',
  ])
  expect(platforms.isLiveTarget(target)).toBe(false)
  expect(platforms.isLiveTarget(target, true)).toBe(true)
  const event = {
    id: 24,
    eventId: 'private-event-id',
    source: 'wxarc' as const,
    scope: 'private-room',
    summary: 'private-text',
    title: 'private-title',
    occurredAt: '',
    receivedAt: '',
  }
  const agent = { summary: 'private-analysis' }
  const signal = new AbortController().signal
  expect(
    (
      await platforms.sendPersonal(
        { ...target, operatorId: 'ou_other' },
        event,
        agent,
        signal,
        () => true,
      )
    ).status,
  ).toBe('rejected')
  expect((await platforms.sendPersonal(target, event, agent, signal, () => false)).status).toBe(
    'rejected',
  )
  expect(send).not.toHaveBeenCalled()
  expect((await platforms.sendPersonal(target, event, agent, signal, () => true)).status).toBe(
    'accepted',
  )
  const [chat, id, text, , maySend] = send.mock.calls[0]
  expect([chat, id]).toEqual(['oc_chat', 24])
  expect(text).toContain('#24')
  expect(text).not.toMatch(/private-|#任务/)
  expect(maySend()).toBe(true)
  host.channels.delete('office')
  expect(maySend()).toBe(false)
})
