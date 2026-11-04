import { expect, test } from 'bun:test'
import {
  type TriggerNativePresence,
  type TriggerRoutingSettings,
  getTriggerTimeContext,
} from '@zero-os/shared'
import { decideTriggerRoute } from '../routing-policy'

const settings: TriggerRoutingSettings = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'present',
  duringWork: 'web',
  afterWork: 'weixin',
  offDay: 'defer',
  awayFallback: 'defer',
  weixinTarget: { channelId: 'test-bot', peerId: 'selected-chat' },
}
const mondayNoon = new Date('2026-11-02T12:00:00+08:00')

test('local work hours include the start and exclude the end, weekends use their own preference', () => {
  const route = (at: string) => decideTriggerRoute(settings, new Date(at), undefined, true)
  expect(route('2026-11-02T08:59:59+08:00').destination).toBe('weixin')
  expect(route('2026-11-02T09:00:00+08:00').destination).toBe('web')
  expect(route('2026-11-02T18:00:00+08:00').destination).toBe('weixin')
  expect(route('2026-11-01T20:00:00+08:00').destination).toBe('defer')
})

test('overnight work belongs to its starting workday and ends at the configured local minute', () => {
  const shift = { ...settings, workStart: '22:00', workEnd: '06:00' }
  const route = (at: string) => decideTriggerRoute(shift, new Date(at), undefined, true)
  expect(route('2026-11-06T23:59:59+08:00').destination).toBe('web')
  expect(route('2026-11-07T00:00:00+08:00').destination).toBe('web')
  expect(route('2026-11-07T05:59:59+08:00').destination).toBe('web')
  expect(route('2026-11-07T06:00:00+08:00').destination).toBe('defer')
  expect(route('2026-11-09T05:59:59+08:00').destination).toBe('weixin')
})

test('evaluates IANA-local hours after daylight saving changes', () => {
  const schedule = { ...settings, timeZone: 'America/New_York' }
  expect(decideTriggerRoute(schedule, new Date('2026-10-30T13:15:00Z')).destination).toBe('web')
  expect(decideTriggerRoute(schedule, new Date('2026-11-02T13:15:00Z')).destination).toBe('defer')
  expect(decideTriggerRoute(schedule, new Date('2026-11-02T14:15:00Z')).destination).toBe('web')
})

test('automatic Web delivery requires a recent non-future activity signal, manual away overrides it', () => {
  const auto = { ...settings, presence: 'auto' } as const
  const previous = (ageMs: number) => new Date(mondayNoon.getTime() - ageMs)
  expect(decideTriggerRoute(auto, mondayNoon, previous(119_999)).destination).toBe('web')
  for (const absent of [undefined, previous(120_000), previous(-1)]) {
    expect(decideTriggerRoute(auto, mondayNoon, absent, true).destination).toBe('defer')
  }
  expect(
    decideTriggerRoute({ ...settings, presence: 'away' }, mondayNoon, mondayNoon).destination,
  ).toBe('defer')
})

test('Weixin requires explicit preference and a currently available selected target', () => {
  const fallback = { ...settings, presence: 'away', awayFallback: 'weixin' } as const
  const direct = { ...settings, duringWork: 'weixin' } as const
  for (const config of [direct, fallback]) {
    expect(decideTriggerRoute(config, mondayNoon, undefined, true).destination).toBe('weixin')
    expect(decideTriggerRoute(config, mondayNoon).destination).toBe('defer')
    expect(
      decideTriggerRoute({ ...config, weixinTarget: null }, mondayNoon, undefined, true)
        .destination,
    ).toBe('defer')
  }
  expect(
    decideTriggerRoute({ ...fallback, enabled: false }, mondayNoon, undefined, true).destination,
  ).toBe('defer')
  expect(
    decideTriggerRoute({ ...fallback, duringWork: 'defer' }, mondayNoon, undefined, true)
      .destination,
  ).toBe('defer')
})

test('deferred delivery has a future check and wakes at a near work or date boundary', () => {
  const allDeferred = { ...settings, duringWork: 'defer', afterWork: 'defer' } as const
  const check = (input: string) => {
    const at = new Date(input)
    const route = decideTriggerRoute(allDeferred, at)
    if (route.destination !== 'defer') throw new Error('Expected a deferred route')
    return new Date(route.recheckAt).getTime() - at.getTime()
  }
  expect(check('2026-11-02T08:59:59+08:00')).toBe(1_000)
  expect(check('2026-11-02T23:59:58+08:00')).toBe(2_000)
  expect(check('2026-11-02T12:00:00+08:00')).toBe(5 * 60_000)
})

test('a dated holiday overrides an overnight shift; a makeup shift carries into an ordinary off day', () => {
  const shift: TriggerRoutingSettings = {
    ...settings,
    workStart: '22:00',
    workEnd: '06:00',
    dateOverrides: { '2026-11-07': 'off', '2026-11-08': 'work' },
  }
  const route = (at: string) => decideTriggerRoute(shift, new Date(at)).destination
  expect(route('2026-11-06T23:59:59+08:00')).toBe('web')
  expect(route('2026-11-07T00:00:00+08:00')).toBe('defer')
  expect(route('2026-11-08T05:59:00+08:00')).toBe('defer')
  expect(route('2026-11-08T22:00:00+08:00')).toBe('web')
  expect(route('2026-11-09T05:59:00+08:00')).toBe('web')
})

test('project and mandate calendar overrides can supersede the global date in the routing zone', () => {
  const config: TriggerRoutingSettings = { ...settings, dateOverrides: { '2026-11-02': 'off' } }
  expect(getTriggerTimeContext(config, mondayNoon)).toMatchObject({
    period: 'offDay',
    localDate: '2026-11-02',
    localTime: '12:00',
  })
  expect(
    getTriggerTimeContext(config, mondayNoon, { dateOverrides: { '2026-11-02': 'work' } }).period,
  ).toBe('duringWork')
  const quiet = { quietStart: '21:00', quietEnd: '07:30' }
  const before = getTriggerTimeContext(config, new Date('2026-11-02T07:29:58+08:00'), quiet)
  expect(before.quiet).toBe(true)
  expect(before.recheckAt).toBe('2026-11-01T23:30:00.000Z')
  expect(getTriggerTimeContext(config, new Date('2026-11-02T07:30:00+08:00'), quiet).quiet).toBe(
    false,
  )
  expect(getTriggerTimeContext(config, new Date('2026-11-02T20:59:59+08:00'), quiet).quiet).toBe(
    false,
  )
  expect(getTriggerTimeContext(config, new Date('2026-11-02T21:00:00+08:00'), quiet).quiet).toBe(
    true,
  )
})

test('user opt-in gives fresh lock/idle signals veto over manual presence; Bluetooth alone cannot release Web', () => {
  const config: TriggerRoutingSettings = {
    ...settings,
    nativePresence: { enabled: true, idleMinutes: 5, bluetooth: true },
  }
  const observation = {
    observedAt: mondayNoon.toISOString(),
    locked: false,
    idleSeconds: 0,
    bluetoothConnected: true,
  }
  const send = (config: TriggerRoutingSettings, data?: TriggerNativePresence, activity?: Date) =>
    decideTriggerRoute(config, mondayNoon, activity, true, data)
  expect(send(config, observation).destination).toBe('web')
  for (const data of [
    undefined,
    { ...observation, locked: true },
    { ...observation, idleSeconds: 300 },
    { ...observation, locked: null },
    { ...observation, idleSeconds: null },
    { ...observation, idleSeconds: -1 },
    { ...observation, observedAt: new Date(+mondayNoon + 1).toISOString() },
    { ...observation, observedAt: new Date(+mondayNoon - 30_000).toISOString() },
  ]) {
    expect(send(config, data).destination).toBe('defer')
    expect(send({ ...config, awayFallback: 'weixin' }, data, mondayNoon).destination).toBe('weixin')
  }
  expect(send({ ...config, presence: 'auto' }, observation).destination).toBe('defer')
  expect(send({ ...config, presence: 'auto' }, observation, mondayNoon).destination).toBe('web')
  expect(send({ ...config, presence: 'away' }, observation, mondayNoon).destination).toBe('defer')
  expect(send(settings, { ...observation, locked: true }).destination).toBe('web')
})
