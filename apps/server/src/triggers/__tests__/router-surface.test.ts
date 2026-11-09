import { expect, test } from 'bun:test'
import {
  ROUTER_A2UI_VERSION,
  type RouterActionName,
  type RouterSurfaceMessages,
  type RouterTrackingResult,
  type TriggerInboxItem,
  type TriggerRouteRecord,
  type TriggerRoutingSettings,
  readRouterSurface,
} from '@zero-os/shared'
import {
  buildRouterReplySurface,
  buildRouterSurface,
  isRouterSurfaceAction,
  matchesRouterSurfaceAction,
} from '../router-surface'

const cfg: TriggerRoutingSettings = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'auto',
  duringWork: 'web',
  afterWork: 'weixin',
  offDay: 'defer',
  awayFallback: 'defer',
  weixinTarget: null,
}
const item: TriggerInboxItem = {
  id: 7,
  eventId: 'github-run',
  source: 'github',
  scope: 'org/repo',
  title: 'build failed',
  summary: 'raw event',
  occurredAt: '2026-10-15T03:15:00Z',
  receivedAt: '2026-10-15T03:19:00Z',
}
const deferred: TriggerRouteRecord = {
  inboxId: 7,
  origin: 'manual',
  status: 'deferred',
  sessionId: null,
  agent: { summary: 'known facts' },
  decision: { destination: 'defer', reason: 'quiet time', recheckAt: '2026-10-16T01:00:00Z' },
  firstDeferred: { at: '2026-10-15T03:25:00Z', reason: 'away' },
  settingsRevision: 7,
  weixinTarget: null,
  error: null,
  updatedAt: '2026-10-15T03:26:00Z',
}

test('the event surface distinguishes own comments and shows live intake instead of notification status', () => {
  const surface = buildRouterSurface(
    7,
    { ...item, githubOwnComment: true },
    { ...deferred, status: 'pending' },
    cfg,
    [],
    undefined,
    undefined,
    undefined,
    { state: 'running', kind: 'worker_result', error: null },
  )
  expect(JSON.stringify(surface)).toContain('自身产生')
  expect(JSON.stringify(surface)).toContain('Router 正在处理 Worker 结果')
  expect(JSON.stringify(surface)).not.toContain('等待 Agent')
})

function click(messages: RouterSurfaceMessages, name: RouterActionName) {
  return {
    version: ROUTER_A2UI_VERSION,
    action: {
      surfaceId: messages[0].createSurface.surfaceId,
      sourceComponentId: `btn-${name}`,
      name,
      timestamp: '2026-10-15T08:00:00.000Z',
      context: {},
    },
  } as const
}

test('surfaces describe the actual scope, routing decision and deferral', () => {
  const general = buildRouterSurface('general', null, null, cfg)
  const event = buildRouterSurface(7, item, deferred, cfg)
  for (const s of [general, event]) {
    expect(readRouterSurface(s)).not.toBeNull()
    expect(matchesRouterSurfaceAction(s, click(s, 'explain_route'))).toBe(true)
    expect(matchesRouterSurfaceAction(s, click(s, 'process_event'))).toBe(false)
  }
  expect(JSON.stringify(general)).toContain('09:00–18:00')
  expect(JSON.stringify(general)).not.toContain(item.summary)
  for (const detail of ['known facts', 'quiet time', 'away', '下次复核'])
    expect(JSON.stringify(event)).toContain(detail)
  expect(matchesRouterSurfaceAction(event, click(general, 'explain_route'))).toBe(false)
  expect(() => buildRouterSurface(8, item, deferred, cfg)).toThrow()
  const pending = buildRouterSurface(7, item, null, cfg)
  expect(matchesRouterSurfaceAction(pending, click(pending, 'process_event'))).toBe(true)
  expect(
    matchesRouterSurfaceAction(
      buildRouterSurface(7, item, null, { ...cfg, enabled: false }),
      click(pending, 'process_event'),
    ),
  ).toBe(false)
})

test('worker actions stay bound to the displayed event and attempt, independently of notification routing', () => {
  const receipt: RouterTrackingResult = {
    id: 13,
    attempt: 1,
    inboxId: item.id,
    repository: item.scope,
    title: item.title,
    occurredAt: item.occurredAt,
    kind: 'issue-comment',
    status: 'completed',
    needsAttention: false,
    result: 'Previous summary',
  }
  const card = (tracking?: RouterTrackingResult) =>
    buildRouterSurface(
      item.id,
      item,
      null,
      { ...cfg, enabled: false },
      [],
      undefined,
      undefined,
      tracking,
    )
  const shown = card(receipt)
  const act = click(shown, 'work_on_event')
  const confirm = { ...act, action: { ...act.action, sourceComponentId: 'btn-work_on_event-1' } }
  expect(matchesRouterSurfaceAction(shown, confirm)).toBe(true)
  expect(matchesRouterSurfaceAction(shown, click(shown, 'process_event'))).toBe(false)
  for (const changed of [
    undefined,
    { ...receipt, attempt: 2 },
    { ...receipt, inboxId: 8 },
    { ...receipt, repository: 'other/repo' },
    { ...receipt, status: 'queued' as const },
  ]) {
    expect(matchesRouterSurfaceAction(card(changed), confirm)).toBe(false)
  }
})

test('model facts become bound text; preference changes require their original version and turn', () => {
  expect(buildRouterReplySurface(7, 42, { text: 'plain reply' })).toBeNull()
  const answer = {
    text: '建议',
    intent: 'next',
    points: ['<img src=x onerror=alert(1)>'],
    proposal: { key: 'offDay', value: 'defer' },
    proposalRevision: 3,
  } as const
  const data = { ...answer, points: [...answer.points] }
  const card = buildRouterReplySurface(7, 42, data, 3)
  const stale = buildRouterReplySurface(7, 42, data, 4)
  const otherTurn = buildRouterReplySurface(7, 43, data, 3)
  if (!card || !stale || !otherTurn) throw Error('Missing reply surface')
  expect(card[2].updateDataModel.value).toContainValue(data.points[0])
  expect(JSON.stringify(card)).toContain('休息日改为「延后提醒」')
  const accept = click(card, 'apply_preference')
  expect(matchesRouterSurfaceAction(card, accept)).toBe(true)
  expect(matchesRouterSurfaceAction(otherTurn, accept)).toBe(false)
  expect(matchesRouterSurfaceAction(stale, accept)).toBe(false)
  expect(JSON.stringify(stale)).toContain('设置版本已更新')
  for (const revision of [3, 4]) {
    const applied = buildRouterReplySurface(
      7,
      42,
      { ...data, proposalAppliedAt: '2026-10-15T08:01:00.000Z' },
      revision,
    )
    if (!applied) throw Error('Missing receipt surface')
    expect(matchesRouterSurfaceAction(applied, accept)).toBe(false)
    expect(JSON.stringify(applied)).toContain('已确认并保存此偏好')
    expect(JSON.stringify(applied)).not.toContain('重新提出')
  }
  expect(matchesRouterSurfaceAction(card, click(card, 'process_event'))).toBe(false)
  expect(
    isRouterSurfaceAction({
      ...accept,
      action: { ...accept.action, context: { value: 'weixin' } },
    }),
  ).toBe(false)
  expect(
    isRouterSurfaceAction({
      ...accept,
      action: { ...accept.action, sourceComponentId: 'heading' },
    }),
  ).toBe(false)
  expect(
    isRouterSurfaceAction({ ...accept, action: { ...accept.action, timestamp: 'yesterday' } }),
  ).toBe(false)
})

test('a proposed Weixin preference requires the selected bot to exist', () => {
  const answer = {
    text: '',
    proposal: { key: 'afterWork', value: 'weixin' },
    proposalRevision: 4,
  } as const
  const absent = buildRouterReplySurface('general', 7, answer, 4)
  const available = buildRouterReplySurface('general', 7, answer, 4, true)
  if (!absent || !available) throw Error('Missing preference surface')
  const action = click(available, 'apply_preference')
  expect(JSON.stringify(absent)).toContain('在渠道配置中核对机器人账号')
  expect(matchesRouterSurfaceAction(absent, action)).toBe(false)
  expect(matchesRouterSurfaceAction(available, action)).toBe(true)
})

test('a personal reminder card shows the exact message and offers send only while it is a draft', () => {
  const reminder = {
    platform: 'weixin',
    channelId: 'v1ki-bot',
    botLabel: '我的微信',
    audienceKey: 'private-fingerprint',
    text: '处理 DeepSeek 的充值\n明细 <https://example.test>',
  } as const
  for (const [status, label] of [
    ['draft', '待发送'],
    ['sending', '正在发送，等待平台回执'],
    ['accepted', '平台已受理'],
    ['rejected', '未能发送'],
    ['unknown', '发送结果待核实，请查看机器人私聊'],
  ] as const) {
    const answer = { text: '一次性通知', reminder: { ...reminder, status } }
    const card = buildRouterReplySurface('general', 5, answer)
    if (!card) throw Error('Missing reminder surface')
    const values = card[2].updateDataModel.value
    expect(values).toContainValue('我的微信（v1ki-bot）')
    expect(values).toContainValue(reminder.text)
    expect(values).toContainValue(label)
    expect(JSON.stringify(card)).not.toContain(reminder.audienceKey)
    expect(matchesRouterSurfaceAction(card, click(card, 'send_reminder'))).toBe(status === 'draft')
    expect(matchesRouterSurfaceAction(card, click(card, 'prepare_reminder'))).toBe(false)
    expect(buildRouterReplySurface(7, 5, answer)).toBeNull()
  }
})

test('a legacy one-time request can prepare a new preview but cannot send from the old answer', () => {
  const legacy = { text: '之前未发送。' }
  expect(buildRouterReplySurface('general', 4, legacy)).toBeNull()
  const card = buildRouterReplySurface('general', 4, legacy, 1, false, undefined, true)
  if (!card) throw Error('Missing legacy prepare surface')
  expect(matchesRouterSurfaceAction(card, click(card, 'prepare_reminder'))).toBe(true)
  expect(matchesRouterSurfaceAction(card, click(card, 'send_reminder'))).toBe(false)
  expect(buildRouterReplySurface('task-5', 4, legacy, 1, false, undefined, true)).toBeNull()
})

test('rejects unsupported catalogs, mixed surfaces, missing data, unknown components and cyclic trees', () => {
  const src = buildRouterSurface('general', null, null, cfg)
  function check(mutate: (messages: RouterSurfaceMessages) => void) {
    const copy = structuredClone(src)
    mutate(copy)
    expect(readRouterSurface(copy)).toBeNull()
  }
  check((m) => Object.assign(m[0].createSurface, { catalogId: 'https://untrusted.example/schema' }))
  check((m) => Object.assign(m[1], { version: 'v1.0' }))
  check((m) => {
    m[2].updateDataModel.surfaceId = 'unrelated'
  })
  check((m) => {
    m[2].updateDataModel.value = {}
  })
  check((m) => {
    Object.assign(m[1].updateComponents.components[0], { component: 'Html', html: '<script>' })
  })
  check((m) => {
    Object.assign(m[1].updateComponents.components[0], {
      component: 'Text',
      text: { call: 'execute' },
    })
  })
  check((m) => {
    const nodes = m[1].updateComponents.components
    const root = nodes.find((n) => n.id === 'root')
    if (root?.component === 'Column') root.children.push('root')
  })
})
