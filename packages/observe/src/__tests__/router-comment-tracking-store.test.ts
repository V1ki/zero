import { Database } from 'bun:sqlite'
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerEvent, TriggerGithubRepository, TriggerSettings } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const repository = 'Example/App'
const stream = 'github:example/app'
const audience = 'local-router'
const epoch = Date.parse('2030-04-01T12:00:00Z')
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString()
const clock = (seconds: number) => setSystemTime(new Date(at(seconds)))
const directories: string[] = []
const stores: TriggerStore[] = []

afterEach(() => {
  setSystemTime()
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-comments-'))
  directories.push(dir)
  return join(dir, 'inbox.sqlite')
}

function open(path = ':memory:') {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}

function update(store: TriggerStore, change: (settings: TriggerSettings) => void) {
  const { settings, revision } = store.getSettings()
  change(settings)
  store.saveSettings(settings, revision)
}

type Flags = Pick<
  TriggerGithubRepository,
  'issues' | 'pullRequests' | 'issueComments' | 'pullRequestComments'
>

function track(store: TriggerStore, requestId: string, flags: Flags) {
  const grant = store.tracking.grant('web')
  if (!grant) throw new Error('Expected a tracking grant')
  return store.tracking.start({
    actor: 'web',
    scope: 'general',
    audience,
    ownerAudience: audience,
    repository,
    requestId,
    expectedGrantGeneration: grant.generation,
    issues: false,
    pullRequests: false,
    ...flags,
  })
}

function watchStore(path = ':memory:') {
  const store = open(path)
  update(store, (settings) => {
    settings.github.credentialRef = 'github_listener'
    settings.github.routerTrackingEnabled = true
  })
  return store
}

function comment(kind: 'issue-comment' | 'pr-comment', id: number, second: number): TriggerEvent {
  const page = kind === 'issue-comment' ? 'issues' : 'pull'
  return {
    scope: repository,
    eventId: `42:comment:${id}`,
    githubCommentKind: kind,
    title: `${kind} #17`,
    summary: 'A new comment',
    occurredAt: at(second),
    url: `https://github.com/${repository}/${page}/17#issuecomment-${id}`,
  }
}

function state(kind: 'issue' | 'pr', id: number, second: number): TriggerEvent {
  return {
    scope: repository,
    eventId: `42:${kind}:${id}:opened:${Date.parse(at(second))}`,
    title: `${kind} #${id}`,
    summary: 'Opened',
    occurredAt: at(second),
  }
}

function batch(store: TriggerStore, events: TriggerEvent[]) {
  return { source: 'github' as const, stream, revision: store.getSettings().revision, events }
}

test('four watch families have independent inclusive boundaries; repeated poll and push schedule one job per accepted event', () => {
  clock(0)
  const store = watchStore()
  const issueWatch = track(store, 'issue', { issues: true })
  clock(10)
  const prWatch = track(store, 'pr', { pullRequests: true })
  clock(20)
  const issueComments = track(store, 'issue-comments', { issueComments: true })
  clock(30)
  const prComments = track(store, 'pr-comments', { pullRequestComments: true })
  expect([prWatch.id, issueComments.id, prComments.id]).toEqual(Array(3).fill(issueWatch.id))

  const admitted = [
    state('issue', 1, 0),
    state('pr', 3, 10),
    comment('issue-comment', 5, 20),
    comment('pr-comment', 7, 30),
  ]
  const old = [
    state('issue', 2, -1),
    state('pr', 4, 9),
    comment('issue-comment', 6, 19),
    comment('pr-comment', 8, 29),
  ]
  const intake = batch(store, [...old, ...admitted])
  expect(store.commitPush(intake)).toBe(true)
  expect(store.commitBatch({ ...intake, previousCursor: null, cursor: 'first-poll' })).toBe(true)
  expect(
    store
      .listInbox()
      .map((item) => item.eventId)
      .sort(),
  ).toEqual(admitted.map((item) => item.eventId).sort())
  const jobs = store.tracking.listResults()
  expect(jobs.map((item) => item.kind).sort()).toEqual([
    'issue',
    'issue-comment',
    'pr',
    'pr-comment',
  ])
  expect(store.routing.list()).toHaveLength(0)

  const issueCommentJob = jobs.find((item) => item.kind === 'issue-comment')
  if (!issueCommentJob) throw new Error('Expected queued issue comment')
  update(store, (settings) => {
    settings.github.repositories[0].issueComments = false
  })
  expect(store.tracking.eventForJob(issueCommentJob.id)?.active).toBe(false)
  for (const job of jobs.filter((item) => item.id !== issueCommentJob.id))
    expect(store.tracking.eventForJob(job.id)?.active).toBe(true)
  expect(
    store.commitPush(batch(store, [comment('issue-comment', 9, 31), state('pr', 10, 31)])),
  ).toBe(true)
  expect(store.listInbox().some((item) => item.eventId === '42:comment:9')).toBe(false)
  expect(store.tracking.listResults()).toHaveLength(4)
})

test('a comment-only watch coexists with a verified earlier PR mention without backfilling ordinary comments', () => {
  clock(0)
  const path = databasePath()
  const store = watchStore(path)
  const policy = store.routing.getSettings()
  store.routing.saveSettings({ ...policy.settings, enabled: true }, policy.revision)
  update(store, (settings) => {
    settings.github.repositories.push({
      name: repository,
      enabled: true,
      mention: 'reviewer',
      workflowFailures: false,
      branch: '',
      workflow: '',
    })
  })
  clock(60)
  const watch = track(store, 'comments-only', { pullRequestComments: true })
  expect(watch).toMatchObject({ issues: false, pullRequests: false, pullRequestComments: true })
  const before = { ...comment('pr-comment', 11, 20), githubCommentMention: true as const }
  const after = { ...comment('pr-comment', 12, 60), githubCommentMention: true as const }
  const intake = batch(store, [
    before,
    after,
    comment('pr-comment', 13, 20),
    state('issue', 14, 60),
  ])
  expect(store.commitPush(intake)).toBe(true)
  expect(store.commitPush(intake)).toBe(true)
  expect(
    store
      .listInbox()
      .map((item) => item.eventId)
      .sort(),
  ).toEqual([before.eventId, after.eventId])
  const jobs = store.tracking.listResults()
  expect(jobs).toHaveLength(1)
  const reopened = open(path)
  expect(reopened.tracking.eventForJob(jobs[0].id)?.event).toMatchObject({
    eventId: after.eventId,
    githubCommentKind: 'pr-comment',
    githubCommentMention: true,
  })
  for (const item of reopened.listInbox())
    expect(reopened.routing.get(item.id)?.origin).toBe('subscription')
})

test('enabling comments in listening settings admits only new comments of the selected type', () => {
  clock(0)
  const store = watchStore()
  track(store, 'states', { issues: true, pullRequests: true })
  clock(40)
  // An explicit lookback for legacy Actions must not backfill newly enabled comments.
  const snapshot = store.getSettings()
  snapshot.settings.github.repositories[0].workflowFailures = true
  snapshot.settings.github.repositories[0].issueComments = true
  store.saveSettings(snapshot.settings, snapshot.revision, 24)
  const newComment = comment('issue-comment', 31, 40)
  const intake = batch(store, [
    comment('issue-comment', 30, 39),
    newComment,
    comment('pr-comment', 32, 40),
  ])
  expect(store.commitPush(intake)).toBe(true)
  expect(store.listInbox().map((item) => item.eventId)).toEqual([newComment.eventId])
  expect(store.getSettings().settings.github.repositories[0]).toMatchObject({
    issues: true,
    pullRequests: true,
    issueComments: true,
  })
})

test('upgrades a previous two-family SQLite watch and request, retaining its ID, baseline, cursor and comments after another restart', () => {
  const path = databasePath()
  const old = new Database(path, { create: true })
  const settings: TriggerSettings = {
    github: {
      credentialRef: 'github_listener',
      routerTrackingEnabled: true,
      repositories: [
        {
          name: repository,
          enabled: true,
          issues: true,
          pullRequests: true,
          mention: '',
          workflow: '',
          branch: '',
          workflowFailures: false,
        },
      ],
    },
    wxarc: { sessions: [] },
  }
  try {
    old.exec(`CREATE TABLE trigger_settings(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE trigger_streams(stream TEXT PRIMARY KEY, started_at TEXT NOT NULL, cursor TEXT);
      CREATE TABLE router_tracking_connection(id INTEGER PRIMARY KEY,credential_ref TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE router_github_watches(id INTEGER PRIMARY KEY,audience TEXT NOT NULL,generation INTEGER NOT NULL,repository TEXT COLLATE NOCASE NOT NULL,issues_since TEXT,pulls_since TEXT);
      CREATE UNIQUE INDEX router_active_watch_per_repository ON router_github_watches(repository) WHERE issues_since IS NOT NULL OR pulls_since IS NOT NULL;
      CREATE VIEW router_current_watches AS SELECT w.* FROM router_github_watches w JOIN router_tracking_connection g ON g.generation=w.generation WHERE w.issues_since IS NOT NULL OR w.pulls_since IS NOT NULL;
      CREATE TABLE router_lifecycle_starts(repository TEXT COLLATE NOCASE NOT NULL,kind TEXT NOT NULL,since TEXT,managed INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(repository,kind));
      CREATE TABLE router_watch_requests(scope TEXT NOT NULL,request_id TEXT NOT NULL,watch_id INTEGER NOT NULL,selection TEXT NOT NULL,PRIMARY KEY(scope,request_id));`)
    old.run('INSERT INTO trigger_settings VALUES(1,1,?)', [JSON.stringify(settings)])
    old.run('INSERT INTO trigger_streams VALUES(?,?,?)', [stream, at(0), 'existing-cursor'])
    old.run("INSERT INTO router_tracking_connection VALUES(1,'github_listener',1)")
    old.run('INSERT INTO router_github_watches VALUES(17,?,1,?,?,?)', [
      audience,
      repository,
      at(0),
      at(0),
    ])
    for (const kind of ['issue', 'pr'])
      old.run('INSERT INTO router_lifecycle_starts VALUES(?,?,?,1,0)', [repository, kind, at(0)])
    old.run("INSERT INTO router_watch_requests VALUES('general','old-request',17,?)", [
      JSON.stringify([repository.toLowerCase(), true, true, 1, audience]),
    ])
  } finally {
    old.close()
  }
  clock(60)
  const upgraded = open(path)
  expect(track(upgraded, 'old-request', { issues: true, pullRequests: true }).id).toBe(17)
  const flags = { issueComments: true, pullRequestComments: true }
  expect(track(upgraded, 'new-comments', flags).id).toBe(17)
  expect(upgraded.tracking.pendingSince(repository)).toBe(at(60))
  expect(upgraded.readCursor(stream)).toBe('existing-cursor')
  clock(120)
  const reopened = open(path)
  expect(track(reopened, 'new-comments', flags).id).toBe(17)
  const oldIssue = state('issue', 20, 10)
  const accepted = comment('issue-comment', 21, 65)
  const intake = batch(reopened, [oldIssue, comment('pr-comment', 22, 59), accepted])
  expect(
    reopened.commitBatch({ ...intake, previousCursor: 'existing-cursor', cursor: 'after-upgrade' }),
  ).toBe(true)
  expect(reopened.tracking.listResults().map((item) => item.kind)).toEqual([
    'issue-comment',
    'issue',
  ])
  expect(reopened.tracking.pendingSince(repository)).toBeNull()
})
