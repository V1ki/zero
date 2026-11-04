import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerEvent, TriggerSettings } from '@zero-os/shared'
import { TriggerSettingsConflictError, TriggerStore } from '../trigger-store'

const settings: TriggerSettings = {
  github: {
    credentialRef: '',
    repositories: [
      {
        name: 'Example/App',
        enabled: true,
        branch: 'main',
        workflow: '',
        workflowFailures: true,
        mention: '',
      },
    ],
  },
  wxarc: { sessions: [{ id: 'room', name: 'Test room', keyword: 'release', enabled: true }] },
}
const event: TriggerEvent = {
  eventId: 'run-1-attempt-1',
  scope: 'Example/App',
  title: 'Run failed',
  summary: 'Test fixture',
  occurredAt: '2025-01-01T00:00:00.000Z',
}
const batch = {
  source: 'github' as const,
  stream: 'github:example/app',
  revision: 1,
  previousCursor: null,
  cursor: 'first',
  events: [event],
}
const stores: TriggerStore[] = []
const dirs: string[] = []
function open(path = ':memory:'): TriggerStore {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('atomic batch persists matches and cursor across readers and restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-trigger-test-'))
  dirs.push(dir)
  const path = join(dir, 'private', 'triggers.db')
  const writer = open(path)
  const stale = open(path)
  expect(writer.saveSettings(settings, 0)).toBe(1)
  expect(() => stale.saveSettings(settings, 0)).toThrow(TriggerSettingsConflictError)
  expect(writer.commitBatch(batch)).toBe(true)
  expect(stale.commitBatch({ ...batch, cursor: 'stale' })).toBe(false)
  expect(stale.readCursor(batch.stream)).toBe('first')
  expect(
    stale.commitBatch({
      ...batch,
      previousCursor: 'first',
      cursor: 'second',
      events: [event, { ...event, eventId: 'next' }],
    }),
  ).toBe(true)
  for (const store of stores.splice(0)) store.close()

  const reopened = open(path)
  expect(reopened.getSettings()).toEqual({ revision: 1, settings })
  expect(reopened.readCursor(batch.stream)).toBe('second')
  const [latest] = reopened.listInbox(1)
  expect(latest.eventId).toBe('next')
  expect(reopened.listInbox(5, latest.id).map((item) => item.eventId)).toEqual([event.eventId])
  expect(statSync(path).mode & 0o077).toBe(0)
})

test('failed scope check rolls back all inserts and the cursor', () => {
  const store = open()
  store.saveSettings(settings, 0)
  expect(() =>
    store.commitBatch({
      ...batch,
      events: [event, { ...event, scope: 'other/repo' }],
    }),
  ).toThrow('scope')
  expect(store.readCursor(batch.stream)).toBeNull()
  expect(store.listInbox()).toEqual([])
})

test('discard revoked polls and rebaseline only the selections whose filters changed', () => {
  const store = open()
  const start = Date.now()
  store.saveSettings(settings, 0, 24)
  const githubStart = store.getStreamStartedAt(batch.stream)
  const wxStart = store.getStreamStartedAt('wxarc:room')
  expect(Date.parse(githubStart ?? '')).toBeGreaterThanOrEqual(start - 24 * 3_600_000)
  expect(Date.parse(githubStart ?? '')).toBeLessThanOrEqual(Date.now() - 24 * 3_600_000)
  expect(Date.parse(wxStart ?? '')).toBeGreaterThanOrEqual(start)
  expect(store.commitBatch(batch)).toBe(true)
  expect(
    store.commitBatch({
      source: 'wxarc',
      stream: 'wxarc:room',
      revision: 1,
      previousCursor: null,
      cursor: '45',
      events: [],
    }),
  ).toBe(true)

  const update = structuredClone(settings)
  update.wxarc.sessions[0].name = 'Renamed'
  store.saveSettings(update, 1, 1)
  expect(store.readCursor('wxarc:room')).toBe('45')
  expect(store.readCursor(batch.stream)).toBe('first')
  expect(store.getStreamStartedAt(batch.stream)).toBe(githubStart)

  update.github.repositories[0].branch = 'stable'
  store.saveSettings(update, 2, 1)
  expect(store.readCursor(batch.stream)).toBeNull()
  expect(Date.parse(store.getStreamStartedAt(batch.stream) ?? '')).toBeGreaterThanOrEqual(
    start - 3_600_000,
  )
  expect(store.readCursor('wxarc:room')).toBe('45')
  expect(store.getStreamStartedAt('wxarc:room')).toBe(wxStart)
  expect(store.commitBatch({ ...batch, revision: 2 })).toBe(false)

  update.wxarc.sessions[0].enabled = false
  store.saveSettings(update, 3)
  expect(store.getStreamStartedAt('wxarc:room')).toBeNull()
  expect(
    store.commitBatch({
      source: 'wxarc',
      stream: 'wxarc:room',
      revision: 4,
      previousCursor: null,
      cursor: '46',
      events: [],
    }),
  ).toBe(false)
  update.wxarc.sessions[0].enabled = true
  expect(store.saveSettings(update, 4)).toBe(5)
  expect(store.readCursor('wxarc:room')).toBeNull()
  expect(store.saveSettings(update, 5, 24)).toBe(5)
})

test('optional mandate revision blocks source cleanup racing another connection attaching a mandate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-trigger-source-cas-'))
  dirs.push(dir)
  const first = open(join(dir, 'test.db'))
  const other = open(join(dir, 'test.db'))
  first.saveSettings(settings, 0)
  const originalSource = first.getSettings()
  const originalMandate = first.mandates.getSettings()
  other.mandates.saveSettings(
    {
      projects: [],
      mandates: [
        {
          id: 'concurrent-reader',
          name: 'Concurrent reader',
          purpose: 'Observe release',
          enabled: true,
          source: 'github',
          scope: 'Example/App',
          keyword: '',
          projectId: null,
          targets: [],
          archive: null,
          policy: {},
          deadline: null,
          urgent: false,
        },
      ],
    },
    originalMandate.revision,
  )
  const removed = { ...settings, github: { ...settings.github, repositories: [] } }
  expect(() =>
    first.saveSettings(removed, originalSource.revision, undefined, originalMandate.revision),
  ).toThrow(TriggerSettingsConflictError)
  expect(first.getSettings()).toEqual(originalSource)
  expect(first.getStreamStartedAt('github:example/app')).not.toBeNull()
  expect(first.mandates.getSettings().settings.mandates[0].id).toBe('concurrent-reader')
  // Even a no-op guarded request must reject a stale precondition.
  expect(() =>
    first.saveSettings(settings, originalSource.revision, undefined, originalMandate.revision),
  ).toThrow(TriggerSettingsConflictError)
  expect(
    first.saveSettings(
      removed,
      originalSource.revision,
      undefined,
      other.mandates.getSettings().revision,
    ),
  ).toBe(originalSource.revision + 1)
  // Existing callers remain valid when they omit the cross-resource precondition.
  expect(first.saveSettings(settings, originalSource.revision + 1)).toBe(
    originalSource.revision + 2,
  )
})
