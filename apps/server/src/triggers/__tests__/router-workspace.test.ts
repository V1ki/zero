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
import { discardedEvents } from './router-log-fixture'

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
  const service = new RouterWorkspaceService(
    store,
    { getConfig: () => routing.getConfig(), listPersonalBots: catalog, process },
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

test('the general surface shows selected bots while the Router hides legacy addresses', async () => {
  const bot = {
    platform: 'feishu' as const,
    channelId: 'feishu-main',
    label: 'OpenClaw',
    online: false,
    ready: false,
    deliveryState: 'offline' as const,
  }
  const { routing, service, catalog } = setup()
  const initial = routing.getConfig()
  const weixinTarget = { channelId: 'wx-bot', peerId: 'private-recipient' }
  routing.saveConfig(
    { ...initial.settings, weixinTarget, personalBots: { feishu: bot.channelId } },
    initial.revision,
  )
  catalog.mockReturnValue([bot])
  const snapshot = await service.message('general', crypto.randomUUID(), '现在的通知去哪？')
  expect(snapshot.settings.settings.personalBots).toMatchObject({
    feishu: bot.channelId,
    weixin: 'wx-bot',
  })
  expect(snapshot.settings.settings.weixinTarget).toBeNull()
  expect(JSON.stringify(snapshot)).not.toContain('private-recipient')
  expect(JSON.stringify(snapshot.surface)).toContain('OpenClaw（离线）')
})

test('answers stored by removed chat features render as their text and never reach the client or model with private fields', async () => {
  const { service, store, ask } = setup(async () => ({ text: '继续。' }))
  const legacy: Array<[string, Record<string, unknown>]> = [
    [
      'reminder',
      {
        text: '平台已受理这条提醒。',
        reminder: {
          platform: 'weixin',
          channelId: 'bot',
          botLabel: '我的微信',
          text: '处理充值',
          audienceKey: 'private-audience-fixture',
          status: 'draft',
        },
      },
    ],
    [
      'proposal',
      {
        text: '请核对卡片中的通知偏好。',
        intent: 'route',
        proposal: { key: 'offDay', value: 'defer' },
        proposalRevision: 1,
      },
    ],
    [
      'commission',
      {
        text: '请核对委托范围。',
        commission: { code: 'private-code', title: '跟踪', details: [], expiresAt: 1 },
      },
    ],
    [
      'repositories',
      {
        text: '1. org/private',
        repositories: { page: 1, repositories: ['org/private'], nextPage: 2 },
        workAccess: { github: true, key: 'private-access-key' },
      },
    ],
  ]
  for (const [id, answer] of legacy) {
    const claim = store.conversations.begin('general', id, `旧问题 ${id}`)
    if (claim.kind !== 'started') throw Error('Expected a legacy turn')
    store.conversations.finish(
      'general',
      id,
      claim.attempt,
      answer as unknown as TriggerConversationAnswer,
    )
  }
  const private_ = ['private-audience-fixture', 'private-code', 'private-access-key']
  const view = service.get('general')
  expect(view.turns.map((turn) => turn.answer)).toEqual([
    { text: '平台已受理这条提醒。' },
    { text: '请核对卡片中的通知偏好。', intent: 'route' },
    { text: '请核对委托范围。' },
    { text: '这条记录的授权已变更。请在当前授权下重新提问。' },
  ])
  expect(view.turns.map((turn) => !!turn.surface)).toEqual([false, true, false, false])
  for (const hidden of private_) expect(JSON.stringify(view)).not.toContain(hidden)
  await service.message('general', crypto.randomUUID(), '接着说。')
  const history = ask.mock.lastCall?.[0].history ?? []
  expect(history).toHaveLength(4)
  for (const turn of history)
    expect(Object.keys(turn.answer ?? {}).every((key) => ['text', 'intent'].includes(key))).toBe(
      true,
    )
  for (const hidden of private_) expect(JSON.stringify(history)).not.toContain(hidden)
})

test('the normal workspace entry point runs successive model tool calls and persists the verified result', async () => {
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
        const tools = request.tools?.map((t) => t.name) ?? []
        expect(tools).toContain('list_notification_bots')
        expect(tools).not.toContain('send_personal_reminder')
        expect(tools).not.toContain('prepare_routing_preference')
        content.push({
          type: 'tool_use',
          name: 'list_notification_bots',
          input: {},
          id: 'bot-directory',
        })
      } else {
        const tool = request.messages.at(-1)?.content[0]
        expect(tool?.type === 'tool_result' && tool.content).toContain('我的微信')
        content.push({ type: 'text', text: '{"text":"微信机器人在线。"}' })
      }
      return {
        id: `test-${calls}`,
        model: 'fake',
        content,
        usage: { input: 1, output: 1 },
        stopReason: calls < 2 ? 'tool_use' : 'end_turn',
      }
    },
  }
  const ask = createRouterAgent({
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (v) => v },
    sessionEvents: discardedEvents,
  })
  const { service, catalog } = setup(ask)
  catalog.mockReturnValue([
    {
      platform: 'weixin',
      channelId: 'v1ki-bot',
      label: '我的微信',
      online: true,
      ready: true,
      deliveryState: 'ready',
    },
  ])
  const id = crypto.randomUUID()
  const question = '微信机器人现在能用吗？'
  const answer = (await service.message('general', id, question)).turns[0].answer
  expect(answer).toEqual({
    text: '微信机器人在线。',
    toolSteps: [{ name: 'list_notification_bots', ok: true }],
  })
  await service.message('general', id, question)
  expect(calls).toBe(2)
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

test('Router IM refuses groups and revoked access before releasing a model response', async () => {
  let allowed = false
  const authorized = () => allowed
  const { ask, service } = setup(async () => {
    allowed = false
    return { text: '不得发送这条回复。' }
  })
  expect(await service.handleIm(routerDm, authorized)).toBeNull()
  expect(await service.handleIm({ ...routerDm, isDirect: false }, () => true)).toBeNull()
  expect(ask).not.toHaveBeenCalled()
  allowed = true
  expect(await service.handleIm({ ...routerDm, text: '现在的去向是什么？' }, authorized)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
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

test('an IM Router turn offers only read-only routing tools and replies with plain text', async () => {
  const tools: string[][] = []
  const systems: string[] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(request) {
      tools.push(request.tools?.map((tool) => tool.name) ?? [])
      systems.push(request.system ?? '')
      return {
        id: 'local-test',
        model: 'fake',
        content: [{ type: 'text', text: '请在网页设置页修改通知偏好。' }],
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      }
    },
  }
  const { service } = setup(
    createRouterAgent({
      secretFilter: { filter: (v) => v },
      sessionEvents: discardedEvents,
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    }),
  )
  const message = { ...routerDm, text: '下班后改用微信提醒我' }
  expect(await service.handleIm(message, () => true)).toBe('请在网页设置页修改通知偏好。')
  expect(await service.handleIm(message, () => true)).toBeNull()
  expect(tools).toHaveLength(1)
  expect(tools[0]).toContain('get_routing_context')
  for (const removed of [
    'send_personal_reminder',
    'prepare_personal_reminder',
    'prepare_routing_preference',
    'prepare_bot_selection',
    'bash',
  ])
    expect(tools[0]).not.toContain(removed)
  expect(systems[0]).toContain('配置 → 监听与收件箱')
  expect(service.get('general').turns).toHaveLength(0)
})
