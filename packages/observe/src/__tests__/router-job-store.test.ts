import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterJobConflictError } from '../router-job-store'
import { TriggerStore } from '../trigger-store'

const stores: TriggerStore[] = []
const dirs: string[] = []

function open(path = ':memory:') {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const owner = `im-${'a'.repeat(64)}` as const
const other = `im-${'b'.repeat(64)}` as const
const input = {
  executor: 'codex',
  instruction: 'read repo',
  repository: 'user/project',
  audience: 'verified',
} as const

test('submits and continuations have scoped durable replay barriers and only workers can claim once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-job-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const first = open(path).jobs
  const second = open(path).jobs
  const original = first.submit(owner, 'id', input)
  expect(original).toMatchObject({ status: 'queued', attempt: 1 })
  expect(second.submit(owner, 'id', input)).toEqual(original)
  expect(() => second.submit(owner, 'id', { ...input, instruction: 'other' })).toThrow(
    RouterJobConflictError,
  )
  expect(second.get(other, original.id)).toBeNull()
  expect(second.history(other, original.id)).toEqual([])
  expect(() => second.continue(other, original.id, 'fork', 'read other')).toThrow(
    RouterJobConflictError,
  )
  const claimed = first.claimNext()
  expect(claimed).toMatchObject({ id: original.id, status: 'running' })
  expect(second.claimNext()).toBeNull()
  expect(() => second.continue(owner, original.id, 'cont', 'next')).toThrow(RouterJobConflictError)
  expect(
    first.finish(original.id, 1, {
      status: 'completed',
      result: 'source evidence',
      threadId: 'worker-id',
    }),
  ).toBe(true)
  const continued = second.continue(owner, original.id, 'cont', 'next')
  expect(continued).toMatchObject({
    attempt: 2,
    threadId: 'worker-id',
    instruction: 'next',
    repository: input.repository,
  })
  expect(first.continue(owner, original.id, 'cont', 'next')).toEqual(continued)
  expect(() => first.continue(owner, original.id, 'cont', 'changed')).toThrow(
    RouterJobConflictError,
  )
  expect(() => first.continue(owner, original.id, 'id', input.instruction)).toThrow(
    RouterJobConflictError,
  )
  expect(() => first.submit(owner, 'cont', input)).toThrow(RouterJobConflictError)
  expect(first.claimReturn()).toBeNull() // superseded before the return began
  expect(first.claimNext()?.attempt).toBe(2)
  expect(first.finish(original.id, 1, { status: 'failed', result: 'late' })).toBe(false)
  expect(first.finish(original.id, 2, { status: 'completed', result: 'continued' })).toBe(true)
  expect(second.history(owner, original.id).map((s) => s.result)).toEqual([
    'source evidence',
    'continued',
  ])
  expect(first.submit(other, 'id', input).id).not.toBe(original.id)
  expect(first.get('general', original.id)).toBeNull()
})

test('recovery keeps queued work, marks interrupted work unknown and never retries ambiguous delivery', () => {
  const jobs = open().jobs
  const first = jobs.submit(owner, 'a', input)
  const queued = jobs.submit(owner, 'b', input)
  expect(jobs.claimNext()?.id).toBe(first.id)
  expect(jobs.recoverInterrupted()).toBe(1)
  expect(jobs.recoverInterrupted()).toBe(0)
  expect(jobs.claimNext()?.id).toBe(queued.id)
  expect(jobs.claimReturn()).toMatchObject({ id: first.id, status: 'unknown' })
  expect(jobs.finish(first.id, 1, { status: 'completed', result: 'stale worker' })).toBe(false)
  expect(jobs.finish(queued.id, 1, { status: 'failed', result: 'read failed' })).toBe(true)
  expect(jobs.recoverInterrupted()).toBe(0)
  expect(jobs.settleReturn(first.id, 1, 'delivered')).toBe(false)
  expect(jobs.claimReturn()).toMatchObject({ id: queued.id, status: 'failed' })
  expect(jobs.settleReturn(queued.id, 1, 'delivered')).toBe(true)
  expect(jobs.claimReturn()).toBeNull()
})

test('returns respect delay across claims and resumed steps cannot release a superseded notice', () => {
  const jobs = open().jobs
  const job = jobs.submit(owner, 'a', input)
  jobs.claimNext()
  jobs.finish(job.id, 1, { status: 'completed', result: 'done' })
  jobs.claimReturn()
  const future = new Date(Date.now() + 86_400_000).toISOString()
  expect(jobs.deferReturn(job.id, 1, future)).toBe(true)
  expect(jobs.nextReturnAt()).toBe(future)
  expect(jobs.claimReturn()).toBeNull()
  jobs.wakeDeferredReturns()
  expect(jobs.claimReturn()?.id).toBe(job.id)
  jobs.continue(owner, job.id, 'b', 'continue')
  expect(jobs.deferReturn(job.id, 1, future)).toBe(true)
  expect(jobs.nextReturnAt()).toBeNull()
  expect(jobs.claimReturn()).toBeNull()
})

test('retention scrubs a settled body, preserving replay protection and queued work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-job-retention-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const store = open(path)
  const { jobs } = store
  const job = jobs.submit(owner, 'secret-request', { ...input, brief: 'private brief' })
  jobs.claimNext()
  jobs.finish(job.id, 1, {
    status: 'completed',
    result: 'private result',
    threadId: 'internal',
    report: true,
  })
  expect(jobs.saveReport(job.id, 1, '{"verdict":"private verdict","done":[]}')).toBe(true)
  const untouched = jobs.submit(other, 'queued', input)
  const settings = store.routing.getSettings()
  store.routing.saveSettings({ ...settings.settings, retentionDays: 7 }, settings.revision)
  const future = new Date(Date.now() + 9 * 86_400_000)
  store.retention.sweep(future)
  expect(jobs.get(owner, job.id)).not.toBeNull() // return still pending
  jobs.claimReturn()
  jobs.settleReturn(job.id, 1, 'unavailable')
  store.retention.sweep(future)
  expect(jobs.get(owner, job.id)).toBeNull()
  expect(jobs.history(owner, job.id)).toEqual([])
  expect(jobs.get(other, untouched.id)?.instruction).toBe(input.instruction)
  expect(() => jobs.submit(owner, 'secret-request', input)).toThrow(RouterJobConflictError)
  const db = new Database(path, { readonly: true })
  try {
    expect(
      db
        .query(
          'SELECT instruction,brief,repository,audience,result,report,thread_id FROM router_job_steps WHERE job_id=?',
        )
        .get(job.id),
    ).toEqual({
      instruction: '',
      brief: null,
      repository: null,
      audience: null,
      result: null,
      report: null,
      thread_id: null,
    })
  } finally {
    db.close()
  }
})

test('a brief is bounded and stored per step; a report holds back the return until it is saved', () => {
  const jobs = open().jobs
  expect(() => jobs.submit(owner, 'long', { ...input, brief: 'x'.repeat(4001) })).toThrow(
    RouterJobConflictError,
  )
  expect(() => jobs.submit(owner, 'blank', { ...input, brief: ' ' })).toThrow(
    RouterJobConflictError,
  )
  const job = jobs.submit(owner, 'a', { ...input, brief: 'background' })
  // A retried turn may write another brief; the request still replays to the stored step.
  expect(jobs.submit(owner, 'a', { ...input, brief: 'reworded' })).toEqual(job)
  expect(job).toMatchObject({ instruction: input.instruction, brief: 'background', report: null })
  jobs.claimNext()
  jobs.finish(job.id, 1, { status: 'completed', result: 'done', report: true })
  expect(jobs.get(owner, job.id)?.reportState).toBe('pending')
  expect(jobs.claimReturn()).toBeNull()
  expect(jobs.nextReturnAt()).toBeNull()
  expect(jobs.saveReport(job.id, 1, '{"verdict":"ok","done":[]}')).toBe(true)
  expect(jobs.saveReport(job.id, 1, null)).toBe(false)
  expect(jobs.get(owner, job.id)).toMatchObject({ reportState: 'ready', result: 'done' })
  expect(jobs.claimReturn()?.id).toBe(job.id)
  jobs.settleReturn(job.id, 1, 'delivered')
  // An answer applies only to the step it was given for.
  expect(() => jobs.continue(owner, job.id, 'stale', 'option', { expectedAttempt: 2 })).toThrow(
    RouterJobConflictError,
  )
  const next = jobs.continue(owner, job.id, 'b', 'option', { brief: 'next', expectedAttempt: 1 })
  expect(next).toMatchObject({ attempt: 2, brief: 'next', report: null, reportState: null })
  expect(jobs.get(owner, job.id, 1)?.brief).toBe('background')
})

test('an existing table gains the brief and report columns in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-job-migrate-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const db = new Database(path)
  db.exec(`CREATE TABLE router_job_steps (
    job_id INTEGER NOT NULL, attempt INTEGER NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL,
    executor TEXT NOT NULL CHECK(executor IN ('zero','codex')), instruction TEXT NOT NULL,
    repository TEXT, audience TEXT, thread_id TEXT, result TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','unknown')),
    return_state TEXT CHECK(return_state IN ('pending','sending','delivered','unavailable','unknown')),
    return_due_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(job_id,attempt), UNIQUE(scope,request_id));
    INSERT INTO router_job_steps VALUES(1,1,'general','old','zero','legacy',NULL,NULL,NULL,
      'legacy result','completed','pending',NULL,'2026-01-01','2026-01-01',0);`)
  db.close()
  const jobs = open(path).jobs
  expect(jobs.get('general', 1)).toMatchObject({
    instruction: 'legacy',
    result: 'legacy result',
    brief: null,
    report: null,
    reportState: null,
  })
  expect(jobs.claimReturn()?.id).toBe(1)
  open(path)
})
