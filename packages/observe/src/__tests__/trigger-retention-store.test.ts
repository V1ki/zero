import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerMandate, TriggerRoutingSettings } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const dirs: string[] = []
const stores: TriggerStore[] = []
const dbs: Database[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const future = () => new Date(Date.now() + 9 * 86_400_000)
function config(store: TriggerStore, patch: Partial<TriggerRoutingSettings>) {
  const current = store.routing.getSettings()
  return store.routing.saveSettings({ ...current.settings, ...patch }, current.revision)
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-retention-'))
  dirs.push(dir)
  const path = join(dir, 'synthetic.sqlite')
  const store = new TriggerStore(path)
  stores.push(store)
  const sql = new Database(path)
  dbs.push(sql)
  store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: 'r', name: 'r', enabled: true, keyword: '' }] },
    },
    0,
  )
  function receive(id: string) {
    const accepted = store.commitPush({
      source: 'wxarc',
      stream: 'wxarc:r',
      revision: store.getSettings().revision,
      events: [
        {
          eventId: id,
          title: 'private title',
          summary: 'private body',
          scope: 'r',
          occurredAt: new Date().toISOString(),
          url: 'https://example.test/private',
        },
      ],
    })
    expect(accepted).toBe(true)
    return store.listInbox(1)[0]?.id
  }
  function done(id: number) {
    expect(store.routing.claimAgent(id, 'synthetic-session')).toBe(true)
    expect(store.routing.finishAgent(id, 'synthetic-session', { summary: 'private summary' })).toBe(
      true,
    )
    expect(
      store.routing.applyDecision(
        id,
        { destination: 'web', reason: 'private reason' },
        store.routing.getSettings().revision,
        new Date().toISOString(),
      ),
    ).toBe(true)
  }
  function turn(scope: number | 'general', request: string) {
    const result = store.conversations.begin(scope, request, 'private question')
    if (result.kind !== 'started') throw new Error('turn not started')
    expect(
      store.conversations.finish(scope, request, result.attempt, { text: 'private reply' }),
    ).toBe(true)
  }
  return { store, sql, receive, done, turn }
}

test('retention opt-in grants existing history a full term, removes closed bodies, preserves ids and replay barriers', () => {
  const { store, sql, receive, done, turn } = fixture()
  const unprocessed = receive('raw')
  config(store, { enabled: true })
  const old = receive('terminal')
  done(old)
  turn(old, 'event-chat')
  turn('general', 'general-chat')
  const webCursor = store.routing.latestWebDeliveryId()
  expect(store.retention.sweep(future()).events).toBe(0)
  config(store, { retentionDays: 7 })
  expect(store.retention.sweep().turns).toBe(0)
  const current = store.routing.getSettings()
  const { retentionDays: _, ...oldClient } = current.settings
  store.routing.saveSettings({ ...oldClient, presence: 'away' }, current.revision)
  expect(store.routing.getSettings().settings.retentionDays).toBe(7)
  expect(store.retention.sweep(future())).toEqual({ events: 1, turns: 2, more: false })
  expect(store.listInbox().map((i) => i.id)).toEqual([unprocessed])
  expect(store.listWorkspaceEvents().some((e) => e.id === old)).toBe(false)
  expect(store.getInboxItem(old)).toBeNull()
  expect(store.routing.get(old)).toBeNull()
  expect(store.routing.listWeb()).toEqual([])
  expect(store.routing.latestWebDeliveryId()).toBe(webCursor)
  expect(store.routing.enqueue(old)).toBe(false)
  expect(store.conversations.list(old)).toEqual([])
  expect(store.conversations.begin(old, 'new-request', '正文已清除').kind).toBe('conflict')
  expect(
    store.conversations.applyActionOnce(old, 'late-action', 'late', () => {
      throw new Error('must not run')
    }),
  ).toBe('conflict')
  expect(store.conversations.list('general')).toEqual([])
  expect(store.conversations.begin('general', 'general-chat', 'private question').kind).toBe(
    'conflict',
  )
  expect(sql.query('SELECT title,summary,url FROM trigger_inbox WHERE id=?').get(old)).toEqual({
    title: '',
    summary: '',
    url: null,
  })
  expect(
    sql.query('SELECT question,answer FROM trigger_conversation_turns WHERE thread=?').get(old),
  ).toEqual({ question: '', answer: null })
  receive('terminal')
  expect(store.listInbox().length).toBe(1)
  expect(receive('new')).toBeGreaterThan(old)
})

test('failed or unknown delivery, new discussions, live and paused task generations keep their history', () => {
  const { store, sql, receive, done, turn } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const unresolved = receive('uncertain')
  sql.run("UPDATE trigger_routes SET status='uncertain' WHERE inbox_id=?", [unresolved])
  const pending = receive('pending')
  store.conversations.begin(pending, 'busy', 'open question')
  const recent = receive('new-discussion')
  done(recent)
  turn(recent, 'recent-chat')
  sql.run('UPDATE trigger_conversation_turns SET updated_at=? WHERE thread=?', [
    future().toISOString(),
    recent,
  ])
  const m: TriggerMandate = {
    id: 'm',
    name: 'm',
    enabled: true,
    purpose: 'monitor',
    source: 'wxarc',
    scope: 'r',
    keyword: '',
    projectId: null,
    targets: [],
    archive: null,
    policy: {},
    urgent: false,
    deadline: null,
  }
  store.mandates.saveSettings({ projects: [], mandates: [m] }, 0)
  const active = receive('active')
  const failed = receive('failed')
  const paused = receive('paused')
  sql.run(
    "UPDATE mandate_effects SET status='failed' WHERE match_id IN (SELECT id FROM mandate_matches WHERE inbox_id=?)",
    [failed],
  )
  sql.run('UPDATE mandate_tasks SET paused=1 WHERE latest_inbox_id=?', [paused])
  expect(store.retention.sweep(future()).events).toBe(0)
  expect(store.listInbox().map((e) => e.id)).toEqual([
    paused,
    failed,
    active,
    recent,
    pending,
    unresolved,
  ])
  const settings = store.mandates.getSettings()
  sql.run(
    "UPDATE mandate_effects SET status='unknown' WHERE match_id IN (SELECT id FROM mandate_matches WHERE inbox_id=?)",
    [active],
  )
  store.mandates.saveSettings({ projects: [], mandates: [] }, settings.revision)
  expect(store.retention.sweep(future()).events).toBe(2)
  expect(store.getInboxItem(active)?.summary).toBe('private body')
})

test('suspending retention cancels the old deadline, confirmation proposals survive, and expired IM drafts become dedup tombstones', () => {
  const { store, sql } = fixture()
  config(store, { retentionDays: 7 })
  const initial = '2000-01-01T00:00:00.000Z'
  sql.run('UPDATE trigger_retention_state SET enabled_at=?', [initial])
  config(store, { retentionDays: null })
  config(store, { retentionDays: 7 })
  expect(
    sql.query<{ enabled_at: string }, []>('SELECT enabled_at FROM trigger_retention_state').get()
      ?.enabled_at,
  ).not.toBe(initial)
  const ts = Date.now()
  const preview = { code: 'oldcode', title: '测试', details: [], expiresAt: ts }
  const pending = store.conversations.begin('general', 'proposal', '待确认的偏好')
  if (pending.kind !== 'started') throw new Error('expected open turn')
  store.conversations.finish('general', 'proposal', pending.attempt, {
    text: '请确认',
    proposal: { key: 'offDay', value: 'defer' },
  })
  const expired = store.conversations.begin('general', 'draft', '已过期的委托提议')
  if (expired.kind !== 'started') throw new Error('expected open turn')
  store.conversations.finish('general', 'draft', expired.attempt, {
    text: '请确认',
    commission: preview,
  })
  sql.run(
    'INSERT INTO trigger_commission_drafts(code,principal,request_id,draft,expires_at) VALUES(?,?,?,?,?)',
    [preview.code, 'web', 'draft', JSON.stringify({ question: '私密草稿', preview }), ts],
  )
  expect(store.retention.sweep(future()).turns).toBe(1)
  expect(store.conversations.list('general').map((row) => row.requestId)).toEqual(['proposal'])
  expect(
    sql
      .query('SELECT request_id AS id,draft FROM trigger_commission_drafts WHERE code=?')
      .get(preview.code),
  ).toEqual({ id: 'draft', draft: '' })
})

test('retention expires stale reminder drafts without replaying them and protects in-flight sends', () => {
  const { store } = fixture()
  config(store, { retentionDays: 7 })
  for (const id of ['draft', 'sending']) {
    const claim = store.conversations.begin('general', id, '发通知')
    if (claim.kind !== 'started') throw Error('Expected to start a reminder turn')
    store.conversations.finish('general', id, claim.attempt, {
      text: '准备发送',
      reminder: {
        platform: 'weixin',
        channelId: 'bot',
        botLabel: '测试',
        audienceKey: 'user-hash',
        text: '待办事项',
        status: 'draft',
      },
    })
  }
  expect(store.conversations.claimReminder('general', 'sending')).toBe(true)
  expect(store.retention.sweep(future()).turns).toBe(1)
  expect(store.conversations.claimReminder('general', 'draft')).toBe(false)
  expect(store.conversations.begin('general', 'draft', '发通知', true).kind).toBe('conflict')
  expect(store.conversations.get('general', 'sending')?.answer?.reminder?.status).toBe('sending')
  expect(store.conversations.finishReminder('general', 'sending', { status: 'accepted' })).toBe(
    true,
  )
  expect(store.retention.sweep(future()).turns).toBe(1)
  expect(store.conversations.claimReminder('general', 'sending')).toBe(false)
})

test('a retired task expires independently of its active sibling and their shared event', () => {
  const { store, sql, receive } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const mandate: TriggerMandate = {
    id: 'one',
    name: 'One',
    enabled: true,
    purpose: 'Watch',
    source: 'wxarc',
    scope: 'r',
    keyword: '',
    projectId: null,
    targets: [],
    archive: null,
    policy: {},
    urgent: false,
    deadline: null,
  }
  const sibling = { ...mandate, id: 'two' }
  store.mandates.saveSettings({ projects: [], mandates: [mandate, sibling] }, 0)
  const inbox = receive('shared')
  const tasks = store.mandates.listTasks()
  const old = tasks.find((task) => task.mandateId === 'one')
  const live = tasks.find((task) => task.mandateId === 'two')
  if (!old || !live) throw new Error('missing tasks')
  const oldScope = `task-${old.id}` as const
  const liveScope = `task-${live.id}` as const
  for (const scope of [inbox, oldScope, liveScope]) {
    const turn = store.conversations.begin(scope, 'same', 'isolated')
    if (turn.kind !== 'started') throw new Error('missing turn')
    expect(store.conversations.finish(scope, 'same', turn.attempt, { text: 'private reply' })).toBe(
      true,
    )
  }
  store.mandates.saveSettings({ projects: [], mandates: [sibling] }, 1)
  expect(store.retention.sweep(future())).toEqual({ events: 0, turns: 1, more: false })
  expect(store.conversations.get(oldScope, 'same')).toBeNull()
  expect(store.conversations.get(liveScope, 'same')?.answer?.text).toBe('private reply')
  expect(store.conversations.get(inbox, 'same')?.answer?.text).toBe('private reply')
  expect(store.getInboxItem(inbox)?.summary).toBe('private body')
  expect(store.conversations.begin(oldScope, 'late', 'late request').kind).toBe('conflict')
  expect(
    sql
      .query('SELECT question,answer FROM trigger_conversation_turns WHERE thread=?')
      .get(oldScope),
  ).toEqual({ question: '', answer: null })
})
