import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterSummaryCounts } from '@zero-os/shared'
import { routerSummaryQueries } from '../router-summary-store'
import { TriggerStore } from '../trigger-store'

const notes = { unread: '（未能读取详情。）', unfinished: '（调查未完成。）' }
const current = { from: '2026-11-04T12:00:00.000Z', to: '2026-11-11T12:00:00.000Z' }
const previous = { from: '2026-10-28T12:00:00.000Z', to: current.from }
const inCurrent = '2026-11-08T08:00:00.000Z'
const inPrevious = '2026-11-01T08:00:00.000Z'

const stores: TriggerStore[] = []
const handles: Database[] = []
const folders: string[] = []
afterEach(() => {
  for (const db of handles.splice(0)) db.close()
  for (const store of stores.splice(0)) store.close()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-summary-'))
  folders.push(dir)
  return join(dir, 'events.sqlite')
}
function open(path: string) {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}
function raw(path: string) {
  const db = new Database(path)
  db.exec('PRAGMA busy_timeout=5000')
  handles.push(db)
  return db
}

/** Writes rows the way the stores leave them, with timestamps chosen by the test. */
function seeder(db: Database) {
  let next = 0
  const event = (receivedAt: string, source: 'github' | 'wxarc' = 'github') =>
    Number(
      db.run(
        `INSERT INTO trigger_inbox(source,stream,event_id,scope,title,summary,occurred_at,received_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        [
          source,
          `${source}:repo`,
          `e${++next}`,
          'repo',
          'private title',
          'private body',
          receivedAt,
          receivedAt,
        ],
      ).lastInsertRowid,
    )
  const route = (
    receivedAt: string,
    status: string,
    updatedAt = receivedAt,
    { restored = 0, agent = null as string | null } = {},
  ) => {
    const id = event(receivedAt)
    db.run(
      `INSERT INTO trigger_routes(inbox_id,origin,status,agent,updated_at,triage_restored)
      VALUES(?,?,?,?,?,?)`,
      [id, restored ? 'manual' : 'subscription', status, agent, updatedAt, restored],
    )
    return id
  }
  db.run(`INSERT INTO mandates(id,stream,definition) VALUES
    ('plain','github:repo','{"processing":"agent"}'),
    ('deep','github:repo','{"processing":"investigate"}')`)
  const task = Number(
    db.run(
      `INSERT INTO mandate_tasks(mandate_id,business_key,title,latest_inbox_id,updated_at)
      VALUES('plain','k','private task',0,?)`,
      [inCurrent],
    ).lastInsertRowid,
  )
  const match = (
    mandate: 'plain' | 'deep',
    receivedAt: string,
    status: string,
    {
      summary = 'private summary' as string | null,
      triage = 0,
      restored = 0,
      doneAt = null as string | null,
      destination = 'web',
      source = 'github' as 'github' | 'wxarc',
    } = {},
  ) => {
    const inboxId = event(receivedAt, source)
    const id = Number(
      db.run(
        `INSERT INTO mandate_matches(task_id,mandate_id,inbox_id,status,summary) VALUES(?,?,?,'ready',?)`,
        [task, mandate, inboxId, summary],
      ).lastInsertRowid,
    )
    db.run(
      `INSERT INTO mandate_effects(match_id,kind,status,destination,triage,triage_restored)
      VALUES(?,'notify',?,?,?,?),(?,'archive','done','archive',0,0)`,
      [id, status, destination, triage, restored, id],
    )
    // The audit trigger writes one row per status change; the archive's done row is not a notification.
    db.run('INSERT INTO mandate_audit(at,action,mandate_id,match_id,detail) VALUES(?,?,?,?,?)', [
      receivedAt,
      'archive',
      mandate,
      id,
      'done · archive',
    ])
    if (doneAt)
      db.run('INSERT INTO mandate_audit(at,action,mandate_id,match_id,detail) VALUES(?,?,?,?,?)', [
        doneAt,
        'notify',
        mandate,
        id,
        `done · ${destination}`,
      ])
    return id
  }
  const audit = (matchId: number, at: string, detail: string) =>
    db.run(
      `INSERT INTO mandate_audit(at,action,mandate_id,match_id,detail) VALUES(?, 'notify', 'plain', ?, ?)`,
      [at, matchId, detail],
    )
  const step = (
    job: number,
    attempt: number,
    updatedAt: string,
    {
      status = 'completed',
      state = 'ready' as string | null,
      report = null as unknown,
      answered = null as number | null,
      retired = 0,
    } = {},
  ) =>
    db.run(
      `INSERT INTO router_job_steps(job_id,attempt,scope,request_id,executor,instruction,status,
        report_state,report,answered_option,retired,result,created_at,updated_at)
      VALUES(?,?,'general',?,'zero','private instruction',?,?,?,?,?,'private result',?,?)`,
      [
        job,
        attempt,
        `r-${job}-${attempt}`,
        status,
        state,
        typeof report === 'string' ? report : report === null ? null : JSON.stringify(report),
        answered,
        retired,
        updatedAt,
        updatedAt,
      ],
    )
  return { event, route, match, audit, step }
}

const decision = (recommended: number) => ({
  verdict: 'private verdict',
  done: [],
  decision: { question: 'private question', options: ['a', 'b'], recommended },
})

function seedBoth(path: string) {
  const db = raw(path)
  const s = seeder(db)
  // Personal pipeline.
  s.route(inCurrent, 'web')
  s.route(inCurrent, 'sent')
  s.route(inCurrent, 'uncertain')
  s.route(inCurrent, 'failed')
  s.route(inCurrent, 'deferred')
  s.route(inCurrent, 'sending')
  s.route(inCurrent, 'filtered')
  s.route(inCurrent, 'sent', inCurrent, { restored: 1 })
  s.route(inPrevious, 'web')
  // Received in the previous window, delivered in the current one: triage counts it before.
  s.route(inPrevious, 'filtered')
  s.route(inPrevious, 'web', inCurrent, { restored: 1 })
  // Boundaries: from is inclusive, to is exclusive.
  s.route(current.from, 'web')
  s.route(current.to, 'web')

  // Mandate pipeline.
  s.match('plain', inCurrent, 'done', { doneAt: inCurrent })
  // A digest marks each member done in one claim.
  s.match('plain', inCurrent, 'done', { doneAt: inCurrent, destination: 'dingtalk' })
  s.match('plain', inCurrent, 'done', { doneAt: inCurrent, destination: 'dingtalk' })
  const deferred = s.match('plain', inCurrent, 'deferred', { destination: 'defer' })
  s.audit(deferred, inCurrent, 'deferred · defer')
  const unknown = s.match('plain', inCurrent, 'unknown', { destination: 'dingtalk' })
  s.audit(unknown, inCurrent, 'sending · dingtalk')
  s.audit(unknown, inCurrent, 'unknown · dingtalk')
  const failed = s.match('plain', inCurrent, 'failed', { destination: 'dingtalk' })
  s.audit(failed, inCurrent, 'failed · dingtalk')
  s.match('plain', inCurrent, 'skipped', { triage: 1, destination: 'none' })
  s.match('plain', inCurrent, 'skipped', { destination: 'none' })
  const restored = s.match('plain', inCurrent, 'done', { restored: 1, doneAt: inCurrent })
  s.audit(restored, inCurrent, 'skipped · none')
  s.audit(restored, inCurrent, 'pending')
  // Investigation mode.
  s.match('deep', inCurrent, 'done', { doneAt: inCurrent })
  s.match('deep', inCurrent, 'done', { doneAt: inCurrent, summary: `摘要${notes.unread}` })
  s.match('deep', inCurrent, 'done', { doneAt: inCurrent, summary: `摘要${notes.unfinished}` })
  s.match('deep', inCurrent, 'done', { doneAt: inCurrent, summary: null })
  s.match('deep', inCurrent, 'skipped', { triage: 1, destination: 'none' })
  // A WXARC event of the same mandate is never investigated.
  s.match('deep', inCurrent, 'done', { doneAt: inCurrent, source: 'wxarc' })
  // Previous window.
  s.match('deep', inPrevious, 'done', { doneAt: inPrevious, summary: `摘要${notes.unread}` })
  s.match('plain', inPrevious, 'skipped', { triage: 1, destination: 'none' })

  // Job steps.
  s.step(1, 1, inCurrent, { report: decision(0), answered: 0 })
  s.step(1, 2, inCurrent, { report: { verdict: 'v', done: [] } })
  s.step(2, 1, inCurrent, { report: decision(1), answered: 0 })
  s.step(3, 1, inCurrent, { report: decision(0) })
  s.step(4, 1, inCurrent, { state: 'none' })
  s.step(5, 1, inCurrent, { state: 'pending' })
  s.step(6, 1, inCurrent, { state: null })
  s.step(7, 1, inCurrent, { retired: 1, answered: 0 })
  s.step(8, 1, inCurrent, { status: 'failed', state: null })
  s.step(9, 1, inCurrent, { report: '{not json' })
  s.step(10, 1, inPrevious, { report: decision(0), answered: 0 })
  s.step(10, 2, inPrevious, { state: 'none' })
  return db
}

const empty: RouterSummaryCounts = {
  notifications: { personal: 0, mandate: 0 },
  triage: { filtered: 0, restored: 0 },
  investigation: { notified: 0, unread: 0, unfinished: 0, expired: 0 },
  reports: {
    completed: 0,
    ready: 0,
    raw: 0,
    pending: 0,
    unrequested: 0,
    expired: 0,
    decisions: 0,
    answered: 0,
    recommended: 0,
  },
}

test('counts deliveries, triage, investigations and reports per window across both pipelines', () => {
  const path = tempPath()
  const store = open(path)
  expect(store.summary.read([current, previous], notes)).toEqual([empty, empty])
  seedBoth(path)
  const [now, before] = store.summary.read([current, previous], notes)
  expect(now).toEqual({
    // web, sent, restored-then-sent, delivered-late restored, and the inclusive lower bound.
    notifications: { personal: 5, mandate: 9 },
    // Personal: one filtered, one restored. Mandate: two filtered (plain, deep), one restored.
    triage: { filtered: 3, restored: 2 },
    investigation: { notified: 4, unread: 1, unfinished: 1, expired: 1 },
    reports: {
      completed: 9,
      ready: 6,
      raw: 1,
      pending: 1,
      unrequested: 1,
      expired: 1,
      decisions: 3,
      answered: 2,
      recommended: 1,
    },
  })
  expect(before).toEqual({
    notifications: { personal: 1, mandate: 1 },
    triage: { filtered: 2, restored: 1 },
    investigation: { notified: 1, unread: 1, unfinished: 0, expired: 0 },
    reports: {
      ...empty.reports,
      completed: 2,
      ready: 1,
      raw: 1,
      decisions: 1,
      answered: 1,
      recommended: 1,
    },
  })
})

test('the definitions add up: restored events are not also filtered, and count when delivered', () => {
  const path = tempPath()
  const store = open(path)
  const s = seeder(raw(path))
  const filteredRoute = s.route(inCurrent, 'filtered')
  const restoredRoute = s.route(inCurrent, 'sent', inCurrent, { restored: 1 })
  s.match('plain', inCurrent, 'skipped', { triage: 1, destination: 'none' })
  s.match('plain', inCurrent, 'done', { restored: 1, doneAt: inCurrent })
  // Restored but then failed: brought back, not delivered.
  s.match('plain', inCurrent, 'failed', { restored: 1, destination: 'dingtalk' })
  const [counts] = store.summary.read([current], notes)
  if (!counts) throw new Error('missing counts')
  const { filtered, restored } = counts.triage
  // Every event triage ever filtered is either still filtered or restored, never both.
  expect(filtered + restored).toBe(5)
  expect({ filtered, restored }).toEqual({ filtered: 2, restored: 3 })
  // Delivered = 1 restored personal + 1 restored mandate; the failed restore is not delivered.
  expect(counts.notifications.personal + counts.notifications.mandate).toBe(2)
  expect(filteredRoute).toBeLessThan(restoredRoute)
})

test('the summary reads only counts, starts from window indexes, and tolerates swept rows', () => {
  const path = tempPath()
  const store = open(path)
  const db = seedBoth(path)
  const json = JSON.stringify(store.summary.read([current, previous], notes))
  for (const secret of ['private', '摘要', 'verdict', 'question'])
    expect(json).not.toContain(secret)

  const plan = (sql: string) =>
    db
      .query<{ detail: string }, Record<string, string>>(`EXPLAIN QUERY PLAN ${sql}`)
      .all({ $from: '', $to: '', $unread: '', $unfinished: '' })
      .map((row) => row.detail)
  const plans = Object.fromEntries(
    Object.entries(routerSummaryQueries).map(([name, sql]) => [name, plan(sql)]),
  )
  expect(plans.personal?.[0]).toMatch(/USING (COVERING )?INDEX trigger_routes_delivered/)
  expect(plans.mandate?.join(' | ')).toMatch(/USING (COVERING )?INDEX mandate_audit_time/)
  expect(plans.routeTriage?.[0]).toMatch(/USING (COVERING )?INDEX trigger_inbox_retention/)
  expect(plans.mandateTriage?.[0]).toMatch(/USING (COVERING )?INDEX trigger_inbox_retention/)
  expect(plans.jobs?.[0]).toMatch(/USING (COVERING )?INDEX router_jobs_completed/)
  // Every other step looks rows up by key; only the window-bounded audit subquery `a` is scanned.
  for (const steps of Object.values(plans))
    for (const step of steps ?? []) expect(step).not.toMatch(/^SCAN (?!a$)(?!.*USING)/)

  // Retention clears bodies but keeps statuses: the counts that rest on statuses are unchanged,
  // and decision figures move to "expired" rather than reading as "no decision".
  const before = store.summary.read([current], notes)[0]
  db.exec(`UPDATE trigger_routes SET agent=NULL;
    UPDATE mandate_matches SET summary=NULL;
    UPDATE trigger_inbox SET title='',summary='';
    UPDATE router_job_steps SET instruction='',report=NULL,result=NULL,retired=1;`)
  const after = store.summary.read([current], notes)[0]
  expect(after?.notifications).toEqual(before?.notifications)
  expect(after?.triage).toEqual(before?.triage)
  expect(after?.investigation).toEqual({ notified: 4, unread: 0, unfinished: 0, expired: 4 })
  expect(after?.reports).toMatchObject({
    completed: 9,
    ready: 6,
    raw: 1,
    expired: 6,
    decisions: 0,
    answered: 0,
  })
})

test('a real retention sweep leaves the summary readable', () => {
  const path = tempPath()
  const store = open(path)
  seedBoth(path)
  store.routing.saveSettings(
    { ...store.routing.getSettings().settings, retentionDays: 7 },
    store.routing.getSettings().revision,
  )
  const db = raw(path)
  db.run("UPDATE trigger_retention_state SET enabled_at='2000-01-01T00:00:00.000Z'")
  const before = store.summary.read([current, previous], notes)
  while (store.retention.sweep(new Date('2027-06-01T00:00:00.000Z')).more) {}
  expect(db.query('SELECT count(*) AS n FROM router_job_steps WHERE retired=1').get()).toEqual({
    n: 12,
  })
  const after = store.summary.read([current, previous], notes)
  expect(after.map((c) => c.notifications)).toEqual(before.map((c) => c.notifications))
  expect(after.map((c) => c.triage)).toEqual(before.map((c) => c.triage))
  expect(after[0]?.reports).toMatchObject({ completed: 9, expired: 6, decisions: 0 })
})

test('rows from before the new columns: personal restores are copied from the stored verdict, the rest start now', () => {
  const path = tempPath()
  open(path).close()
  stores.length = 0
  const db = raw(path)
  db.exec(`DROP INDEX trigger_routes_delivered;
    ALTER TABLE trigger_routes DROP COLUMN triage_restored;
    ALTER TABLE mandate_effects DROP COLUMN triage_restored;
    ALTER TABLE router_job_steps DROP COLUMN answered_option;
    DROP TABLE trigger_recorded_facts;`)
  const skip = JSON.stringify({ summary: 's', triage: { decision: 'skip', reason: 'r' } })
  const insert = (status: string, agent: string | null) => {
    const id = Number(
      db.run(
        `INSERT INTO trigger_inbox(source,stream,event_id,scope,title,summary,occurred_at,received_at)
        VALUES('github','github:repo',?, 'repo','t','s',?,?)`,
        [crypto.randomUUID(), inCurrent, inCurrent],
      ).lastInsertRowid,
    )
    db.run(
      'INSERT INTO trigger_routes(inbox_id,origin,status,agent,updated_at) VALUES(?,?,?,?,?)',
      [id, 'manual', status, agent, inCurrent],
    )
  }
  insert('sent', skip) // notify anyway, then delivered
  insert('filtered', skip) // still filtered
  insert('web', JSON.stringify({ summary: 's' })) // never filtered
  insert('sent', '{broken') // malformed bodies are ignored, not fatal
  db.close()
  handles.length = 0

  const startedAt = new Date().toISOString()
  const store = open(path)
  expect(store.summary.read([current], notes)[0]).toMatchObject({
    notifications: { personal: 3 },
    triage: { filtered: 1, restored: 1 },
  })
  const since = store.summary.recordedSince()
  expect(since !== null && since >= startedAt).toBe(true)
  // Reopening keeps the first date.
  store.close()
  stores.length = 0
  expect(open(path).summary.recordedSince()).toBe(since)
})
