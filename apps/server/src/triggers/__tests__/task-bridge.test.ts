import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { MandateTarget, TriggerMandate } from '@zero-os/shared'
import { dispatchRouterCommand } from '../../runtime/channel-runtime/runtime-common'
import { type TaskMessage, createTaskBridge } from '../task-bridge'

const now = new Date().toISOString()
const ding: MandateTarget = {
  platform: 'dingtalk',
  channelId: 'work',
  peerId: 'group',
  operatorId: 'owner',
}
const wx: MandateTarget = {
  platform: 'weixin',
  channelId: 'personal',
  peerId: 'owner',
  operatorId: 'owner',
}
const event = {
  eventId: 'test',
  scope: 'room',
  title: 'private room name',
  summary: 'private source content',
  occurredAt: now,
}
const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup(target = ding, withSibling = false) {
  const store = new TriggerStore(':memory:')
  stores.push(store)
  const settings = {
    github: { credentialRef: '', repositories: [] },
    wxarc: { sessions: [{ id: 'room', name: 'private room', enabled: true, keyword: '' }] },
  }
  store.saveSettings(settings, 0)
  store.routing.saveSettings(
    {
      ...store.routing.getSettings().settings,
      enabled: true,
      weixinTarget: { channelId: 'personal', peerId: 'owner' },
    },
    0,
  )
  const mandate: TriggerMandate = {
    id: 'tracked',
    enabled: true,
    source: 'wxarc',
    scope: 'room',
    name: 'watch',
    keyword: '',
    purpose: 'track',
    groupBy: 'mandate',
    projectId: null,
    deadline: null,
    urgent: false,
    targets: [target],
    archive: null,
    policy: {},
  }
  const mandates = withSibling
    ? [mandate, { ...mandate, id: 'research', purpose: 'research' }]
    : [mandate]
  store.mandates.saveSettings({ projects: [], mandates }, 0)
  store.commitPush({ source: 'wxarc', stream: 'wxarc:room', events: [event], revision: 1 })
  const analysis = store.mandates.claimAnalysis('private-session')
  if (!analysis) throw new Error('missing match')
  const { match } = analysis
  store.mandates.finishAnalysis(match.id, 'private model summary', analysis.claimToken)
  const out = store.mandates.claimEffect(match.id, 'notify', target.platform, target, 'test', now)
  expect(out.length).toBe(1)
  const input: TaskMessage = {
    platform: target.platform,
    channelId: target.channelId,
    peerId: target.peerId,
    actorId: target.operatorId ?? '',
    messageId: 'message',
    isDirect: target.platform === 'weixin',
    text: `#任务${match.taskId} 最新进展？`,
  }
  const agent = mock(
    async (_context: Parameters<Parameters<typeof createTaskBridge>[0]['agent']>[0]) =>
      '已收到你的问题。',
  )
  const options = { store, agent, isLiveTarget: () => true }
  const bridge = createTaskBridge(options)
  return {
    store,
    bridge,
    input,
    taskId: match.taskId,
    matchId: match.id,
    inboxId: match.inboxId,
    agent,
    options,
    settings,
  }
}

test('only delivered tasks at the exact channel, conversation and actor allow IM follow-up; private source and Web history stay local', async () => {
  const { store, input, taskId, matchId, inboxId, agent, bridge, options } = setup()
  const early = { ...input, messageId: 'early' }
  const denial = await bridge.handle(early)
  expect(await bridge.handle({ ...input, messageId: 'guess', text: '#任务999 进展？' })).toEqual(
    denial,
  )
  expect(agent).not.toHaveBeenCalled()
  expect(store.mandates.finishEffect(matchId, 'notify', 'done', 'original-card')).toBe(true)
  expect(await bridge.handle(early)).toEqual({ handled: true })
  for (const patch of [
    { actorId: 'observer' },
    { peerId: 'another-room' },
    { channelId: 'another-bot' },
    { messageId: '' },
  ]) {
    expect(await bridge.handle({ ...input, ...patch })).toEqual(denial)
  }
  const web = store.conversations.begin(inboxId, 'web-request', 'private browser question')
  if (web.kind !== 'started') throw new Error('missing turn')
  store.conversations.finish(inboxId, 'web-request', web.attempt, {
    text: 'private browser answer',
  })
  expect((await bridge.handle(input)).reply).toBe('已收到你的问题。')
  expect(agent).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(agent.mock.calls[0])).not.toContain('private ')
  expect(store.conversations.list(inboxId).map((t) => t.question)).toEqual([
    'private browser question',
  ])
  expect(store.conversations.list(`task-${taskId}`).map((t) => t.question)).toEqual(['最新进展？'])
  expect(await createTaskBridge(options).handle(input)).toEqual({ handled: true })
  await bridge.handle({ ...input, messageId: 'followup', text: `#task ${taskId} 上一条呢？` })
  expect(agent.mock.calls[1]?.[0].history.map((t) => t.question)).toEqual(['最新进展？'])
  expect(await bridge.handle({ ...input, messageId: 'hello', text: '你好' })).toEqual({
    handled: false,
  })
  await bridge.handle({ ...input, messageId: 'pause', text: `#任务${taskId} 暂停` })
  expect(store.mandates.getTask(taskId)?.paused).toBe(true)
})

test('card acknowledgement requires the recorded native receipt even in the right chat; replays are idempotent', async () => {
  const { store, input, taskId, matchId, bridge } = setup()
  store.mandates.finishEffect(matchId, 'notify', 'done', 'original-card')
  const action = { ...input, taskId, cardId: 'original-card', action: 'ack' as const }
  for (const patch of [
    { cardId: 'forwarded-copy' },
    { actorId: 'observer' },
    { channelId: 'duplicate-bot' },
    { peerId: 'other-group' },
    { taskId: 42 },
  ]) {
    expect(await bridge.card({ ...action, ...patch })).toBe(false)
  }
  expect(store.mandates.getTask(taskId)?.acknowledgedAt).toBeNull()
  expect(await bridge.card(action)).toBe(true)
  expect(await bridge.card(action)).toBe(true)
  expect(await bridge.card({ ...action, messageId: 'second-click' })).toBe(true)
  expect(store.mandates.listAudit().filter((entry) => entry.action === 'ack')).toHaveLength(1)
  expect(store.mandates.getTask(taskId)?.acknowledgedAt).not.toBeNull()
  store.mandates.saveSettings({ projects: [], mandates: [] }, 1)
  expect(await bridge.card(action)).toBe(false)
})

test('iLink bare inbox IDs require a confirmed delivery to this direct peer and ongoing local authorization', async () => {
  const { store, input, agent, bridge, settings } = setup(wx)
  store.saveSettings(
    {
      ...settings,
      wxarc: {
        sessions: [
          ...settings.wxarc.sessions,
          { id: 'legacy', name: 'legacy room', enabled: true, keyword: '' },
        ],
      },
    },
    1,
  )
  store.commitPush({
    source: 'wxarc',
    stream: 'wxarc:legacy',
    events: [{ ...event, scope: 'legacy' }],
    revision: 2,
  })
  const inboxId = store.listInbox().find((item) => item.scope === 'legacy')?.id
  if (!inboxId) throw new Error('expected legacy inbox fixture')
  const query = { ...input, text: `ZeRo 监听 #${inboxId} 上一条说了什么？` }
  const denied = await bridge.handle({ ...query, messageId: 'before-delivery' })
  expect(agent).not.toHaveBeenCalled()
  store.routing.enqueue(inboxId)
  expect(store.routing.claimAgent(inboxId, 'agent')).toBe(true)
  expect(store.routing.finishAgent(inboxId, 'agent', { summary: 'private WXARC analysis' })).toBe(
    true,
  )
  expect(
    store.routing.applyDecision(inboxId, { destination: 'weixin', reason: 'test' }, 1, now),
  ).toBe(true)
  expect(await bridge.handle({ ...query, messageId: 'before-receipt' })).toEqual(denied)
  expect(store.routing.finishSend(inboxId)).toBe(true)
  for (const patch of [
    { actorId: 'stranger' },
    { isDirect: false },
    { peerId: 'other' },
    { channelId: 'another-account' },
  ]) {
    expect(await bridge.handle({ ...query, ...patch })).toEqual(denied)
  }
  expect((await bridge.handle(query)).reply).toBe('已收到你的问题。')
  expect(JSON.stringify(agent.mock.calls)).not.toContain('private')
  const config = store.routing.getSettings()
  store.routing.saveSettings({ ...config.settings, weixinTarget: null }, config.revision)
  expect(await bridge.handle({ ...query, messageId: 'new' })).toEqual(denied)
})

test('revoking a receiver during a model turn prevents the outbound reply', async () => {
  const { store, input, matchId, taskId, options } = setup()
  store.mandates.finishEffect(matchId, 'notify', 'done', 'original-card')
  const result = Promise.withResolvers<string>()
  const bridge = createTaskBridge({ ...options, agent: () => result.promise })
  const pending = bridge.handle(input)
  await Promise.resolve()
  store.mandates.saveSettings({ projects: [], mandates: [] }, 1)
  result.resolve('must not leave')
  expect(await pending).toEqual({ handled: true })
  expect(store.conversations.list(`task-${taskId}`).at(-1)?.status).toBe('failed')
})

test('Feishu commission commands receive the authenticated identity and repeated ingress replies only once', async () => {
  const feishu: MandateTarget = { ...ding, platform: 'feishu', operatorId: 'ou_12' }
  const { input, options } = setup(feishu)
  const commission = { handleIm: mock(async () => '请确认这条委托草案。') }
  const bridge = createTaskBridge({ ...options, commission })
  const command = { ...input, text: '跟踪这个项目接下来的发布' }
  const result = await bridge.handle(command)
  expect(result.reply).toBe('请确认这条委托草案。')
  expect(commission.handleIm).toHaveBeenCalledWith(
    { ...feishu, isDirect: false },
    input.messageId,
    command.text,
    expect.any(AbortSignal),
  )
  expect(await createTaskBridge({ ...options, commission }).handle(command)).toEqual({
    handled: true,
  })
  expect(commission.handleIm).toHaveBeenCalledTimes(1)
  expect(
    await bridge.handle({ ...command, messageId: 'ordinary', text: '项目进展如何？' }),
  ).toEqual({ handled: false })
  const unknown = await bridge.handle({ ...command, actorId: 'unknown' })
  expect(unknown.handled).toBe(true)
  expect(commission.handleIm).toHaveBeenCalledTimes(1)
})

test('the channel entry point replies in the authenticated origin and ignores commands found only in quotes', async () => {
  const { store, bridge, input, matchId } = setup()
  store.mandates.finishEffect(matchId, 'notify', 'done', 'original-card')
  const adapter = { reply: mock(async () => {}), showTyping: async () => null }
  const channel = {
    channelName: input.channelId,
    channelType: 'dingtalk' as const,
    channelAdapter: adapter,
  }
  const incoming = {
    channelType: 'dingtalk',
    senderId: input.actorId,
    timestamp: now,
    metadata: { messageId: input.messageId, chatId: input.peerId, conversationType: 2 },
    content: `> 引用: 旧消息\n${input.text}`,
    commandText: input.text,
  }
  expect(await dispatchRouterCommand(incoming, channel, bridge)).toBe(true)
  expect(adapter.reply).toHaveBeenCalledWith(input.peerId, '已收到你的问题。', input.messageId)
  expect(await dispatchRouterCommand(incoming, channel, bridge)).toBe(true)
  expect(adapter.reply).toHaveBeenCalledTimes(1)
  expect(
    await dispatchRouterCommand(
      { ...incoming, content: input.text, commandText: '今天好吗？' },
      channel,
      bridge,
    ),
  ).toBe(false)
  expect(
    await dispatchRouterCommand({ ...incoming, eventType: 'message_recalled' }, channel, bridge),
  ).toBe(false)
  expect(await dispatchRouterCommand(incoming, channel)).toBe(true)
  expect(
    await dispatchRouterCommand(
      { ...incoming, metadata: {}, senderId: input.peerId },
      channel,
      bridge,
    ),
  ).toBe(true)
  expect(adapter.reply).toHaveBeenCalledTimes(1)
})

test('IM follows the referenced task across later events and cannot read local or sibling task turns', async () => {
  const { store, bridge, agent, input, matchId, taskId, inboxId } = setup(ding, true)
  store.mandates.finishEffect(matchId, 'notify', 'done', 'work-card')
  const sibling = store.mandates.claimAnalysis('sibling')
  if (!sibling) throw new Error('missing sibling mandate')
  expect(sibling.match.inboxId).toBe(inboxId)
  const otherId = sibling.task.id
  expect(otherId).not.toBe(taskId)
  store.mandates.finishAnalysis(sibling.match.id, 'sibling summary', sibling.claimToken)
  store.mandates.claimEffect(sibling.match.id, 'notify', ding.platform, ding, 'fixture', now)
  store.mandates.finishEffect(sibling.match.id, 'notify', 'done', 'research-card')
  const scope = `task-${taskId}` as const
  const local = store.conversations.begin(scope, 'owner-web', 'a private note in the same task')
  if (local.kind !== 'started') throw new Error('missing task web question')
  store.conversations.finish(scope, 'owner-web', local.attempt, { text: 'owner-only response' })
  await bridge.handle({ ...input, messageId: 'a', text: `#任务${taskId} 关于工作` })
  await bridge.handle({ ...input, messageId: 'b', text: `#任务${otherId} 关于研究` })
  expect(agent.mock.calls[0]?.[0].history).toEqual([])
  expect(agent.mock.calls[1]?.[0].history).toEqual([])
  store.commitPush({
    source: 'wxarc',
    stream: 'wxarc:room',
    revision: 1,
    events: [{ ...event, eventId: 'followup' }],
  })
  expect(store.mandates.getTask(taskId)?.eventCount).toBe(2)
  await bridge.handle({ ...input, messageId: 'a2', text: `#任务${taskId} 继续跟进` })
  expect(agent.mock.calls[2]?.[0].history.map((turn) => turn.question)).toEqual(['关于工作'])
  expect(store.conversations.list(scope).map((turn) => turn.question)).toEqual([
    'a private note in the same task',
    '关于工作',
    '继续跟进',
  ])
  expect(store.conversations.list(`task-${otherId}`).map((turn) => turn.question)).toEqual([
    '关于研究',
  ])
  expect(store.conversations.list(inboxId)).toEqual([])
})
