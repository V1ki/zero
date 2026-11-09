import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { RouterJobStore } from '../router-job-store'
import { RouterLedgerConflict, RouterLedgerStore } from '../router-ledger-store'

const databases: Database[] = []
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  return { db, store: new RouterLedgerStore(db) }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

test('matters retain context, isolate owners and reject stale updates', () => {
  const { store } = fixture()
  const matter = store.createMatter('owner', '安装失败', '确定原因并解决安装失败', [
    '复现问题',
    '验证修复',
  ])
  const current = store.updateMatter('owner', matter.id, 1, {
    state: 'working',
    context: { facts: ['pnpm 版本限制尚未证实'], worker: { id: 19 } },
  })
  expect(current.version).toBe(2)
  expect(store.searchMatters('owner', 'pnpm')).toEqual([current])
  expect(store.getMatter('stranger', matter.id)).toBeNull()
  expect(store.searchMatters('stranger')).toEqual([])
  expect(() =>
    store.updateMatter('owner', matter.id, 1, { state: 'completed', context: {} }),
  ).toThrow(RouterLedgerConflict)
  expect(() =>
    store.updateMatter('stranger', matter.id, 2, { state: 'completed', context: {} }),
  ).toThrow(RouterLedgerConflict)
  expect(store.getMatter('owner', matter.id)).toEqual(current)
})

test('trace queries paginate without duplicates and recovery preserves unfinished evidence', () => {
  const { db, store } = fixture()
  const first = store.begin('conversation-a', 'Router', { input: '项目甲' })
  store.append(first, 'model_request', { messages: [{ text: '完整输入甲' }] })
  const second = store.begin('conversation-b', 'Worker', { input: '项目乙' })
  store.end(second, 'completed')
  expect(store.listRuns({ query: '完整输入甲' }).map((r) => r.id)).toEqual([first])
  const page = store.listRuns({ limit: 1 })
  expect(page[0].id).toBe(second)
  expect(store.listRuns({ before: page[0].ordinal }).map((r) => r.id)).toEqual([first])
  const entries = store.entries(first, 0, 1)
  expect(store.entries(first, entries[0].ordinal)).toHaveLength(1)
  expect(() => store.append(second, 'tool_result', {})).toThrow(RouterLedgerConflict)
  const restarted = new RouterLedgerStore(db)
  expect(restarted.recoverInterrupted()).toBe(1)
  expect(restarted.getRun(first)?.status).toBe('interrupted')
  expect(restarted.getRun(second)?.status).toBe('completed')
  expect(restarted.entries(first)).toHaveLength(2)
})

test('replay and matter links preserve original trace and completion state', () => {
  const { store } = fixture()
  const matter = store.createMatter('owner', '核查', '核对来源', ['提供证据'])
  const original = store.begin('main', 'Router', {})
  store.linkMatter(original, matter.id)
  store.end(original, 'completed')
  const replay = store.begin('replay', '只读重放', {}, original)
  expect(store.getRun(replay)?.replayOf).toBe(original)
  expect(store.listRuns({ matterId: matter.id }).map((r) => r.id)).toEqual([original])
  expect(() => store.linkMatter(replay, 'missing')).toThrow('Unknown matter')
  expect(() => store.begin('replay', 'Replay', {}, 'missing')).toThrow('Unknown original')
  expect(store.listRuns()).toHaveLength(2)
})

test('input receipt is durable, duplicate input is idempotent and identity changes cannot reuse a key', () => {
  const { db, store } = fixture()
  const signal = {
    key: 'new-source:1',
    principal: 'owner',
    kind: 'event' as const,
    scope: 'general',
    payload: { evidence: 'full original' },
  }
  const id = store.receiveSignal(signal)
  expect(store.receiveSignal(signal)).toBe(id)
  expect(() => store.receiveSignal({ ...signal, principal: 'other' })).toThrow(RouterLedgerConflict)
  const reloaded = new RouterLedgerStore(db)
  expect(reloaded.claimSignal()?.payload).toEqual(signal.payload)
  expect(store.claimSignal()).toBeNull()
  reloaded.deferSignal(id)
  expect(store.claimSignal()?.id).toBe(id)
  reloaded.recoverInterrupted()
  expect(store.listSignals('owner')[0].state).toBe('interrupted')
  expect(store.listSignals('other')).toEqual([])
})

test('worker and matter linkage commit together; a failed link cannot leave an orphan queued worker', () => {
  const { db, store } = fixture()
  const jobs = new RouterJobStore(db)
  const matter = store.createMatter('owner', '核对', '提供核对结果', ['实际读取来源'])
  const register = (job: { id: number }) =>
    store.bindWorker({
      jobId: job.id,
      principal: 'owner',
      matterId: matter.id,
      scope: 'general',
      audience: 'owner-grant',
      eventIds: [1],
      authority: 'user',
    })
  const job = jobs.submit(
    'general',
    'request-one',
    { executor: 'zero', instruction: '核对', audience: 'owner-grant' },
    register,
  )
  expect(store.workerLink(job.id)?.matterId).toBe(matter.id)
  expect(() =>
    jobs.submit(
      'general',
      'request-two',
      { executor: 'zero', instruction: '核对', audience: 'owner-grant' },
      (next) =>
        store.bindWorker({
          jobId: next.id,
          principal: 'other',
          matterId: matter.id,
          scope: 'general',
          audience: 'other-grant',
          eventIds: [],
          authority: 'user',
        }),
    ),
  ).toThrow(RouterLedgerConflict)
  expect(jobs.get('general', job.id + 1)).toBeNull()
})

test('saved wakeups survive restart and atomically become one Agent input with current matter version', () => {
  const { db, store } = fixture()
  const matter = store.createMatter('owner', '等外部验证', '核对真实结果', ['收到独立证据'])
  const now = new Date('2026-01-01T00:00:00Z')
  const input = {
    principal: 'owner',
    matterId: matter.id,
    scope: 'general',
    dueAt: '2026-01-01T00:01:00Z',
    reason: '复查外部结果',
    requestKey: 'wake-one',
  }
  const timer = store.scheduleTimer(input, now)
  expect(store.scheduleTimer(input, now)).toEqual(timer)
  expect(() => store.scheduleTimer({ ...input, reason: 'changed' }, now)).toThrow(
    RouterLedgerConflict,
  )
  expect(() => store.cancelTimer('other', timer.id)).toThrow(RouterLedgerConflict)
  store.updateMatter('owner', matter.id, 1, {
    state: 'waiting',
    context: { correction: '旧假设已排除' },
  })
  const restarted = new RouterLedgerStore(db)
  expect(restarted.releaseDueTimers(now)).toBe(0)
  expect(restarted.releaseDueTimers(new Date('2026-01-01T00:02:00Z'))).toBe(1)
  expect(store.releaseDueTimers(new Date('2026-01-01T00:03:00Z'))).toBe(0)
  const signal = restarted.claimSignal()
  expect(signal?.kind).toBe('timer')
  expect(signal?.payload.observedVersion).toBe(2)
  expect(restarted.getTimer('owner', timer.id)?.state).toBe('fired')
  expect(restarted.claimSignal()).toBeNull()
})

test('cancelled timers and completed matters never trigger more work after restart', () => {
  const { db, store } = fixture()
  const now = new Date('2026-01-01T00:00:00Z')
  const matter = store.createMatter('owner', '办理', '核对', ['证据'])
  for (const requestKey of ['cancelled', 'completed'])
    store.scheduleTimer(
      {
        principal: 'owner',
        matterId: matter.id,
        scope: 'general',
        dueAt: '2026-01-01T00:01:00Z',
        reason: '核对',
        requestKey,
      },
      now,
    )
  expect(store.cancelTimer('owner', 'cancelled')?.state).toBe('cancelled')
  store.updateMatter('owner', matter.id, 1, {
    state: 'completed',
    context: { evidence: 'checked' },
  })
  const restarted = new RouterLedgerStore(db)
  expect(restarted.releaseDueTimers(new Date('2026-01-01T00:02:00Z'))).toBe(0)
  expect(restarted.listTimers('owner', matter.id).map((t) => t.state)).toEqual([
    'cancelled',
    'cancelled',
  ])
})

test('explicit owner authority survives source continuations and association corrections are audited', () => {
  const { store } = fixture()
  const matter = store.createMatter('owner', '复测', '核实故障', ['复测通过'])
  const link = {
    jobId: 1,
    principal: 'owner',
    matterId: matter.id,
    scope: 'general',
    audience: 'owner',
    eventIds: [1],
    authority: 'user' as const,
  }
  store.bindWorker(link)
  store.bindWorker({ ...link, eventIds: [2], authority: 'source' })
  expect(store.workerLink(1)?.authority).toBe('user')
  store.unlinkSource('owner', matter.id, 2, '新线索属于另一设备')
  expect(store.workerLink(1)?.eventIds).toEqual([1])
  expect(store.matterSources(matter.id)).toEqual([1])
  store.updateMatter('owner', matter.id, 1, {
    state: 'waiting',
    context: { correction: '排除线缆因素' },
  })
  const history = store.matterHistory('owner', matter.id)
  expect(history.map((h) => h.version)).toEqual([2, 1])
  expect(history[0].snapshot.context.correction).toBe('排除线缆因素')
  expect(history[1].snapshot.context).toEqual({})
})

test('trace structured filters match exact platform, event, Worker, state and time', () => {
  const { store } = fixture()
  const first = store.begin('same', 'Router', { context: { platform: 'weixin', eventId: 12 } })
  const second = store.begin('worker', 'Worker', { context: { workerId: 7 } })
  store.end(first, 'completed')
  expect(
    store.listRuns({ platform: 'weixin', eventId: 12, status: 'completed' }).map((r) => r.id),
  ).toEqual([first])
  expect(store.listRuns({ platform: 'weixin', eventId: 1 })).toEqual([])
  expect(store.listRuns({ workerId: 7 }).map((r) => r.id)).toEqual([second])
  expect(store.listRuns({ runId: first, startedAfter: '2999-01-01T00:00:00Z' })).toEqual([])
  expect(store.listRuns({ runId: first, startedBefore: '2999-01-01T00:00:00Z' })).toHaveLength(1)
})

test('input arrival order survives an older turn finishing last and a late Worker result', () => {
  const { store } = fixture()
  const m = store.createMatter('owner', '核查', '核对环境', ['有来源'], {
    turnId: 7,
    kind: 'user',
    receivedAt: '2026-11-06T01:00:00Z',
  })
  const patch = { state: 'waiting' as const, context: {} }
  const recent = { turnId: 9, kind: 'user' as const, receivedAt: '2026-11-06T01:02:01Z' }
  store.updateMatter('owner', m.id, 1, patch, recent)
  store.updateMatter('owner', m.id, 2, patch, {
    turnId: 8,
    kind: 'user',
    receivedAt: '2026-11-06T01:02:00Z',
  })
  store.updateMatter('owner', m.id, 3, patch, {
    turnId: 10,
    kind: 'worker_result',
    receivedAt: '2026-11-06T01:03:00Z',
  })
  expect(store.latestUserUpdate('owner', m.id)).toEqual({
    turnId: 9,
    version: 2,
    receivedAt: recent.receivedAt,
  })
  expect(store.latestUserUpdate('other', m.id)).toBeNull()
  expect(store.matterHistory('owner', m.id).map((v) => v.snapshot.inputOrigin.turnId)).toEqual([
    10, 8, 9, 7,
  ])
})

test('paused timers do not consume the release batch or prevent a later user-selected date', () => {
  const { db, store } = fixture()
  try {
    const now = new Date('2026-01-01T00:00:00Z')
    const paused = store.createMatter('owner', '停办', '保留约定', ['收到恢复'])
    const active = store.createMatter('owner', '仍需提醒', '到期交付', ['网页提醒'])
    for (let i = 0; i < 100; i++)
      store.scheduleTimer(
        {
          principal: 'owner',
          matterId: paused.id,
          scope: 'general',
          reason: '等待恢复',
          dueAt: '2026-01-02T00:00:00Z',
          requestKey: 'paused-' + i,
        },
        now,
      )
    store.updateMatter('owner', paused.id, 1, { state: 'paused', context: {} })
    const timer = store.scheduleTimer(
      {
        principal: 'owner',
        matterId: active.id,
        scope: 'general',
        reason: '用户指定日期',
        dueAt: '2028-02-01T00:00:00Z',
        requestKey: 'active',
      },
      now,
    )
    expect(store.releaseDueTimers(new Date(timer.dueAt))).toBe(1)
    expect(store.claimSignal()?.payload.matterId).toBe(active.id)
    expect(store.listTimers('owner', paused.id).every((t) => t.state === 'scheduled')).toBe(true)
  } finally {
    db.close()
  }
})

test('a released timer waits through pause and drops a pending wakeup if its matter is finished', () => {
  const { db, store } = fixture()
  try {
    const now = new Date('2026-01-01T00:00:00Z')
    const matter = store.createMatter('owner', '等待答复', '等新资料', ['有回复'])
    store.scheduleTimer(
      {
        principal: 'owner',
        matterId: matter.id,
        scope: 'general',
        reason: '跟进',
        dueAt: '2026-01-01T00:01:00Z',
        requestKey: 'follow',
      },
      now,
    )
    store.releaseDueTimers(new Date('2026-01-01T00:02:00Z'))
    store.updateMatter('owner', matter.id, 1, { state: 'paused', context: {} })
    expect(store.claimSignal()).toBeNull()
    store.updateMatter('owner', matter.id, 2, { state: 'waiting', context: {} })
    const resumed = store.claimSignal()!
    expect(resumed.payload.matterId).toBe(matter.id)
    store.deferSignal(resumed.id)
    store.updateMatter('owner', matter.id, 3, {
      state: 'completed',
      context: { reason: '资料已到' },
    })
    expect(store.claimSignal()).toBeNull()
    expect(store.listSignals('owner')[0].state).toBe('cancelled')
  } finally {
    db.close()
  }
})

test('moving one source versions both matters and detaches the original Worker only from that source', () => {
  const { store } = fixture()
  const from = store.createMatter('owner', '同名', '核对温度', ['温度'])
  const to = store.createMatter('owner', '同名', '核对封条', ['照片'])
  const other = store.createMatter('other', '同名', '另一个人', ['独立'])
  store.bindWorker({
    jobId: 4,
    principal: 'owner',
    matterId: from.id,
    scope: 'general',
    audience: 'fixture',
    eventIds: [7, 8],
    authority: 'source',
  })
  expect(() => store.changeSourceAssociation('owner', 7, from.id, other.id, '纠正')).toThrow(
    '不可访问',
  )
  expect(store.workerLink(4)?.eventIds).toEqual([7, 8])
  const changed = store.changeSourceAssociation('owner', 7, from.id, to.id, '封条照片')
  expect(changed.versions).toEqual({ [from.id]: 2, [to.id]: 2 })
  expect(store.changeSourceAssociation('owner', 7, from.id, to.id, '封条照片').versions).toEqual({})
  expect(store.eventMatters('owner', 7)).toEqual([to.id])
  expect(store.sourceCorrections('owner', from.id)).toHaveLength(1)
  expect(store.matterHistory('owner', from.id)[0].snapshot.sourceEventIds).toEqual([8])
  expect(store.matterHistory('owner', to.id)[0].snapshot.sourceEventIds).toEqual([7])
  expect(store.workerLink(4)).toMatchObject({ matterId: from.id, eventIds: [8] })
  expect(() => store.changeSourceAssociation('owner', 999, from.id, to.id, '误改')).toThrow(
    '没有当前关联',
  )
})

test('opens the exact stored runs for a conversation turn, including retries and pre-index records', () => {
  const { db, store } = fixture()
  const input = (id: number) => ({
    prompt: JSON.stringify({ contextProvenance: { currentTurnId: id } }),
  })
  const first = store.begin('router-general', 'Router 对话', input(12))
  store.end(first, 'failed')
  const retry = store.begin('router-general', 'Router 对话', input(12))
  store.end(retry, 'completed')
  store.begin('router-general', '隔离重放', input(12), first)
  store.begin('router-event-9', 'Router 对话', input(12))
  store.begin('router-general', 'Router 对话', { prompt: '历史文字，无关联编号' })
  db.exec('DROP INDEX router_trace_input_turn')
  const reopened = new RouterLedgerStore(db)
  expect([...reopened.conversationRuns('router-general', [12, 13])]).toEqual([[12, [first, retry]]])
})

test('original publication and retry receipts keep their exact runs across index rebuilds', () => {
  const { db, store } = fixture()
  const add = (name: string, publicationId: string, success: boolean, replayOf?: string) => {
    const run = store.begin('router-general', 'Router 对话', {}, replayOf)
    store.append(run, 'tool_result', {
      name,
      id: 'call',
      input: { publicationId, channel: 'dingtalk' },
      result: { success, output: success ? JSON.stringify({ id: publicationId }) : '平台拒绝' },
    })
    store.end(run, 'completed')
    return run
  }
  const first = add('publish_update', 'a', true)
  const retry = add('retry_delivery', 'a', false)
  store.publications.prepare({
    id: 'a',
    principal: 'owner',
    matterId: 'matter-a',
    matterVersion: 1,
    scope: 'general',
    deliveries: [
      { channel: 'web', presentation: { title: '原卡', text: '正文', actions: [] }, target: null },
    ],
  })
  expect(store.publishedLinks('owner', [first, retry])).toEqual([])
  const web = store.publications.claim('owner', 'a', 'web')!
  store.publications.finish('owner', 'a', 'web', web.attempt, {
    status: 'accepted',
    receipt: 'web:a',
    reason: null,
  })
  expect(store.publishedLinks('owner', [first, retry])).toEqual([
    { runId: first, id: 'a', matterId: 'matter-a', title: '原卡' },
  ])
  expect(store.publishedLinks('different-reader', [first])).toEqual([])
  add('read_publication', 'a', true)
  add('publish_update', 'a', true, first)
  add('publish_update', 'b', true)
  db.exec('DROP INDEX router_trace_receipt')
  const result = new RouterLedgerStore(db).publicationTraces(['a'])
  const traces = result.get('a')!
  expect(traces.map((t) => t.runId)).toEqual([first, retry])
  expect(traces[1]).toMatchObject({ operation: 'retry_delivery', channel: 'dingtalk' })
  for (const t of traces)
    expect(store.entries(t.runId).find((e) => e.ordinal === t.ordinal)?.kind).toBe('tool_result')
})

test('a signal with no further tools stays linked to the authorized matter in its recorded input', () => {
  const { store } = fixture()
  const matter = store.createMatter('owner', '签收', '核对签收记录', ['核对结果'])
  const make = (principal: string) =>
    store.begin('router-general', 'Router 对话', {
      prompt: JSON.stringify({
        matters: { focusedMatter: { id: matter.id } },
        contextProvenance: { principal },
      }),
    })
  const own = make('owner')
  const unrelated = make('other')
  expect(store.getRun(own)).toMatchObject({
    matterId: matter.id,
    relatedMatters: [{ id: matter.id, title: matter.title }],
  })
  expect(store.getRun(unrelated)?.matterId).toBeNull()
  expect(store.listRuns({ matterId: matter.id }).map((r) => r.id)).toEqual([own])
})

test('cancelled reminders retain the deciding turn and its evidence after a repeated cancellation and restart', () => {
  const { store, db } = fixture()
  const matter = store.createMatter('owner', '监测', '等到新的读数', ['记录读数'])
  store.scheduleTimer(
    {
      principal: 'owner',
      scope: 'general',
      matterId: matter.id,
      requestKey: 'old',
      dueAt: '2026-11-10T00:00:00Z',
      reason: '等待复测',
    },
    new Date('2026-11-06T00:00:00Z'),
  )
  store.cancelTimer('owner', 'old', { turnId: 14, reason: '第二条输入已带回复测记录' })
  store.cancelTimer('owner', 'old', { turnId: 16, reason: '后来再次操作' })
  const recovered = new RouterLedgerStore(db)
  expect(recovered.listTimers('owner', matter.id)[0]).toMatchObject({
    state: 'cancelled',
    cancelReason: '第二条输入已带回复测记录',
    cancelTurnId: 14,
    matterId: matter.id,
  })
  expect(recovered.releaseDueTimers(new Date('2026-11-11'))).toBe(0)
})
