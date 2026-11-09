import { expect, mock, test } from 'bun:test'
import type { RouterJob } from '@zero-os/observe'
import type {
  CommissionOperator,
  TriggerRouteDecision,
  TriggerRoutingSettings,
} from '@zero-os/shared'
import type { MandateReceipt } from '../mandate-runtime'
import { createRouterJobDelivery } from '../router-job-delivery'
import { routerImScope } from '../router-job-principal'

const actor: CommissionOperator = {
  platform: 'weixin',
  channelId: 'test-bot',
  operatorId: 'operator',
  peerId: 'operator',
}
const initial: TriggerRoutingSettings = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'auto',
  awayFallback: 'defer',
  duringWork: 'web',
  afterWork: 'weixin',
  offDay: 'defer',
  weixinTarget: null,
}
const job: RouterJob = {
  id: 31,
  scope: routerImScope(actor),
  audience: JSON.stringify([actor, 1, 'connection']),
  requestId: 'test',
  executor: 'zero',
  instruction: '查看失败原因',
  repository: 'owner/test',
  result: '测试步骤失败',
  attempt: 2,
  status: 'completed',
  threadId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function fixture(decision: TriggerRouteDecision = { destination: 'weixin', reason: '个人偏好' }) {
  const state = {
    allowed: true,
    live: true,
    revision: 1,
    settings: { ...initial },
    targets: [actor],
    grant: 'read-grant' as string | null,
  }
  const send = mock(
    async (
      ...args: Parameters<Parameters<typeof createRouterJobDelivery>[0]['sendDirectReminder']>
    ): Promise<MandateReceipt> =>
      args[5]?.() ? { status: 'accepted' } : { status: 'rejected', reason: '授权失效' },
  )
  const preview = mock(async () => decision)
  const deliver = createRouterJobDelivery(
    {
      getConfig: () => ({ revision: state.revision, settings: state.settings }),
      listPersonalTargets: () => state.targets.map((target) => ({ ...target, label: 'private' })),
      isSelectedDirectTarget: (target) =>
        state.targets.some(
          (active) =>
            active.platform === target.platform &&
            active.channelId === target.channelId &&
            active.peerId === target.peerId &&
            active.operatorId === target.operatorId,
        ) && state.live,
      previewCurrentRoute: preview,
      prepareDirectReminder: (platform) => ({
        channelId: state.targets.find((target) => target.platform === platform)?.channelId ?? '',
        label: 'test',
        audienceKey: 'key',
      }),
      sendDirectReminder: send,
    },
    () => state.allowed,
    () => state.grant,
  )
  const signal = new AbortController().signal
  return { state, send, deliver, preview, signal }
}

test('matching route returns the worker result to the authorized private bot with a stable attempt ID', async () => {
  const { send, deliver, signal } = fixture()
  expect(await deliver(job, signal)).toBe('delivered')
  expect(send).toHaveBeenCalledTimes(1)
  const [platform, , body, key] = send.mock.calls[0]
  expect(platform).toBe(actor.platform)
  expect(body).toContain('派工 #31')
  expect(body).toContain('测试步骤失败')
  expect(key).toBe('router-job-31-2')
})

test('web completion stays on its own turn; other routes never disclose a private result', async () => {
  for (const destination of ['web', 'feishu', 'dingtalk'] as const) {
    const { deliver, send, signal, preview } = fixture({ destination, reason: '当前时段偏好' })
    expect(
      await deliver(
        { ...job, scope: 'general', audience: JSON.stringify(['web', null, 'connection']) },
        signal,
      ),
    ).toBe('delivered')
    expect(preview).not.toHaveBeenCalled()
    expect(await deliver(job, signal)).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
  }
})

test('deferred and offline returns respect the next policy recheck without sending', async () => {
  const recheckAt = new Date(Date.now() + 60_000).toISOString()
  const { state, deliver, send, signal } = fixture({
    destination: 'defer',
    reason: '离席',
    recheckAt,
  })
  state.live = false
  expect(await deliver(job, signal)).toEqual({ recheckAt })
  expect(send).not.toHaveBeenCalled()
  state.allowed = false
  expect(await deliver(job, signal)).toBe('unavailable')
})

test('revocations during policy and channel preparation suppress the result', async () => {
  const { state, send, deliver, preview, signal } = fixture()
  preview.mockImplementation(async () => {
    state.allowed = false
    return { destination: 'weixin', reason: '测试' }
  })
  expect(await deliver(job, signal)).toBe('unavailable')
  expect(send).not.toHaveBeenCalled()
  state.allowed = true
  preview.mockImplementation(async () => ({ destination: 'weixin', reason: '测试' }))
  send.mockImplementation(async (...args) => {
    state.live = false
    expect(args[5]?.()).toBe(false)
    return { status: 'rejected', reason: '私聊解绑' }
  })
  expect(await deliver(job, signal)).toBe('unavailable')
  state.live = true
  state.settings.enabled = false
  expect(await deliver(job, signal)).toBe('unavailable')
  expect(send).toHaveBeenCalledTimes(1)
})

test('unknown delivery receipt is never marked delivered and a long result is bounded', async () => {
  const { send, deliver, signal } = fixture()
  send.mockResolvedValue({ status: 'unknown', reason: '平台结果未知' })
  expect(await deliver({ ...job, result: '多'.repeat(3000) }, signal)).toBe('unknown')
  expect(send.mock.calls[0][2].length).toBeLessThan(2000)
})

const watched: RouterJob = {
  ...job,
  kind: 'github-watch',
  scope: 'general',
  audience: JSON.stringify(['web', null, 'connection']),
  repository: 'private/repository',
  result: '只在网页显示的私有事件及分析',
}

test('routine watch events only update the Web feed even when the current route points to IM', async () => {
  const { deliver, send, preview, signal, state } = fixture()
  expect(await deliver(watched, signal)).toBe('delivered')
  expect(preview).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  state.allowed = false
  expect(await deliver(watched, signal)).toBe('unavailable')
})

test('Router-owned attention, failure, and unknown outcomes nudge the authorized personal destination without disclosing event details', async () => {
  for (const outcome of [
    { status: 'completed', attentionQuestion: '需确认的私有内容' },
    { status: 'failed', attentionQuestion: null },
    { status: 'unknown', attentionQuestion: null },
  ] as const) {
    const privateFeishu: CommissionOperator = {
      platform: 'feishu',
      channelId: 'feishu-bot',
      operatorId: 'owner',
      peerId: 'dm',
    }
    const { deliver, send, signal, state } = fixture({
      destination: 'feishu',
      reason: '工作时段首选飞书',
    })
    state.targets.push(privateFeishu)
    expect(await deliver({ ...watched, ...outcome }, signal)).toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
    const [platform, , body, key] = send.mock.calls[0]
    expect(platform).toBe('feishu')
    expect(body).toBe('有一项 GitHub 跟踪结果需要你查看。请打开 Router 网页查看派工 #31。')
    expect(key).toBe('router-job-31-2')
  }
})

test('watch alerts honor Web, deferred, offline and unavailable recipients', async () => {
  const attention: RouterJob = { ...watched, attentionQuestion: '请判断' }
  const recheckAt = new Date(Date.now() + 60_000).toISOString()
  for (const decision of [
    { destination: 'web', reason: '在场' },
    { destination: 'defer', reason: '静默', recheckAt },
    { destination: 'feishu', reason: '另一个平台' },
    { destination: 'weixin', reason: '离线' },
  ] as const) {
    const { deliver, send, signal, state } = fixture(decision)
    state.live = false
    expect(await deliver(attention, signal)).toEqual(
      decision.destination === 'web'
        ? 'delivered'
        : decision.destination === 'defer'
          ? { recheckAt }
          : 'unavailable',
    )
    expect(send).not.toHaveBeenCalled()
  }
})

test('watch nudges require a unique selected private recipient with a current GitHub connection grant', async () => {
  const attention: RouterJob = { ...watched, attentionQuestion: '需确认' }
  const { deliver, send, signal, state } = fixture()
  state.grant = null
  expect(await deliver(attention, signal)).toBe('unavailable')
  state.grant = 'allowed'
  state.targets.push({ ...actor, peerId: 'other', operatorId: 'other' })
  expect(await deliver(attention, signal)).toBe('unavailable')
  state.targets = [{ ...actor, operatorId: '' }]
  expect(await deliver(attention, signal)).toBe('unavailable')
  expect(send).not.toHaveBeenCalled()
})

test('watch nudge rechecks the grant identity and private binding at send time', async () => {
  const attention: RouterJob = { ...watched, status: 'unknown' }
  for (const change of ['regrant', 'rebind', 'ambiguous'] as const) {
    const { deliver, send, signal, state } = fixture()
    send.mockImplementation(async (...args) => {
      if (change === 'regrant') state.grant = 'new-read-grant'
      if (change === 'rebind') state.targets = [{ ...actor, peerId: 'next' }]
      if (change === 'ambiguous')
        state.targets.push({ ...actor, peerId: 'other', operatorId: 'other' })
      expect(args[5]?.()).toBe(false)
      return { status: 'rejected', reason: '授权变更' }
    })
    expect(await deliver(attention, signal)).toBe('unavailable')
  }
})
