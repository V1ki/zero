import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerEvent } from '@zero-os/shared'
import { RouterJobConflictError } from '../router-job-store'
import { TriggerStore } from '../trigger-store'

const allowed = () => true
const repository = 'Example/App'
const directories: string[] = []
const opened = new Set<TriggerStore>()
function open(path = ':memory:') {
  const store = new TriggerStore(path)
  opened.add(store)
  return store
}
function close(store: TriggerStore) {
  store.close()
  opened.delete(store)
}
afterEach(() => {
  for (const store of opened) close(store)
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function enable(store: TriggerStore, name = repository, allowOwnerIssueClose = false) {
  const { settings, revision } = store.getSettings()
  settings.github.credentialRef = 'github_listener'
  settings.github.routerTrackingEnabled = true
  settings.github.repositories.push({
    name,
    githubAppRef: 'github_app_demo',
    enabled: true,
    workflowFailures: false,
    workflow: '',
    branch: '',
    mention: '',
    issues: true,
    issueComments: true,
    allowOwnerIssueClose,
    pullRequests: true,
    pullRequestComments: true,
  })
  store.saveSettings(settings, revision)
  const grant = store.tracking.grant('web')
  if (!grant) throw new Error('Missing grant')
  store.tracking.start({
    actor: 'web',
    scope: 'general',
    audience: 'owner',
    ownerAudience: 'owner',
    repository: name,
    requestId: `watch:${name}`,
    expectedGrantGeneration: grant.generation,
    issues: true,
    pullRequests: true,
    issueComments: true,
    pullRequestComments: true,
  })
}

type EventOptions = {
  number?: number
  repoId?: number
  name?: string
  pr?: boolean
  observed?: boolean
  url?: string
}
function claimEvent(store: TriggerStore, comment: number, options: EventOptions = {}) {
  const { name = repository, number = 181, repoId = 42, pr = false } = options
  const event: TriggerEvent = {
    scope: name,
    eventId: `${repoId}:comment:${comment}`,
    githubCommentKind: pr ? 'pr-comment' : 'issue-comment',
    url:
      options.url ??
      `https://github.com/${name}/${pr ? 'pull' : 'issues'}/${number}#issuecomment-${comment}`,
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    title: 'Spoofed text about #159',
    summary: 'See https://github.com/Example/App/issues/159; old issue #159',
  }
  expect(
    store.commitPush({
      source: 'github',
      stream: `github:${name.toLowerCase()}`,
      revision: store.getSettings().revision,
      events: [event],
    }),
  ).toBe(true)
  const job = store.jobs.claimNext()
  if (!job) throw new Error('Job was not queued')
  const thread = store.tracking.eventForJob(job.id, job.attempt)
  if (!thread || !event.url) throw new Error('Missing job event')
  return { job, inbox: thread.event.id, url: event.url }
}

function ingest(store: TriggerStore, comment: number, options: EventOptions = {}) {
  const { job, inbox, url } = claimEvent(store, comment, options)
  expect(
    store.jobs.finish(job.id, job.attempt, {
      status: 'completed',
      result: options.observed ? 'observed' : 'found prior evidence',
      work: options.observed
        ? { outcome: 'observed', steps: [], sources: [] }
        : {
            outcome: 'resolved',
            steps: [{ tool: 'find_related_issues', ok: true }],
            sources: [
              { label: 'historic issue', url: 'https://github.com/Example/App/issues/159' },
            ],
          },
    }),
  ).toBe(true)
  return { job: job.id, inbox, url }
}

test('manual work on a bot reply uses the same issue worker and preserves each event receipt after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-issue-thread-'))
  directories.push(dir)
  const path = join(dir, 'inbox.sqlite')
  const store = open(path)
  enable(store)
  const original = ingest(store, 101)
  const moreRecent = ingest(store, 102)
  const other = ingest(store, 103, { number: 159 })
  const bot = ingest(store, 104, { observed: true })
  expect(store.githubReplies.claim(original.inbox, 'published', 'f'.repeat(64))).toEqual({
    state: 'new',
  })
  store.githubReplies.finish(original.inbox, 'published', {
    state: 'sent',
    id: 104,
    author: 'demo[bot]',
    url: bot.url,
  })
  const submit = (db: TriggerStore) =>
    db.tracking.continueIssueWork(bot.inbox, 'operator-close-181', '关闭这个 issue', allowed)
  expect(moreRecent.job).toBe(original.job)
  expect(bot.job).toBe(original.job)
  expect(other.job).not.toBe(original.job)
  const next = submit(store)
  expect(next).toMatchObject({
    id: original.job,
    attempt: 4,
    workOrigin: 'manual',
    instruction: '关闭这个 issue',
  })
  expect(store.tracking.eventForJob(original.job, 1)?.event.id).toBe(original.inbox)
  expect(store.tracking.eventForJob(original.job, 2)?.event.id).toBe(moreRecent.inbox)
  expect(store.tracking.eventForJob(original.job, 3)?.event.id).toBe(bot.inbox)
  expect(store.tracking.eventForJob(original.job, 4)?.event.id).toBe(bot.inbox)
  expect(store.tracking.resultForEvent(original.inbox, allowed)).toMatchObject({
    id: original.job,
    attempt: 1,
    work: { outcome: 'resolved', sources: [{ label: 'historic issue' }] },
  })
  expect(store.tracking.resultForEvent(bot.inbox, allowed)).toMatchObject({
    id: original.job,
    inboxId: bot.inbox,
    attempt: 4,
    previous: { attempt: 3, work: { outcome: 'observed' } },
  })
  expect(store.jobs.history('general', other.job)).toHaveLength(1)
  close(store)
  const restored = open(path)
  expect(submit(restored)).toMatchObject({ id: original.job, attempt: 4 })
  expect(() =>
    restored.tracking.continueIssueWork(
      original.inbox,
      'operator-close-181',
      '关闭这个 issue',
      allowed,
    ),
  ).toThrow(RouterJobConflictError)
  expect(restored.jobs.claimNext()).toMatchObject({ id: original.job, attempt: 4 })
  expect(() =>
    restored.tracking.continueIssueWork(bot.inbox, 'second-click', '关闭这个 issue', allowed),
  ).toThrow(RouterJobConflictError)
  expect(restored.jobs.claimNext()).toBeNull()
  expect(restored.jobs.history('general', original.job)).toHaveLength(4)
})

test('an unrelated issue, same number on a PR, another owner or recreated repository, and mentions in text cannot select historical work', () => {
  const store = open()
  enable(store)
  enable(store, 'Other/App')
  const eligible = ingest(store, 21)
  const exclusions = [
    ingest(store, 22, { number: 159 }),
    ingest(store, 23, { pr: true }),
    ingest(store, 24, { repoId: 43 }),
    ingest(store, 25, { name: 'Other/App' }),
  ]
  const recent = ingest(store, 26, { observed: true })
  expect(
    store.tracking.continueIssueWork(recent.inbox, 'close', '关闭这个 issue', allowed),
  ).toMatchObject({ id: eligible.job })
  for (const entry of exclusions) expect(store.jobs.history('general', entry.job)).toHaveLength(1)
})

test('revoked access or a stale observation with a different canonical URL cannot modify prior work', () => {
  const store = open()
  enable(store)
  const earlier = ingest(store, 31)
  const incoming = ingest(store, 32, { observed: true })
  const mismatch = ingest(store, 33, {
    observed: true,
    url: `https://github.com/${repository}/issues/181#issuecomment-9999`,
  })
  for (const [id, canRead] of [
    [incoming.inbox, false],
    [mismatch.inbox, true],
  ] as const) {
    expect(
      store.tracking.continueIssueWork(id, 'denied', '关闭这个 issue', () => canRead),
    ).toBeNull()
    expect(store.jobs.history('general', earlier.job)).toHaveLength(2)
    expect(store.jobs.claimNext()).toBeNull()
  }
  const { settings, revision } = store.getSettings()
  settings.github.repositories[0].issueComments = false
  store.saveSettings(settings, revision)
  expect(
    store.tracking.continueIssueWork(incoming.inbox, 'after-revoke', '关闭', allowed),
  ).toBeNull()
  expect(store.jobs.history('general', earlier.job)).toHaveLength(2)
})

test('a new owner mention reaches the original issue worker with its own source for revalidation', () => {
  const store = open()
  enable(store, repository, true)
  const historical = ingest(store, 41)
  const unrelated = ingest(store, 42, { number: 159 })
  const mention = claimEvent(store, 43)
  expect(mention.job).toMatchObject({ id: historical.job, attempt: 2, workOrigin: null })
  expect(store.tracking.eventForJob(historical.job, 1)?.event.id).toBe(historical.inbox)
  expect(store.tracking.eventForJob(historical.job, 2)?.event.id).toBe(mention.inbox)
  expect(store.tracking.handoffOwnerIssueWork(mention.job, '请关闭这个 Issue')).toBeNull()
  expect(store.jobs.history('general', unrelated.job)).toHaveLength(1)
  expect(store.jobs.claimNext()).toBeNull()
})

test('owner handoff cannot reuse work on another issue, run from a finished job or run with a disabled repository grant', () => {
  const store = open()
  enable(store, repository, true)
  enable(store, 'Other/App')
  const otherIssue = ingest(store, 51, { number: 159 })
  const ungrantedWork = ingest(store, 52, { name: 'Other/App', repoId: 45 })
  const noHistory = claimEvent(store, 53)
  const noGrant = claimEvent(store, 54, { name: 'Other/App', repoId: 45 })
  const finished = claimEvent(store, 55, { number: 159 })
  expect(
    store.jobs.finish(finished.job.id, finished.job.attempt, {
      status: 'completed',
      result: 'done',
    }),
  ).toBe(true)
  for (const source of [noHistory, noGrant, finished]) {
    expect(store.tracking.handoffOwnerIssueWork(source.job, '关闭这个 Issue')).toBeNull()
  }
  expect(store.jobs.history('general', otherIssue.job)).toHaveLength(2)
  expect(store.jobs.history('general', ungrantedWork.job)).toHaveLength(2)
  expect(store.jobs.claimNext()).toBeNull()
})

test('switching GitHub App keeps new automatic and manual work apart from old issue history', () => {
  const store = open()
  enable(store)
  const prior = ingest(store, 61)
  const { settings, revision } = store.getSettings()
  settings.github.repositories[0].githubAppRef = 'github_app_replacement'
  store.saveSettings(settings, revision)
  const current = ingest(store, 62, { observed: true })
  expect(current.job).not.toBe(prior.job)
  expect(
    store.tracking.continueIssueWork(current.inbox, 'manual', '核对当前 Issue', allowed),
  ).toMatchObject({
    id: current.job,
    attempt: 2,
  })
  expect(store.jobs.history('general', prior.job)).toHaveLength(1)
})

test('pre-upgrade independent watch jobs still hand off an authenticated owner close and keep its request id on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-legacy-issue-jobs-'))
  directories.push(dir)
  const path = join(dir, 'inbox.sqlite')
  const store = open(path)
  enable(store, repository, true)
  // Write precisely the old per-event records. These jobs have no persisted follow-up subject.
  const db = new Database(path)
  const at = new Date(Date.now() + 1000).toISOString()
  function legacyJob(comment: number) {
    const inbox = Number(
      db.run(
        `INSERT INTO trigger_inbox(source,stream,event_id,scope,title,summary,occurred_at,received_at,url)
       VALUES('github','github:example/app',?,?,?,?,?,?,?)`,
        [
          `42:comment:${comment}`,
          repository,
          'Issue #181',
          '旧事件',
          at,
          at,
          `https://github.com/${repository}/issues/181#issuecomment-${comment}`,
        ],
      ).lastInsertRowid,
    )
    db.run(
      "INSERT INTO trigger_github_comments(inbox_id,kind,mentioned) VALUES(?,'issue-comment',1)",
      [inbox],
    )
    const job = store.jobs.submit('general', `github-watch:1:${inbox}`, {
      executor: 'zero',
      kind: 'github-watch',
      instruction: '旧的跟踪记录',
      audience: 'owner',
      repository,
    })
    db.run(
      "INSERT INTO router_watch_events(watch_id,inbox_id,job_id,kind) VALUES(1,?,?,'issue-comment')",
      [inbox, job.id],
    )
    expect(store.jobs.claimNext()?.id).toBe(job.id)
    return { job, inbox }
  }
  try {
    const prior = legacyJob(71)
    expect(
      store.jobs.finish(prior.job.id, 1, {
        status: 'completed',
        result: '找到历史 Issue #159',
        work: { outcome: 'resolved', steps: [], sources: [] },
      }),
    ).toBe(true)
    const mention = legacyJob(72)
    const running = store.jobs.get('general', mention.job.id)
    if (!running) throw new Error('Missing legacy @mention')
    const request = '请关闭这个 Issue'
    expect(store.tracking.handoffOwnerIssueWork(running, request)).toMatchObject({
      id: prior.job.id,
      attempt: 2,
      workOrigin: 'owner',
    })
    close(store)
    const restored = open(path)
    expect(restored.tracking.handoffOwnerIssueWork(running, request)).toMatchObject({
      id: prior.job.id,
      attempt: 2,
    })
    expect(restored.tracking.eventForJob(prior.job.id, 2)?.event.id).toBe(mention.inbox)
    expect(restored.jobs.claimNext()).toMatchObject({ id: prior.job.id, attempt: 2 })
    expect(restored.jobs.claimNext()).toBeNull()
  } finally {
    db.close()
  }
})

test('upgrade reconnects the first new issue comment to the historically attested researcher without replaying legacy work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-router-followup-upgrade-'))
  directories.push(dir)
  const path = join(dir, 'inbox.sqlite')
  const old = open(path)
  enable(old)
  const original = ingest(old, 81)
  const local = old.tracking.continueIssueWork(original.inbox, 'legacy-local', '核对历史', allowed)
  expect(local?.id).toBe(original.job)
  expect(old.jobs.claimNext()?.attempt).toBe(2)
  old.jobs.finish(original.job, 2, {
    status: 'completed',
    result: '找到 #159 原评论',
    work: {
      outcome: 'resolved',
      steps: [{ tool: 'find_related_issues', ok: true }],
      sources: [
        { label: '历史原文', url: 'https://github.com/Example/App/issues/159#issuecomment-81' },
      ],
    },
  })
  const other = ingest(old, 83, { number: 999 })
  close(old)
  // Restore the pre-upgrade schema. Only the first case has an attested App identity.
  const db = new Database(path)
  db.exec(`DROP TABLE router_followup_inputs; DROP TABLE router_tracking_migrations;
    ALTER TABLE router_watch_events RENAME TO fixture_modern_watch;
    CREATE TABLE router_watch_events (
      watch_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,job_id INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(watch_id,inbox_id));
    INSERT INTO router_watch_events SELECT watch_id,inbox_id,job_id,kind,revoked FROM fixture_modern_watch;
    DROP TABLE fixture_modern_watch;`)
  db.close()
  const upgraded = open(path)
  expect(upgraded.jobs.claimNext()).toBeNull()
  const latest = claimEvent(upgraded, 82)
  expect(latest.job).toMatchObject({ id: original.job, attempt: 3 })
  expect(upgraded.tracking.eventForJob(latest.job.id, 3)).toMatchObject({
    inboxId: latest.inbox,
    hadAction: true,
    previousResult: '找到 #159 原评论',
    previousSources: expect.arrayContaining([
      { label: '历史原文', url: 'https://github.com/Example/App/issues/159#issuecomment-81' },
    ]),
  })
  const unauthenticated = claimEvent(upgraded, 84, { number: 999 })
  expect(unauthenticated.job.id).not.toBe(other.job)
})

test('Web actions pin the selected earlier event, keep the later event receipt, and reject a different or revoked Worker', () => {
  const store = open()
  enable(store)
  const first = ingest(store, 81)
  const later = ingest(store, 82)
  const unrelated = ingest(store, 83, { number: 159 })
  expect(() =>
    store.tracking.continueEventWork(first.inbox, 'wrong', '核对', unrelated.job),
  ).toThrow(RouterJobConflictError)
  const step = store.tracking.continueEventWork(first.inbox, 'correct', '只核对第一条', first.job)
  expect(step).toMatchObject({ id: first.job, attempt: 3, workOrigin: 'manual' })
  expect(store.tracking.eventForJob(step.id, step.attempt)?.event.id).toBe(first.inbox)
  expect(store.tracking.resultForEvent(first.inbox, allowed)).toMatchObject({
    attempt: 3,
    status: 'queued',
  })
  expect(store.tracking.resultForEvent(later.inbox, allowed)).toMatchObject({
    attempt: 2,
    status: 'completed',
  })
  expect(
    store.tracking.continueEventWork(first.inbox, 'correct', '只核对第一条', first.job),
  ).toEqual(step)
  const { settings, revision } = store.getSettings()
  settings.github.repositories[0].issueComments = false
  store.saveSettings(settings, revision)
  expect(store.tracking.eventForJob(step.id, step.attempt)?.active).not.toBe(true)
  expect(() =>
    store.tracking.continueEventWork(first.inbox, 'after-revocation', '核对', first.job),
  ).toThrow(RouterJobConflictError)
})

test('an upgraded inbox shows the old Web research on its exact event and keeps the later close on its own event', () => {
  const store = open()
  enable(store)
  const first = ingest(store, 90, { observed: true })
  const result = '已查到 #159 原评论'
  const research = store.jobs.continue(
    'general',
    first.job,
    `event-work:${first.inbox}:local-web`,
    '查证引用',
    'manual',
  )
  expect(store.jobs.claimNext()?.attempt).toBe(research.attempt)
  store.jobs.finish(first.job, research.attempt, {
    status: 'completed',
    result,
    work: {
      outcome: 'resolved',
      steps: [{ tool: 'find_related_issues', ok: true }],
      sources: [
        { label: '原评论', url: 'https://github.com/Example/App/issues/159#issuecomment-90' },
      ],
    },
  })
  const later = ingest(store, 91, { observed: true })
  const close = store.tracking.continueIssueWork(later.inbox, 'close', '关闭当前 Issue', allowed)
  if (!close) throw new Error('No scoped close receipt')
  expect(close.id).toBe(first.job)
  expect(store.jobs.claimNext()?.attempt).toBe(close.attempt)
  store.jobs.finish(first.job, close.attempt, { status: 'completed', result: '已关闭' })
  const near = store.jobs.continue(
    'general',
    first.job,
    `event-work:${first.inbox}0:other`,
    '其他事件',
    'manual',
  )
  expect(store.jobs.claimNext()?.attempt).toBe(near.attempt)
  store.jobs.finish(first.job, near.attempt, { status: 'completed', result: '别的事件' })
  expect(store.tracking.resultForEvent(first.inbox, allowed)).toMatchObject({
    attempt: research.attempt,
    result,
    work: { steps: [{ tool: 'find_related_issues', ok: true }] },
  })
  expect(store.tracking.resultForEvent(later.inbox, allowed)).toMatchObject({
    attempt: close?.attempt,
    result: '已关闭',
  })
  expect(store.tracking.resultForEvent(first.inbox, () => false)).toBeUndefined()
})
