import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MandateTarget, TriggerMandate } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const room = 'synthetic-room'
const team: MandateTarget = {
  platform: 'feishu',
  channelId: 'test-app',
  peerId: 'test-peer',
  operatorId: 'test-owner',
}
const archive = { channelId: 'test-app', documentId: 'test-doc' }
const stores = new Set<TriggerStore>()
const databases: Database[] = []
const dirs: string[] = []

afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const db of databases.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-web-inbox-'))
  dirs.push(dir)
  const path = join(dir, 'synthetic.sqlite')
  const store = new TriggerStore(path)
  stores.add(store)
  const sql = new Database(path)
  databases.push(sql)
  const revision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: {
        sessions: [room, 'legacy-room'].map((id) => ({ id, name: id, enabled: true, keyword: '' })),
      },
    },
    0,
  )
  const routeRevision = store.routing.saveSettings(
    { ...store.routing.getSettings().settings, enabled: true },
    0,
  )
  function receive(id: string, scope = room) {
    expect(
      store.commitPush({
        source: 'wxarc',
        stream: `wxarc:${scope}`,
        revision,
        events: [
          {
            eventId: id,
            scope,
            title: `private title ${id}`,
            summary: `private body ${id}`,
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    ).toBe(true)
    return store.listInbox(1)[0].id
  }
  function setMandates(ids: string[]) {
    const mandates: TriggerMandate[] = ids.map((id) => ({
      id,
      name: id,
      purpose: id,
      source: 'wxarc',
      scope: room,
      enabled: true,
      keyword: '',
      projectId: null,
      targets: [team],
      archive,
      policy: {},
      deadline: null,
      urgent: false,
    }))
    store.mandates.saveSettings({ mandates, projects: [] }, store.mandates.getSettings().revision)
  }
  function analyzeMandates() {
    for (;;) {
      const work = store.mandates.claimAnalysis(crypto.randomUUID())
      if (!work) break
      expect(
        store.mandates.finishAnalysis(
          work.match.id,
          `private analysis ${work.mandate.id}`,
          work.claimToken,
        ),
      ).toBe(true)
    }
  }
  function deliverLegacy(id: number) {
    expect(store.routing.claimAgent(id, 'legacy')).toBe(true)
    expect(store.routing.finishAgent(id, 'legacy', { summary: 'private legacy summary' })).toBe(
      true,
    )
    expect(
      store.routing.applyDecision(
        id,
        { destination: 'web', reason: '网页在场' },
        routeRevision,
        new Date().toISOString(),
      ),
    ).toBe(true)
  }
  function claimWeb(matchId: number) {
    expect(
      store.mandates.claimEffect(
        matchId,
        'notify',
        'web',
        null,
        '测试网页',
        new Date().toISOString(),
      ),
    ).toHaveLength(1)
  }
  function reopen(previous: TriggerStore) {
    previous.close()
    stores.delete(previous)
    const recovered = new TriggerStore(path)
    stores.add(recovered)
    return recovered
  }
  return { store, sql, receive, setMandates, analyzeMandates, deliverLegacy, claimWeb, reopen }
}

test('a late legacy delivery and two mandates on one event receive distinct sequence numbers in committed delivery order', () => {
  const f = fixture()
  const feed = f.store.webNotifications
  expect(feed.latestId()).toBe(0)
  const older = f.receive('older', 'legacy-room')
  f.setMandates(['release', 'research'])
  const shared = f.receive('shared')
  f.analyzeMandates()
  const matches = f.store.mandates.listMatches()
  const release = matches.find((m) => m.mandateId === 'release')
  const research = matches.find((m) => m.mandateId === 'research')
  if (!release || !research) throw Error('Expected two authorized matches')
  f.claimWeb(research.id)
  expect(feed.list({}).items).toBeEmpty()
  expect(f.store.mandates.finishEffect(research.id, 'notify', 'done', 'web')).toBe(true)
  const first = feed.latestId()
  f.deliverLegacy(older)
  const second = feed.latestId()
  f.claimWeb(release.id)
  expect(f.store.mandates.finishEffect(release.id, 'notify', 'done', 'web')).toBe(true)
  expect(f.store.mandates.finishEffect(release.id, 'notify', 'done', 'duplicate')).toBe(false)
  const third = feed.latestId()
  expect(second).toBeGreaterThan(first)
  expect(third).toBeGreaterThan(second)
  expect(feed.list({ after: 0 }).items.map((n) => [n.id, n.taskId, n.inboxId, n.summary])).toEqual([
    [first, research.taskId, shared, 'private analysis research'],
    [second, null, older, 'private legacy summary'],
    [third, release.taskId, shared, 'private analysis release'],
  ])
  expect(feed.list({ limit: 2 }).items.map((n) => n.id)).toEqual([third, second])
  expect(feed.list({ before: second }).items.map((n) => n.id)).toEqual([first])
  const page = feed.list({ after: first, limit: 1 })
  expect(page.items.map((n) => n.id)).toEqual([second])
  expect(page.latestId).toBe(third)
  expect(feed.list({ after: third }).items).toEqual([])
  // The global toast needs only pointers. No duplicate copy of the private text is retained in the index.
  const brief = feed.list({ after: 0, brief: true })
  expect(brief.items.map((n) => [n.id, n.taskId, n.inboxId])).toEqual([
    [first, research.taskId, shared],
    [second, null, older],
    [third, release.taskId, shared],
  ])
  for (const item of brief.items) {
    expect(item).not.toHaveProperty('title')
    expect(item).not.toHaveProperty('summary')
  }
  const indexed = f.sql.query('SELECT * FROM trigger_web_notifications').all()
  expect(JSON.stringify(indexed)).not.toContain('private')
})

test('recovery completes an interrupted local Web effect once while archives, remote receipts and unknown sends stay outside the feed', () => {
  const f = fixture()
  f.setMandates(['release'])
  f.receive('web')
  f.receive('remote')
  f.receive('accepted')
  f.analyzeMandates()
  const matches = f.store.mandates.listMatches().sort((a, b) => a.id - b.id)
  const [web, remote, accepted] = matches
  f.claimWeb(web.id)
  for (const match of [remote, accepted]) {
    expect(
      f.store.mandates.claimEffect(
        match.id,
        'notify',
        'feishu',
        team,
        '测试私聊',
        new Date().toISOString(),
      ),
    ).toHaveLength(1)
  }
  expect(f.store.mandates.finishEffect(accepted.id, 'notify', 'done', 'native-id')).toBe(true)
  expect(
    f.store.mandates.claimEffect(
      web.id,
      'archive',
      'archive',
      archive,
      '测试归档',
      new Date().toISOString(),
    ),
  ).toHaveLength(1)
  expect(f.store.mandates.finishEffect(web.id, 'archive', 'done', 'document-block')).toBe(true)
  expect(f.store.webNotifications.latestId()).toBe(0)
  const recovered = f.reopen(f.store)
  recovered.mandates.recoverInterrupted()
  const cursor = recovered.webNotifications.latestId()
  expect(cursor).toBeGreaterThan(0)
  expect(recovered.webNotifications.list({}).items.map((n) => n.taskId)).toEqual([web.taskId])
  expect(
    recovered.mandates.getMatch(remote.id)?.effects.find((e) => e.kind === 'notify')?.status,
  ).toBe('unknown')
  const reopened = f.reopen(recovered)
  reopened.mandates.recoverInterrupted()
  expect(reopened.webNotifications.list({ after: cursor })).toEqual({ items: [], latestId: cursor })
})

test('upgrading a database indexes completed legacy and mandate history once; retiring one task hides only its own notice', () => {
  const f = fixture()
  // The previous version had both delivery paths, but no unified notification index.
  f.sql.exec(`DROP TRIGGER trigger_web_notification_legacy;
    DROP TRIGGER trigger_web_notification_mandate;
    DROP TABLE trigger_web_notifications;`)
  const legacy = f.receive('legacy')
  f.deliverLegacy(legacy)
  f.setMandates(['one', 'two'])
  const shared = f.receive('shared')
  f.analyzeMandates()
  const matches = f.store.mandates.listMatches()
  for (const match of matches) {
    f.claimWeb(match.id)
    expect(f.store.mandates.finishEffect(match.id, 'notify', 'done', 'web')).toBe(true)
  }
  const upgraded = f.reopen(f.store)
  const history = upgraded.webNotifications.list({ after: 0 })
  expect(history.items).toHaveLength(3)
  const cursor = history.latestId
  const reopened = f.reopen(upgraded)
  expect(reopened.webNotifications.latestId()).toBe(cursor)
  expect(reopened.webNotifications.list({ after: cursor }).items).toBeEmpty()
  const [ended, stillOpen] = matches
  f.sql.run('INSERT INTO trigger_retired_task_threads(id) VALUES (?)', [ended.taskId])
  expect(
    reopened.webNotifications
      .list({})
      .items.map((n) => n.taskId)
      .sort(),
  ).toEqual([null, stillOpen.taskId].sort())
  f.sql.run('INSERT INTO trigger_retired_inbox(id) VALUES (?)', [shared])
  expect(reopened.webNotifications.list({}).items.map((n) => n.inboxId)).toEqual([legacy])
  f.sql.run('INSERT INTO trigger_retired_inbox(id) VALUES (?)', [legacy])
  expect(reopened.webNotifications.list({})).toEqual({ items: [], latestId: cursor })
})

test('a failed local Web index write rolls back the effect receipt and restart can recover it', () => {
  const f = fixture()
  f.setMandates(['releases'])
  f.receive('atomic')
  f.analyzeMandates()
  const [match] = f.store.mandates.listMatches()
  f.claimWeb(match.id)
  f.sql.exec(`CREATE TRIGGER reject_test_notice BEFORE INSERT ON trigger_web_notifications BEGIN
    SELECT RAISE(ABORT,'fixture rejected notification'); END;`)
  expect(() => f.store.mandates.finishEffect(match.id, 'notify', 'done', 'web')).toThrow(
    'fixture rejected notification',
  )
  expect(f.store.webNotifications.latestId()).toBe(0)
  expect(
    f.store.mandates.getMatch(match.id)?.effects.find((e) => e.kind === 'notify')?.status,
  ).toBe('sending')
  f.sql.exec('DROP TRIGGER reject_test_notice')
  const restarted = f.reopen(f.store)
  restarted.mandates.recoverInterrupted()
  expect(restarted.webNotifications.list({ after: 0 }).items.map((n) => n.taskId)).toEqual([
    match.taskId,
  ])
})
