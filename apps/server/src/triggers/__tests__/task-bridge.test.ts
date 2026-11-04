import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import { type MandateTarget, type TriggerMandate, sameTriggerRouteTarget } from '@zero-os/shared'
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
  const options = {
    store,
    agent,
    isLiveTarget: () => true,
    isPersonalTarget: (target: MandateTarget) =>
      sameTriggerRouteTarget(
        store.routing.resolveBotTarget(store.routing.getSettings().settings, target.platform),
        target,
      ),
  }
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

function setupPersonalInbox(target = wx) {
  const fixture = setup(target)
  const { store, settings } = fixture
  if (target.platform !== 'weixin') {
    const current = store.routing.getSettings()
    store.routing.saveSettings(
      { ...current.settings, personalBots: { [target.platform]: target.channelId } },
      current.revision,
    )
    store.routing.saveBotBinding(
      target.platform,
      target.channelId,
      target,
      store.routing.getBotBindings().revision,
    )
  }
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
  function receive(eventId: string) {
    store.commitPush({
      source: 'wxarc',
      stream: 'wxarc:legacy',
      events: [{ ...event, scope: 'legacy', eventId }],
      revision: 2,
    })
    const item = store
      .listInbox()
      .find((item) => item.eventId === eventId && item.scope === 'legacy')
    if (!item) throw new Error('expected legacy inbox fixture')
    return item.id
  }
  function claim(inboxId: number) {
    const { revision } = store.routing.getSettings()
    store.routing.enqueue(inboxId)
    expect(store.routing.claimAgent(inboxId, 'agent')).toBe(true)
    expect(store.routing.finishAgent(inboxId, 'agent', { summary: 'private WXARC analysis' })).toBe(
      true,
    )
    expect(
      store.routing.applyDecision(
        inboxId,
        { destination: target.platform, reason: 'test' },
        revision,
        now,
      ),
    ).toBe(true)
  }
  return { ...fixture, receive, claim }
}

for (const platform of ['feishu', 'dingtalk'] as const) {
  test(`${platform} personal listener follow-up uses its text delivery receipt and selected bot independently of task cards`, async () => {
    const target = { platform, channelId: 'bot', peerId: 'original-dm', operatorId: 'owner' }
    const { store, options, agent, input, receive, claim } = setupPersonalInbox(target)
    // Plain text reminders and follow-ups do not require a task-card template.
    const bridge = createTaskBridge({ ...options, isLiveTarget: () => false })
    const id = receive('personal-listener')
    const query = { ...input, isDirect: true, text: `#监听${id} 现在有什么进展？` }
    claim(id)
    const denial = await bridge.handle({ ...query, messageId: 'not-accepted' })
    store.routing.finishSend(id)
    for (const patch of [
      { actorId: 'another-person' },
      { peerId: 'another-dm' },
      { channelId: 'another-bot' },
    ]) {
      expect(await bridge.handle({ ...query, ...patch })).toEqual(denial)
    }
    expect(agent).not.toHaveBeenCalled()
    expect((await bridge.handle(query)).reply).toBe('已收到你的问题。')
    expect(JSON.stringify(agent.mock.calls)).not.toContain('private')
    expect(await bridge.handle(query)).toEqual({ handled: true })
    const replacement = { ...target, peerId: 'new-dm', operatorId: 'new-owner' }
    store.routing.saveBotBinding(
      platform,
      target.channelId,
      replacement,
      store.routing.getBotBindings().revision,
    )
    expect(await bridge.handle({ ...query, messageId: 'old-recipient' })).toEqual(denial)
    expect(
      await bridge.handle({
        ...query,
        peerId: replacement.peerId,
        actorId: replacement.operatorId,
      }),
    ).toEqual(denial)
    expect(agent).toHaveBeenCalledTimes(1)
  })
}

test('iLink bare inbox IDs require a confirmed delivery to this direct peer and ongoing local authorization', async () => {
  const { store, input, agent, bridge, receive, claim } = setupPersonalInbox()
  const inboxId = receive('before-binding')
  const query = { ...input, text: `ZeRo 监听 #${inboxId} 上一条说了什么？` }
  const denied = await bridge.handle({ ...query, messageId: 'before-delivery' })
  expect(agent).not.toHaveBeenCalled()
  claim(inboxId)
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

test('iLink follow-up requires the selected bot and its current channel-side default as well as the original recipient', async () => {
  const { store, bridge, input, receive, claim } = setupPersonalInbox()
  const routing = store.routing
  const replacement = { ...wx, peerId: 'new-peer', operatorId: 'new-peer' }
  const otherBot = { ...replacement, channelId: 'another-account' }
  function bind(bot: MandateTarget, target: MandateTarget | null) {
    routing.saveBotBinding('weixin', bot.channelId, target, routing.getBotBindings().revision)
  }
  const ask = (inboxId: number, who: MandateTarget, messageId: string) =>
    bridge.handle({
      ...input,
      channelId: who.channelId,
      peerId: who.peerId,
      actorId: who.peerId,
      messageId,
      text: `#监听${inboxId} 进展？`,
    })
  const legacyId = receive('legacy-recipient')
  claim(legacyId)
  routing.finishSend(legacyId)
  const allowed = await ask(legacyId, wx, 'legacy')
  const denied = await ask(legacyId, replacement, 'wrong-peer')
  expect(allowed.reply).toBe('已收到你的问题。')
  expect(denied).not.toEqual(allowed)

  bind(wx, replacement)
  expect(await ask(legacyId, wx, 'replaced')).toEqual(denied)
  expect(await ask(legacyId, replacement, 'previous-receipt')).toEqual(denied)
  const newId = receive('new-recipient')
  claim(newId)
  routing.finishSend(newId)
  expect(await ask(newId, replacement, 'current')).toEqual(allowed)
  bind(wx, null)
  expect(await ask(newId, replacement, 'unbound')).toEqual(denied)
  bind(wx, replacement)
  bind(otherBot, otherBot)
  const current = routing.getSettings()
  routing.saveSettings(
    { ...current.settings, personalBots: { weixin: otherBot.channelId } },
    current.revision,
  )
  expect(await ask(newId, replacement, 'old-bot')).toEqual(denied)
  expect(await ask(newId, otherBot, 'different-bot-same-peer')).toEqual(denied)
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

test('a personal reply is withheld if the selected bot loses its recipient during the question', async () => {
  const { options, store, input, receive, claim } = setupPersonalInbox({
    platform: 'feishu',
    channelId: 'bot',
    peerId: 'original-dm',
    operatorId: 'owner',
  })
  const id = receive('recipient-changes')
  claim(id)
  store.routing.finishSend(id)
  const result = Promise.withResolvers<string>()
  let available = true
  const bridge = createTaskBridge({
    ...options,
    agent: () => result.promise,
    isPersonalTarget: (target) => available && options.isPersonalTarget(target),
  })
  const response = bridge.handle({ ...input, isDirect: true, text: `#监听${id} 进展？` })
  available = false
  result.resolve('obsolete private answer')
  expect(await response).toEqual({ handled: true })
  expect(store.conversations.list(id).at(-1)?.status).toBe('failed')
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

test('selected bots claim ordinary text, slash commands, recalls and media without diverting other bots', async () => {
  const { options, store } = setup(wx)
  store.routing.saveSettings(
    { ...store.routing.getSettings().settings, personalBots: { weixin: wx.channelId } },
    store.routing.getSettings().revision,
  )
  const handle = mock(async () => 'Router 的答复。')
  const bridge = createTaskBridge({
    ...options,
    personalDialog: {
      authorize: (target) => (sameTriggerRouteTarget(target, wx) ? () => true : null),
      handle,
    },
  })
  const adapter = { reply: mock(async () => {}), showTyping: async () => null }
  const channel = {
    channelName: wx.channelId,
    channelType: 'weixin' as const,
    channelAdapter: adapter,
  }
  const dm = {
    channelType: 'weixin',
    senderId: wx.peerId,
    timestamp: now,
    metadata: { messageId: 'a', chatType: 'dm', chatId: wx.peerId, routerDirect: true },
    content: '引用中的其他内容',
    commandText: '看看我的 GitHub 里面的仓库',
  }
  for (const text of [dm.commandText, '/new']) {
    expect(await dispatchRouterCommand({ ...dm, commandText: text }, channel, bridge)).toBe(true)
    expect(handle).toHaveBeenLastCalledWith(expect.objectContaining({ text }), expect.any(Function))
  }
  const media = { ...dm, commandText: '', metadata: { ...dm.metadata, messageId: 'image' } }
  expect(await dispatchRouterCommand(media, channel, bridge)).toBe(true)
  expect(handle).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: '' }),
    expect.any(Function),
  )
  for (const msg of [
    { ...dm, eventType: 'message_recalled' as const },
    { ...dm, senderId: 'other' },
    { ...dm, commandText: '#任务1 确认', metadata: { ...dm.metadata, routerDirect: false } },
  ])
    expect(await dispatchRouterCommand(msg, channel, bridge)).toBe(true)
  expect(handle).toHaveBeenCalledTimes(3)
  expect(adapter.reply).toHaveBeenCalledTimes(3)
  expect(await dispatchRouterCommand(dm, { ...channel, channelName: 'another' }, bridge)).toBe(
    false,
  )
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
