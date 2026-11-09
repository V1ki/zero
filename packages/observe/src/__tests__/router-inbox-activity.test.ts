import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TriggerEvent, routerEventActivityLabel } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const stores: TriggerStore[] = []
const dirs: string[] = []
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Expected a persisted record')
  return value
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(path = ':memory:') {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}
function setup(path?: string) {
  const store = open(path)
  store.useAgentIntake()
  store.saveSettings(
    {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: 'owner/repo',
            enabled: true,
            branch: '',
            workflow: '',
            mention: 'owner',
            workflowFailures: false,
          },
        ],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  return store
}
function comment(id: number, own = false): TriggerEvent {
  return {
    eventId: `42:comment:${id}`,
    scope: 'owner/repo',
    title: 'Issue #202 · 新评论',
    summary: own ? 'app[bot]：已发布结论' : 'owner：请继续核对展示方案',
    occurredAt: new Date().toISOString(),
    url: `https://github.com/owner/repo/issues/202#issuecomment-${id}`,
    ...(own && { githubOwnComment: true }),
  }
}
function push(store: TriggerStore, events: TriggerEvent[]) {
  store.commitPush({ source: 'github', stream: 'github:owner/repo', revision: 1, events })
}

test('verified own comments survive restart, stay available by link, and filtering happens before pagination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-inbox-'))
  dirs.push(dir)
  const path = join(dir, 'inbox.sqlite')
  const store = setup(path)
  push(store, [comment(1), comment(2, true), comment(3, true), comment(4)])
  const restarted = open(path)
  expect(restarted.getInboxItem(2)?.githubOwnComment).toBe(true)
  expect(restarted.listInbox().find((e) => e.id === 3)?.githubOwnComment).toBe(true)
  expect(restarted.getInboxItem(4)?.githubOwnComment).toBeUndefined()
  expect(restarted.listWorkspaceEvents(2, undefined, false).map((e) => e.id)).toEqual([4, 1])
  expect(restarted.listWorkspaceEvents(1, 4, false).map((e) => e.id)).toEqual([1])
  expect(
    restarted
      .listWorkspaceEvents()
      .filter((e) => e.githubOwnComment)
      .map((e) => e.id),
  ).toEqual([3, 2])
  // Both inputs remain evidence for the Router; the filter never consumes or drops signals.
  expect(restarted.ledger.listSignals('router-owner')).toHaveLength(4)
  push(restarted, [{ ...comment(1), githubOwnComment: true }])
  expect(restarted.getInboxItem(1)?.githubOwnComment).toBe(true)
  expect(restarted.ledger.listSignals('router-owner')).toHaveLength(4)
})

test('legacy own-comment migration uses sent receipts and does not guess from bot-looking text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-inbox-migration-'))
  dirs.push(dir)
  const path = join(dir, 'inbox.sqlite')
  const store = setup(path)
  push(store, [comment(1), { ...comment(2), summary: 'app[bot]：looks similar' }])
  expect(store.githubReplies.claim(1, 'reply', 'a'.repeat(64))).toEqual({ state: 'new' })
  store.githubReplies.finish(1, 'reply', {
    state: 'sent',
    id: 3,
    url: required(comment(3).url),
    author: 'app[bot]',
  })
  push(store, [comment(3)])
  const db = new Database(path)
  db.exec('ALTER TABLE trigger_inbox DROP COLUMN github_own_comment')
  db.close()
  const migrated = open(path)
  expect(migrated.getInboxItem(3)?.githubOwnComment).toBe(true)
  expect(migrated.getInboxItem(2)?.githubOwnComment).toBeUndefined()
  expect(open(path).getInboxItem(3)?.githubOwnComment).toBe(true)
})

test('event progress follows Router signals and the actual Worker attempt instead of a stale pending notification', () => {
  const store = setup()
  push(store, [comment(1)])
  store.routing.enqueue(1)
  const signal = required(store.ledger.claimSignal())
  expect(store.getEventActivity(1)?.state).toBe('running')
  const job = store.jobs.submit('general', 'work', { executor: 'codex', instruction: '核对新评论' })
  const turn = store.conversations.begin(1, 'reply', '收到新评论')
  if (turn.kind !== 'started') throw Error('expected a new turn')
  store.conversations.finish(1, 'reply', turn.attempt, {
    text: '交给原 Worker',
    job: { id: job.id, attempt: job.attempt, executor: job.executor, status: job.status },
  })
  store.ledger.finishSignal(signal.id, 'completed')
  store.jobs.claimNext()
  expect(store.listWorkspaceEvents()[0]).toMatchObject({
    status: 'pending',
    activity: { state: 'completed', worker: { id: job.id, status: 'running' } },
  })
  expect(routerEventActivityLabel(required(store.getEventActivity(1)))).toBe(
    `Worker #${job.id} 正在处理`,
  )
  store.jobs.finish(job.id, 1, { status: 'completed', result: '已核验' })
  store.ledger.receiveSignal({
    key: 'returned',
    principal: 'router-owner',
    kind: 'worker_result',
    scope: '1',
    payload: { jobId: job.id, attempt: 1 },
  })
  const returned = required(store.ledger.claimSignal())
  expect(routerEventActivityLabel(required(store.getEventActivity(1)))).toBe(
    'Router 正在处理 Worker 结果',
  )
  store.ledger.finishSignal(returned.id, 'failed', '模型连接失败')
  expect(store.getEventActivity(1)).toMatchObject({ state: 'failed', error: '模型连接失败' })
  expect(routerEventActivityLabel(required(store.getEventActivity(1)))).toBe('Router 处理失败')
  // Continuing the same worker elsewhere must not rewrite this event's attempt status.
  store.jobs.continue('general', job.id, 'another-input', '另一条输入')
  store.jobs.claimNext()
  expect(store.getEventActivity(1)?.worker).toMatchObject({ attempt: 1, status: 'completed' })
})
