import { afterEach, expect, mock, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import type {
  ContentBlock,
  RouterActionName,
  RouterSurfaceAction,
  RouterSurfaceMessages,
  TriggerConversationAnswer,
} from '@zero-os/shared'
import { type RouterAgentInput, createRouterAgent } from '../router-agent'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

const closeAfterTest: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closeAfterTest.splice(0)) await close()
})

function setup(
  reply: (
    input: RouterAgentInput,
    signal?: AbortSignal,
  ) => Promise<TriggerConversationAnswer> = async () => ({
    text: '已根据本事件整理。',
    intent: 'route',
    points: ['请核对记录中的去向。'],
  }),
) {
  const store = new TriggerStore(':memory:')
  const source = 'private-room-fixture'
  const revision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: source, name: 'Fixture', keyword: '', enabled: true }] },
    },
    0,
  )
  store.commitBatch({
    source: 'wxarc',
    stream: `wxarc:${source}`,
    previousCursor: null,
    cursor: '2',
    revision,
    events: ['first-only-secret', 'second-only-secret'].map((summary) => ({
      eventId: summary,
      scope: source,
      title: '匹配的文字',
      summary,
      occurredAt: '2026-11-03T09:00:00Z',
    })),
  })
  const [second, first] = store.listInbox().map((item) => item.id)
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected automatic analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw new Error('Unexpected external delivery')
      },
    },
  })
  const ask = mock(reply)
  const process = mock((id: number) => routing.process(id))
  const catalog = mock(() => routing.listPersonalBots())
  const prepareReminder = mock(routing.prepareDirectReminder.bind(routing))
  const sendReminder = mock(routing.sendDirectReminder.bind(routing))
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      saveConfig: routing.saveConfig.bind(routing),
      listPersonalBots: catalog,
      prepareDirectReminder: prepareReminder,
      sendDirectReminder: sendReminder,
      process,
    },
    ask,
  )
  service.start()
  closeAfterTest.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  return {
    store,
    routing,
    process,
    catalog,
    prepareReminder,
    sendReminder,
    ask,
    service,
    first,
    second,
  }
}

function actionFor(surface: RouterSurfaceMessages, name: RouterActionName): RouterSurfaceAction {
  const { surfaceId, components } = surface[1].updateComponents
  const button = components.find((c) => c.component === 'Button' && c.action.event.name === name)
  if (!button) throw new Error(`Expected ${name} on ${surfaceId}`)
  return {
    version: surface[0].version,
    action: {
      name,
      sourceComponentId: button.id,
      surfaceId,
      context: {},
      timestamp: new Date().toISOString(),
    },
  }
}

test('general and event threads supply only their own event and retained dialogue to the Agent', async () => {
  const { service, first, second, ask } = setup()
  const key = crypto.randomUUID()
  await service.message('general', key, '工作日怎么提醒？')
  await service.message(first, key, '这一条有什么事实？')
  const detail = await service.message(first, crypto.randomUUID(), '继续解释之前的回答。')
  await service.message(second, key, '另一条事件呢？')
  const calls = ask.mock.calls.map(([input]) => input)
  expect(calls[0]).toMatchObject({
    event: null,
    route: null,
    subscriptions: { wxarc: 1, github: 0 },
  })
  expect(JSON.stringify(calls[0])).not.toContain('only-secret')
  expect(calls[1].event?.summary).toBe('first-only-secret')
  expect(JSON.stringify(calls[2])).not.toContain('second-only-secret')
  expect(
    calls[2].history.filter((turn) => turn.status === 'completed').map((turn) => turn.question),
  ).toEqual(['这一条有什么事实？'])
  expect(calls[3].event?.summary).toBe('second-only-secret')
  expect(JSON.stringify(calls[3].history)).not.toContain('这一条有什么事实')
  expect(detail.turns.map((turn) => turn.question)).toEqual([
    '这一条有什么事实？',
    '继续解释之前的回答。',
  ])
  expect(detail.turns[0].surface).not.toBeNull()
  expect(await service.get(first)).toEqual(detail)
  expect((await service.get('general')).turns).toHaveLength(1)
  expect((await service.get(second)).turns).toHaveLength(1)
  expect(await service.listEvents(1, second)).toMatchObject([{ id: first }])
  expect(JSON.stringify(await service.listEvents(2))).not.toContain('only-secret')
  await expect(Promise.resolve().then(() => service.get(9999))).rejects.toMatchObject({
    status: 404,
  })
})

test('an in-flight turn fences conflicting requests and replay never calls the model twice', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const { service, ask, first } = setup(async () => {
    started.resolve()
    await release.promise
    return { text: '完成' }
  })
  const id = crypto.randomUUID()
  const run = service.message(first, id, '第一问')
  await started.promise
  const repeated = service.message(first, id, '第一问')
  try {
    await expect(service.message(first, crypto.randomUUID(), '抢占另一轮')).rejects.toMatchObject({
      status: 409,
    })
    await expect(service.message(first, id, '复用编号改内容')).rejects.toMatchObject({
      status: 409,
    })
    expect((await service.get(first)).turns[0].status).toBe('pending')
  } finally {
    release.resolve()
  }
  await Promise.all([run, repeated])
  await service.message(first, id, '第一问', true)
  expect(ask).toHaveBeenCalledTimes(1)
  expect((await service.get(first)).turns).toHaveLength(1)
})

test('card actions are scoped and a failed card question can be retried explicitly as a message', async () => {
  let fail = true
  const { service, first, second, ask } = setup(async () => {
    if (fail) throw new Error('secret raw provider response')
    return { text: '请核查当前事件。', intent: 'next', points: ['打开这条记录查看来源。'] }
  })
  const action = actionFor((await service.get(first)).surface, 'explain_route')
  const id = crypto.randomUUID()
  await expect(service.action(second, id, action)).rejects.toThrow()
  await expect(
    service.action(first, id, {
      ...action,
      action: { ...action.action, sourceComponentId: 'root' },
    }),
  ).rejects.toThrow()
  expect(ask).not.toHaveBeenCalled()
  await expect(service.action(first, id, action)).rejects.toMatchObject({ status: 502 })
  const failed = (await service.get(first)).turns[0]
  expect(failed).toMatchObject({ status: 'failed', requestId: id, answer: null })
  expect(failed.error).not.toContain('secret raw provider response')
  fail = false
  const result = await service.message(first, id, failed.question, true)
  expect(result.turns).toHaveLength(1)
  expect(result.turns[0]).toMatchObject({ status: 'completed', error: null })
  const replyCard = result.turns[0].surface
  if (!replyCard) throw new Error('Missing follow-up A2UI surface')
  const next = actionFor(replyCard, 'explain_route')
  await service.action(first, crypto.randomUUID(), next)
  expect(ask).toHaveBeenCalledTimes(3)
})

test('a process button can enroll only its original eligible event and cannot replay an uncertain send', async () => {
  const { store, service, routing, process, first, ask } = setup()
  const initial = routing.getConfig()
  const enabled = routing.saveConfig(
    {
      ...initial.settings,
      enabled: true,
      weixinTarget: { channelId: 'fixture', peerId: 'fixture-peer' },
    },
    initial.revision,
  )
  const processAction = actionFor((await service.get(first)).surface, 'process_event')
  const paused = routing.saveConfig({ ...enabled.settings, enabled: false }, enabled.revision)
  await expect(service.action(first, crypto.randomUUID(), processAction)).rejects.toThrow()
  expect(store.routing.get(first)).toBeNull()
  const active = routing.saveConfig(enabled.settings, paused.revision)
  const id = crypto.randomUUID()
  await service.action(first, id, processAction)
  expect(store.routing.get(first)?.status).toBe('pending')
  expect(store.routing.claimAgent(first, 'test-analysis')).toBe(true)
  expect(store.routing.finishAgent(first, 'test-analysis', { summary: '已分析' })).toBe(true)
  expect(
    store.routing.applyDecision(
      first,
      { destination: 'weixin', reason: '测试' },
      active.revision,
      new Date().toISOString(),
    ),
  ).toBe(true)
  expect(store.routing.failSend(first, '结果未知', true)).toBe(true)
  // Replaying the same gesture may return the last snapshot even though the action is no longer offered.
  await service.action(first, id, processAction)
  await expect(service.action(first, crypto.randomUUID(), processAction)).rejects.toThrow()
  expect(store.routing.get(first)?.status).toBe('uncertain')
  expect(process).toHaveBeenCalledTimes(1)
  expect(ask).not.toHaveBeenCalled()
})

test('startup exposes an interrupted turn for explicit retry without automatically invoking the Agent', async () => {
  const { store, routing, service, ask, first } = setup()
  await service.close()
  const key = crypto.randomUUID()
  expect(store.conversations.begin(first, key, '重启前的问题').kind).toBe('started')
  const restarted = new RouterWorkspaceService(store, routing, ask)
  try {
    restarted.start()
    expect((await restarted.get(first)).turns[0]).toMatchObject({
      requestId: key,
      status: 'failed',
    })
    expect(ask).not.toHaveBeenCalled()
    await restarted.message(first, key, '重启前的问题', true)
    expect((await restarted.get(first)).turns.map((turn) => turn.status)).toEqual(['completed'])
    expect(ask).toHaveBeenCalledTimes(1)
  } finally {
    await restarted.close()
  }
})

test('a model proposal only changes a saved preference after a current, explicit card action', async () => {
  const { service, routing, ask } = setup(async (input) => ({
    text: '请确认时段偏好。',
    intent: 'route',
    proposal: { key: 'afterWork', value: input.question === '改为微信' ? 'weixin' : 'web' },
  }))
  const before = routing.getConfig()
  const askProposal = async (text: string) => {
    const snapshot = await service.message('general', crypto.randomUUID(), text)
    const surface = snapshot.turns.at(-1)?.surface
    if (!surface) throw new Error('Expected a proposal surface')
    return surface
  }
  const first = await askProposal('下班用网页')
  expect(routing.getConfig()).toEqual(before)
  const stale = actionFor(first, 'apply_preference')
  const edited = routing.saveConfig({ ...before.settings, presence: 'away' }, before.revision)
  await expect(service.action('general', crypto.randomUUID(), stale)).rejects.toThrow()
  expect(routing.getConfig()).toEqual(edited)

  const proposal = actionFor(await askProposal('重新按当前设置提议'), 'apply_preference')
  const requestId = crypto.randomUUID()
  await service.action('general', requestId, proposal)
  expect(routing.getConfig()).toEqual({
    revision: edited.revision + 1,
    settings: { ...edited.settings, afterWork: 'web' },
  })
  const replayed = await service.action('general', requestId, proposal)
  const accepted = replayed.turns.at(-1)
  expect(accepted?.answer?.proposalAppliedAt).toBeString()
  expect(JSON.stringify(accepted?.surface)).toContain('已确认并保存此偏好')
  expect(accepted?.answer).toEqual((await service.get('general')).turns.at(-1)?.answer)
  await expect(service.action('general', crypto.randomUUID(), proposal)).rejects.toMatchObject({
    status: 409,
  })
  expect(routing.getConfig().revision).toBe(edited.revision + 1)
  const weixin = await askProposal('改为微信')
  // An implementation may omit the button or reject an unbound target on the server.
  const unavailable = {
    ...proposal,
    action: { ...proposal.action, surfaceId: weixin[0].createSurface.surfaceId },
  }
  await expect(service.action('general', crypto.randomUUID(), unavailable)).rejects.toMatchObject({
    status: 409,
  })
  expect(routing.getConfig().settings.afterWork).toBe('web')
  expect(ask).toHaveBeenCalledTimes(3)
})

test.each(['dingtalk', 'feishu'] as const)(
  '%s drafts require the configured sender on confirmation',
  async (platform) => {
    const other = platform === 'feishu' ? 'dingtalk' : 'feishu'
    const { routing, service, catalog, ask } = setup(async () => ({
      text: '请核对离席选项。',
      intent: 'route',
      proposal: { key: 'awayFallback', value: platform },
    }))
    const initial = routing.getConfig()
    const target = {
      platform,
      channelId: 'selected-account',
      label: 'selected bot',
      online: false,
      ready: false,
      deliveryState: 'offline' as const,
    }
    const saved = routing.saveConfig(
      {
        ...initial.settings,
        personalBots: { [platform]: target.channelId },
      },
      initial.revision,
    )
    catalog.mockImplementation(() => [target])
    const result = await service.message('general', crypto.randomUUID(), '请更改离席通知去向')
    const surface = result.turns[0].surface
    if (!surface) throw Error('Expected preference draft')
    const action = actionFor(surface, 'apply_preference')
    expect(ask.mock.calls[0][0].personalBots).toEqual([target])
    expect(routing.getConfig()).toEqual(saved)
    catalog.mockImplementation(() => [{ ...target, platform: other }])
    await expect(service.action('general', crypto.randomUUID(), action)).rejects.toMatchObject({
      status: 409,
    })
    expect(routing.getConfig()).toEqual(saved)
    catalog.mockImplementation(() => [target])
    await service.action('general', crypto.randomUUID(), action)
    expect(routing.getConfig()).toEqual({
      revision: saved.revision + 1,
      settings: { ...saved.settings, awayFallback: platform },
    })
  },
)

test('a named bot choice is revision guarded and saves only the bot while the Router hides legacy addresses', async () => {
  const bot = {
    platform: 'feishu' as const,
    channelId: 'feishu-main',
    label: 'OpenClaw',
    online: false,
    ready: false,
    deliveryState: 'offline' as const,
  }
  const { routing, service, catalog } = setup(async () => ({
    text: '请确认',
    intent: 'route',
    proposal: {
      key: 'personalBot',
      platform: bot.platform,
      value: bot.channelId,
      label: bot.label,
    },
  }))
  const initial = routing.getConfig()
  const weixinTarget = { channelId: 'wx-bot', peerId: 'private-recipient' }
  const before = routing.saveConfig({ ...initial.settings, weixinTarget }, initial.revision)
  catalog.mockReturnValue([bot])
  const snapshot = await service.message(
    'general',
    crypto.randomUUID(),
    '把飞书机器人改为 OpenClaw',
  )
  expect(snapshot.settings.settings.personalBots?.weixin).toBe('wx-bot')
  expect(JSON.stringify(snapshot)).not.toContain('private-recipient')
  const surface = snapshot.turns.at(-1)?.surface
  if (!surface) throw Error('missing confirmation')
  expect(JSON.stringify(surface)).toContain('OpenClaw')
  const action = actionFor(surface, 'apply_preference')
  catalog.mockReturnValue([])
  await expect(service.action('general', crypto.randomUUID(), action)).rejects.toMatchObject({
    status: 409,
  })
  expect(routing.getConfig()).toEqual(before)
  catalog.mockReturnValue([bot])
  const result = await service.action('general', crypto.randomUUID(), action)
  expect(result.settings.settings.personalBots).toMatchObject({
    feishu: bot.channelId,
    weixin: 'wx-bot',
  })
  expect(result.settings.settings.weixinTarget).toBeNull()
  expect(routing.getConfig().settings.weixinTarget).toEqual(weixinTarget)
  expect(JSON.stringify(result.surface)).toContain('离线')
})

const reminderRequest = '发送微信通知，通知我处理 DeepSeek 的充值'
const reminderRecipient = {
  channelId: 'v1ki-bot',
  label: '我的微信',
  audienceKey: 'private-audience-fixture',
}

test('a personal reminder in general chat needs no event, has a private pinned audience and sends only on its card click', async () => {
  const initial = '劳驾把这件事记作一条给我自己的微信草稿吧：处理 DeepSeek 的充值'
  const { service, routing, store, ask, prepareReminder, sendReminder } = setup(async (input) => {
    if (input.question === initial) {
      input.actions?.prepareReminder?.('weixin', '处理 DeepSeek 的充值')
      input.actions?.onToolStep?.('prepare_personal_reminder', true)
    }
    return { text: '已核对', toolSteps: [{ name: 'forged', ok: true }] }
  })
  const source = store.getSettings()
  store.saveSettings(
    { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [] } },
    source.revision,
  )
  const prefs = routing.getConfig()
  const key = crypto.randomUUID()
  prepareReminder.mockReturnValue(reminderRecipient)
  const draft = await service.message('general', key, initial)
  expect(draft.event).toBeNull()
  expect(draft.turns[0].answer?.reminder).toMatchObject({
    platform: 'weixin',
    channelId: 'v1ki-bot',
    status: 'draft',
    text: '处理 DeepSeek 的充值',
  })
  expect(JSON.stringify(draft)).not.toContain(reminderRecipient.audienceKey)
  expect(ask).toHaveBeenCalledTimes(1)
  expect(draft.turns[0].answer?.toolSteps).toEqual([
    { name: 'prepare_personal_reminder', ok: true },
  ])
  expect(sendReminder).not.toHaveBeenCalled()
  expect(store.conversations.get('general', key)?.answer?.reminder?.audienceKey).toBe(
    reminderRecipient.audienceKey,
  )
  const surface = draft.turns[0].surface
  if (!surface) throw Error('Missing reminder card')
  const click = actionFor(surface, 'send_reminder')
  const clickId = crypto.randomUUID()
  const gate = Promise.withResolvers<{ status: 'accepted' }>()
  sendReminder.mockImplementation(async () => gate.promise)
  const delivery = service.action('general', clickId, click)
  try {
    const repeated = await service.action('general', clickId, click)
    expect(repeated.turns[0].answer?.reminder?.status).toBe('sending')
    await expect(service.action('general', crypto.randomUUID(), click)).rejects.toMatchObject({
      status: 409,
    })
    expect(sendReminder).toHaveBeenCalledTimes(1)
    expect(sendReminder.mock.calls[0].slice(0, 4)).toEqual([
      'weixin',
      { channelId: 'v1ki-bot', audienceKey: reminderRecipient.audienceKey },
      '处理 DeepSeek 的充值',
      key,
    ])
  } finally {
    gate.resolve({ status: 'accepted' })
  }
  const accepted = await delivery
  expect(accepted.turns[0].answer?.text).toContain('已受理')
  expect(accepted.turns[0].answer?.reminder?.status).toBe('accepted')
  expect((await service.action('general', clickId, click)).turns[0].answer?.reminder?.status).toBe(
    'accepted',
  )
  expect(routing.getConfig()).toEqual(prefs)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  await service.message('general', crypto.randomUUID(), '刚才的提醒怎么样了？')
  expect(JSON.stringify(ask.mock.calls[1][0].history)).not.toContain(reminderRecipient.audienceKey)
  expect(ask.mock.calls[1][0].history[0].answer?.text).toContain('已受理')
})

test('a previous unsupported request can prepare its own card without rewriting other turns or replaying an external request', async () => {
  const { service, store, first, ask, prepareReminder, sendReminder } = setup()
  const key = crypto.randomUUID()
  expect(store.conversations.begin('general', key, reminderRequest).kind).toBe('started')
  expect(
    store.conversations.finish('general', key, 1, { text: '目前没有这个动作。', intent: 'next' }),
  ).toBe(true)
  const historical = service.get('general').turns[0]
  if (!historical.surface) throw Error('Missing historical prepare card')
  expect(prepareReminder).not.toHaveBeenCalled()
  expect(sendReminder).not.toHaveBeenCalled()
  const click = actionFor(historical.surface, 'prepare_reminder')
  await expect(service.action(first, crypto.randomUUID(), click)).rejects.toMatchObject({
    status: 409,
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  const clickId = crypto.randomUUID()
  const prepared = await service.action('general', clickId, click)
  expect(prepared.turns).toHaveLength(1)
  expect(prepared.turns[0].id).toBe(historical.id)
  expect(prepared.turns[0].answer?.reminder?.status).toBe('draft')
  expect(prepared.turns[0].answer?.text).not.toContain('没有这个动作')
  await service.action('general', clickId, click)
  expect(prepareReminder).toHaveBeenCalledTimes(1)
  expect(sendReminder).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
  if (!prepared.turns[0].surface) throw Error('Missing reminder card')
  const send = actionFor(prepared.turns[0].surface, 'send_reminder')
  sendReminder.mockRejectedValue(new Error('private downstream response'))
  const attempted = await service.action('general', crypto.randomUUID(), send)
  expect(attempted.turns[0].answer?.reminder?.status).toBe('unknown')
  expect(JSON.stringify(attempted)).not.toContain('private downstream')
  await expect(service.action('general', crypto.randomUUID(), send)).rejects.toMatchObject({
    status: 409,
  })
  expect(sendReminder).toHaveBeenCalledTimes(1)
})

test('model output and text inside event discussions cannot authorize a reminder', async () => {
  const { service, first, ask, prepareReminder, sendReminder } = setup(async () => ({
    text: '模型回答',
    reminder: {
      platform: 'weixin',
      channelId: 'injected',
      botLabel: 'injected',
      text: 'injected',
      audienceKey: 'injected',
      status: 'draft',
    },
  }))
  for (const [scope, text] of [
    ['general', '如何配置通知？'],
    [first, reminderRequest],
  ] as const) {
    const snap = await service.message(scope, crypto.randomUUID(), text)
    const turn = snap.turns.at(-1)
    expect(turn?.answer?.reminder).toBeUndefined()
    expect(JSON.stringify(turn?.surface)).not.toContain('send_reminder')
  }
  expect(ask).toHaveBeenCalledTimes(2)
  expect(prepareReminder).not.toHaveBeenCalled()
  expect(sendReminder).not.toHaveBeenCalled()
})

test('a natural-language send tool reserves the current turn before sending and preserves its receipt if the next model step fails', async () => {
  const key = crypto.randomUUID()
  const gate = Promise.withResolvers<{ status: 'accepted' }>()
  const submitted = Promise.withResolvers<void>()
  const q = '这笔 DeepSeek 充值得现在处理，微信给我发一句「记得充值」吧'
  const { service, ask, prepareReminder, sendReminder } = setup(async (input) => {
    const send = input.actions?.sendReminder
    if (!send) throw Error('Missing send tool')
    const receipt = await send('weixin', '记得充值', new AbortController().signal)
    expect(receipt.status).toBe('accepted')
    throw new Error('final provider call timed out')
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockImplementation(async () => {
    submitted.resolve()
    return gate.promise
  })
  const job = service.message('general', key, q)
  await submitted.promise
  try {
    expect(service.get('general').turns[0].answer?.reminder?.status).toBe('sending')
    const replay = await service.message('general', key, q, true)
    expect(replay.turns[0].status).toBe('pending')
    expect(sendReminder).toHaveBeenCalledTimes(1)
  } finally {
    gate.resolve({ status: 'accepted' })
  }
  const finished = await job
  expect(finished.turns[0]).toMatchObject({
    status: 'completed',
    answer: { reminder: { platform: 'weixin', text: '记得充值', status: 'accepted' } },
  })
  expect((await service.message('general', key, q, true)).turns[0].answer?.reminder?.status).toBe(
    'accepted',
  )
  expect(ask).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(finished)).not.toContain(reminderRecipient.audienceKey)
})

test('when the current user asks to send an existing draft its original card and the new turn share one outcome', async () => {
  const { service, prepareReminder, sendReminder } = setup(async (input) => {
    const text = '处理充值'
    if (!input.history.length) input.actions?.prepareReminder?.('weixin', text)
    else {
      const send = input.actions?.sendReminder
      if (!send) throw Error('Missing send tool')
      await send('weixin', text, new AbortController().signal, input.history[0].id)
    }
    return { text: '已处理' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const key = crypto.randomUUID()
  const before = await service.message('general', key, '整理成微信草稿：处理充值')
  const surface = before.turns[0].surface
  if (!surface) throw Error('Missing draft card')
  const original = actionFor(surface, 'send_reminder')
  const done = await service.message('general', crypto.randomUUID(), '现在把上一条草稿发出去')
  expect(done.turns.map((t) => t.answer?.reminder?.status)).toEqual(['accepted', 'accepted'])
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(sendReminder.mock.calls[0][3]).toBe(key)
  await expect(service.action('general', crypto.randomUUID(), original)).rejects.toMatchObject({
    status: 409,
  })
  expect(sendReminder).toHaveBeenCalledTimes(1)
})

test('the normal workspace entry point runs successive model tool calls, feeds a real transport outcome back and persists the verified result', async () => {
  const channel = 'weixin'
  const body = '处理 DeepSeek 充值'
  const question = '我要你现在通过微信给我发这句话：「处理 DeepSeek 充值」'
  let calls = 0
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(request) {
      calls++
      const content: ContentBlock[] = []
      if (calls === 1) {
        expect(request.tools?.map((t) => t.name)).toContain('send_personal_reminder')
        content.push({
          type: 'tool_use',
          name: 'list_notification_bots',
          input: {},
          id: 'bot-directory',
        })
      } else if (calls === 2) {
        const tool = request.messages.at(-1)?.content[0]
        expect(tool?.type === 'tool_result' && tool.content).toContain('我的微信')
        content.push({
          type: 'tool_use',
          name: 'send_personal_reminder',
          input: { platform: channel, text: body },
          id: 'send-tool',
        })
      } else {
        const tool = request.messages.at(-1)?.content[0]
        expect(tool?.type === 'tool_result' && tool.content).toContain('accepted')
        expect(JSON.stringify(request.messages)).not.toContain(reminderRecipient.audienceKey)
        content.push({ type: 'text', text: '{"text":"微信平台已受理。"}' })
      }
      return {
        id: `test-${calls}`,
        model: 'fake',
        content,
        usage: { input: 1, output: 1 },
        stopReason: calls < 3 ? 'tool_use' : 'end_turn',
      }
    },
  }
  const ask = createRouterAgent({
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (v) => v },
  })
  const { service, routing, catalog, prepareReminder, sendReminder } = setup(ask)
  const settings = routing.getConfig()
  routing.saveConfig(
    { ...settings.settings, personalBots: { weixin: reminderRecipient.channelId } },
    settings.revision,
  )
  catalog.mockReturnValue([
    {
      platform: channel,
      channelId: reminderRecipient.channelId,
      label: reminderRecipient.label,
      online: true,
      ready: true,
      deliveryState: 'ready',
    },
  ])
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const id = crypto.randomUUID()
  const answer = (await service.message('general', id, question)).turns[0].answer
  expect(answer?.reminder).toMatchObject({ platform: channel, text: body, status: 'accepted' })
  expect(answer?.toolSteps).toEqual([
    { name: 'list_notification_bots', ok: true },
    { name: 'send_personal_reminder', ok: true },
  ])
  await service.message('general', id, question)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(calls).toBe(3)
})

const routerDm = {
  platform: 'weixin' as const,
  channelId: 'v1ki-bot',
  actorId: 'im-owner',
  peerId: 'im-owner',
  messageId: 'im-upstream-id',
  text: '我的工作日偏好是什么？',
  isDirect: true,
}

test('Router IM retains history only for the authenticated platform, bot, peer and actor', async () => {
  const { service, ask } = setup(async (input) => ({ text: input.question }))
  await service.message('general', crypto.randomUUID(), '只存在于网页主对话')
  const allowed = () => true
  for (const identity of [
    routerDm,
    { ...routerDm, platform: 'feishu' as const },
    { ...routerDm, platform: 'feishu' as const, peerId: 'another-chat' },
    { ...routerDm, platform: 'feishu' as const, actorId: 'another-actor' },
    { ...routerDm, channelId: 'another-bot' },
  ]) {
    expect(await service.handleIm(identity, allowed)).toContain(routerDm.text)
    expect(ask.mock.lastCall?.[0].history).toEqual([])
  }
  const imSessions = ask.mock.calls.slice(1).map(([input]) => input.sessionId)
  expect(new Set(imSessions).size).toBe(5)
  const next = { ...routerDm, messageId: 'next-im-id', text: '接着上一个问题。' }
  await service.handleIm(next, allowed)
  expect(ask.mock.lastCall?.[0].sessionId).toBe(imSessions[0])
  expect(ask.mock.lastCall?.[0].history.map((turn) => turn.question)).toEqual([routerDm.text])
  expect(service.get('general').turns.map((turn) => turn.question)).toEqual(['只存在于网页主对话'])
})

test('Router IM deduplicates concurrent and replayed deliveries across service restarts', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const { service, ask, store, routing } = setup(async () => {
    started.resolve()
    await release.promise
    return { text: '这是唯一一条回复。' }
  })
  const first = service.handleIm(routerDm, () => true)
  await started.promise
  const replay = service.handleIm(routerDm, () => true)
  release.resolve()
  expect((await Promise.all([first, replay])).filter(Boolean)).toEqual(['这是唯一一条回复。'])
  await service.close()
  const restored = new RouterWorkspaceService(store, routing, ask)
  restored.start()
  try {
    expect(await restored.handleIm(routerDm, () => true)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
  } finally {
    await restored.close()
  }
})

test('Router IM refuses groups and revoked access before releasing a model response or an external send', async () => {
  let allowed = false
  const authorized = () => allowed
  const { ask, service, prepareReminder, sendReminder } = setup(async (input) => {
    allowed = false
    await input.actions?.sendReminder?.('weixin', '发送测试', new AbortController().signal)
    return { text: '不得发送这条回复。' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  expect(await service.handleIm(routerDm, authorized)).toBeNull()
  expect(await service.handleIm({ ...routerDm, isDirect: false }, () => true)).toBeNull()
  expect(ask).not.toHaveBeenCalled()
  allowed = true
  expect(
    await service.handleIm({ ...routerDm, text: '现在发微信提醒我发送测试' }, authorized),
  ).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
  expect(sendReminder).not.toHaveBeenCalled()
})

test('an IM reminder draft stays in its private dialogue and confirmation survives delivery replay', async () => {
  const body = '处理充值'
  const { service, ask, prepareReminder, sendReminder } = setup(async (input) => {
    if (input.history.length === 0) {
      input.actions?.prepareReminder?.('weixin', body)
    } else {
      const prior = input.history[0]
      expect(prior.answer?.reminder?.status).toBe('draft')
      expect(prior.answer?.reminder?.audienceKey).toBeUndefined()
      await input.actions?.sendReminder?.('weixin', body, new AbortController().signal, prior.id)
    }
    return { text: '已处理。' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const draft = { ...routerDm, text: '先帮我拟一份微信草稿：处理充值' }
  const confirmation = { ...routerDm, text: '把上一条草稿发出去', messageId: 'confirmation' }
  expect(await service.handleIm(draft, () => true)).toContain(body)
  expect(sendReminder).not.toHaveBeenCalled()
  expect(await service.handleIm(confirmation, () => true)).toContain('受理')
  expect(await service.handleIm(confirmation, () => true)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(2)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(service.get('general').turns).toHaveLength(0)
})

test('a read-only reply cannot leave the Router after ownership changes during the model call', async () => {
  let allowed = true
  const { service, ask } = setup(async () => {
    allowed = false
    return { text: '只应向原收件人展示。' }
  })
  expect(await service.handleIm(routerDm, () => allowed)).toBeNull()
  allowed = true
  expect(await service.handleIm(routerDm, () => allowed)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
})

test('an IM Router turn exposes personal reminder tools and keeps global confirmation cards in the Web workspace', async () => {
  const tools: string[][] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(request) {
      tools.push(request.tools?.map((tool) => tool.name) ?? [])
      const first = tools.length === 1
      const content: ContentBlock[] = first
        ? [
            {
              type: 'tool_use',
              id: 'send',
              name: 'send_personal_reminder',
              input: { platform: 'weixin', text: '处理充值' },
            },
          ]
        : [{ type: 'text', text: '平台已受理。' }]
      if (!first) {
        const result = request.messages.at(-1)?.content[0]
        expect(result?.type === 'tool_result' && result.content).toContain('accepted')
      }
      return {
        id: 'local-test',
        model: 'fake',
        content,
        usage: { input: 1, output: 1 },
        stopReason: first ? 'tool_use' : 'end_turn',
      }
    },
  }
  const { service, prepareReminder, sendReminder } = setup(
    createRouterAgent({
      secretFilter: { filter: (v) => v },
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    }),
  )
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const message = { ...routerDm, text: '现在发微信提醒我处理充值' }
  expect(await service.handleIm(message, () => true)).toContain('受理')
  expect(await service.handleIm(message, () => true)).toBeNull()
  expect(tools[0]).toContain('get_routing_context')
  expect(tools[0]).toContain('send_personal_reminder')
  expect(tools[0]).toContain('prepare_personal_reminder')
  expect(tools[0]).not.toContain('prepare_routing_preference')
  expect(tools[0]).not.toContain('prepare_bot_selection')
  expect(tools[0]).not.toContain('bash')
  expect(tools).toHaveLength(2)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(service.get('general').turns).toHaveLength(0)
})
