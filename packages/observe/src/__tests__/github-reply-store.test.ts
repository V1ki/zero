import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '../trigger-store'

function seed(store: TriggerStore) {
  store.saveSettings(
    {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: 'Example/App',
            branch: 'main',
            enabled: true,
            workflowFailures: false,
            workflow: '',
            mention: '',
          },
        ],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  store.commitPush({
    source: 'github',
    stream: 'github:example/app',
    revision: 1,
    events: [
      {
        eventId: 'fixture',
        scope: 'Example/App',
        title: 'Test issue',
        summary: 'Synthetic',
        occurredAt: new Date().toISOString(),
      },
    ],
  })
  const event = store.listInbox()[0]
  if (!event) throw new Error('Missing inbox fixture')
  return event.id
}

const fingerprint = 'a'.repeat(64)
const other = 'b'.repeat(64)
const receipt = {
  state: 'sent' as const,
  id: 123,
  author: 'fixture[bot]',
  url: 'https://github.com/Example/App/issues/1#issuecomment-123',
}

test('restart, fresh browser IDs and a second connection never claim an already submitted public reply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-github-reply-'))
  const path = join(dir, 'fixture.sqlite')
  const first = new TriggerStore(path)
  let second: TriggerStore | undefined
  try {
    const id = seed(first)
    expect(first.githubReplies.claim(id, 'one', fingerprint)).toEqual({ state: 'new' })
    second = new TriggerStore(path)
    expect(second.githubReplies.claim(id, 'two', fingerprint)).toEqual({ state: 'pending' })
    expect(second.githubReplies.claim(id, 'two', other)).toEqual({ state: 'conflict' })
    expect(() => second?.githubReplies.finish(id, 'two', receipt)).toThrow()
    first.githubReplies.finish(id, 'one', receipt)
    expect(second.githubReplies.claim(id, 'two', fingerprint)).toEqual(receipt)
    expect(second.githubReplies.claim(id, 'after-reload', fingerprint)).toEqual(receipt)
    expect(second.githubReplies.claim(id, 'three', other)).toEqual({ state: 'new' })
    second.githubReplies.finish(id, 'three', { state: 'unknown' })
    expect(first.githubReplies.claim(id, 'after-timeout', other)).toEqual({ state: 'unknown' })
    expect(() => first.githubReplies.finish(id, 'three', receipt)).toThrow()
  } finally {
    first.close()
    second?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only a fresh request may retry a definitive rejection, and a retired event cannot claim again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-github-reply-'))
  const path = join(dir, 'fixture.sqlite')
  const store = new TriggerStore(path)
  const sql = new Database(path)
  try {
    const id = seed(store)
    expect(store.githubReplies.claim(id, 'one', fingerprint)).toEqual({ state: 'new' })
    const rejected = { state: 'rejected' as const, error: 'No write permission' }
    store.githubReplies.finish(id, 'one', rejected)
    expect(store.githubReplies.claim(id, 'one', fingerprint)).toEqual(rejected)
    expect(store.githubReplies.claim(id, 'two', fingerprint)).toEqual({ state: 'new' })
    const route = store.routing.getSettings()
    store.routing.saveSettings(
      { ...route.settings, enabled: true, retentionDays: 7 },
      route.revision,
    )
    store.routing.enqueue(id)
    expect(store.routing.claimAgent(id, 'test-session')).toBe(true)
    store.routing.finishAgent(id, 'test-session', { summary: 'done' })
    store.routing.applyDecision(
      id,
      { destination: 'web', reason: 'test' },
      store.routing.getSettings().revision,
      new Date().toISOString(),
    )
    store.githubReplies.finish(id, 'two', receipt)
    expect(store.retention.sweep(new Date(Date.now() + 9 * 86_400_000)).events).toBe(1)
    expect(sql.query('SELECT * FROM router_github_replies').all()).toHaveLength(0)
    expect(sql.query('SELECT * FROM router_github_reply_requests').all()).toHaveLength(0)
    expect(store.githubReplies.claim(id, 'new', fingerprint)).toEqual({ state: 'conflict' })
  } finally {
    sql.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
