import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MandateTarget, TriggerEvent, TriggerMandate } from '@zero-os/shared'
import { TriggerSettingsConflictError, TriggerStore } from '../trigger-store'

const receiver = {
  platform: 'dingtalk',
  channelId: 'dedicated',
  peerId: 'room',
  operatorId: 'manager',
} satisfies MandateTarget
const config: TriggerMandate = {
  id: 'release',
  enabled: true,
  name: '发布',
  purpose: '跟踪发布',
  source: 'github',
  scope: 'Owner/App',
  keyword: 'build',
  projectId: null,
  targets: [receiver],
  archive: null,
  policy: {},
  deadline: null,
  urgent: false,
}
const subscriptions = {
  github: {
    credentialRef: 'test',
    repositories: [
      {
        name: config.scope,
        enabled: true,
        branch: 'main',
        workflow: '',
        workflowFailures: true,
        mention: 'owner',
      },
    ],
  },
  wxarc: { sessions: [{ id: 'chat', name: 'chat', enabled: true, keyword: '' }] },
}
const event = (id: number, pr = 5): TriggerEvent => ({
  eventId: `123:comment:${id}`,
  scope: config.scope,
  occurredAt: '2026-01-01T00:00:00.000Z',
  title: 'Build question',
  summary: 'test',
  url: `https://github.com/Owner/App/pull/${pr}#issuecomment-${id}`,
})
const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function setup(mandates: TriggerMandate[] = [config], path = ':memory:') {
  const store = new TriggerStore(path)
  stores.push(store)
  store.saveSettings(subscriptions, 0)
  store.routing.saveSettings({ ...store.routing.getSettings().settings, enabled: true }, 0)
  store.mandates.saveSettings({ projects: [], mandates }, 0)
  return store
}
function push(store: TriggerStore, events: TriggerEvent[], revision = 1) {
  return store.commitPush({ source: 'github', stream: 'github:owner/app', revision, events })
}

test('one intake atomically hands off to every matching purpose, or to the legacy path for ungoverned scopes', () => {
  const store = setup([config, { ...config, id: 'stability', purpose: '稳定性' }])
  expect(push(store, [event(1), event(2), event(1), { ...event(3), title: 'irrelevant' }])).toBe(
    true,
  )
  expect(store.listInbox()).toHaveLength(3)
  expect(store.mandates.listMatches()).toHaveLength(4)
  const tasks = store.mandates.listTasks()
  expect(tasks).toHaveLength(2)
  expect(tasks.every((t) => t.eventCount === 2 && t.businessKey === 'repo:123:pr:5')).toBe(true)
  expect(store.mandates.listMatches(10, undefined, 1)).toHaveLength(2)
  expect(store.routing.list()).toHaveLength(0)
  expect(store.routing.enqueue(1)).toBe(false)
  expect(store.routing.enqueue(3)).toBe(false)
  expect(store.readCursor('github:owner/app')).toBeNull()
  expect(push(store, [event(4)], 0)).toBe(false)
  expect(() => push(store, [event(4), { ...event(5), scope: 'wrong/repo' }])).toThrow('scope')
  expect(store.listInbox()).toHaveLength(3)
  expect(store.mandates.listMatches()).toHaveLength(4)
  expect(
    store.commitPush({
      source: 'wxarc',
      stream: 'wxarc:chat',
      revision: 1,
      events: [{ ...event(1), scope: 'chat' }],
    }),
  ).toBe(true)
  expect(store.routing.list()).toHaveLength(1)
})

test('analysis uses a task session and claim token. Authenticated PR identity and optional mandate-wide grouping drive coalescing', () => {
  const store = setup()
  push(store, [
    event(1),
    event(2),
    event(3, 8),
    { ...event(4), url: 'https://github.com/Owner/App/pull/5#issuecomment-2' },
  ])
  const ledger = store.mandates
  expect(ledger.listTasks()).toHaveLength(3)
  const first = ledger.claimAnalysis('first')
  if (!first) throw new Error('expected first claim')
  expect(first.task.sessionId).toBe('first')
  expect(ledger.finishAnalysis(first.match.id, 'bad', 'wrong')).toBe(false)
  const parallel = ledger.claimAnalysis('parallel')
  expect(parallel?.task.id).not.toBe(first.task.id)
  expect(ledger.finishAnalysis(first.match.id, 'earlier', first.claimToken)).toBe(true)
  const second = ledger.claimAnalysis('different')
  if (!second) throw new Error('expected second claim')
  expect(second.task.id).toBe(first.task.id)
  expect(second.task.sessionId).toBe('first')
  expect(ledger.getPriorSummaries(second.task.id, second.match.id)).toEqual([
    { summary: 'earlier', at: expect.any(String), outcome: 'not_notified' },
  ])
  store.mandates.saveSettings({ projects: [], mandates: [{ ...config, groupBy: 'mandate' }] }, 1)
  push(store, [event(6, 9), event(7, 12)])
  const [grouped] = ledger.listTasks()
  expect(grouped.businessKey).toBe('mandate')
  expect(grouped.eventCount).toBe(2)
})

test('switching to or from investigation revokes undelivered work decided under the previous mode', () => {
  const store = setup()
  const ledger = store.mandates
  let revision = 1
  for (const processing of ['investigate', 'agent'] as const) {
    push(store, [event(revision)])
    const work = ledger.claimAnalysis('session')
    if (!work) throw new Error('expected a claim')
    expect(ledger.finishAnalysis(work.match.id, 'summary', work.claimToken)).toBe(true)
    const notify = () => ledger.getMatch(work.match.id)?.effects.find((e) => e.kind === 'notify')
    expect(notify()?.status).toBe('pending')
    ledger.saveSettings({ projects: [], mandates: [{ ...config, processing }] }, revision++)
    expect(notify()?.status).toBe('revoked')
    expect(ledger.getTask(work.task.id)?.active).toBe(false)
  }
})

test('recipient identity, revocation generations and source release protect historical task details', () => {
  const store = setup()
  push(store, [event(1)])
  const ledger = store.mandates
  const [task] = ledger.listTasks()
  expect(ledger.authorizedTask(task.id, { ...receiver, operatorId: 'another' })).toBeNull()
  expect(ledger.authorizedTask(task.id, { ...receiver, operatorId: undefined })).toBeNull()
  expect(ledger.authorizedTask(task.id, { ...receiver, peerId: 'other-room' })).toBeNull()
  expect(ledger.acknowledge(task.id, receiver, 'action-1')).toBe(true)
  expect(ledger.acknowledge(task.id, receiver, 'action-1')).toBe(false)
  expect(ledger.getTask(task.id)?.acknowledgedAt).toBeTruthy()
  expect(ledger.pauseTask(task.id, receiver, 'action-2')).toBe(true)
  expect(ledger.getTask(task.id)?.matches[0]?.status).toBe('revoked')
  push(store, [event(2)])
  expect(ledger.listMatches()).toHaveLength(1)
  expect(ledger.setTaskPaused(task.id, false)).toBe(true)
  push(store, [event(3)])
  expect(ledger.getTask(task.id)?.eventCount).toBe(2)
  const newPeer = { ...receiver, operatorId: 'replacement' }
  ledger.saveSettings({ projects: [], mandates: [{ ...config, targets: [newPeer] }] }, 1)
  expect(ledger.authorizedTask(task.id, newPeer)).toBeNull()
  expect(ledger.authorizedTask(task.id, receiver)).toBeNull()
  push(store, [event(4)])
  const replacement = ledger.listTasks()[0]
  expect(replacement.id).not.toBe(task.id)
  expect(ledger.authorizedTask(replacement.id, newPeer)?.matches).toHaveLength(1)
  store.saveSettings({ ...subscriptions, github: { credentialRef: 'test', repositories: [] } }, 1)
  store.saveSettings(subscriptions, 2)
  expect(ledger.authorizedTask(replacement.id, newPeer)).toBeNull()
  expect(push(store, [event(5)], 3)).toBe(true)
  expect(ledger.listTasks()).toHaveLength(3)
})

test('config CAS, scoped authority and trusted action markers share one rollback boundary', () => {
  const store = setup()
  const ledger = store.mandates
  const configState = { projects: [], mandates: [{ ...config, urgent: true }] }
  let hook = 0
  expect(() =>
    ledger.saveSettings(configState, 0, {
      before: () => {
        hook++
      },
      after: () => {
        hook++
      },
    }),
  ).toThrow(TriggerSettingsConflictError)
  expect(hook).toBe(0)
  expect(() =>
    ledger.saveSettings(configState, 1, {
      before: () => {
        hook++
      },
      after: () => {
        throw new Error('action revoked')
      },
    }),
  ).toThrow('action revoked')
  expect(ledger.getSettings().revision).toBe(1)
  expect(ledger.getSettings().settings.mandates[0].urgent).toBe(false)
  expect(() =>
    ledger.saveSettings({ projects: [], mandates: [{ ...config, scope: 'unselected/repo' }] }, 1),
  ).toThrow('来源')
  expect(
    ledger.saveSettings(ledger.getSettings().settings, 1, {
      before: () => {
        hook++
      },
      after: () => {
        hook++
      },
    }),
  ).toBe(1)
  expect(hook).toBe(3)
})

test('removing a source permits independent config edits without granting it to new mandates', () => {
  const store = setup()
  store.saveSettings({ ...subscriptions, github: { credentialRef: 'test', repositories: [] } }, 1)
  const projects = [{ id: 'second', name: 'other', policy: {} }]
  expect(store.mandates.saveSettings({ projects, mandates: [config] }, 1)).toBe(2)
  expect(() =>
    store.mandates.saveSettings({ projects, mandates: [config, { ...config, id: 'new' }] }, 2),
  ).toThrow('来源')
  expect(
    store.mandates.saveSettings({ projects, mandates: [{ ...config, enabled: false }] }, 2),
  ).toBe(3)
  expect(() => store.mandates.saveSettings({ projects, mandates: [config] }, 3)).toThrow('来源')
})

test('shows the last accepted operator while the current follow-up is open, respecting recipient boundaries', () => {
  const mobile: MandateTarget = { platform: 'weixin', channelId: 'wx', peerId: 'private-peer' }
  const store = setup([{ ...config, targets: [receiver, mobile] }])
  const ledger = store.mandates
  push(store, [event(1)])
  const [task] = ledger.listTasks()
  expect(ledger.getTask(task.id)?.acknowledgedBy).toBeNull()
  expect(ledger.acknowledge(task.id, receiver, 'card-A')).toBe(true)
  expect(ledger.getTask(task.id)?.acknowledgedBy).toEqual(receiver)
  expect(ledger.authorizedTask(task.id, mobile)?.acknowledgedBy).toBeNull()
  expect(ledger.authorizedTask(task.id, receiver)?.acknowledgedBy).toEqual(receiver)
  expect(ledger.acknowledge(task.id, mobile, 'message-B')).toBe(true)
  const mobileActor = { ...mobile, operatorId: mobile.peerId }
  expect(ledger.getTask(task.id)?.acknowledgedBy).toEqual(mobileActor)
  expect(ledger.acknowledge(task.id, receiver, 'card-A')).toBe(false)
  expect(ledger.getTask(task.id)?.acknowledgedBy).toEqual(mobileActor)
  expect(ledger.authorizedTask(task.id, receiver)?.acknowledgedBy).toBeNull()
  push(store, [event(2)])
  expect(ledger.getTask(task.id)).toMatchObject({ acknowledgedBy: null, acknowledgedAt: null })
  expect(ledger.acknowledge(task.id, receiver, 'card-C')).toBe(true)
  ledger.saveSettings({ projects: [], mandates: [{ ...config, targets: [mobile] }] }, 1)
  expect(ledger.authorizedTask(task.id, mobile)).toBeNull()
  expect(ledger.authorizedTask(task.id, receiver)).toBeNull()
  expect(ledger.getTask(task.id)).toMatchObject({ active: false, acknowledgedBy: receiver })
  push(store, [event(3)])
  expect(ledger.getTask(ledger.listTasks()[0].id)?.acknowledgedBy).toBeNull()
})

test('old confirmations without a recorded identity keep only their timestamp', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zero-ack-test-'))
  const path = join(directory, 'inbox.sqlite')
  const store = setup([config], path)
  const raw = new Database(path)
  try {
    push(store, [event(1)])
    const [task] = store.mandates.listTasks()
    const at = '2026-02-03T04:00:00.000Z'
    raw.run('UPDATE mandate_tasks SET acknowledged_at=? WHERE id=?', [at, task.id])
    for (const actor of [null, '{}', '[1,2,3,4]', 'broken']) {
      if (actor) raw.run("INSERT INTO mandate_actions VALUES(?,?,'old','ack')", [task.id, actor])
      expect(store.mandates.getTask(task.id)).toMatchObject({
        acknowledgedAt: at,
        acknowledgedBy: null,
      })
    }
    expect(store.mandates.acknowledge(task.id, receiver, 'real-card')).toBe(true)
    expect(store.mandates.getTask(task.id)?.acknowledgedBy).toEqual(receiver)
  } finally {
    raw.close()
    stores.splice(stores.indexOf(store), 1)
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
