import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type {
  TriggerAgentResult,
  TriggerInboxItem,
  TriggerRoutingSettings,
  TriggerWeixinTarget,
} from '@zero-os/shared'
import { TriggerRoutingRuntime } from '../routing-runtime'
import { ListenerRuntime } from '../runtime'
import { TriggerWeixinDeliveryError } from '../weixin-delivery'

const target = { channelId: 'test-account', peerId: 'test-recipient' }
const scope = 'project/repo'
const stream = `github:${scope.toLowerCase()}`

function fixture(options: { analyze?: () => Promise<void>; send?: () => Promise<void> } = {}) {
  const store = new TriggerStore(':memory:')
  store.saveSettings(
    {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: scope,
            branch: '',
            workflow: '',
            mention: '',
            workflowFailures: true,
            enabled: true,
          },
        ],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  let clock = new Date('2030-01-07T12:00:00Z') // Monday in the configured time zone.
  const analyze = mock(async (event: TriggerInboxItem, sessionId: string) => {
    await options.analyze?.()
    return { summary: `分析 ${event.eventId}`, sessionId }
  })
  const send = mock(
    async (_target: TriggerWeixinTarget, _event: TriggerInboxItem, _agent: TriggerAgentResult) => {
      await options.send?.()
    },
  )
  const runtime = new TriggerRoutingRuntime(
    store.routing,
    {
      analyze,
      weixin: { listTargets: () => [{ ...target, label: '测试会话' }], send },
    },
    () => clock,
  )
  function configure(patch: Partial<TriggerRoutingSettings>) {
    const { revision, settings } = runtime.getConfig()
    return runtime.saveConfig({ ...settings, ...patch }, revision)
  }
  function receive(eventId: string) {
    const previousCursor = store.readCursor(stream)
    expect(
      store.commitBatch({
        source: 'github',
        stream,
        revision: store.getSettings().revision,
        previousCursor,
        cursor: String(Number(previousCursor ?? 0) + 1),
        events: [
          {
            eventId,
            scope,
            title: '构建失败',
            summary: '原始事件',
            occurredAt: clock.toISOString(),
          },
        ],
      }),
    ).toBe(true)
    const item = store.listInbox().find((item) => item.eventId === eventId)
    if (!item) throw new Error('Missing test event')
    return item.id
  }
  function enableSource(enabled: boolean) {
    const current = store.getSettings()
    current.settings.github.repositories[0].enabled = enabled
    store.saveSettings(current.settings, current.revision)
  }
  async function close() {
    await runtime.close()
    store.close()
  }
  configure({
    timeZone: 'UTC',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    presence: 'present',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    weixinTarget: target,
  })
  return {
    runtime,
    store,
    analyze,
    send,
    configure,
    receive,
    enableSource,
    close,
    setTime: (time: string) => {
      clock = new Date(time)
    },
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a committed event enters routing once and a returning reader releases its deferred Web result', async () => {
  const f = fixture()
  const pollGithub = mock(async () => ({
    cursor: 'test-checkpoint',
    events: [
      {
        eventId: 'run-1',
        scope,
        title: '构建失败',
        summary: '原始事件',
        occurredAt: '2030-01-07T12:00:00Z',
      },
    ],
  }))
  const listener = new ListenerRuntime(f.store, () => undefined, f.runtime, {
    pollGithub,
    async pollWxarc() {
      throw new Error('WXARC is not configured')
    },
  })
  try {
    f.configure({ enabled: true, presence: 'auto', awayFallback: 'defer' })
    listener.start()
    await flush()
    const id = listener.listInbox()[0].id
    expect(f.store.routing.get(id)).toMatchObject({
      origin: 'subscription',
      status: 'deferred',
      agent: { summary: '分析 run-1' },
    })
    expect(f.runtime.listWeb()).toEqual([])
    await listener.scan()
    await flush()
    expect(pollGithub).toHaveBeenCalledTimes(2)
    expect(listener.listInbox()).toHaveLength(1)
    f.runtime.heartbeat()
    await flush()
    expect(
      f.runtime.listWeb().map((w) => [w.event.id, w.event.summary, w.route.agent?.summary]),
    ).toEqual([[id, '原始事件', '分析 run-1']])
    expect(f.runtime.process(id)).toBe('already_processed')
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await listener.close()
  }
})

test('the due timer releases an off-hours item when its local work period starts', async () => {
  const f = fixture()
  try {
    f.setTime('2030-01-07T08:59:59.950Z')
    f.configure({ enabled: true })
    f.runtime.start()
    const id = f.receive('run-boundary')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(id)?.decision).toMatchObject({
      destination: 'defer',
      recheckAt: '2030-01-07T09:00:00.000Z',
    })
    f.setTime('2030-01-07T09:00:00.001Z')
    const deadline = performance.now() + 1200
    while (f.store.routing.get(id)?.status === 'deferred' && performance.now() < deadline)
      await Bun.sleep(10)
    expect(f.store.routing.get(id)?.status).toBe('web')
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

for (const status of ['sent', 'uncertain'] as const) {
  test(`WeChat ${status} outcome prevents replay, redirection and manual resend`, async () => {
    const f = fixture({
      send: async () => {
        if (status === 'uncertain') throw new TriggerWeixinDeliveryError('测试回执未知', true)
      },
    })
    try {
      f.configure({ enabled: true, duringWork: 'weixin' })
      f.runtime.start()
      const id = f.receive('run-weixin')
      f.runtime.notify()
      await flush()
      expect(f.store.routing.get(id)).toMatchObject({ status, weixinTarget: target })
      expect(f.send.mock.calls[0][0]).toEqual(target)
      expect(f.send.mock.calls[0][1].id).toBe(id)
      expect(f.send.mock.calls[0][2].summary).toBe('分析 run-weixin')
      expect(f.runtime.process(id)).toBe('already_processed')
      f.receive('run-weixin')
      f.configure({ duringWork: 'web' })
      f.runtime.heartbeat()
      f.runtime.notify()
      await flush()
      expect(f.analyze).toHaveBeenCalledTimes(1)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.runtime.listWeb()).toEqual([])
    } finally {
      await f.close()
    }
  })
}

for (const [change, expected] of [
  ['disable', 'ready'],
  ['switch-to-web', 'web'],
  ['pause-source', 'cancelled'],
] as const) {
  test(`in-flight analysis rechecks authority before delivery on ${change}`, async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture({
      analyze: async () => {
        started.resolve()
        await release.promise
      },
    })
    try {
      f.configure({ enabled: true, duringWork: 'weixin' })
      f.runtime.start()
      const id = f.receive('before-change')
      f.runtime.notify()
      await started.promise
      if (change === 'disable') f.configure({ enabled: false })
      if (change === 'switch-to-web') f.configure({ duringWork: 'web' })
      if (change === 'pause-source') f.enableSource(false)
      release.resolve()
      await flush()
      expect(f.store.routing.get(id)?.status).toBe(expected)
      expect(f.analyze).toHaveBeenCalledTimes(1)
      expect(f.send).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await f.close()
    }
  })
}

test('enabling routing does not backfill history and paused sources require an explicit per-item request', async () => {
  const f = fixture()
  try {
    f.runtime.start()
    const history = f.receive('historic')
    expect(f.runtime.process(history)).toBe('disabled')
    f.configure({ enabled: true })
    const skipped = f.receive('paused-before-dispatch')
    f.enableSource(false)
    f.enableSource(true)
    f.runtime.notify()
    await flush()
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.store.routing.get(history)).toBeNull()
    expect(f.store.routing.get(skipped)).toMatchObject({
      origin: 'subscription',
      status: 'cancelled',
    })
    f.enableSource(false)
    expect(f.runtime.process(history)).toBe('accepted')
    await flush()
    expect(f.store.routing.get(history)).toMatchObject({ origin: 'manual', status: 'web' })
    expect(f.runtime.listWeb().map((item) => item.event.id)).toEqual([history])
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.runtime.process(skipped)).toBe('accepted')
    await flush()
    expect(f.store.routing.get(skipped)).toMatchObject({ origin: 'manual', status: 'web' })
    expect(f.analyze).toHaveBeenCalledTimes(2)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
