import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MandateTarget, TriggerMandate } from '@zero-os/shared'
import { TriggerStore } from '../trigger-store'

const room = 'test-room'
const team: MandateTarget = {
  platform: 'dingtalk',
  channelId: 'work',
  peerId: 'group',
  operatorId: 'owner',
}
const archive = { channelId: 'research', documentId: 'test-doc' }
const future = '2099-01-01T00:00:00.000Z'
const now = '2098-01-01T00:00:00.000Z'
const stores: TriggerStore[] = []
const folders: string[] = []

function open(path: string) {
  const store = new TriggerStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configure() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-effects-'))
  folders.push(dir)
  const path = join(dir, 'events.sqlite')
  const store = open(path)
  const sourceRevision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: room, name: 'room', enabled: true, keyword: '' }] },
    },
    0,
  )
  const routingRevision = store.routing.saveSettings(
    { ...store.routing.getSettings().settings, enabled: true },
    0,
  )
  const mandate: TriggerMandate = {
    id: 'one',
    enabled: true,
    name: '跟踪',
    purpose: '发布',
    source: 'wxarc',
    scope: room,
    keyword: '',
    projectId: null,
    targets: [team],
    archive,
    policy: {},
    deadline: null,
    urgent: false,
  }
  const mandateRevision = store.mandates.saveSettings(
    { projects: [], mandates: [mandate, { ...mandate, id: 'two', name: '归档' }] },
    0,
  )
  for (const id of ['a', 'b']) {
    expect(
      store.commitBatch({
        source: 'wxarc',
        stream: `wxarc:${room}`,
        events: [
          {
            eventId: id,
            scope: room,
            title: '事件',
            summary: id,
            occurredAt: new Date().toISOString(),
          },
        ],
        previousCursor: store.readCursor(`wxarc:${room}`),
        cursor: id,
        revision: sourceRevision,
      }),
    ).toBe(true)
  }
  return { store, path, expected: { mandateRevision, routingRevision } }
}

function analyze(store: TriggerStore) {
  for (;;) {
    const work = store.mandates.claimAnalysis(crypto.randomUUID())
    if (!work) break
    expect(store.mandates.finishAnalysis(work.match.id, '分析完成', work.claimToken)).toBe(true)
  }
}

test('digest claim validates every member, target/operator and policy revisions before the first write', () => {
  const { store, path, expected } = configure()
  const other = open(path)
  const ledger = store.mandates
  expect(ledger.hasPendingAnalysisBefore('one', future)).toBe(true)
  analyze(store)
  expect(ledger.hasPendingAnalysisBefore('one', future)).toBe(false)
  const candidates = ledger.listReadyEffects('notify', now)
  const ids = candidates.filter((item) => item.mandate.id === 'one').map((item) => item.match.id)
  const foreign = candidates.find((item) => item.mandate.id === 'two')
  expect(ids).toHaveLength(2)
  if (!foreign || ids[0] === undefined || ids[1] === undefined) throw new Error('missing members')
  const [first, second] = ids
  const claim = (target = team, extra = [second], version = expected) =>
    ledger.claimEffect(first, 'notify', 'dingtalk', target, '汇总', now, extra, version)
  expect(claim(team, [second, foreign.match.id])).toEqual([])
  expect(claim({ ...team, operatorId: 'someone-else' })).toEqual([])
  expect(claim(team, [second], { ...expected, routingRevision: 0 })).toEqual([])
  expect(ledger.deferEffect(second, 'notify', future, '晚点提醒', expected)).toBe(true)
  expect(ledger.nextDueAt()).toBe(future)
  expect(claim()).toEqual([])
  ledger.recheckDeferred(now)
  expect(claim().map((item) => item.match.id)).toEqual([first, second])
  expect(other.mandates.claimEffect(first, 'notify', 'dingtalk', team, '并发竞争', now)).toEqual([])
  expect(other.mandates.isAuthorizedEffect(first, 'notify', team)).toBe(true)
  expect(
    other.mandates.isAuthorizedEffect(first, 'notify', { ...team, channelId: 'another-bot' }),
  ).toBe(false)
  expect(ledger.finishEffect(first, 'notify', 'done', 'remote-msg-id')).toBe(true)
  expect(ledger.finishEffect(first, 'notify', 'done', 'duplicate')).toBe(false)
  expect(
    ledger.claimEffect(
      first,
      'archive',
      'archive',
      { ...archive, documentId: 'wrong-doc' },
      '写文档',
      now,
    ),
  ).toEqual([])
  expect(ledger.claimEffect(first, 'archive', 'archive', archive, '写文档', now)).toHaveLength(1)
  expect(ledger.finishEffect(first, 'archive', 'failed', 'missing permission')).toBe(true)
  expect(ledger.retryEffect(first, 'archive')).toBe(true)
  expect(ledger.retryEffect(first, 'notify')).toBe(false)
  expect(ledger.claimEffect(foreign.match.id, 'notify', 'web', null, '网页展示', now)).toHaveLength(
    1,
  )
  other.mandates.recoverInterrupted()
  expect(ledger.getMatch(foreign.match.id)?.effects.find((e) => e.kind === 'notify')).toMatchObject(
    { status: 'done', receipt: 'web' },
  )
  expect(ledger.getMatch(second)?.effects.find((e) => e.kind === 'notify')?.status).toBe('unknown')
  expect(ledger.retryEffect(second, 'notify')).toBe(false)
})

test('pausing the router removes deferred work from the timer and blocks receipt claims across connections', () => {
  const { store, path, expected } = configure()
  analyze(store)
  const other = open(path)
  const item = store.mandates.nextEffect('notify', now)
  if (!item) throw new Error('no eligible effect')
  const id = item.match.id
  expect(store.mandates.deferEffect(id, 'notify', future, '静默时段', expected)).toBe(true)
  other.routing.saveSettings(
    { ...other.routing.getSettings().settings, enabled: false },
    expected.routingRevision,
  )
  expect(store.mandates.nextDueAt()).toBeNull()
  expect(store.mandates.listReadyEffects('notify', future)).toEqual([])
  expect(store.mandates.claimEffect(id, 'notify', 'dingtalk', team, '测试', future)).toEqual([])
  expect(store.mandates.skipEffect(id, 'notify', '过期策略', expected)).toBe(false)
})
