import { expect, test } from 'bun:test'
import type { TriggerRoutingSettings } from '@zero-os/shared'
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
