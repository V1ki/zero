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
  expect(store.retention.expiredTraceSources(old)).toEqual(['event'])
  expect(store.retention.expiredTraceSources(unprocessed)).toEqual([])
  expect(store.retention.expiredTraceSources(99999)).toEqual([])
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

test('retention expires IM history per audience and preserves the inbound replay barrier', () => {
  const { store } = fixture()
  config(store, { retentionDays: 7 })
  const busy = `im-${'a'.repeat(64)}` as const
  const idle = `im-${'b'.repeat(64)}` as const
  const c = store.conversations
  for (const scope of [busy, idle]) {
    const turn = c.begin(scope, 'upstream-id', 'question')
    if (turn.kind !== 'started') throw Error('Expected a turn')
    expect(c.finish(scope, 'upstream-id', turn.attempt, { text: 'private reply' })).toBe(true)
  }
  expect(c.begin(busy, 'followup', 'next question').kind).toBe('started')
  expect(store.retention.sweep(future()).turns).toBe(1)
  expect(c.list(idle)).toEqual([])
  expect(c.begin(idle, 'upstream-id', 'question').kind).toBe('conflict')
  expect(c.get(busy, 'upstream-id')?.answer?.text).toBe('private reply')
  expect(c.begin(busy, 'upstream-id', 'question').kind).toBe('existing')
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

test('WXARC inbox bodies survive while general follow-up work or its delivery is in flight', () => {
  const { store, receive, done } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const id = receive('wxarc:text:17')
  done(id)
  expect(store.retention.sweep(future()).events).toBe(0)
  const job = store.jobs.claimNext()
  expect(job?.kind).toBe('event-followup')
  if (!job) throw new Error('Missing archive follow-up')
  expect(store.retention.sweep(future()).events).toBe(0)
  store.jobs.finish(job.id, job.attempt, { status: 'completed', result: '核对完成' })
  expect(store.retention.sweep(future()).events).toBe(0)
  expect(store.jobs.claimReturn()?.id).toBe(job.id)
  expect(store.retention.sweep(future()).events).toBe(0)
  store.jobs.settleReturn(job.id, job.attempt, 'delivered')
  expect(store.retention.sweep(future()).events).toBe(1)
  expect(store.getInboxItem(id)).toBeNull()
})

test('unfinished matters retain source bodies, relevant cross-platform turns and their Worker until completion', () => {
  const { store, receive, done } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const id = receive('wxarc:text:18')
  done(id)
  const job = store.jobs.claimNext()
  if (!job) throw Error('missing Worker')
  store.jobs.finish(job.id, job.attempt, { status: 'completed', result: '仍需复测，不能确认解决' })
  store.jobs.claimReturn()
  store.jobs.settleReturn(job.id, job.attempt, 'delivered')
  let matter = store.ledger.createMatter('owner', '完成复测', '核实是否解决', ['取得复测证据'])
  store.ledger.bindWorker({
    jobId: job.id,
    principal: 'owner',
    matterId: matter.id,
    scope: 'general',
    audience: 'owner',
    eventIds: [id],
    authority: 'user',
  })
  const scope = `im-${'c'.repeat(64)}` as const
  const turn = store.conversations.begin(scope, 'prior-context', '下次收到复测结果再继续')
  if (turn.kind !== 'started') throw Error('missing turn')
  store.conversations.finish(scope, 'prior-context', turn.attempt, {
    text: '已保留当前证据，等待复测。',
    matterIds: [matter.id],
  })
  for (const state of ['open', 'working', 'waiting', 'paused'] as const) {
    matter = store.ledger.updateMatter('owner', matter.id, matter.version, { state, context: {} })
    expect(store.retention.sweep(future())).toEqual({ events: 0, turns: 0, more: false })
    expect(store.getInboxItem(id)?.summary).toBe('private body')
    expect(store.conversations.get(scope, 'prior-context')?.answer?.matterIds).toEqual([matter.id])
    expect(store.jobs.get(job.scope, job.id)?.result).toBe('仍需复测，不能确认解决')
  }
  store.ledger.updateMatter('owner', matter.id, matter.version, { state: 'completed', context: {} })
  expect(store.retention.sweep(future()).events).toBe(1)
  expect(store.conversations.get(scope, 'prior-context')).toBeNull()
  expect(store.getInboxItem(id)).toBeNull()
})

test('protected turns cannot fill the expiry batch and starve unrelated eligible records', () => {
  const { store, turn } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const matter = store.ledger.createMatter('owner', '等待新证据', '取得原单', ['核对'])
  for (let i = 0; i < 100; i++) {
    const result = store.conversations.begin('general', 'protected-' + i, '核对这份原单')
    if (result.kind !== 'started') throw Error('Expected synthetic turn')
    store.conversations.finish('general', result.turn.requestId, result.attempt, {
      text: '正在核对',
      matterIds: [matter.id],
    })
  }
  turn('general', 'unrelated-old')
  expect(store.retention.sweep(future()).turns).toBe(1)
  expect(store.conversations.get('general', 'unrelated-old')).toBeNull()
  expect(store.conversations.get('general', 'protected-99')?.answer?.text).toBe('正在核对')
})

test('moving an event preserves evidence inherited by an unfinished matter across later edits and expiry', () => {
  const { store, receive, done } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const event = receive('moved-note')
  done(event)
  const first = store.ledger.createMatter('owner', '归档复核', '复核单据', ['取得签收'])
  const second = store.ledger.createMatter('owner', '单据归档', '归档单据', ['已归档'])
  store.ledger.linkSource('owner', first.id, event, '初次登记')
  const move = store.ledger.changeSourceAssociation(
    'owner',
    event,
    first.id,
    second.id,
    '归档与复核各自跟进',
  )
  store.ledger.updateMatter('owner', second.id, move.versions[second.id], {
    state: 'completed',
    context: {},
  })
  const updated = store.ledger.updateMatter('owner', first.id, move.versions[first.id], {
    state: 'paused',
    context: first.context,
  })
  expect(store.ledger.matterSources(first.id)).toEqual([])
  expect(store.ledger.matterEvidenceSources(first.id)).toEqual([event])
  expect(store.ledger.matterHistory('owner', first.id)[0].snapshot.inheritedSourceIds).toEqual([
    event,
  ])
  expect(store.retention.sweep(future()).events).toBe(0)
  expect(store.getInboxItem(event)?.summary).toBe('private body')
  store.ledger.updateMatter('owner', first.id, updated.version, { state: 'completed', context: {} })
  expect(store.retention.sweep(future()).events).toBe(1)
})

test('an event conversation linked to open work can still be opened after retention runs', () => {
  const { store, receive, done } = fixture()
  config(store, { enabled: true, retentionDays: 7 })
  const id = receive('case-note')
  done(id)
  const m = store.ledger.createMatter('owner', '原件', '等待签字', ['核对签字'])
  const claim = store.conversations.begin(id, 'context', '有了签字再核对')
  if (claim.kind !== 'started') throw Error('Missing event turn')
  store.conversations.finish(id, 'context', claim.attempt, { text: '等待签字', matterIds: [m.id] })
  store.retention.sweep(future())
  expect(store.getInboxItem(id)?.summary).toBe('private body')
  expect(store.conversations.get(id, 'context')?.answer?.text).toBe('等待签字')
  store.ledger.updateMatter('owner', m.id, 1, { state: 'cancelled', context: {} })
  store.retention.sweep(future())
  expect(store.getInboxItem(id)).toBeNull()
})
