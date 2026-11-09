import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommissionOperator, TriggerEvent, TriggerSettings } from '@zero-os/shared'
import { githubActorKey } from '../router-tracking-store'
import { TriggerStore } from '../trigger-store'

const dirs: string[] = []
const opened: TriggerStore[] = []
const owner: CommissionOperator = {
  platform: 'weixin',
  channelId: 'bot',
  peerId: 'dm',
  operatorId: 'me',
}
const kindScope = `im-${createHash('sha256').update(githubActorKey(owner)).digest('hex')}` as const
const repository = 'Example/App'
const stream = 'github:example/app'
const future = () => new Date(Date.now() + 8 * 86_400_000)
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(path: string) {
  const store = new TriggerStore(path)
  opened.push(store)
  return store
}
function change(store: TriggerStore, fn: (s: TriggerSettings) => void) {
  const { settings, revision } = store.getSettings()
  fn(settings)
  return store.saveSettings(settings, revision)
}
function required<T>(value: T | null): T {
  if (value === null) throw new Error('Required test record is missing')
  return value
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-watch-'))
  dirs.push(dir)
  const path = join(dir, 'events.sqlite')
  const store = open(path)
  change(store, (s) => {
    s.github.credentialRef = 'github_listener'
    s.github.routerOperators = [owner]
    s.github.routerTrackingEnabled = true
  })
  const start = {
    actor: owner,
    scope: kindScope,
    audience: 'initiator-pin',
    ownerAudience: 'owner-web',
    requestId: 'm1',
    repository,
    issues: true,
    pullRequests: false,
    expectedGrantGeneration: required(store.tracking.grant(owner)).generation,
  }
  const route = store.routing.getSettings()
  store.routing.saveSettings({ ...route.settings, enabled: true, retentionDays: 7 }, route.revision)
  return { store, path, start }
}
function lifecycle(kind: 'issue' | 'pr', number: number, at = Date.now() + 1000): TriggerEvent {
  return {
    scope: repository,
    title: `Object #${number}`,
    summary: 'Test only',
    url: `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`,
    occurredAt: new Date(at).toISOString(),
    eventId: `42:${kind}:${number}:opened:${at}`,
  }
}
function push(store: TriggerStore, events: TriggerEvent[]) {
  return store.commitPush({
    source: 'github',
    stream,
    revision: store.getSettings().revision,
    events,
  })
}

test('tracking atomically provisions the repository, preserves other filters and their cursor, and queues a durable job per match', () => {
  const { store, start, path } = fixture()
  const before = change(store, (s) =>
    s.github.repositories.push({
      name: 'eXample/App',
      enabled: true,
      workflow: 'deploy.yml',
      branch: 'main',
      workflowFailures: true,
      mention: 'me',
      deliveryMode: 'webhook',
      webhookSecretRef: 'github_webhook',
    }),
  )
  const startAt = store.getStreamStartedAt(stream)
  expect(
    store.commitBatch({
      source: 'github',
      stream,
      revision: before,
      events: [],
      previousCursor: null,
      cursor: 'previous',
    }),
  ).toBe(true)
  expect(store.tracking.start(start)).toEqual({
    id: 1,
    repository: 'eXample/App',
    issues: true,
    pullRequests: false,
    deliveryMode: 'webhook',
  })
  const revision = store.getSettings().revision
  expect(store.getSettings().settings.github.repositories[0]).toMatchObject({
    issues: true,
    workflow: 'deploy.yml',
    workflowFailures: true,
    mention: 'me',
    branch: 'main',
    webhookSecretRef: 'github_webhook',
  })
  expect(store.readCursor(stream)).toBe('previous')
  expect(store.getStreamStartedAt(stream)).toBe(startAt)
  expect(store.tracking.start(start).id).toBe(1)
  expect(store.getSettings().revision).toBe(revision)
  expect(() => store.tracking.start({ ...start, repository: 'Other/Repo' })).toThrow()
  const old = lifecycle('issue', 1, Date.now() - 60000)
  const event = lifecycle('issue', 2)
  push(store, [old, event, lifecycle('pr', 3)])
  push(store, [event])
  expect(store.listInbox()).toHaveLength(1)
  expect(store.routing.list()).toHaveLength(0)
  const reopened = open(path)
  const results = reopened.tracking.listResults()
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ repository: 'eXample/App', status: 'queued', kind: 'issue' })
  const job = required(reopened.jobs.claimNext())
  expect(job).toMatchObject({
    scope: 'general',
    kind: 'github-watch',
    executor: 'zero',
    audience: start.ownerAudience,
  })
  expect(reopened.tracking.eventForJob(job.id)).toMatchObject({
    trackingId: 1,
    inboxId: results[0].inboxId,
    active: true,
    event: { eventId: event.eventId },
  })
  expect(reopened.jobs.claimNext()).toBeNull()
  expect(reopened.tracking.listResults(20, results[0].id)).toEqual([])
  expect(reopened.tracking.listResults(20, undefined, () => false)).toEqual([])
})

test('Web and IM extend the same Router watch and schedule one job per event', () => {
  const { store, start } = fixture()
  const watch = store.tracking.start(start)
  const web = {
    ...start,
    actor: 'web' as const,
    scope: 'general' as const,
    audience: start.ownerAudience,
    expectedGrantGeneration: required(store.tracking.grant('web')).generation,
    requestId: 'web-add-pr',
    pullRequests: true,
  }
  expect(store.tracking.start(web).id).toBe(watch.id)
  const pr = lifecycle('pr', 10)
  push(store, [pr])
  expect(store.tracking.listResults()).toHaveLength(1)
  expect(
    store.tracking.start({ ...start, pullRequests: true, requestId: 'im-add-pr' }),
  ).toMatchObject({
    id: watch.id,
    issues: true,
    pullRequests: true,
  })
  push(store, [pr, lifecycle('issue', 11)])
  expect(store.tracking.listResults().map((r) => r.kind)).toEqual(['issue', 'pr'])
  expect(store.routing.get(store.listInbox(1)[0].id)).toBeNull()
  change(store, (s) => {
    s.github.repositories[0].issues = false
  })
  expect(store.tracking.listResults().map((r) => r.kind)).toEqual(['pr'])
  change(store, (s) => {
    s.github.repositories[0].issues = true
  })
  expect(store.tracking.listResults().map((r) => r.kind)).toEqual(['pr'])
  expect(() => store.tracking.start(start)).toThrow()
  push(store, [lifecycle('issue', 12)])
  expect(store.routing.get(store.listInbox(1)[0].id)?.origin).toBe('subscription')
})

test('revoking the initiating IM access fences that actor while the shared Router watch keeps working', () => {
  const { store, start } = fixture()
  const watch = store.tracking.start(start)
  push(store, [lifecycle('issue', 7)])
  const original = store.tracking.listResults()[0]
  change(store, (s) => {
    s.github.routerOperators = []
  })
  expect(store.getRouterGithubGrant(owner)).toBeNull()
  expect(store.tracking.grant(owner)).toBeNull()
  expect(store.tracking.eventForJob(original.id)?.active).toBe(true)
  expect(() => store.tracking.start({ ...start, requestId: 'im-after-revoke' })).toThrow()
  push(store, [lifecycle('issue', 8)])
  expect(store.tracking.listResults()).toHaveLength(2)
  expect(store.routing.list()).toHaveLength(0)
  change(store, (s) => {
    s.github.routerOperators = [owner]
  })
  const generation = required(store.tracking.grant(owner)).generation
  expect(generation).not.toBe(start.expectedGrantGeneration)
  expect(() => store.tracking.start({ ...start, requestId: 'stale' })).toThrow()
  expect(() => store.tracking.start({ ...start, expectedGrantGeneration: generation })).toThrow()
  expect(
    store.tracking.start({ ...start, expectedGrantGeneration: generation, requestId: 'renewed' })
      .id,
  ).toBe(watch.id)
})

test('global switch off retires private activities and never reroutes managed events to generic notifications', () => {
  const { store, start } = fixture()
  change(store, (s) => {
    s.github.repositories.push({
      name: repository,
      enabled: true,
      pullRequests: true,
      workflowFailures: false,
      branch: '',
      mention: '',
      workflow: '',
    })
  })
  store.tracking.start(start)
  push(store, [lifecycle('issue', 7)])
  const original = store.tracking.listResults()[0]
  change(store, (s) => {
    s.github.routerTrackingEnabled = false
  })
  expect(store.getRouterGithubGrant(owner)).not.toBeNull()
  expect(store.tracking.grant(owner)).toBeNull()
  expect(store.tracking.grant('web')).toBeNull()
  expect(store.tracking.eventForJob(original.id)?.active).toBe(false)
  expect(store.tracking.listResults()).toEqual([])
  push(store, [lifecycle('issue', 8)])
  expect(store.listInbox()).toHaveLength(1)
  expect(store.routing.list()).toHaveLength(0)
  // The PR source was separately enabled in listening settings.
  push(store, [lifecycle('pr', 9)])
  expect(store.routing.get(store.listInbox(1)[0].id)?.origin).toBe('subscription')
  change(store, (s) => {
    s.github.routerTrackingEnabled = true
  })
  expect(store.tracking.listResults()).toEqual([])
  expect(() => store.tracking.start({ ...start, requestId: 'stale' })).toThrow()
  change(store, (s) => {
    s.github.repositories[0].enabled = false
  })
  expect(() =>
    store.tracking.start({
      ...start,
      expectedGrantGeneration: required(store.tracking.grant(owner)).generation,
      requestId: 'resume',
    }),
  ).toThrow('暂停')
  expect(store.getSettings().settings.github.repositories[0].enabled).toBe(false)
  change(store, (s) => {
    s.github.repositories[0].enabled = true
  })
  push(store, [lifecycle('issue', 10)])
  expect(store.listInbox()).toHaveLength(2)
  expect(store.tracking.listResults()).toHaveLength(0)
})

test('upstream polling suppresses only dormant Router families and respects an independent mandate', () => {
  const { store, start } = fixture()
  store.tracking.start(start)
  const repo = () => store.getSettings().settings.github.repositories[0]
  expect(store.tracking.pollSelection(repo())?.issues).toBe(true)
  change(store, (s) => {
    s.github.routerTrackingEnabled = false
  })
  expect(store.tracking.pollSelection(repo())).toBeNull()
  change(store, (s) => {
    s.github.repositories[0].pullRequests = true
    s.github.repositories[0].workflowFailures = true
  })
  expect(store.tracking.pollSelection(repo())).toMatchObject({
    issues: false,
    pullRequests: true,
    workflowFailures: true,
  })
  const configuration = store.mandates.getSettings()
  store.mandates.saveSettings(
    {
      ...configuration.settings,
      mandates: [
        {
          id: 'independent',
          enabled: true,
          source: 'github',
          scope: repository,
          purpose: 'Handle reports',
          keyword: '',
          name: 'Independent',
          targets: [],
          projectId: null,
          archive: null,
          policy: {},
          deadline: null,
          urgent: false,
        },
      ],
    },
    configuration.revision,
  )
  expect(store.tracking.pollSelection(repo())).toMatchObject({
    issues: true,
    pullRequests: true,
    workflowFailures: true,
  })
})

test('rotating the connection under the same credential name retires old jobs and starts only one watch', () => {
  const { store, start } = fixture()
  const first = store.tracking.start(start)
  push(store, [lifecycle('issue', 1)])
  const firstJob = store.tracking.listResults()[0]
  const replacement = {
    ...start,
    ownerAudience: 'new-owner-pin',
    audience: 'new-initiator-pin',
    requestId: 'renew',
  }
  expect(store.tracking.start(replacement).id).not.toBe(first.id)
  expect(store.tracking.eventForJob(firstJob.id)?.active).toBe(false)
  push(store, [lifecycle('issue', 2)])
  expect(store.tracking.listResults()).toHaveLength(1)
  expect(store.tracking.start({ ...start, requestId: 'switch-back' }).id).not.toBe(first.id)
  expect(store.tracking.eventForJob(firstJob.id)?.active).toBe(false)
  expect(store.tracking.listResults()).toHaveLength(0)
})

test('new watches accept GitHub events stamped in the activation second and only a committed poll clears its baseline', () => {
  const { store, start } = fixture()
  store.tracking.start(start)
  const since = required(store.tracking.pendingSince(repository))
  expect(since.endsWith('.000Z')).toBe(true)
  const boundary = Date.parse(since)
  push(store, [lifecycle('issue', 4, boundary - 1000), lifecycle('issue', 5, boundary)])
  expect(store.tracking.listResults()).toHaveLength(1)
  expect(store.tracking.pendingSince(repository)).toBe(since)
  const batch = {
    source: 'github' as const,
    stream,
    revision: store.getSettings().revision,
    previousCursor: null,
    cursor: 'polled',
    events: [],
  }
  expect(store.commitBatch({ ...batch, revision: 0 })).toBe(false)
  expect(store.tracking.pendingSince(repository)).toBe(since)
  expect(store.commitBatch(batch)).toBe(true)
  expect(store.tracking.pendingSince(repository)).toBeNull()
})

test('retention waits for the job and its delivery then clears both the private event and worker result without replay', () => {
  const { store, start } = fixture()
  store.tracking.start(start)
  const event = lifecycle('issue', 2)
  push(store, [event])
  expect(store.retention.sweep(future()).events).toBe(0)
  const job = required(store.jobs.claimNext())
  expect(
    store.jobs.finish(job.id, 1, {
      status: 'completed',
      result: 'summary',
      attentionQuestion: '继续吗？',
    }),
  ).toBe(true)
  expect(store.tracking.listResults()[0]).toMatchObject({
    result: 'summary',
    needsAttention: true,
    attentionQuestion: '继续吗？',
  })
  expect(store.retention.sweep(future()).events).toBe(0)
  expect(store.jobs.claimReturn()?.id).toBe(job.id)
  store.jobs.settleReturn(job.id, 1, 'delivered')
  expect(store.retention.sweep(future()).events).toBe(1)
  expect(store.tracking.listResults()).toEqual([])
  expect(store.tracking.eventForJob(job.id)).toBeNull()
  push(store, [event])
  expect(store.jobs.claimNext()).toBeNull()
})
