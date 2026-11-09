import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterJobConflictError, RouterJobStore } from '../router-job-store'
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
  const job = jobs.submit(owner, 'secret-request', input)
  jobs.claimNext()
  jobs.finish(job.id, 1, {
    status: 'completed',
    result: 'private result',
    threadId: 'internal',
    attentionQuestion: 'sensitive question',
  })
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
          'SELECT instruction,repository,audience,result,thread_id,attention_question FROM router_job_steps WHERE job_id=?',
        )
        .get(job.id),
    ).toEqual({
      instruction: '',
      repository: null,
      audience: null,
      result: null,
      thread_id: null,
      attention_question: null,
    })
  } finally {
    db.close()
  }
})

test('upgrades pre-tracking job storage without turning ordinary jobs into event Workers', () => {
  const db = new Database(':memory:')
  try {
    const original = new RouterJobStore(db).submit(owner, 'old', input)
    db.exec(
      'ALTER TABLE router_job_steps DROP COLUMN kind; ALTER TABLE router_job_steps DROP COLUMN attention_question; ALTER TABLE router_job_steps DROP COLUMN work_origin; ALTER TABLE router_job_steps DROP COLUMN work_json',
    )
    const upgraded = new RouterJobStore(db)
    expect(upgraded.get(owner, original.id)).toMatchObject({
      kind: null,
      workOrigin: null,
      attentionQuestion: null,
      executor: 'codex',
      instruction: input.instruction,
    })
    const event = upgraded.submit(owner, 'new', {
      executor: 'zero',
      kind: 'github-watch',
      instruction: '已核实的仓库变化',
    })
    expect(event.kind).toBe('github-watch')
    expect(() =>
      upgraded.submit(owner, 'new', { executor: 'zero', instruction: event.instruction }),
    ).toThrow(RouterJobConflictError)
  } finally {
    db.close()
  }
})

test('event work attempts persist source evidence and cannot inherit or replay manual authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-event-attempt-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const { jobs } = open(path)
  const watch = jobs.submit('general', 'watch', {
    ...input,
    executor: 'zero',
    kind: 'github-watch',
  })
  jobs.claimNext()
  jobs.finish(watch.id, 1, { status: 'completed', result: 'legacy event summary' })
  const acted = jobs.continue('general', watch.id, 'explicit', '查找相关旧 Issue', 'manual')
  expect(jobs.claimNext()).toMatchObject({ attempt: 2, workOrigin: 'manual' })
  expect(jobs.continue('general', watch.id, 'explicit', '查找相关旧 Issue', 'manual').id).toBe(
    acted.id,
  )
  expect(() => jobs.continue('general', watch.id, 'explicit', '查找相关旧 Issue')).toThrow(
    RouterJobConflictError,
  )
  const work = {
    outcome: 'resolved',
    steps: [{ tool: 'find_related_issues', ok: true }],
    sources: [
      {
        label: '旧 Issue 的原评论',
        url: 'https://github.com/user/project/issues/12#issuecomment-34',
      },
    ],
  } satisfies import('@zero-os/shared').RouterEventWork
  jobs.finish(watch.id, 2, { status: 'completed', result: '找到旧讨论', work })
  const restart = open(path)
  const history = restart.jobs.history('general', watch.id)
  expect(history.map((j) => [j.attempt, j.workOrigin, j.work])).toEqual([
    [1, null, undefined],
    [2, 'manual', work],
  ])
  expect(history[1]).not.toHaveProperty('workJson')
  const generic = jobs.continue('general', watch.id, 'generic', '再看一下')
  expect(generic.workOrigin).toBeNull()
  expect(generic.work).toBeUndefined()
  jobs.claimNext()
  jobs.finish(watch.id, 3, { status: 'completed', result: 'latest' })
  jobs.claimReturn()
  jobs.settleReturn(watch.id, 3, 'delivered')
  const settings = restart.routing.getSettings()
  restart.routing.saveSettings({ ...settings.settings, retentionDays: 7 }, settings.revision)
  restart.retention.sweep(new Date(Date.now() + 9 * 86_400_000))
  const db = new Database(path, { readonly: true })
  try {
    expect(
      db.query('SELECT work_json FROM router_job_steps WHERE job_id=? AND attempt=2').get(watch.id),
    ).toEqual({ work_json: null })
  } finally {
    db.close()
  }
})

test('full Worker results survive persistence and continuation without truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-job-full-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const first = open(path).jobs
  const submitted = first.submit(owner, 'long', input)
  const job = first.claimNext()
  if (!job) throw new Error('Expected queued job')
  const result = `${'事实与来源\n'.repeat(6000)}最终结论及剩余问题`
  const attentionQuestion = '待确认条件'.repeat(200)
  expect(
    first.finish(job.id, job.attempt, { status: 'completed', result, attentionQuestion }),
  ).toBe(true)
  const reopened = open(path).jobs
  expect(reopened.get(owner, submitted.id)?.result).toBe(result)
  expect(reopened.get(owner, submitted.id)?.attentionQuestion).toBe(attentionQuestion)
  reopened.continue(owner, job.id, 'follow-long', '接着核验最后的剩余问题')
  expect(reopened.history(owner, job.id).find((step) => step.attempt === 1)?.result).toBe(result)
})

test('thread persisted before execution survives interruption, restart and explicit continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-thread-recovery-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const first = new TriggerStore(path)
  const job = first.jobs.submit(owner, 'recoverable', input)
  first.jobs.claimNext()
  first.jobs.attachThread(job.id, 1, 'actual-thread-before-turn')
  first.close()
  const restored = open(path).jobs
  restored.recoverInterrupted()
  expect(restored.get(owner, job.id)).toMatchObject({
    status: 'unknown',
    threadId: 'actual-thread-before-turn',
  })
  const continued = restored.continue(owner, job.id, 'continue', '核对已完成步骤，再继续')
  expect(continued.threadId).toBe('actual-thread-before-turn')
  expect(() => restored.attachThread(job.id, 1, 'late-thread')).toThrow(RouterJobConflictError)
  expect(restored.get(owner, job.id)?.threadId).toBe('actual-thread-before-turn')
})

test('migrates historical executor constraints while preserving attempts, returns and indexes', () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterJobStore(db)
    const original = store.submit('general', 'old-codex', input)
    store.claimNext()
    store.finish(original.id, 1, { status: 'completed', result: '原结果', threadId: 'old-thread' })
    const definition = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='router_job_steps'")
      .get()
    expect(definition).toBeTruthy()
    db.exec(
      definition!.sql
        .replace('router_job_steps', 'old_steps')
        .replace(
          'executor TEXT NOT NULL',
          "executor TEXT NOT NULL CHECK(executor IN ('zero','codex'))",
        ),
    )
    db.exec(
      'INSERT INTO old_steps SELECT * FROM router_job_steps; DROP TABLE router_job_steps; ALTER TABLE old_steps RENAME TO router_job_steps',
    )
    const upgraded = new RouterJobStore(db)
    expect(upgraded.get('general', original.id)).toMatchObject({
      executor: 'codex',
      attempt: 1,
      result: '原结果',
      threadId: 'old-thread',
    })
    expect(
      upgraded.submit('general', 'new-reader', { executor: 'scale-reader', instruction: '读单' })
        .executor,
    ).toBe('scale-reader')
    expect(
      db.query("SELECT sql FROM sqlite_master WHERE name='router_jobs_return'").get(),
    ).toBeTruthy()
    expect(
      db.query('SELECT return_state FROM router_job_steps WHERE job_id=?').get(original.id),
    ).toEqual({ return_state: 'pending' })
  } finally {
    db.close()
  }
})
