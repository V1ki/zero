import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type {
  RouterActionName,
  RouterSurfaceAction,
  RouterSurfaceMessages,
  TriggerConversationAnswer,
} from '@zero-os/shared'
import type { RouterAgentInput } from '../router-agent'
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
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      saveConfig: routing.saveConfig.bind(routing),
      listTargets: () => routing.listTargets(),
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
  return { store, routing, process, ask, service, first, second }
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
