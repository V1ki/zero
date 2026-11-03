import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerRoutingSettings, TriggerSettings } from '@zero-os/shared'
import { TriggerSettingsConflictError, TriggerStore } from '../trigger-store'

const source: TriggerSettings = {
  github: { credentialRef: '', repositories: [] },
  wxarc: { sessions: [{ id: 'room', name: 'room', keyword: '', enabled: true }] },
}
const now = '2040-05-01T12:00:00.000Z'
const later = '2040-05-01T14:00:00.000Z'
const stores = new Set<TriggerStore>()
const dirs: string[] = []

function open(path = ':memory:') {
  const store = new TriggerStore(path)
  stores.add(store)
  return store
}
function close(store: TriggerStore) {
  store.close()
  stores.delete(store)
}
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-routing-'))
  dirs.push(dir)
  return join(dir, 'inbox.sqlite')
}
afterEach(() => {
  for (const store of stores) close(store)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function receive(store: TriggerStore, eventId: string) {
  expect(
    store.commitBatch({
      source: 'wxarc',
      stream: 'wxarc:room',
      previousCursor: store.readCursor('wxarc:room'),
      cursor: eventId,
      revision: store.getSettings().revision,
      events: [{ eventId, scope: 'room', title: '事件', summary: eventId, occurredAt: now }],
    }),
  ).toBe(true)
}
function configure(store: TriggerStore, settings: Partial<TriggerRoutingSettings>) {
  const current = store.routing.getSettings()
  return store.routing.saveSettings({ ...current.settings, ...settings }, current.revision)
}
function analyze(store: TriggerStore, id: number) {
  expect(store.routing.claimAgent(id, 'session')).toBe(true)
  expect(store.routing.finishAgent(id, 'session', { summary: '摘要', sessionId: 'session' })).toBe(
    true,
  )
}

test('phase-one inbox upgrades in place without auto-enrolling history; intake is transactional and deduplicated', () => {
  const path = tempPath()
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE trigger_inbox (id INTEGER PRIMARY KEY, source TEXT NOT NULL, stream TEXT NOT NULL,
    event_id TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, url TEXT, UNIQUE(stream, event_id))`)
  old.run(
    "INSERT INTO trigger_inbox VALUES(1, 'wxarc', 'wxarc:room', 'history', 'room', 'old', 'old', ?, ?, NULL)",
    [now, now],
  )
  old.close()
  const store = open(path)
  const observer = open(path)
  store.saveSettings(source, 0)
  expect(observer.routing.getSettings().settings.enabled).toBe(false)
  expect(configure(store, { enabled: true })).toBe(1)
  expect(() => observer.routing.saveSettings(observer.routing.getSettings().settings, 0)).toThrow(
    TriggerSettingsConflictError,
  )
  receive(store, 'history')
  expect(observer.routing.list()).toEqual([])
  receive(store, 'auto')
  receive(store, 'auto')
  expect(observer.routing.list().map(({ event, route }) => [event.eventId, route.origin])).toEqual([
    ['auto', 'subscription'],
  ])
  expect(configure(store, { enabled: false })).toBe(2)
  receive(store, 'paused')
  configure(store, { enabled: true })
  expect(observer.routing.listReady(now).map(({ event }) => event.eventId)).toEqual(['auto'])

  expect(observer.routing.enqueue(999)).toBe(false)
  expect(observer.routing.enqueue(1)).toBe(true)
  expect(store.routing.enqueue(1)).toBe(true)
  expect(
    store.routing.listReady(now).map(({ event, route }) => [event.eventId, route.origin]),
  ).toEqual([
    ['history', 'manual'],
    ['auto', 'subscription'],
  ])
})

test('pending and deferred work respects source pause, explicit request and current version when claiming a destination', () => {
  const store = open()
  store.saveSettings(source, 0)
  const rev = configure(store, { enabled: true })
  receive(store, 'first')
  receive(store, 'second')
  analyze(store, 1)
  expect(
    store.routing.applyDecision(
      1,
      { destination: 'defer', reason: '休息', recheckAt: later },
      rev,
      now,
    ),
  ).toBe(true)
  expect(store.routing.nextDueAt()).toBe(later)
  expect(store.routing.get(1)?.agent?.summary).toBe('摘要')
  expect(store.routing.listReady(now).map(({ event }) => event.id)).toEqual([2])
  store.saveSettings({ ...source, wxarc: { sessions: [] } }, 1)
  expect(store.routing.nextDueAt()).toBeNull()
  expect(store.routing.listReady(later)).toEqual([])
  expect(store.routing.claimAgent(2, 'x')).toBe(false)
  expect(store.routing.applyDecision(1, { destination: 'web', reason: '在场' }, rev, later)).toBe(
    false,
  )
  expect(store.routing.enqueue(1)).toBe(true)
  const newer = configure(store, { presence: 'present' })
  expect(store.routing.listReady(now)[0].route.status).toBe('ready')
  expect(store.routing.applyDecision(1, { destination: 'web', reason: '在场' }, rev, now)).toBe(
    false,
  )
  expect(store.routing.applyDecision(1, { destination: 'web', reason: '在场' }, newer, now)).toBe(
    true,
  )
  expect(store.routing.nextDueAt()).toBeNull()
  expect(store.routing.get(1)?.decision?.destination).toBe('web')
  expect(store.routing.get(1)?.firstDeferred).toEqual({ at: now, reason: '休息' })
  expect(store.routing.listWeb()[0].event.id).toBe(1)
})

test('claim occurs once across connections and interrupted sends stay uncertain on restart', () => {
  const path = tempPath()
  const store = open(path)
  const reader = open(path)
  const target = { channelId: 'weixin', peerId: 'bound-user' }
  store.saveSettings(source, 0)
  const revision = configure(store, { enabled: true, weixinTarget: target })
  receive(store, 'one')
  receive(store, 'two')
  expect(store.routing.claimAgent(1, 'one')).toBe(true)
  expect(reader.routing.claimAgent(1, 'two')).toBe(false)
  expect(reader.routing.finishAgent(1, 'two', { summary: 'outdated' })).toBe(false)
  expect(store.routing.finishAgent(1, 'one', { summary: '摘要' })).toBe(true)
  const decision = { destination: 'weixin', reason: '已绑定' } as const
  expect(store.routing.applyDecision(1, decision, revision, now)).toBe(true)
  expect(reader.routing.applyDecision(1, decision, revision, now)).toBe(false)
  expect(reader.routing.get(1)?.weixinTarget).toEqual(target)
  configure(store, { weixinTarget: null })
  expect(reader.routing.get(1)?.weixinTarget).toEqual(target)
  expect(store.routing.claimAgent(2, 'two')).toBe(true)
  close(reader)
  close(store)
  const recovered = open(path)
  expect(recovered.routing.get(1)?.status).toBe('sending')
  recovered.routing.recoverInterrupted()
  expect(recovered.routing.get(1)?.status).toBe('uncertain')
  expect(recovered.routing.retry(1)).toBe(false)
  recovered.routing.enqueue(1)
  expect(recovered.routing.get(1)?.status).toBe('uncertain')
  expect(recovered.routing.get(2)?.status).toBe('failed')
  expect(recovered.routing.retry(2)).toBe(true)
  expect(recovered.routing.listReady(now).map(({ event }) => event.id)).toEqual([2])
  expect(recovered.routing.finishAgent(2, 'two', { summary: 'late' })).toBe(false)
})

test('a definite send rejection can reroute without rerunning Agent; Web cursor follows delivery order', () => {
  const store = open()
  store.saveSettings(source, 0)
  const rev = configure(store, {
    enabled: true,
    weixinTarget: { channelId: 'weixin', peerId: 'bound' },
  })
  receive(store, 'older')
  receive(store, 'newer')
  receive(store, 'third')
  for (const id of [1, 2, 3]) analyze(store, id)
  const web = { destination: 'web', reason: '首选网页' } as const
  const weixin = { destination: 'weixin', reason: '首选微信' } as const
  expect(store.routing.latestWebDeliveryId()).toBeNull()
  expect(store.routing.applyDecision(1, weixin, rev, now)).toBe(true)
  expect(store.routing.failSend(1, '平台拒绝', false)).toBe(true)
  expect(store.routing.retry(1)).toBe(true)
  expect(store.routing.get(1)?.status).toBe('ready')
  expect(store.routing.applyDecision(2, web, rev, now)).toBe(true)
  expect(store.routing.latestWebDeliveryId()).toBe(1)
  expect(store.routing.applyDecision(1, web, rev, now)).toBe(true)
  expect(store.routing.latestWebDeliveryId()).toBe(2)
  expect(store.routing.applyDecision(1, web, rev, now)).toBe(false)
  expect(store.routing.applyDecision(3, weixin, rev, now)).toBe(true)
  expect(store.routing.finishSend(3)).toBe(true)
  expect(store.routing.finishSend(3)).toBe(false)
  expect(store.routing.listWeb().map(({ event }) => event.id)).toEqual([1, 2])
  expect(store.routing.get(3)?.status).toBe('sent')
})

test('replacing a filter revokes outstanding automatic work, even if the prior filter is restored', () => {
  const store = open()
  store.saveSettings(source, 0)
  configure(store, { enabled: true })
  receive(store, 'before')
  receive(store, 'explicit')
  store.routing.enqueue(2)
  expect(store.routing.claimAgent(1, 'old-attempt')).toBe(true)
  const narrowed = structuredClone(source)
  narrowed.wxarc.sessions[0].keyword = 'narrower'
  store.saveSettings(narrowed, 1)
  store.saveSettings(source, 2)
  expect(store.routing.get(1)?.status).toBe('cancelled')
  expect(store.routing.listReady(now).map(({ event }) => event.id)).toEqual([2])
  expect(store.routing.enqueue(1)).toBe(true)
  expect(store.routing.get(1)?.sessionId).toBe(null)
  expect(store.routing.claimAgent(1, 'new-attempt')).toBe(true)
  expect(store.routing.finishAgent(1, 'old-attempt', { summary: 'stale' })).toBe(false)
  expect(store.routing.finishAgent(1, 'new-attempt', { summary: 'fresh' })).toBe(true)
})

test('reopen a router database without first-defer history, then preserve first recorded defer through later decisions', () => {
  const path = tempPath()
  const before = open(path)
  before.saveSettings(source, 0)
  const rev = configure(before, { enabled: true })
  receive(before, 'defer')
  analyze(before, 1)
  close(before)
  const older = new Database(path)
  older.exec('ALTER TABLE trigger_routes DROP COLUMN first_deferred')
  older.close()
  const store = open(path)
  expect(store.routing.get(1)?.firstDeferred).toBeNull()
  const first = { destination: 'defer', reason: 'away', recheckAt: later } as const
  expect(store.routing.applyDecision(1, first, rev, now)).toBe(true)
  store.routing.wakeDeferred(now)
  expect(store.routing.applyDecision(1, { ...first, reason: 'still away' }, rev, now)).toBe(true)
  expect(store.routing.applyDecision(1, { destination: 'web', reason: 'back' }, rev, later)).toBe(
    true,
  )
  expect(store.routing.get(1)?.firstDeferred).toEqual({ at: now, reason: 'away' })
  expect(store.routing.listWeb()[0].route.decision?.reason).toBe('back')
})
