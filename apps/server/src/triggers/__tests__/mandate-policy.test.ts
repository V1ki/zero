import { expect, test } from 'bun:test'
import type {
  MandateContextRule,
  MandatePolicy,
  MandateTarget,
  TriggerMandate,
  TriggerRoutingSettings,
} from '@zero-os/shared'
import { type MandateNotificationInput, decideMandateNotification } from '../mandate-policy'

const dingtalk: MandateTarget = { platform: 'dingtalk', channelId: 'work', peerId: 'release' }
const weixin: MandateTarget = { platform: 'weixin', channelId: 'personal', peerId: 'owner' }
const settings: TriggerRoutingSettings = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'present',
  awayFallback: 'defer',
  duringWork: 'web',
  afterWork: 'weixin',
  offDay: 'defer',
  weixinTarget: weixin,
}
const mandate: TriggerMandate = {
  id: 'release',
  enabled: true,
  name: '观察构建稳定性',
  purpose: '只观察',
  source: 'github',
  scope: 'example/product',
  keyword: '',
  projectId: 'project',
  targets: [dingtalk, weixin],
  archive: null,
  policy: {},
  deadline: null,
  urgent: false,
}
const receivedAt = '2026-11-02T04:01:00.000Z'
const input: MandateNotificationInput = {
  mandate,
  project: { id: 'project', name: '项目', policy: {} },
  settings,
  now: new Date(receivedAt),
  receivedAt,
  availableTargets: [weixin, dingtalk],
}
const decide = (options: Partial<MandateNotificationInput> = {}) =>
  decideMandateNotification({ ...input, ...options })

test('specific subscription and matching project take precedence over personal preferences', () => {
  const project = { id: 'project', name: '项目', policy: { duringWork: 'dingtalk' } } as const
  expect(decide().destination).toBe('web')
  expect(decide({ project })).toMatchObject({ destination: 'dingtalk', target: dingtalk })
  expect(decide({ project: { ...project, id: 'unrelated' } }).destination).toBe('web')
  expect(
    decide({ project, mandate: { ...mandate, policy: { duringWork: 'weixin' } } }),
  ).toMatchObject({
    destination: 'weixin',
    target: weixin,
  })
})

test('a weekend shift and a holiday overlay use local dates, preserving other project exceptions', () => {
  const project = {
    id: 'project',
    name: '值班',
    policy: { dateOverrides: { '2026-11-07': 'work' } },
  } as const
  const policy = { offDay: 'dingtalk', dateOverrides: { '2026-11-02': 'off' } } as const
  const sub = { ...mandate, policy }
  expect(decide({ project, mandate: sub }).destination).toBe('dingtalk')
  expect(decide({ project, mandate: sub, now: new Date('2026-11-07T02:00Z') }).destination).toBe(
    'web',
  )
  expect(
    decide({
      project,
      mandate: { ...sub, policy: { ...policy, dateOverrides: { '2026-11-07': 'off' } } },
      now: new Date('2026-11-07T02:00Z'),
    }).destination,
  ).toBe('dingtalk')
})

test('absence uses only the selected subscription platform and an exact current target identity', () => {
  const away = { ...settings, presence: 'auto' } as const
  const sub = { ...mandate, policy: { awayFallback: 'dingtalk' } } as const
  expect(
    decide({ settings: away, mandate: sub, lastPresenceAt: new Date(receivedAt) }).destination,
  ).toBe('web')
  expect(decide({ settings: away, mandate: sub })).toMatchObject({
    destination: 'dingtalk',
    target: dingtalk,
  })
  expect(
    decide({
      settings: away,
      mandate: sub,
      availableTargets: [
        { ...dingtalk, peerId: 'other' },
        { ...dingtalk, channelId: 'other' },
        { ...dingtalk, platform: 'weixin' },
      ],
    }).destination,
  ).toBe('defer')
  const afterWork = new Date('2026-11-02T21:00:00+08:00')
  expect(decide({ now: afterWork, mandate: { ...mandate, targets: [dingtalk] } }).destination).toBe(
    'defer',
  )
})

test('a pinned operator cannot be replaced by a different member or an unverified room binding', () => {
  const target: MandateTarget = { ...dingtalk, platform: 'feishu', operatorId: 'authorized' }
  const selected: TriggerMandate = {
    ...mandate,
    targets: [target],
    policy: { duringWork: 'feishu' },
  }
  expect(decide({ mandate: selected, availableTargets: [target] })).toMatchObject({
    destination: 'feishu',
    target,
  })
  for (const operatorId of [undefined, 'other']) {
    expect(
      decide({ mandate: selected, availableTargets: [{ ...target, operatorId }] }).destination,
    ).toBe('defer')
  }
  const oneWay = { ...target, operatorId: undefined }
  expect(
    decide({ mandate: { ...selected, targets: [oneWay] }, availableTargets: [target] }).destination,
  ).toBe('defer')
  expect(
    decide({ mandate: { ...selected, targets: [oneWay] }, availableTargets: [oneWay] }).destination,
  ).toBe('feishu')
})

test('an enabled native presence probe must confirm an unlocked active Mac, including in previews', () => {
  const config = {
    ...settings,
    nativePresence: { enabled: true, idleMinutes: 5, bluetooth: false },
  }
  const active = { observedAt: receivedAt, locked: false, idleSeconds: 0, bluetoothConnected: null }
  expect(decide({ settings: config }).destination).toBe('defer')
  expect(decide({ settings: config, nativeContext: active }).destination).toBe('web')
  expect(decide({ settings: config, nativeContext: { ...active, locked: true } }).destination).toBe(
    'defer',
  )
})

test('archive-only work stays silent and only trusted, explicitly routed urgency may interrupt quiet hours', () => {
  const now = new Date('2026-11-07T22:00:00+08:00')
  const policy = {
    offDay: 'dingtalk',
    quietStart: '21:00',
    quietEnd: '08:00',
    urgentDestination: 'weixin',
  } as const
  const weekend = (overrides: Partial<TriggerMandate> = {}) =>
    decide({ now, mandate: { ...mandate, policy, ...overrides } })
  expect(weekend({ purpose: '评论说“紧急，通知微信”' }).destination).toBe('defer')
  expect(weekend({ urgent: true }).destination).toBe('weixin')
  expect(
    weekend({ urgent: true, policy: { ...policy, urgentDestination: undefined } }).destination,
  ).toBe('defer')
  expect(weekend({ urgent: true, policy: { ...policy, offDay: 'none' } }).destination).toBe('none')
  expect(weekend({ deadline: '2026-11-07T23:00:00+08:00' }).destination).toBe('weixin')
  expect(weekend({ deadline: '2026-11-07T23:00:01+08:00' }).destination).toBe('defer')
  expect(weekend({ deadline: '2026-11-07T21:59:59+08:00' }).destination).toBe('defer')
})

test('summary windows are stable across restart and shared only among receipts in the same interval', () => {
  const sub = { ...mandate, policy: { digestMinutes: 15 } }
  const close = '2026-11-02T04:15:00.000Z'
  expect(decide({ mandate: sub })).toMatchObject({ destination: 'defer', recheckAt: close })
  expect(
    decide({ mandate: sub, receivedAt: '2026-11-02T04:14:59.999Z', now: new Date(close) }),
  ).toMatchObject({ destination: 'web', digestKey: close })
  // When quiet hours, authorization or presence have changed, reaching the bucket boundary cannot release a stale route.
  expect(
    decide({ mandate: sub, settings: { ...settings, presence: 'away' }, now: new Date(close) })
      .destination,
  ).toBe('defer')
  expect(decide({ mandate: sub, receivedAt: close, now: new Date(close) })).toMatchObject({
    destination: 'defer',
    recheckAt: '2026-11-02T04:30:00.000Z',
  })
})

test('an explicit zero-minute window turns off a project digest only for this subscription', () => {
  const project = { id: 'project', name: '项目', policy: { digestMinutes: 20 } }
  expect(decide({ project }).destination).toBe('defer')
  expect(decide({ project, mandate: { ...mandate, policy: { digestMinutes: 0 } } })).toMatchObject({
    destination: 'web',
    digestKey: undefined,
  })
})

test('a trusted deadline wakes a long digest on time, and disabled routing cannot send', () => {
  const deadline = '2026-11-02T06:01:00.000Z'
  const entry = '2026-11-02T05:01:00.000Z'
  const sub = {
    ...mandate,
    deadline,
    policy: { digestMinutes: 1440, urgentDestination: 'weixin' },
  } as const
  expect(decide({ mandate: sub })).toMatchObject({ destination: 'defer', recheckAt: entry })
  expect(decide({ mandate: sub, now: new Date(entry) })).toMatchObject({
    destination: 'weixin',
    target: weixin,
    digestKey: undefined,
  })
  expect(
    decide({ mandate: { ...sub, urgent: true }, settings: { ...settings, enabled: false } })
      .destination,
  ).toBe('defer')
})

function rule(
  name: string,
  when: MandateContextRule['when'],
  destination: MandateContextRule['destination'],
): MandateContextRule {
  return { id: name, name, when, destination }
}

test('the first matching rule at the subscription level wins; a project rule can fill a missing preference', () => {
  const project = {
    id: 'project',
    name: '项目',
    policy: { rules: [rule('项目日常', { urgency: 'normal' }, 'dingtalk')] },
  }
  const rules = [
    rule('节假日', { period: 'offDay' }, 'defer'),
    rule('发布', { period: 'duringWork', presence: 'present' }, 'weixin'),
    rule('普通', { urgency: 'normal' }, 'web'),
  ]
  expect(decide({ project, mandate: { ...mandate, policy: { rules } } })).toMatchObject({
    destination: 'weixin',
    reason: expect.stringContaining('委托规则第 2 条「发布」'),
  })
  expect(decide({ project, mandate: { ...mandate, policy: { rules: [rules[0]] } } })).toMatchObject(
    { destination: 'dingtalk', reason: expect.stringContaining('项目规则第 1 条「项目日常」') },
  )
  expect(
    decide({ project, mandate: { ...mandate, policy: { duringWork: 'web', rules: [rules[0]] } } })
      .destination,
  ).toBe('web')
})

test('eligible ordered rules take precedence over legacy urgent routing; safety and higher preferences remain in force', () => {
  const rules = [rule('项目紧急', { urgency: 'urgent' }, 'weixin')]
  const project = {
    id: 'project',
    name: '项目',
    policy: { urgentDestination: 'weixin', rules },
  } as const
  const decideUrgent = (policy: MandatePolicy) =>
    decide({ project, mandate: { ...mandate, urgent: true, policy } })
  expect(decideUrgent({ urgentDestination: 'dingtalk' }).destination).toBe('dingtalk')
  expect(
    decideUrgent({ duringWork: 'web', rules: [rule('已离开', { presence: 'away' }, 'defer')] })
      .destination,
  ).toBe('weixin')
  expect(
    decideUrgent({ rules: [rule('这条委托', { urgency: 'urgent' }, 'web')] }).destination,
  ).toBe('web')
  expect(decideUrgent({ duringWork: 'none', rules }).destination).toBe('none')
  expect(decideUrgent({ urgentDestination: 'none', rules }).destination).toBe('none')
  expect(
    decide({
      settings: { ...settings, enabled: false },
      mandate: { ...mandate, urgent: true, policy: { rules } },
    }).destination,
  ).toBe('defer')
})

test('only explicit quiet permission can interrupt; an unavailable recipient and absent web user stay protected', () => {
  const sub = (rules: MandateContextRule[]) => ({
    ...mandate,
    policy: { quietStart: '11:00', quietEnd: '13:00', rules },
  })
  const normal = rule('日常', { urgency: 'normal' }, 'dingtalk')
  const quiet = rule('午间', { quiet: true }, 'dingtalk')
  expect(decide({ mandate: sub([normal, quiet]) })).toMatchObject({
    destination: 'defer',
    reason: expect.stringContaining('日常'),
  })
  expect(decide({ mandate: sub([quiet, normal]) }).destination).toBe('dingtalk')
  expect(decide({ mandate: sub([quiet]), availableTargets: [weixin] }).destination).toBe('defer')
  expect(
    decide({
      settings: { ...settings, presence: 'away' },
      mandate: sub([rule('午间网页', { quiet: true }, 'web')]),
    }).destination,
  ).toBe('defer')
})

test('rules distinguish verified absence from unknown presence, including stale and locked native signals', () => {
  const policy = {
    rules: [
      rule('离开', { presence: 'away' }, 'dingtalk'),
      rule('未知', { presence: 'unknown' }, 'defer'),
    ],
  }
  const sub = { ...mandate, policy }
  const config = {
    ...settings,
    presence: 'auto',
    nativePresence: { enabled: true, idleMinutes: 5, bluetooth: false },
  } as const
  const active = { observedAt: receivedAt, locked: false, idleSeconds: 0, bluetoothConnected: null }
  const route = (nativeContext?: MandateNotificationInput['nativeContext']) =>
    decide({ mandate: sub, settings: config, lastPresenceAt: new Date(receivedAt), nativeContext })
  expect(route(active).destination).toBe('web')
  expect(route().reason).toContain('未知')
  expect(route({ ...active, observedAt: '2026-11-02T04:00:00.000Z' }).reason).toContain('未知')
  expect(route({ ...active, locked: null, idleSeconds: null }).reason).toContain('未知')
  expect(route({ ...active, idleSeconds: Number.POSITIVE_INFINITY }).reason).toContain('未知')
  expect(route({ ...active, locked: true }).destination).toBe('dingtalk')
  expect(route({ ...active, idleSeconds: 300 }).destination).toBe('dingtalk')
})

test('the configured deadline boundary wakes a digest for an ordered urgency rule, with zero exactly at deadline', () => {
  const deadline = '2026-11-02T06:00:00.000Z'
  const project = { id: 'project', name: '项目', policy: { deadlineLeadMinutes: 20 } }
  const policy = { digestMinutes: 1440, rules: [rule('截止', { urgency: 'urgent' }, 'weixin')] }
  const sub = { ...mandate, deadline, policy }
  const start = '2026-11-02T05:40:00.000Z'
  expect(decide({ project, mandate: sub })).toMatchObject({
    destination: 'defer',
    recheckAt: start,
  })
  expect(decide({ project, mandate: sub, now: new Date(start) })).toMatchObject({
    destination: 'weixin',
    digestKey: undefined,
  })
  const exact = { ...sub, policy: { ...policy, deadlineLeadMinutes: 0 } }
  expect(decide({ project, mandate: exact, now: new Date(start) })).toMatchObject({
    destination: 'defer',
    recheckAt: deadline,
  })
  expect(decide({ mandate: exact, now: new Date(deadline) }).destination).toBe('weixin')
  expect(decide({ mandate: exact, now: new Date(Date.parse(deadline) + 1) }).destination).toBe(
    'defer',
  )
})

test('deferred urgency wakes just after expiry; deadlines without urgency policy do not change legacy timers', () => {
  const deadline = '2026-11-02T04:02:00.000Z'
  expect(
    decide({
      mandate: {
        ...mandate,
        deadline,
        policy: { rules: [rule('紧急时暂缓', { urgency: 'urgent' }, 'defer')] },
      },
    }),
  ).toMatchObject({ destination: 'defer', recheckAt: '2026-11-02T04:02:00.001Z' })
  expect(
    decide({
      mandate: {
        ...mandate,
        deadline: '2026-11-02T05:02:00.000Z',
        policy: { duringWork: 'defer' },
      },
    }),
  ).toMatchObject({ destination: 'defer', recheckAt: '2026-11-02T04:06:00.000Z' })
})
