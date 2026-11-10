import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type {
  MandateTarget,
  TriggerAgentResult,
  TriggerInboxItem,
  TriggerRoutingSettings,
  TriggerWeixinTarget,
} from '@zero-os/shared'
import type { TriggerAnalysisContext } from '../event-agent'
import type { NativePresenceProbe } from '../native-presence'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'
import { ListenerRuntime } from '../runtime'
import { TriggerWeixinDeliveryError } from '../weixin-delivery'

const target = { channelId: 'test-account', peerId: 'test-recipient' }
const scope = 'project/repo'
const stream = `github:${scope.toLowerCase()}`

function fixture(
  options: {
    analyze?: () => Promise<void>
    triage?: (event: TriggerInboxItem) => TriggerAgentResult['triage']
    send?: () => Promise<void>
    nativePresence?: NativePresenceProbe
    personal?: NonNullable<ConstructorParameters<typeof TriggerRoutingRuntime>[1]['personal']>
  } = {},
) {
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
  const analyze = mock(
    async (
      event: TriggerInboxItem,
      sessionId: string,
      _signal?: AbortSignal,
      _context?: TriggerAnalysisContext,
    ): Promise<TriggerAgentResult> => {
      await options.analyze?.()
      const triage = options.triage?.(event)
      return { summary: `分析 ${event.eventId}`, sessionId, ...(triage && { triage }) }
    },
  )
  const send = mock(
    async (_target: TriggerWeixinTarget, _event: TriggerInboxItem, _agent: TriggerAgentResult) => {
      await options.send?.()
    },
  )
  const runtime = new TriggerRoutingRuntime(
    store.routing,
    {
      analyze,
      nativePresence: options.nativePresence,
      onWebDelivery: () => store.webNotifications.changed(),
      weixin: { listTargets: () => [{ ...target, label: '测试会话' }], send },
      personal: options.personal,
    },
    () => clock,
  )
  function configure(patch: Partial<TriggerRoutingSettings>) {
    const { revision, settings } = runtime.getConfig()
    return runtime.saveConfig({ ...settings, ...patch }, revision)
  }
  function bind(target: MandateTarget) {
    runtime.saveBotBinding(
      target.platform,
      target.channelId,
      target,
      runtime.getBotBindings().revision,
    )
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
    bind,
    configure,
    receive,
    enableSource,
    close,
    setTime: (time: string) => {
      clock = new Date(time)
    },
  }
}

test('the Router tool previews the current time and presence without delivering an event', async () => {
  const f = fixture()
  try {
    f.configure({ enabled: true, presence: 'auto', awayFallback: 'defer', duringWork: 'web' })
    expect((await f.runtime.previewCurrentRoute()).destination).toBe('defer')
    f.runtime.heartbeat()
    expect((await f.runtime.previewCurrentRoute()).destination).toBe('web')
    f.setTime('2030-01-07T20:00:00Z')
    expect((await f.runtime.previewCurrentRoute()).destination).toBe('defer')
    expect(f.runtime.listRoutes()).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

for (const platform of ['dingtalk', 'feishu'] as const) {
  test(`personal ${platform} uses the exact selected chat and never resends an uncertain or accepted delivery`, async () => {
    const chosen: MandateTarget = {
      platform,
      channelId: 'bot',
      peerId: 'chat',
      operatorId: 'actor',
    }
    const selected = { ...chosen, label: '接收会话' }
    const otherBot = { ...chosen, channelId: 'other-bot', label: '另一账户的会话' }
    const sendPersonal = mock(async () =>
      platform === 'dingtalk'
        ? { status: 'unknown' as const, reason: '模拟回执丢失' }
        : { status: 'accepted' as const },
    )
    const f = fixture({
      personal: {
        listPersonalBots: () => [
          { platform, channelId: chosen.channelId, label: '提醒机器人', online: true },
          { platform, channelId: otherBot.channelId, label: '另一机器人', online: true },
        ],
        listPersonalDirectTargets: () => [],
        listPersonalTargets: () =>
          platform === 'feishu'
            ? [selected, otherBot]
            : [selected, { ...selected, peerId: 'another-chat' }, otherBot],
        sendPersonal,
      },
    })
    try {
      f.bind({ ...chosen, channelId: otherBot.channelId })
      f.configure({
        enabled: true,
        duringWork: platform,
        personalBots: { [platform]: chosen.channelId },
      })
      f.runtime.start()
      const first = f.receive('unavailable')
      f.runtime.notify()
      await flush()
      expect(f.store.routing.get(first)?.status).toBe('deferred')
      expect(sendPersonal).not.toHaveBeenCalled()
      expect(f.runtime.listPersonalBots()).toEqual([
        {
          platform,
          channelId: 'bot',
          label: '提醒机器人',
          online: true,
          ready: false,
          deliveryState: 'awaiting_private',
        },
        {
          platform,
          channelId: 'other-bot',
          label: '另一机器人',
          online: true,
          ready: true,
          deliveryState: 'ready',
        },
      ])
      f.bind(chosen)
      expect(f.runtime.listPersonalBots()[0].ready).toBe(true)
      const id = f.receive('selected')
      f.runtime.notify()
      await flush()
      const route = f.store.routing.get(id)
      expect(route).toMatchObject({
        status: platform === 'feishu' ? 'sent' : 'uncertain',
        deliveryTarget: chosen,
      })
      expect(sendPersonal).toHaveBeenCalledWith(
        chosen,
        expect.objectContaining({ id }),
        expect.any(Object),
        expect.any(AbortSignal),
        expect.any(Function),
      )
      const sent = sendPersonal.mock.calls.length
      expect(f.runtime.process(id)).toBe('already_processed')
      f.runtime.notify()
      await flush()
      expect(sendPersonal).toHaveBeenCalledTimes(sent)
      expect(f.send).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
}

test.each(['weixin', 'feishu', 'dingtalk'] as const)(
  '%s learns only the selected bot’s unique private endpoint on an actual send',
  async (platform) => {
    const address = {
      platform,
      channelId: 'auto-bot',
      peerId: 'p1',
      operatorId: platform === 'weixin' ? 'p1' : 'actor',
    }
    const group = { ...address, peerId: 'group' }
    const other = { ...address, channelId: 'other-bot' }
    const targets = [group, other, address].map((t) => ({ ...t, label: 'bound peer' }))
    let direct = [other]
    let online = true
    const sendPersonal = mock(async () => ({ status: 'accepted' as const }))
    const f = fixture({
      personal: {
        listPersonalBots: () =>
          [address, other].map(({ channelId }) => ({
            platform,
            channelId,
            label: channelId,
            online,
          })),
        listPersonalTargets: () => targets,
        listPersonalDirectTargets: () => direct,
        sendPersonal,
      },
    })
    try {
      f.configure({
        enabled: true,
        duringWork: platform,
        personalBots: { [platform]: address.channelId },
      })
      const before = f.runtime.getBotBindings()
      const status = () => f.runtime.listPersonalBots()[0].deliveryState
      expect(status()).toBe('awaiting_private')
      direct = [other, address]
      online = false
      expect(status()).toBe('offline')
      online = true
      expect(status()).toBe('ready')
      expect(f.runtime.getBotBindings()).toEqual(before)
      f.runtime.start()
      const id = f.receive('bot-only')
      f.runtime.notify()
      await flush()
      expect(f.store.routing.get(id)).toMatchObject({ status: 'sent', deliveryTarget: address })
      expect(f.store.routing.getPersonalBotBinding(platform, address.channelId)).toMatchObject({
        automatic: true,
        target: address,
      })
      expect(f.store.routing.getPersonalBotBinding(platform, other.channelId)).toBeNull()
      expect(f.runtime.isPersonalTarget(address)).toBe(true)
      expect(f.runtime.isPersonalTarget(group)).toBe(false)
      expect(f.runtime.isPersonalTarget(other)).toBe(false)
      if (platform === 'weixin') expect(f.send).toHaveBeenCalledTimes(1)
      else expect(sendPersonal).toHaveBeenCalledTimes(1)
      f.runtime.saveBotBinding(
        platform,
        address.channelId,
        null,
        f.runtime.getBotBindings().revision,
      )
      expect(status()).toBe('unavailable')
      expect(f.runtime.isPersonalTarget(address)).toBe(false)
    } finally {
      await f.close()
    }
  },
)

test('a second direct correspondent during token lookup defers before external delivery; the first pin cannot drift', async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const address = { platform: 'feishu' as const, channelId: 'bot', peerId: 'p1', operatorId: 'u1' }
  const second = { ...address, peerId: 'p2', operatorId: 'u2' }
  let direct = [address]
  const sent = mock((_target: MandateTarget) => {})
  const f = fixture({
    personal: {
      listPersonalBots: () => [
        { platform: address.platform, channelId: address.channelId, label: 'bot', online: true },
      ],
      listPersonalTargets: () => direct.map((t) => ({ ...t, label: 'private' })),
      listPersonalDirectTargets: () => direct,
      sendPersonal: async (target, _event, _agent, _signal, maySend) => {
        reached.resolve()
        await release.promise
        if (!maySend()) return { status: 'rejected', reason: 'changed' }
        sent(target)
        return { status: 'accepted' }
      },
    },
  })
  try {
    f.configure({
      enabled: true,
      duringWork: 'feishu',
      personalBots: { feishu: address.channelId },
    })
    f.runtime.start()
    const id = f.receive('remains-private')
    f.runtime.notify()
    await reached.promise
    direct = [address, second]
    expect(f.runtime.listPersonalBots()[0].deliveryState).toBe('ambiguous')
    expect(f.runtime.isPersonalTarget(address)).toBe(false)
    release.resolve()
    await flush()
    expect(sent).not.toHaveBeenCalled()
    expect(f.store.routing.get(id)?.status).toBe('deferred')
    direct = [second]
    expect(f.runtime.listPersonalBots()[0].deliveryState).toBe('unavailable')
    expect(f.runtime.isPersonalTarget(second)).toBe(false)
    direct = [address]
    expect(f.runtime.isPersonalTarget(address)).toBe(true)
  } finally {
    release.resolve()
    await f.close()
  }
})

test.each([
  ['revoke-and-rebind-source', 'cancelled', 0],
  ['clear-bot-address', 'deferred', 0],
  ['replace-bot-address', 'sent', 1],
  ['change-route', 'web', 0],
  ['edit-other-repo', 'sent', 1],
] as const)('personal IM rechecks %s at the write boundary', async (change, status, sent) => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const selected = {
    platform: 'feishu' as const,
    channelId: 'bot',
    peerId: 'chat',
    operatorId: 'actor',
  }
  const newAddress = { ...selected, peerId: 'new-chat' }
  const externalWrite = mock((_peerId: string) => {})
  const f = fixture({
    personal: {
      listPersonalBots: () => [
        { platform: 'feishu', channelId: selected.channelId, label: '提醒机器人', online: true },
      ],
      listPersonalDirectTargets: () => [],
      listPersonalTargets: () =>
        [selected, newAddress].map((address) => ({ ...address, label: address.peerId })),
      sendPersonal: async (target, _item, _agent, _signal, maySend) => {
        reached.resolve()
        await release.promise
        if (!maySend()) return { status: 'rejected', reason: '授权已撤销' }
        externalWrite(target.peerId)
        return { status: 'accepted' }
      },
    },
  })
  try {
    f.bind(selected)
    f.configure({
      enabled: true,
      duringWork: 'feishu',
      personalBots: { feishu: selected.channelId },
    })
    f.runtime.start()
    const id = f.receive('revoked')
    f.runtime.notify()
    await reached.promise
    if (change === 'revoke-and-rebind-source') {
      f.enableSource(false)
      f.enableSource(true)
    } else if (change === 'change-route') {
      f.configure({ duringWork: 'web' })
    } else if (change === 'clear-bot-address') {
      f.runtime.saveBotBinding(
        'feishu',
        selected.channelId,
        null,
        f.runtime.getBotBindings().revision,
      )
    } else if (change === 'replace-bot-address') {
      f.bind(newAddress)
    } else {
      const snapshot = f.store.getSettings()
      const repo = snapshot.settings.github.repositories[0]
      snapshot.settings.github.repositories.push({ ...repo, name: 'another/repo' })
      f.store.saveSettings(snapshot.settings, snapshot.revision)
    }
    release.resolve()
    await flush()
    expect(externalWrite).toHaveBeenCalledTimes(sent)
    if (change === 'replace-bot-address')
      expect(externalWrite).toHaveBeenCalledWith(newAddress.peerId)
    expect(f.store.routing.get(id)?.status).toBe(status)
  } finally {
    release.resolve()
    await f.close()
  }
})

test('a selected Weixin bot uses its own mapped recipient even with a different legacy address', async () => {
  const address = {
    platform: 'weixin' as const,
    channelId: 'new-weixin',
    peerId: 'new-peer',
    operatorId: 'new-peer',
  }
  const f = fixture({
    personal: {
      listPersonalBots: () => [
        { platform: 'weixin', channelId: address.channelId, label: '新机器人', online: true },
      ],
      listPersonalDirectTargets: () => [],
      listPersonalTargets: () => [{ ...address, label: '接收会话' }],
      sendPersonal: async () => {
        throw new Error('Weixin uses iLink')
      },
    },
  })
  try {
    f.bind(address)
    f.configure({
      enabled: true,
      duringWork: 'weixin',
      personalBots: { weixin: address.channelId },
    })
    f.runtime.start()
    const id = f.receive('new-weixin')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(id)).toMatchObject({ status: 'sent', deliveryTarget: address })
    expect(f.send.mock.calls[0][0]).toEqual({
      channelId: address.channelId,
      peerId: address.peerId,
    })
  } finally {
    await f.close()
  }
})

test.each(['accepted', 'unknown'] as const)(
  'a late %s receipt stays with its original IM after a policy change',
  async (receipt) => {
    const sent = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<void>()
    const target = {
      platform: 'feishu' as const,
      channelId: 'bot',
      peerId: 'chat',
      operatorId: 'actor',
    }
    const f = fixture({
      personal: {
        listPersonalBots: () => [
          { platform: 'feishu', channelId: target.channelId, label: '提醒机器人', online: true },
        ],
        listPersonalDirectTargets: () => [],
        listPersonalTargets: () => [{ ...target, label: '接收会话' }],
        sendPersonal: async (_target, _item, _agent, _signal, maySend) => {
          expect(maySend()).toBe(true)
          sent.resolve()
          await reply.promise
          return receipt === 'accepted'
            ? { status: 'accepted' }
            : { status: 'unknown', reason: '回执不明' }
        },
      },
    })
    try {
      f.bind(target)
      f.configure({
        enabled: true,
        duringWork: 'feishu',
        personalBots: { feishu: target.channelId },
      })
      f.runtime.start()
      const id = f.receive('after-dispatch')
      f.runtime.notify()
      await sent.promise
      f.configure({ duringWork: 'web', personalBots: { feishu: null } })
      reply.resolve()
      await flush()
      expect(f.store.routing.get(id)).toMatchObject({
        status: receipt === 'accepted' ? 'sent' : 'uncertain',
        deliveryTarget: target,
      })
      expect(f.runtime.listWeb()).toEqual([])
    } finally {
      reply.resolve()
      await f.close()
    }
  },
)

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
  const workspace = new RouterWorkspaceService(f.store, f.runtime, async () => {
    throw new Error('Unexpected chat')
  })
  const listener = new ListenerRuntime(f.store, () => undefined, f.runtime, workspace, {
    pollGithub,
    async pollWxarc() {
      throw new Error('WXARC is not configured')
    },
  })
  const markers: number[] = []
  const unsubscribe = f.store.webNotifications.subscribe(() => {
    markers.push(f.store.webNotifications.latestId())
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
    expect(markers).toEqual([])
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
    expect(markers).toEqual([f.store.webNotifications.list({}).items[0].id])
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
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

test('after a slow Mac check, a changed policy is reread before a route can deliver', async () => {
  const gate = Promise.withResolvers<void>()
  const probe = mock(async () => {
    await gate.promise
    return { locked: false, idleSeconds: 0, bluetoothConnected: null }
  })
  const f = fixture({ nativePresence: probe })
  try {
    f.configure({
      enabled: true,
      nativePresence: { enabled: true, idleMinutes: 5, bluetooth: false },
    })
    f.runtime.start()
    const id = f.receive('native-policy-race')
    f.runtime.notify()
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(f.runtime.listWeb()).toHaveLength(0)
    f.configure({ presence: 'away' })
    gate.resolve()
    await flush()
    expect(f.store.routing.get(id)).toMatchObject({
      status: 'deferred',
      decision: { destination: 'defer' },
    })
    expect(f.runtime.listWeb()).toHaveLength(0)
    expect(probe).toHaveBeenCalledTimes(1)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test('Router private ingress requires the selected verified peer and fences in-flight replies after a change', async () => {
  const bot = { platform: 'feishu' as const, channelId: 'personal', label: 'work', online: true }
  const dm = { ...bot, peerId: 'chat1', operatorId: 'person1' }
  const second = { ...bot, peerId: 'chat2', operatorId: 'person2' }
  const direct = [dm]
  const f = fixture({
    personal: {
      listPersonalBots: () => [bot],
      listPersonalTargets: () => [dm, second],
      listPersonalDirectTargets: () => direct,
      sendPersonal: async () => ({ status: 'accepted' }),
    },
  })
  try {
    expect(f.runtime.claimRouterImTarget(dm)).toBeNull()
    f.configure({ enabled: false, personalBots: { feishu: bot.channelId } })
    expect(f.runtime.claimRouterImTarget(second)).toBeNull()
    const allowed = f.runtime.claimRouterImTarget(dm)
    expect(allowed?.()).toBe(true)
    direct.push(second)
    expect(allowed?.()).toBe(false)
    expect(f.runtime.claimRouterImTarget(second)).toBeNull()
    direct.pop()
    f.configure({ personalBots: { feishu: 'different-bot' } })
    f.configure({ personalBots: { feishu: bot.channelId } })
    expect(allowed?.()).toBe(false)
    expect(f.runtime.claimRouterImTarget(dm)?.()).toBe(true)
  } finally {
    await f.close()
  }
})

test('explicit private reminders use a pinned selected bot without an event, automatic routing or a work period', async () => {
  const bot = {
    platform: 'feishu' as const,
    channelId: 'chosen',
    label: '选择的机器人',
    online: true,
  }
  const dm = {
    platform: bot.platform,
    channelId: bot.channelId,
    peerId: 'private-peer',
    operatorId: 'confirmed-actor',
    label: 'selected private chat',
  }
  const another = { ...dm, peerId: 'new-peer', operatorId: 'someone-else' }
  const group = { ...dm, peerId: 'a-group' }
  const direct = [dm]
  const signal = new AbortController().signal
  let beforeWrite: (() => void) | undefined
  const writes: string[] = []
  const sendDirect: NonNullable<
    NonNullable<ConstructorParameters<typeof TriggerRoutingRuntime>[1]['personal']>['sendDirect']
  > = async (target, text, id, _signal, authorized) => {
    await Promise.resolve()
    beforeWrite?.()
    if (!authorized()) return { status: 'rejected', reason: '已撤销' }
    expect(target).toMatchObject(dm)
    writes.push(`${id} ${text}`)
    return { status: 'accepted' }
  }
  const f = fixture({
    personal: {
      listPersonalBots: () => [bot],
      listPersonalTargets: () => [...direct, group],
      listPersonalDirectTargets: () => direct,
      sendPersonal: async () => {
        throw Error('event path must not run')
      },
      sendDirect,
    },
  })
  try {
    const config = f.configure({
      enabled: false,
      duringWork: 'defer',
      personalBots: { feishu: bot.channelId },
    })
    const prepared = f.runtime.prepareDirectReminder('feishu')
    const otherDraft = f.runtime.prepareDirectReminder('feishu')
    expect(JSON.stringify(prepared)).not.toContain(dm.peerId)
    expect(f.runtime.getBotBindings().targets.some((t) => t.platform === 'feishu')).toBe(false)
    expect(
      await f.runtime.sendDirectReminder(
        'feishu',
        prepared,
        '处理 DeepSeek 的充值',
        'manual-1',
        signal,
      ),
    ).toEqual({ status: 'accepted' })
    expect(writes).toEqual(['manual-1 处理 DeepSeek 的充值'])
    expect(
      (await f.runtime.sendDirectReminder('feishu', otherDraft, '第二条', 'other-manual', signal))
        .status,
    ).toBe('accepted')
    expect(f.store.listInbox()).toEqual([])
    expect(f.store.webNotifications.list().items).toEqual([])
    expect(f.runtime.getConfig()).toEqual(config)
    expect(f.store.routing.getPersonalBotBinding('feishu', bot.channelId)).toMatchObject({
      automatic: true,
      target: { peerId: dm.peerId },
    })
    const next = f.runtime.prepareDirectReminder('feishu')
    let imCallerAuthorized = true
    beforeWrite = () => {
      imCallerAuthorized = false
    }
    expect(
      (
        await f.runtime.sendDirectReminder(
          'feishu',
          next,
          '不要发送',
          'im-request',
          signal,
          () => imCallerAuthorized,
        )
      ).status,
    ).toBe('rejected')
    beforeWrite = () => {
      direct.push(another)
    }
    expect(
      (await f.runtime.sendDirectReminder('feishu', next, '不要发送', 'manual-2', signal)).status,
    ).toBe('rejected')
    expect(() => f.runtime.prepareDirectReminder('feishu')).toThrow('多个私聊')
    direct.pop()
    beforeWrite = () => {
      f.bind(group)
      f.bind(dm)
    }
    expect(
      (await f.runtime.sendDirectReminder('feishu', next, '不要发送', 'manual-3', signal)).status,
    ).toBe('rejected')
    f.bind(group)
    expect(() => f.runtime.prepareDirectReminder('feishu')).toThrow('个人私聊')
    expect(writes).toHaveLength(2)
  } finally {
    await f.close()
  }
})

const skipRepeats = (event: TriggerInboxItem): TriggerAgentResult['triage'] =>
  event.eventId.startsWith('repeat')
    ? { decision: 'skip', reason: '与上次已通知的失败相同。' }
    : { decision: 'notify', reason: '新的失败。' }

test('triage filters a repeat without delivery, shows earlier events, and notify anyway reuses the summary', async () => {
  const f = fixture({ triage: skipRepeats })
  const onWeb = mock(() => {})
  const unsubscribe = f.store.webNotifications.subscribe(onWeb)
  try {
    f.configure({ enabled: true })
    f.runtime.start()
    const first = f.receive('first')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(first)?.status).toBe('web')
    const repeat = f.receive('repeat-1')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(repeat)).toMatchObject({
      status: 'filtered',
      decision: null,
      agent: { summary: '分析 repeat-1', triage: { decision: 'skip' } },
    })
    expect(f.analyze.mock.calls[1][3]).toEqual({
      previous: [
        { title: '构建失败', at: expect.any(String), summary: '分析 first', outcome: 'notified' },
      ],
    })
    expect(f.runtime.listWeb().map((w) => w.event.id)).toEqual([first])
    expect(onWeb).toHaveBeenCalledTimes(1)
    // A later event sees the filtered one as filtered, not as something the owner was told.
    f.receive('third')
    f.runtime.notify()
    await flush()
    expect(f.analyze.mock.calls[2][3]?.previous.map((p) => p.outcome)).toEqual([
      'notified',
      'filtered',
    ])

    expect(f.runtime.process(repeat)).toBe('accepted')
    await flush()
    expect(f.store.routing.get(repeat)).toMatchObject({ origin: 'manual', status: 'web' })
    expect(f.analyze).toHaveBeenCalledTimes(3)
    expect(f.runtime.process(repeat)).toBe('already_processed')
  } finally {
    unsubscribe()
    await f.close()
  }
})

test('a manual request is never filtered, and a restart keeps a filtered route terminal', async () => {
  const f = fixture({ triage: () => ({ decision: 'skip', reason: '无新信息。' }) })
  try {
    f.runtime.start()
    const history = f.receive('historic')
    f.configure({ enabled: true })
    expect(f.runtime.process(history)).toBe('accepted')
    await flush()
    expect(f.store.routing.get(history)).toMatchObject({
      origin: 'manual',
      status: 'web',
      agent: { triage: { decision: 'notify', reason: '手动提交的事件不做筛选。' } },
    })
    const subscribed = f.receive('subscribed')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(subscribed)?.status).toBe('filtered')
    f.store.routing.recoverInterrupted()
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(subscribed)?.status).toBe('filtered')
    expect(f.runtime.listWeb().map((w) => w.event.id)).toEqual([history])
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('with triage off a skip judgement is ignored and no earlier events are gathered', async () => {
  const f = fixture({ triage: () => ({ decision: 'skip', reason: '重复。' }) })
  try {
    f.configure({ enabled: true, triage: false })
    f.runtime.start()
    f.receive('first')
    const second = f.receive('second')
    f.runtime.notify()
    await flush()
    expect(f.store.routing.get(second)).toMatchObject({ status: 'web' })
    expect(f.store.routing.get(second)?.agent).toEqual({
      summary: '分析 second',
      sessionId: expect.any(String),
    })
    expect(f.analyze.mock.calls.map((call) => call[3])).toEqual([undefined, undefined])
  } finally {
    await f.close()
  }
})

test('turning triage off during analysis delivers the event instead of filtering it', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = fixture({
    triage: () => ({ decision: 'skip', reason: '重复。' }),
    analyze: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    f.configure({ enabled: true })
    f.runtime.start()
    const id = f.receive('first')
    f.runtime.notify()
    await entered.promise
    f.configure({ triage: false })
    release.resolve()
    await flush()
    await flush()
    expect(f.store.routing.get(id)?.status).toBe('web')
    expect(f.store.routing.get(id)?.agent?.triage).toBeUndefined()
  } finally {
    release.resolve()
    await f.close()
  }
})

test('a stored result without a triage field is routed as notify', async () => {
  const f = fixture()
  try {
    f.configure({ enabled: true })
    const id = f.receive('legacy')
    // Simulate a result analysed by an older version and left ready across an upgrade.
    expect(f.store.routing.claimAgent(id, 'old-session')).toBe(true)
    expect(f.store.routing.finishAgent(id, 'old-session', { summary: '旧版摘要' })).toBe(true)
    f.runtime.start()
    await flush()
    expect(f.store.routing.get(id)?.status).toBe('web')
    expect(f.analyze).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
