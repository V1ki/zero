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
    proposal: { key: 'duringWork', value: 'defer' },
    proposalRevision: 5,
  }
  expect(() =>
    writer.conversations.finish(first, requestId, started.attempt, {
      ...answer,
      proposalAppliedAt: '2026-01-01T12:00:00.000Z',
    }),
  ).toThrow('cannot confirm')
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

test('confirming a preference atomically commits its configuration, source turn and receipt', () => {
  const path = temporaryPath()
  const store = open(path)
  const reader = open(path)
  const [event] = receiveEvents(store)
  const turnId = crypto.randomUUID()
  const actionId = crypto.randomUUID()
  const at = '2026-10-30T14:00:00.000Z'
  const original = store.routing.getSettings()
  const answer: TriggerConversationAnswer = {
    text: '设置为离开？',
    proposal: { key: 'presence', value: 'away' },
    proposalRevision: original.revision,
  }
  const turn = store.conversations.begin('general', turnId, '设置为离开')
  if (turn.kind !== 'started') throw new Error('Could not create the proposal turn')
  store.conversations.finish('general', turnId, turn.attempt, answer)
  const confirm = () => {
    store.routing.saveSettings({ ...original.settings, presence: 'away' }, original.revision)
    store.conversations.markProposalApplied('general', turnId, at)
  }
  expect(() =>
    store.conversations.applyActionOnce('general', actionId, turnId, () => {
      confirm()
      throw new Error('Abort after marking the proposal')
    }),
  ).toThrow('Abort after marking the proposal')
  expect(reader.routing.getSettings()).toEqual(original)
  expect(reader.conversations.get('general', turnId)?.answer).toEqual(answer)
  expect(reader.conversations.getActionIdentity('general', actionId)).toBeNull()
  expect(store.conversations.applyActionOnce('general', actionId, turnId, confirm)).toBe('applied')
  expect(reader.routing.getSettings()).toMatchObject({
    revision: original.revision + 1,
    settings: { presence: 'away' },
  })
  expect(reader.conversations.get('general', turnId)?.answer).toEqual({
    ...answer,
    proposalAppliedAt: at,
  })
  expect(reader.conversations.applyActionOnce('general', actionId, turnId, confirm)).toBe(
    'existing',
  )
  expect(() => reader.conversations.markProposalApplied('general', turnId, at)).toThrow()
  expect(() => reader.conversations.markProposalApplied(event, turnId, at)).toThrow()
})

test('missing, pending, failed and plain-text turns cannot confirm preference changes', () => {
  const store = open()
  const id = crypto.randomUUID()
  const plainId = crypto.randomUUID()
  const original = store.routing.getSettings()
  const at = '2026-10-30T14:00:00.000Z'
  const verifyRejected = (turnId: string) => {
    const actionId = crypto.randomUUID()
    expect(() =>
      store.conversations.applyActionOnce('general', actionId, turnId, () => {
        store.routing.saveSettings({ ...original.settings, presence: 'away' }, original.revision)
        store.conversations.markProposalApplied('general', turnId, at)
      }),
    ).toThrow()
    expect(store.routing.getSettings()).toEqual(original)
    expect(store.conversations.getActionIdentity('general', actionId)).toBeNull()
  }
  verifyRejected(id)
  const pending = store.conversations.begin('general', id, 'Question')
  if (pending.kind !== 'started') throw new Error('Could not create the pending turn')
  verifyRejected(id)
  store.conversations.fail('general', id, pending.attempt, 'Model unavailable')
  verifyRejected(id)
  const plain = store.conversations.begin('general', plainId, 'Another question')
  if (plain.kind !== 'started') throw new Error('Could not create the plain-text turn')
  store.conversations.finish('general', plainId, plain.attempt, { text: 'A reply' })
  verifyRejected(plainId)
})

const reminder = {
  platform: 'weixin',
  channelId: 'bot',
  botLabel: '我的机器人',
  text: '回家前带上钥匙。',
  audienceKey: 'opaque-key',
  status: 'draft',
} as const

test('an IM reminder can consume only a draft from its own private Router conversation', () => {
  const path = temporaryPath()
  const store = open(path)
  const c = store.conversations
  const first = `im-${'a'.repeat(64)}` as const
  const second = `im-${'b'.repeat(64)}` as const
  for (const invalid of ['im-', `im-${'A'.repeat(64)}`, `im-${'a'.repeat(63)}`] as const)
    expect(() => c.list(invalid)).toThrow()

  function draft(scope: typeof first | 'general', text: string) {
    const turn = c.begin(scope, 'same-message', text)
    if (turn.kind !== 'started') throw Error('Expected an independent draft turn')
    expect(c.finish(scope, 'same-message', turn.attempt, { text, reminder })).toBe(true)
    expect(c.begin(scope, 'same-message', text).kind).toBe('existing')
    return turn.turn.id
  }
  const webDraft = draft('general', 'web only')
  const otherDraft = draft(second, 'second only')
  const myDraft = draft(first, 'first only')
  expect(c.list(first).map((t) => t.question)).toEqual(['first only'])
  expect(c.list(second).map((t) => t.question)).toEqual(['second only'])

  const sending = c.begin(first, 'confirm', '发刚才的草稿')
  if (sending.kind !== 'started') throw Error('Expected a confirmation turn')
  for (const foreign of [webDraft, otherDraft])
    expect(c.reserveToolReminder(first, 'confirm', sending.attempt, reminder, foreign)).toBe(false)
  expect(c.reserveToolReminder(first, 'confirm', sending.attempt, reminder, myDraft)).toBe(true)
  expect(c.finishReminder(second, 'confirm', { status: 'accepted' })).toBe(false)
  close(store)
  const recovered = open(path).conversations
  recovered.recoverInterrupted()
  for (const id of ['same-message', 'confirm']) {
    expect(recovered.get(first, id)).toMatchObject({
      status: 'completed',
      answer: { reminder: { status: 'unknown' } },
    })
    expect(recovered.get(first, id)?.answer?.reminder).not.toHaveProperty('audienceKey')
  }
  expect(recovered.begin(first, 'confirm', '发刚才的草稿', true).kind).toBe('existing')
  for (const scope of ['general', second] as const)
    expect(recovered.get(scope, 'same-message')?.answer?.reminder).toEqual(reminder)
})

test('one reminder draft authorizes one send and one final receipt across store instances', () => {
  const path = temporaryPath()
  const store = open(path)
  const other = open(path)
  for (const status of ['accepted', 'rejected', 'unknown'] as const) {
    const id = crypto.randomUUID()
    const started = store.conversations.begin('general', id, '发一条通知')
    if (started.kind !== 'started') throw Error('Expected a new reminder turn')
    expect(() =>
      store.conversations.finish('general', id, started.attempt, {
        text: 'fake receipt',
        reminder: { ...reminder, status },
      }),
    ).toThrow('unsent draft')
    expect(store.conversations.claimReminder('general', id)).toBe(false)
    expect(
      store.conversations.finish('general', id, started.attempt, { text: '草稿', reminder }),
    ).toBe(true)
    expect(store.conversations.claimReminder(1, id)).toBe(false)
    expect(store.conversations.finishReminder('general', id, { status })).toBe(false)
    expect(store.conversations.claimReminder('general', id)).toBe(true)
    expect(other.conversations.claimReminder('general', id)).toBe(false)
    expect(other.conversations.get('general', id)?.answer?.reminder?.status).toBe('sending')
    if (status === 'unknown') {
      other.conversations.recoverInterrupted()
      expect(store.conversations.finishReminder('general', id, { status: 'accepted' })).toBe(false)
    } else {
      expect(other.conversations.finishReminder('general', id, { status })).toBe(true)
    }
    expect(store.conversations.claimReminder('general', id)).toBe(false)
    expect(store.conversations.finishReminder('general', id, { status: 'unknown' })).toBe(false)
    expect(store.conversations.begin('general', id, '发一条通知', true).kind).toBe('existing')
    const { audienceKey: _private, ...publicReminder } = reminder
    expect(store.conversations.get('general', id)?.answer?.reminder).toMatchObject({
      ...publicReminder,
      status,
    })
    expect(store.conversations.get('general', id)?.answer?.reminder).not.toHaveProperty(
      'audienceKey',
    )
  }
})

test('a model tool reserves at most one reminder on its current general turn and cannot overwrite the receipt', () => {
  const path = temporaryPath()
  const store = open(path).conversations
  const other = open(path).conversations
  const turn = store.begin('general', 'send', '请发通知')
  if (turn.kind !== 'started') throw Error('Expected current model turn')
  expect(store.reserveToolReminder(1, 'send', turn.attempt, reminder)).toBe(false)
  expect(store.reserveToolReminder('general', 'send', turn.attempt + 1, reminder)).toBe(false)
  expect(store.reserveToolReminder('general', 'send', turn.attempt, reminder)).toBe(true)
  expect(other.get('general', 'send')).toMatchObject({
    status: 'pending',
    answer: { reminder: { status: 'sending' } },
  })
  expect(
    other.reserveToolReminder('general', 'send', turn.attempt, { ...reminder, text: '重复调用' }),
  ).toBe(false)
  expect(store.finishReminder('general', 'send', { status: 'rejected', reason: '平台拒绝' })).toBe(
    true,
  )
  expect(
    store.finish('general', 'send', turn.attempt, {
      text: '已经解释',
      reminder: { ...reminder, text: 'model forged', status: 'accepted' },
    }),
  ).toBe(true)
  expect(other.get('general', 'send')).toMatchObject({
    status: 'completed',
    answer: {
      text: '已经解释',
      reminder: { status: 'rejected', text: reminder.text, reason: '平台拒绝' },
    },
  })
  expect(other.get('general', 'send')?.answer?.reminder).not.toHaveProperty('audienceKey')
})

test('a spoken confirmation consumes the exact historical draft and seals both receipts even if the model fails or restarts', () => {
  const path = temporaryPath()
  const c = open(path).conversations
  const other = open(path).conversations
  for (const outcome of ['accepted', 'fail', 'restart'] as const) {
    const source = c.begin('general', `draft-${outcome}`, '暂存提醒。')
    if (source.kind !== 'started') throw Error('Expected draft turn')
    c.finish('general', source.turn.requestId, source.attempt, { text: '请确认', reminder })
    const current = c.begin('general', outcome, '发刚才那条')
    if (current.kind !== 'started') throw Error('Expected confirmation turn')
    const reserve = (which: typeof c, draft: NonNullable<TriggerConversationAnswer['reminder']>) =>
      which.reserveToolReminder('general', outcome, current.attempt, draft, source.turn.id)
    expect(reserve(c, { ...reminder, text: '改正文' })).toBe(false)
    expect(reserve(c, { ...reminder, audienceKey: 'other' })).toBe(false)
    expect(c.get('general', outcome)?.answer).toBeNull()
    expect(reserve(c, reminder)).toBe(true)
    expect(reserve(other, reminder)).toBe(false)
    expect(other.claimReminder('general', source.turn.requestId)).toBe(false)
    expect(other.finishReminder('general', source.turn.requestId, { status: 'accepted' })).toBe(
      false,
    )
    expect(c.fail('general', outcome, current.attempt - 1, 'late stale model')).toBe(false)
    if (outcome === 'accepted') {
      expect(c.finishReminder('general', outcome, { status: 'accepted' })).toBe(true)
      other.recoverInterrupted()
    } else if (outcome === 'fail') {
      expect(c.fail('general', outcome, current.attempt, 'model died')).toBe(true)
    } else {
      other.recoverInterrupted()
    }
    const status = outcome === 'accepted' ? 'accepted' : 'unknown'
    for (const requestId of [source.turn.requestId, outcome]) {
      expect(other.get('general', requestId)).toMatchObject({
        status: 'completed',
        answer: { reminder: { status, text: reminder.text } },
      })
      expect(other.get('general', requestId)?.answer?.reminder).not.toHaveProperty('audienceKey')
      expect(other.claimReminder('general', requestId)).toBe(false)
    }
    expect(other.begin('general', outcome, '发刚才那条', true).kind).toBe('existing')
    expect(c.finishReminder('general', outcome, { status: 'rejected' })).toBe(false)
  }
})

test('a historical plain answer gets one prepared reminder without overwriting a competing draft', () => {
  const path = temporaryPath()
  const store = open(path)
  const reader = open(path)
  const draft = {
    platform: 'weixin',
    channelId: 'bot',
    botLabel: '我的机器人',
    text: '提醒我带钥匙',
    audienceKey: 'opaque-key',
    status: 'draft',
  } as const
  for (const answer of [
    { text: '旧版本未发送。' },
    {
      text: '修改偏好',
      proposal: { key: 'presence', value: 'away' },
    },
  ] satisfies TriggerConversationAnswer[]) {
    const id = crypto.randomUUID()
    const c = store.conversations
    const turn = c.begin('general', id, '发送微信通知，提醒我带钥匙')
    if (turn.kind !== 'started') throw Error('Expected a new turn')
    expect(c.attachReminder('general', id, draft)).toBe(false)
    expect(c.finish('general', id, turn.attempt, answer)).toBe(true)
    expect(c.attachReminder('general', id, { ...draft, audienceKey: undefined })).toBe(false)
    expect(c.attachReminder('general', id, { ...draft, status: 'accepted' })).toBe(false)
    expect(c.attachReminder(1, id, draft)).toBe(false)
    const otherAudience = `im-${'c'.repeat(64)}` as const
    expect(c.attachReminder(otherAudience, id, draft)).toBe(false)
    expect(c.attachReminder('general', id, draft)).toBe(!answer.proposal)
    expect(c.claimReminder(otherAudience, id)).toBe(false)
    expect(
      reader.conversations.attachReminder('general', id, { ...draft, text: '另一条提醒' }),
    ).toBe(false)
    expect(reader.conversations.get('general', id)?.answer).toEqual(
      answer.proposal ? answer : { ...answer, reminder: draft },
    )
  }
})
