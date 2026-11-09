import { afterEach, expect, test } from 'bun:test'
import type { TriggerEvent, TriggerGithubRepository, TriggerMandate } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const repository = 'Owner/Private'
const stream = 'github:owner/private'
const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function requireValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a workflow follow-up')
  return value
}
function configure(store: TriggerStore, change: Partial<TriggerGithubRepository> = {}) {
  const { settings, revision } = store.getSettings()
  settings.github.credentialRef ||= 'github_listener'
  settings.github.repositories = [
    {
      ...(settings.github.repositories[0] ?? {
        name: repository,
        enabled: true,
        branch: '',
        workflow: '',
        workflowFailures: true,
        mention: '',
      }),
      ...change,
    },
  ]
  store.saveSettings(settings, revision)
}
function routing(store: TriggerStore, enabled: boolean) {
  const snapshot = store.routing.getSettings()
  store.routing.saveSettings({ ...snapshot.settings, enabled }, snapshot.revision)
}
function open() {
  const store = new TriggerStore(':memory:')
  stores.push(store)
  configure(store)
  routing(store, true)
  store.tracking.setWorkflowAudience(() => 'authorized-web')
  return store
}
function failure(attempt: number): TriggerEvent {
  return {
    eventId: `71:run:45:${attempt}:failure`,
    scope: repository,
    title: 'Build failed',
    summary: 'Recorded failure',
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    url: `https://github.com/${repository}/actions/runs/45/attempts/${attempt}`,
  }
}
function push(store: TriggerStore, event: TriggerEvent) {
  store.commitPush({
    source: 'github',
    stream,
    revision: store.getSettings().revision,
    events: [event],
  })
  const inbox = store.listInbox().find((i) => i.eventId === event.eventId)
  if (!inbox) throw new Error('Missing inbox receipt')
  return { inbox: inbox.id, job: store.tracking.resultForEvent(inbox.id, () => true) }
}

test('native failures use the same Worker across retries, deduplicate, and keep the configured notification', () => {
  const store = open()
  const first = push(store, failure(1))
  expect(first.job).toMatchObject({ kind: 'workflow-failure', attempt: 1, status: 'queued' })
  expect(store.routing.get(first.inbox)?.status).toBe('pending')
  expect(push(store, failure(1))).toEqual(first)
  const second = push(store, failure(2))
  expect(second.inbox).not.toBe(first.inbox)
  expect(second.job?.id).toBe(first.job?.id)
  expect(store.tracking.listResults()).toHaveLength(2)
  const claim = requireValue(store.jobs.claimNext())
  store.jobs.finish(claim.id, claim.attempt, { status: 'completed', result: 'Checked attempt 1' })
  const continuation = store.jobs.claimNext()
  expect(continuation).toMatchObject({ id: claim.id, attempt: 2 })
  expect(store.tracking.eventForJob(claim.id, 2)).toMatchObject({
    inboxId: second.inbox,
    active: true,
    followup: true,
  })
  expect(push(store, { ...failure(3), eventId: 'ci:71:run:45:3:failure' }).job).toBeUndefined()
  expect(push(store, { ...failure(4), url: failure(3).url }).job).toBeUndefined()
  expect(push(store, { ...failure(5), occurredAt: '2020-01-01T00:00:00Z' }).job).toBeUndefined()
})

test('respects existing model, GitHub principal and explicit mandate; source changes isolate the old Worker', () => {
  const store = open()
  routing(store, false)
  expect(push(store, failure(1)).job).toBeUndefined()
  routing(store, true)
  store.tracking.setWorkflowAudience(() => null)
  expect(push(store, failure(2)).job).toBeUndefined()
  store.tracking.setWorkflowAudience(() => 'authorized-web')
  let previous = requireValue(push(store, failure(3)).job)
  store.tracking.setWorkflowAudience(() => 'changed-key')
  expect(store.tracking.eventForJob(previous.id, 1)?.active).toBe(false)
  expect(store.tracking.resultForEvent(previous.inboxId, () => true)).toBeUndefined()
  store.tracking.setWorkflowAudience(() => 'authorized-web')
  let attempt = 4
  for (const change of [
    { branch: 'main' },
    { workflow: 'ci.yml' },
    { githubAppRef: 'github_app_a' },
    { deliveryMode: 'webhook' as const, webhookSecretRef: 'github_webhook' },
  ]) {
    configure(store, change)
    expect(store.tracking.eventForJob(previous.id, 1)?.active).toBe(false)
    const fresh = requireValue(push(store, failure(attempt++)).job)
    expect(fresh.id).not.toBe(previous.id)
    previous = fresh
  }
  const m: TriggerMandate = {
    id: 'chosen',
    name: 'Chosen',
    enabled: true,
    purpose: 'Notify',
    processing: 'direct',
    source: 'github',
    scope: repository,
    keyword: '',
    projectId: null,
    targets: [],
    archive: null,
    policy: {},
    deadline: null,
    urgent: false,
  }
  const mandate = store.mandates.getSettings()
  store.mandates.saveSettings({ ...mandate.settings, mandates: [m] }, mandate.revision)
  expect(store.tracking.eventForJob(previous.id, 1)?.active).toBe(false)
  expect(push(store, failure(attempt++)).job).toBeUndefined()
  store.mandates.saveSettings({ ...mandate.settings }, store.mandates.getSettings().revision)
  expect(store.tracking.eventForJob(previous.id, 1)?.active).toBe(false)
  const fresh = requireValue(push(store, failure(attempt++)).job)
  expect(fresh.id).not.toBe(previous.id)
  routing(store, false)
  routing(store, true)
  expect(store.tracking.eventForJob(fresh.id, 1)?.active).toBe(false)
  configure(store, { workflowFailures: false })
  expect(push(store, failure(attempt++)).job).toBeUndefined()
})
