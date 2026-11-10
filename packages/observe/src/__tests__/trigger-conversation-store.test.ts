import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TriggerConversationAnswer } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const stores = new Set<TriggerStore>()
const directories: string[] = []

function open(path = ':memory:') {
  const store = new TriggerStore(path)
  stores.add(store)
  return store
}

function close(store: TriggerStore) {
  store.close()
  stores.delete(store)
}

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), 'zero-router-conversation-'))
  directories.push(directory)
  return join(directory, 'inbox.sqlite')
}

afterEach(() => {
  for (const store of stores) close(store)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function receiveEvents(store: TriggerStore) {
  const revision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: 'room', name: 'Test room', enabled: true, keyword: '' }] },
    },
    0,
  )
  const events = ['first', 'second'].map((eventId) => ({
    eventId,
    scope: 'room',
    title: `Event ${eventId}`,
    summary: 'Fixture excerpt',
    occurredAt: '2026-01-01T12:00:00Z',
  }))
  expect(
    store.commitBatch({
      source: 'wxarc',
      stream: 'wxarc:room',
      revision,
      previousCursor: null,
      cursor: '2',
      events,
    }),
  ).toBe(true)
  return store.listInbox().map((event) => event.id)
}

test('turns are isolated by event or general workspace and responses are idempotent across connections', () => {
  const path = temporaryPath()
  const writer = open(path)
  const reader = open(path)
  const [second, first] = receiveEvents(writer)
  const requestId = crypto.randomUUID()
  const question = 'What happened?'
  const started = writer.conversations.begin(first, requestId, question)
  expect(started.kind).toBe('started')
  if (started.kind !== 'started') throw new Error('Expected to claim the turn')
  expect(reader.conversations.begin(first, requestId, question).kind).toBe('existing')
  expect(reader.conversations.begin(first, requestId, 'Different question').kind).toBe('conflict')
  expect(reader.conversations.begin(first, crypto.randomUUID(), question).kind).toBe('busy')
  expect(reader.conversations.begin('general', requestId, 'General question').kind).toBe('started')
  expect(reader.conversations.list(second)).toEqual([])

  const answer: TriggerConversationAnswer = {
    text: 'See the matching rule.',
    intent: 'route',
    points: ['Rule A'],
  }
  expect(writer.conversations.finish(first, requestId, started.attempt, answer)).toBe(true)
  expect(writer.conversations.finish(first, requestId, started.attempt, { text: 'changed' })).toBe(
    false,
  )
  const replay = reader.conversations.begin(first, requestId, question, true)
  expect(replay.kind).toBe('existing')
  const saved = reader.conversations.get(first, requestId)
  if (!saved) throw new Error('Expected the persisted reply')
  expect(reader.conversations.list(first)).toEqual([saved])
  expect(saved).toMatchObject({ answer, status: 'completed' })
  expect(reader.conversations.get('general', requestId)).toMatchObject({
    question: 'General question',
    status: 'pending',
    answer: null,
  })
})

test('recovery requires an explicit retry and ignores stale results from an interrupted attempt', () => {
  const path = temporaryPath()
  const first = open(path)
  const requestId = crypto.randomUUID()
  const claim = first.conversations.begin('general', requestId, 'Explain')
  if (claim.kind !== 'started') throw new Error('Expected the first claim')
  close(first)

  const restarted = open(path)
  restarted.conversations.recoverInterrupted()
  expect(restarted.conversations.get('general', requestId)?.status).toBe('failed')
  expect(restarted.conversations.begin('general', requestId, 'Explain').kind).toBe('existing')
  const retry = restarted.conversations.begin('general', requestId, 'Explain', true)
  if (retry.kind !== 'started') throw new Error('Expected explicit retry to claim the turn')
  expect(retry.attempt).toBeGreaterThan(claim.attempt)
  expect(restarted.conversations.fail('general', requestId, claim.attempt, 'late error')).toBe(
    false,
  )
  expect(
    restarted.conversations.finish('general', requestId, claim.attempt, { text: 'late' }),
  ).toBe(false)
  expect(
    restarted.conversations.fail('general', requestId, retry.attempt, 'Model unavailable'),
  ).toBe(true)
  const failed = restarted.conversations.list('general')
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({
    requestId,
    status: 'failed',
    error: 'Model unavailable',
    answer: null,
  })
})

test('history uses exclusive cursors and chronological display order; event lists omit the excerpt', () => {
  const store = open()
  const [newer, older] = receiveEvents(store)
  expect(store.getInboxItem(older)?.eventId).toBe('first')
  expect(store.getInboxItem(Number.MAX_SAFE_INTEGER)).toBeNull()
  store.routing.enqueue(newer)
  const workspace = store.listWorkspaceEvents(1)
  expect(workspace[0]).toMatchObject({
    id: newer,
    title: 'Event second',
    source: 'wxarc',
    status: 'pending',
  })
  expect(workspace[0]).not.toHaveProperty('summary')
  expect(store.listWorkspaceEvents(1, newer)[0]).toMatchObject({ id: older, status: null })
  for (const question of ['one', 'two', 'three']) {
    const id = crypto.randomUUID()
    const claim = store.conversations.begin(older, id, question)
    if (claim.kind !== 'started') throw new Error('Expected a claim')
    store.conversations.finish(older, id, claim.attempt, { text: question })
  }
  const latest = store.conversations.list(older, 2)
  expect(latest.map(({ question }) => question)).toEqual(['two', 'three'])
  expect(store.conversations.list(older, 2, latest[0].id).map(({ question }) => question)).toEqual([
    'one',
  ])
  expect(store.conversations.list('general')).toEqual([])
})

test('named actions commit once with their effect and reject collisions with messages or other actions', () => {
  const path = temporaryPath()
  const store = open(path)
  const other = open(path)
  const [scope] = receiveEvents(store)
  const id = crypto.randomUUID()
  let calls = 0
  const dispatch = () => {
    calls++
    store.routing.enqueue(scope)
  }
  expect(() =>
    store.conversations.applyActionOnce(scope, id, 'process_event', () => {
      dispatch()
      throw new Error('Abort action')
    }),
  ).toThrow('Abort action')
  expect(store.routing.get(scope)).toBeNull()
  expect(store.conversations.applyActionOnce(scope, id, 'process_event', dispatch)).toBe('applied')
  expect(other.conversations.getActionIdentity(scope, id)).toBe('process_event')
  expect(other.conversations.getActionIdentity('general', id)).toBeNull()
  expect(other.conversations.applyActionOnce(scope, id, 'process_event', dispatch)).toBe('existing')
  expect(other.conversations.applyActionOnce(scope, id, 'explain_route', dispatch)).toBe('conflict')
  expect(other.conversations.begin(scope, id, 'message').kind).toBe('conflict')
  const messageId = crypto.randomUUID()
  expect(other.conversations.begin(scope, messageId, 'message').kind).toBe('started')
  expect(store.conversations.applyActionOnce(scope, messageId, 'process_event', dispatch)).toBe(
    'conflict',
  )
  expect(calls).toBe(2)
})

test('IM threads are private per audience and reject malformed scopes', () => {
  const c = open().conversations
  const first = `im-${'a'.repeat(64)}` as const
  const second = `im-${'b'.repeat(64)}` as const
  for (const invalid of ['im-', `im-${'A'.repeat(64)}`, `im-${'a'.repeat(63)}`] as const)
    expect(() => c.list(invalid)).toThrow()
  for (const [scope, text] of [
    ['general', 'web only'],
    [second, 'second only'],
    [first, 'first only'],
  ] as const) {
    const turn = c.begin(scope, 'same-message', text)
    if (turn.kind !== 'started') throw Error('Expected an independent turn')
    expect(c.finish(scope, 'same-message', turn.attempt, { text })).toBe(true)
  }
  expect(c.list(first).map((t) => t.question)).toEqual(['first only'])
  expect(c.list(second).map((t) => t.question)).toEqual(['second only'])
  expect(c.list('general').map((t) => t.question)).toEqual(['web only'])
})

test('answers stored by removed Router chat features stay readable and recover like plain turns', () => {
  const path = temporaryPath()
  const store = open(path)
  const sql = new Database(path)
  const legacy = {
    text: '请查看机器人的发送回执。',
    reminder: { platform: 'weixin', channelId: 'bot', audienceKey: 'opaque', status: 'sending' },
    proposal: { key: 'presence', value: 'away' },
  }
  for (const [id, status] of [
    ['done', 'completed'],
    ['interrupted', 'pending'],
  ] as const)
    sql.run(
      `INSERT INTO trigger_conversation_turns(thread,request_id,question,answer,status,attempt,created_at,updated_at)
       VALUES('0',?,?,?,?,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      [id, '发微信', JSON.stringify(legacy), status],
    )
  sql.close()
  store.conversations.recoverInterrupted()
  expect(store.conversations.get('general', 'done')).toMatchObject({ status: 'completed' })
  expect(store.conversations.get('general', 'interrupted')).toMatchObject({
    status: 'failed',
    error: '服务重启中断了这次回答，可重试此轮对话。',
  })
  const retry = store.conversations.begin('general', 'interrupted', '发微信', true)
  expect(retry.kind).toBe('started')
})
