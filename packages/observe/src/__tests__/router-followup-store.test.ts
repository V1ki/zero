import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterJobStore } from '../router-job-store'

const opens = new Set<Database>()
const dirs: string[] = []
function open(path = ':memory:') {
  const db = new Database(path)
  opens.add(db)
  return { db, jobs: new RouterJobStore(db) }
}
function close(db: Database) {
  db.close()
  opens.delete(db)
}
afterEach(() => {
  for (const db of opens) close(db)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const signal = {
  scope: 'general' as const,
  audience: 'owner',
  authority: 'verified-project-34',
  subject: 'incident:22',
  eventKey: 'github:1',
  instruction: 'Evaluate the incident',
}
test('two sources deliver to one Worker in arrival order across restart, with independent delivery receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-router-followup-'))
  dirs.push(dir)
  const path = join(dir, 'jobs.sqlite')
  const first = open(path)
  const receipt = first.jobs.followups.receive(signal)
  expect(first.jobs.claimNext()).toMatchObject({ id: receipt.jobId, attempt: 1 })
  const second = { ...signal, eventKey: 'wxarc:44', instruction: 'The reporter added evidence' }
  const third = { ...signal, eventKey: 'github:3' }
  expect(first.jobs.followups.receive(second)).toEqual({ ...receipt, attempt: null })
  expect(first.jobs.followups.receive(third)).toEqual({ ...receipt, attempt: null })
  expect(first.jobs.followups.receive(second)).toEqual({ ...receipt, attempt: null })
  expect(first.jobs.claimNext()).toBeNull()
  close(first.db)
  const { jobs } = open(path)
  expect(jobs.recoverInterrupted()).toBe(1)
  const next = jobs.claimNext()
  expect(next).toMatchObject({ id: receipt.jobId, attempt: 2, instruction: second.instruction })
  expect(jobs.followups.step(receipt.jobId, 2)).toEqual({
    eventKey: second.eventKey,
    followup: true,
  })
  expect(jobs.claimNext()).toBeNull()
  expect(jobs.claimReturn()).toMatchObject({ id: receipt.jobId, attempt: 1, status: 'unknown' })
  expect(
    jobs.finish(receipt.jobId, 2, {
      status: 'completed',
      result: 'fixed',
      threadId: 'continued-worker',
    }),
  ).toBe(true)
  expect(jobs.claimNext()).toMatchObject({
    id: receipt.jobId,
    attempt: 3,
    threadId: 'continued-worker',
  })
  expect(jobs.followups.receive(second)).toEqual({ ...receipt, attempt: 2 })
  expect(jobs.followups.receive(third)).toEqual({ ...receipt, attempt: 3 })
  expect(jobs.claimReturn()).toMatchObject({ attempt: 2, result: 'fixed' })
  expect(jobs.claimNext()).toBeNull()
})
test('another authority, audience, subject or workspace cannot acquire the original Worker', () => {
  const { jobs } = open()
  const initial = jobs.followups.receive(signal)
  for (const variant of [
    { authority: 'rotated-project' },
    { audience: 'different-reader' },
    { subject: 'incident:23', eventKey: 'github:2' },
    { repository: 'other/repo' },
    { scope: `im-${'a'.repeat(64)}` as const },
  ]) {
    expect(jobs.followups.receive({ ...signal, ...variant }).jobId).not.toBe(initial.jobId)
  }
  expect(() => jobs.followups.receive({ ...signal, subject: 'forged-subject' })).toThrow()
  expect(jobs.followups.matchesAuthority(initial.jobId, signal)).toBe(true)
  expect(jobs.followups.matchesAuthority(initial.jobId, { ...signal, authority: 'other' })).toBe(
    false,
  )
})
