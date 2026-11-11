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

test('bound IM audiences survive older clients and the send claim records the actual recipient', () => {
  const store = open()
  store.saveSettings(source, 0)
  const target = {
    platform: 'dingtalk',
    channelId: 'work',
    peerId: 'project',
    operatorId: 'member',
  } as const
  store.routing.saveBotBinding(
    'dingtalk',
    target.channelId,
    target,
    store.routing.getBotBindings().revision,
  )
  const revision = configure(store, { enabled: true, personalBots: { dingtalk: target.channelId } })
  const { personalBots: omitted, ...olderClient } = store.routing.getSettings().settings
  expect(omitted).toEqual({ dingtalk: target.channelId })
  const latest = store.routing.saveSettings({ ...olderClient, presence: 'away' }, revision)
  expect(store.routing.getSettings().settings.personalBots).toEqual({ dingtalk: target.channelId })
  receive(store, 'first')
  analyze(store, 1)
  const sourceRev = store.getSettings().revision
  const decision = { destination: 'dingtalk', reason: '已选钉钉会话' } as const
  expect(store.routing.applyDecision(1, decision, latest, now)).toBe(true)
  expect(store.routing.get(1)).toMatchObject({
    status: 'sending',
    deliveryTarget: target,
    weixinTarget: null,
  })
  expect(store.routing.maySend(1, latest)).toBe(true)
  // Updating a different subscription during token acquisition preserves this send.
  const extraRoom = { id: 'another', name: 'another', keyword: '', enabled: true }
  store.saveSettings(
    { ...source, wxarc: { sessions: [...source.wxarc.sessions, extraRoom] } },
    sourceRev,
  )
  expect(store.routing.maySend(1, latest)).toBe(true)
  store.saveSettings({ ...source, wxarc: { sessions: [extraRoom] } }, sourceRev + 1)
  store.saveSettings(source, sourceRev + 2)
  expect(store.routing.maySend(1, latest)).toBe(false)
  configure(store, { personalBots: { dingtalk: null } })
  expect(store.routing.maySend(1, latest)).toBe(false)
  expect(store.routing.getSettings().settings.personalBots?.dingtalk).toBe(null)
  expect(store.routing.get(1)?.deliveryTarget).toEqual(target)
  expect(store.routing.releaseUnsent(1)).toBe(true)
  expect(store.routing.get(1)?.status).toBe('cancelled')
})

test('a confirmed unsent personal claim rechecks policy; explicit manual work survives removal of its source', () => {
  const store = open()
  store.saveSettings(source, 0)
  const rev = configure(store, {
    enabled: true,
    weixinTarget: { channelId: 'bot', peerId: 'self' },
  })
  receive(store, 'first')
  store.routing.enqueue(1)
  analyze(store, 1)
  const decision = { destination: 'weixin', reason: '已选微信' } as const
  expect(store.routing.applyDecision(1, decision, rev, now)).toBe(true)
  store.saveSettings({ ...source, wxarc: { sessions: [] } }, 1)
  expect(store.routing.maySend(1, rev)).toBe(true)
  const next = configure(store, { duringWork: 'defer' })
  expect(store.routing.maySend(1, rev)).toBe(false)
  expect(store.routing.maySend(1, next)).toBe(false)
  expect(store.routing.releaseUnsent(1)).toBe(true)
  expect(store.routing.get(1)).toMatchObject({
    status: 'ready',
    deliveryTarget: null,
    agent: { summary: '摘要' },
  })
  expect(store.routing.releaseUnsent(1)).toBe(false)
  expect(
    store.routing.applyDecision(
      1,
      { destination: 'defer', reason: '偏好已变更', recheckAt: later },
      next,
      now,
    ),
  ).toBe(true)
})

test('migrates legacy private recipients once and preserves an explicit unbinding through old-client saves and restart', () => {
  const path = tempPath()
  const legacyPeer = { channelId: 'personal-weixin', peerId: 'legacy-peer' }
  const { personalBots: _newPreference, ...legacyDefaults } = open().routing.getSettings().settings
  const legacyConfig = { ...legacyDefaults, weixinTarget: legacyPeer }
  const old = new Database(path, { create: true })
  old.exec(
    'CREATE TABLE trigger_route_settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL)',
  )
  old.run('INSERT INTO trigger_route_settings VALUES (1,4,?)', [JSON.stringify(legacyConfig)])
  old.close()
  const store = open(path)
  const migrated = { ...legacyPeer, platform: 'weixin', operatorId: 'legacy-peer' } as const
  expect(store.routing.getBotBindings().targets).toEqual([migrated])
  expect(store.routing.resolveBotTarget(legacyConfig, 'weixin')).toEqual(migrated)
  const cleared = store.routing.saveBotBinding(
    'weixin',
    legacyPeer.channelId,
    null,
    store.routing.getBotBindings().revision,
  )
  expect(cleared.targets).toEqual([])
  expect(() => store.routing.saveSettings({ ...legacyConfig, presence: 'away' }, 4)).toThrow(
    TriggerSettingsConflictError,
  )
  expect(store.routing.getSettings()).toMatchObject({
    revision: 5,
    settings: { weixinTarget: null, personalBots: { weixin: legacyPeer.channelId } },
  })
  configure(store, { presence: 'away' })
  close(store)
  const reopened = open(path)
  expect(reopened.routing.getBotBindings().targets).toEqual([])
  expect(
    reopened.routing.resolveBotTarget(reopened.routing.getSettings().settings, 'weixin'),
  ).toBeNull()

  // An old client that explicitly selects a different recipient still updates this bot's binding.
  configure(reopened, { weixinTarget: { ...legacyPeer, peerId: 'new-peer' } })
  expect(
    reopened.routing.resolveBotTarget(reopened.routing.getSettings().settings, 'weixin'),
  ).toEqual({
    ...migrated,
    peerId: 'new-peer',
    operatorId: 'new-peer',
  })
})

test('changing a represented legacy Weixin address invalidates old editors without changing the selected bot', () => {
  const store = open()
  configure(store, {
    weixinTarget: { channelId: 'legacy-bot', peerId: 'first' },
    personalBots: { weixin: 'selected-bot' },
  })
  const previous = store.routing.getSettings()
  const other = {
    platform: 'weixin',
    channelId: 'other',
    peerId: 'unrelated',
    operatorId: 'unrelated',
  } as const
  const unrelated = store.routing.saveBotBinding(
    'weixin',
    'other',
    other,
    store.routing.getBotBindings().revision,
  )
  expect(store.routing.getSettings().revision).toBe(previous.revision)
  const changed = { ...other, channelId: 'legacy-bot', peerId: 'second', operatorId: 'second' }
  const rebound = store.routing.saveBotBinding('weixin', 'legacy-bot', changed, unrelated.revision)
  expect(store.routing.getSettings()).toMatchObject({
    revision: previous.revision + 1,
    settings: {
      weixinTarget: { channelId: 'legacy-bot', peerId: 'second' },
      personalBots: { weixin: 'selected-bot' },
    },
  })
  expect(() =>
    store.routing.saveSettings({ ...previous.settings, presence: 'away' }, previous.revision),
  ).toThrow(TriggerSettingsConflictError)
  store.routing.saveBotBinding('weixin', 'legacy-bot', null, rebound.revision)
  expect(store.routing.getSettings().settings).toMatchObject({
    weixinTarget: null,
    personalBots: { weixin: 'selected-bot' },
  })
})

test('send claims use only the selected bot binding and detect an address change even after restoring it', () => {
  const store = open()
  store.saveSettings(source, 0)
  const a = {
    platform: 'feishu',
    channelId: 'selected-bot',
    peerId: 'private',
    operatorId: 'operator',
  } as const
  const b = { ...a, channelId: 'second-bot', peerId: 'other-private' }
  const revision = configure(store, { enabled: true, personalBots: { feishu: a.channelId } })
  const { settings } = store.routing.getSettings()
  const initial = store.routing.getBotBindings().revision
  expect(() => store.routing.saveBotBinding(a.platform, a.channelId, b, initial)).toThrow()
  const onlySecond = store.routing.saveBotBinding(b.platform, b.channelId, b, initial)
  expect(store.routing.resolveBotTarget(settings, 'feishu')).toBeNull()
  expect(() => store.routing.saveBotBinding(a.platform, a.channelId, a, initial)).toThrow(
    TriggerSettingsConflictError,
  )
  const bound = store.routing.saveBotBinding(a.platform, a.channelId, a, onlySecond.revision)
  expect(store.routing.resolveBotTarget(settings, 'feishu')).toEqual(a)
  receive(store, 'with-selected-bot')
  analyze(store, 1)
  expect(
    store.routing.applyDecision(
      1,
      { destination: 'feishu', reason: '选用研究机器人' },
      revision,
      now,
    ),
  ).toBe(true)
  expect(store.routing.get(1)?.deliveryTarget).toEqual(a)
  expect(store.routing.maySend(1, revision)).toBe(true)
  const removedOther = store.routing.saveBotBinding(b.platform, b.channelId, null, bound.revision)
  expect(store.routing.maySend(1, revision)).toBe(true)
  const changed = store.routing.saveBotBinding(
    a.platform,
    a.channelId,
    { ...a, operatorId: 'new-operator' },
    removedOther.revision,
  )
  expect(store.routing.maySend(1, revision)).toBe(false)
  store.routing.saveBotBinding(a.platform, a.channelId, a, changed.revision)
  expect(store.routing.maySend(1, revision)).toBe(false)
  expect(store.routing.releaseUnsent(1)).toBe(true)
  expect(store.routing.get(1)?.status).toBe('ready')
  expect(
    store.routing.applyDecision(1, { destination: 'feishu', reason: '重新核验' }, revision, now),
  ).toBe(true)
  expect(store.routing.maySend(1, revision)).toBe(true)
})

test('a partial bot map keeps other selections and an explicit Weixin opt-out', () => {
  const store = open()
  const weixinTarget = { channelId: 'old', peerId: 'peer' }
  configure(store, { weixinTarget, personalBots: { weixin: null, dingtalk: 'work' } })
  configure(store, { personalBots: { feishu: 'research' } })
  expect(store.routing.getSettings().settings.personalBots).toEqual({
    weixin: null,
    dingtalk: 'work',
    feishu: 'research',
  })
  // A legacy editor echoes unrecognized fields, but the edited Weixin recipient still selects its bot.
  configure(store, { weixinTarget: { channelId: 'new', peerId: 'self' } })
  expect(store.routing.getSettings().settings.personalBots).toEqual({
    weixin: 'new',
    dingtalk: 'work',
    feishu: 'research',
  })
})

test('a bot learns only its own address on a successful claim and keeps the original recipient through restart', () => {
  const path = tempPath()
  const store = open(path)
  store.saveSettings(source, 0)
  const target = {
    platform: 'feishu',
    channelId: 'research',
    peerId: 'direct',
    operatorId: 'person',
  } as const
  const lookup = { target: { ...target, label: 'private display metadata' }, bindingRevision: null }
  const revision = configure(store, { enabled: true, personalBots: { feishu: target.channelId } })
  const decision = { destination: 'feishu', reason: '已选择飞书' } as const
  receive(store, 'first')
  expect(store.routing.applyDecision(1, decision, revision, now, lookup)).toBe(false)
  analyze(store, 1)
  expect(store.routing.applyDecision(1, decision, revision - 1, now, lookup)).toBe(false)
  expect(
    store.routing.applyDecision(1, decision, revision, now, {
      ...lookup,
      target: { ...target, channelId: 'different-bot' },
    }),
  ).toBe(false)
  expect(store.routing.getPersonalBotBinding(target.platform, target.channelId)).toBeNull()
  expect(store.routing.applyDecision(1, decision, revision, now, lookup)).toBe(true)
  expect(store.routing.get(1)?.deliveryTarget).toEqual(target)
  expect(store.routing.maySend(1, revision)).toBe(true)
  expect(store.routing.getSettings().revision).toBe(revision)
  close(store)
  const reopened = open(path)
  const saved = reopened.routing.getPersonalBotBinding(target.platform, target.channelId)
  expect(saved).toEqual({ target, revision: 1, automatic: true })
  expect(reopened.routing.applyDecision(1, decision, revision, now, lookup)).toBe(false)
  // Confirming the same recipient explicitly supersedes the inferred grant.
  reopened.routing.saveBotBinding(target.platform, target.channelId, target, 1)
  expect(reopened.routing.getPersonalBotBinding(target.platform, target.channelId)).toEqual({
    target,
    revision: 2,
    automatic: false,
  })
  expect(reopened.routing.maySend(1, revision)).toBe(false)
  expect(reopened.routing.releaseUnsent(1)).toBe(true)
  expect(
    reopened.routing.applyDecision(1, decision, revision, now, { target, bindingRevision: 1 }),
  ).toBe(false)
  expect(
    reopened.routing.applyDecision(1, decision, revision, now, { target, bindingRevision: 2 }),
  ).toBe(true)
})

test('an explicit revoke before first delivery survives restart and prevents stale discovery from learning an address', () => {
  const path = tempPath()
  const store = open(path)
  store.saveSettings(source, 0)
  const target = {
    platform: 'dingtalk',
    channelId: 'ops',
    peerId: 'dm',
    operatorId: 'staff',
  } as const
  const revision = configure(store, { enabled: true, personalBots: { dingtalk: target.channelId } })
  const decision = { destination: 'dingtalk', reason: '运维提醒' } as const
  receive(store, 'first')
  analyze(store, 1)
  const revoked = store.routing.saveBotBinding(target.platform, target.channelId, null, 0)
  expect(revoked).toEqual({ revision: 1, targets: [] })
  close(store)
  const reopened = open(path)
  const pin = reopened.routing.getPersonalBotBinding(target.platform, target.channelId)
  expect(pin).toEqual({ target: null, automatic: false, revision: 1 })
  for (const bindingRevision of [null, 1]) {
    expect(
      reopened.routing.applyDecision(1, decision, revision, now, { target, bindingRevision }),
    ).toBe(false)
  }
  expect(reopened.routing.getBotBindings()).toEqual(revoked)
  expect(reopened.routing.get(1)?.status).toBe('ready')
})

test('legacy Weixin receipts expose the original audience on schema upgrade', () => {
  const path = tempPath()
  const before = open(path)
  before.saveSettings(source, 0)
  const target = { channelId: 'bot', peerId: 'self' }
  const revision = configure(before, { enabled: true, weixinTarget: target })
  receive(before, 'old')
  analyze(before, 1)
  before.routing.applyDecision(1, { destination: 'weixin', reason: '已绑定' }, revision, now)
  before.routing.finishSend(1)
  close(before)
  const old = new Database(path)
  old.exec(`
    DROP TRIGGER trigger_route_cancel_on_unsubscribe;
    DROP TRIGGER trigger_route_cancel_on_new_filter;
    ALTER TABLE trigger_routes DROP COLUMN send_source_revoked;
    ALTER TABLE trigger_routes DROP COLUMN delivery_target;
    ALTER TABLE trigger_route_bot_bindings DROP COLUMN automatic;
    CREATE TRIGGER trigger_route_cancel_on_unsubscribe AFTER DELETE ON trigger_streams
      BEGIN UPDATE trigger_routes SET status='cancelled' WHERE status='pending'; END;
  `)
  old.close()
  const after = open(path)
  expect(after.routing.getPersonalBotBinding('weixin', target.channelId)?.automatic).toBe(false)
  expect(after.routing.get(1)).toMatchObject({
    status: 'sent',
    weixinTarget: target,
    deliveryTarget: { platform: 'weixin', ...target, operatorId: 'self' },
  })
  receive(after, 'after-upgrade')
  analyze(after, 2)
  expect(
    after.routing.applyDecision(2, { destination: 'weixin', reason: '已绑定' }, revision, now),
  ).toBe(true)
  after.saveSettings({ ...source, wxarc: { sessions: [] } }, 1)
  after.saveSettings(source, 2)
  expect(after.routing.maySend(2, revision)).toBe(false)
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

test('triage filters only a subscription route while triage is on; notify anyway resumes with its summary', () => {
  const path = tempPath()
  const store = open(path)
  store.saveSettings(source, 0)
  configure(store, { enabled: true })
  const skip = {
    summary: '重复',
    sessionId: 's',
    triage: { decision: 'skip' as const, reason: '同上' },
  }
  receive(store, 'first')
  receive(store, 'second')
  receive(store, 'third')
  const [first, second, third] = store.routing
    .list()
    .map(({ event }) => event.id)
    .sort()
  expect(store.routing.filterAgent(first, 's', skip)).toBe(false)
  expect(store.routing.claimAgent(first, 's')).toBe(true)
  expect(store.routing.filterAgent(first, 'other-session', skip)).toBe(false)
  expect(store.routing.filterAgent(first, 's', skip)).toBe(true)
  expect(store.routing.get(first)).toMatchObject({ status: 'filtered', agent: skip })
  expect(store.routing.listReady(later)).toHaveLength(2)

  // Older clients omit the switch and keep it; an explicit false turns triage off.
  const { triage: _, ...oldClient } = store.routing.getSettings().settings
  store.routing.saveSettings(oldClient, store.routing.getSettings().revision)
  expect(store.routing.getSettings().settings.triage).toBeUndefined()
  configure(store, { triage: false })
  expect(store.routing.claimAgent(second, 's')).toBe(true)
  expect(store.routing.filterAgent(second, 's', skip)).toBe(false)
  store.routing.saveSettings(
    { ...store.routing.getSettings().settings, triage: undefined },
    store.routing.getSettings().revision,
  )
  expect(store.routing.getSettings().settings.triage).toBe(false)
  configure(store, { triage: true })

  // A manual request made before analysis is never filtered.
  expect(store.routing.enqueue(third)).toBe(true)
  expect(store.routing.claimAgent(third, 's')).toBe(true)
  expect(store.routing.filterAgent(third, 's', skip)).toBe(false)

  // Only analysed earlier events of the stream within the window are listed.
  expect(
    store.routing
      .listRecentInStream(third, '2000-01-01T00:00:00.000Z')
      .map((e) => [e.summary, e.outcome]),
  ).toEqual([['重复', 'filtered']])
  expect(store.routing.listRecentInStream(third, '2999-01-01T00:00:00.000Z')).toEqual([])

  close(store)
  const reopened = open(path)
  reopened.routing.recoverInterrupted()
  expect(reopened.routing.get(first)?.status).toBe('filtered')
  expect(reopened.routing.enqueue(first)).toBe(true)
  expect(reopened.routing.get(first)).toMatchObject({
    origin: 'manual',
    status: 'ready',
    sessionId: 's',
    agent: skip,
  })

  // The summary sees the restore through its own column; the route itself reads as before.
  const window = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' }
  const notes = { unread: '（未读）', unfinished: '（未完）' }
  const restoredCount = () => reopened.summary.read([window], notes)[0]?.triage
  expect(restoredCount()).toEqual({ filtered: 0, restored: 1 })
  expect(
    reopened.routing.applyDecision(
      first,
      { destination: 'web', reason: 'here' },
      reopened.routing.getSettings().revision,
      later,
    ),
  ).toBe(true)
  expect(reopened.routing.get(first)?.status).toBe('web')
  expect(restoredCount()).toEqual({ filtered: 0, restored: 1 })
  expect(reopened.summary.read([window], notes)[0]?.notifications.personal).toBe(1)
  // A plain retry of a failed route is not a restore.
  expect(reopened.routing.get(second)?.status).toBe('failed')
  expect(reopened.routing.retry(second)).toBe(true)
  const raw = new Database(path)
  expect(
    raw
      .query(
        'SELECT inbox_id AS id, triage_restored AS restored FROM trigger_routes ORDER BY inbox_id',
      )
      .all(),
  ).toEqual([
    { id: first, restored: 1 },
    { id: second, restored: 0 },
    { id: third, restored: 0 },
  ])
  raw.close()
})
