import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLifecycle } from '../lifecycle'
import { MemoryStore } from '../store'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('MemoryLifecycle', () => {
  let tmpDir: string
  let store: MemoryStore
  let lifecycle: MemoryLifecycle

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zero-lifecycle-'))
    store = new MemoryStore(tmpDir)
    lifecycle = new MemoryLifecycle(store)
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('createSessionMemory sets title, status, and confidence', async () => {
    const mem = await lifecycle.createSessionMemory('sess-001', 'Completed deploy task', ['deploy'])

    expect(mem.title).toBe('Session sess-001')
    expect(mem.status).toBe('verified')
    expect(mem.confidence).toBe(0.8)
    expect(mem.sessionId).toBe('sess-001')
    expect(mem.tags).toContain('deploy')
    expect(mem.content).toBe('Completed deploy task')
  })

  test('createIncident prefixes tags with incident and sets draft status', async () => {
    const mem = await lifecycle.createIncident('OOM Crash', 'Process killed by OOM', 'sess-002', [
      'memory',
      'crash',
    ])

    expect(mem.title).toBe('OOM Crash')
    expect(mem.status).toBe('draft')
    expect(mem.confidence).toBe(0.7)
    expect(mem.tags[0]).toBe('incident')
    expect(mem.tags).toContain('memory')
    expect(mem.tags).toContain('crash')
    expect(mem.sessionId).toBe('sess-002')
  })

  test('verify updates status to verified with specified confidence', async () => {
    const mem = await lifecycle.createIncident('Bug', 'A bug', 'sess-003', ['bug'])
    expect(mem.status).toBe('draft')

    const verified = await lifecycle.verify('incident', mem.id, 0.95)
    expect(expectDefined(verified).status).toBe('verified')
    expect(expectDefined(verified).confidence).toBe(0.95)
  })

  test('verify uses default confidence 0.9 when not specified', async () => {
    const mem = await lifecycle.createIncident('Issue', 'An issue', 'sess-004', ['issue'])

    const verified = await lifecycle.verify('incident', mem.id)
    expect(expectDefined(verified).status).toBe('verified')
    expect(expectDefined(verified).confidence).toBe(0.9)
  })

  test('archiveOld archives memories older than N days', async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'zero-lifecycle-archive-'))
    const archiveStore = new MemoryStore(archiveDir)
    const archiveLifecycle = new MemoryLifecycle(archiveStore)

    await archiveStore.create('note', 'Recent note', 'Just created', {
      status: 'verified',
      confidence: 0.8,
    })

    // Wait a small amount to ensure time gap
    await Bun.sleep(10)

    // olderThanDays=0 means cutoff = Date.now(), so anything created before now is older
    const count = await archiveLifecycle.archiveOld('note', 0)
    expect(count).toBe(1)

    const notes = archiveStore.list('note')
    expect(notes[0].status).toBe('archived')

    rmSync(archiveDir, { recursive: true, force: true })
  })

  test('archiveOld skips already archived memories', async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'zero-lifecycle-skip-'))
    const archiveStore = new MemoryStore(archiveDir)
    const archiveLifecycle = new MemoryLifecycle(archiveStore)

    await archiveStore.create('note', 'Already archived', 'Old stuff', {
      status: 'archived',
      confidence: 0.5,
    })

    await Bun.sleep(10)

    const count = await archiveLifecycle.archiveOld('note', 0)
    expect(count).toBe(0)

    rmSync(archiveDir, { recursive: true, force: true })
  })

  test('resolveConflict archives lower confidence memory', async () => {
    const m1 = await store.create('note', 'High confidence', 'Winner content', {
      confidence: 0.9,
      status: 'verified',
    })
    const m2 = await store.create('note', 'Low confidence', 'Loser content', {
      confidence: 0.6,
      status: 'verified',
    })

    const winner = await lifecycle.resolveConflict('note', m1.id, m2.id)
    const winningMemory = expectDefined(winner)
    expect(winningMemory.id).toBe(m1.id)
    expect(winningMemory.related).toContain(m2.id)

    const loser = store.get('note', m2.id)
    expect(expectDefined(loser).status).toBe('archived')
  })

  test('resolveConflict with same confidence picks more recently updated', async () => {
    const m1 = await store.create('note', 'Older note', 'Created first', {
      confidence: 0.8,
      status: 'verified',
    })

    // Wait to ensure different updatedAt timestamps
    await Bun.sleep(10)

    const m2 = await store.create('note', 'Newer note', 'Created second', {
      confidence: 0.8,
      status: 'verified',
    })

    const winner = await lifecycle.resolveConflict('note', m1.id, m2.id)
    const winningMemory = expectDefined(winner)
    expect(winningMemory.id).toBe(m2.id)
    expect(winningMemory.related).toContain(m1.id)

    const loser = store.get('note', m1.id)
    expect(expectDefined(loser).status).toBe('archived')
  })
})

// 对抗R6回归：发展裁决与权威模型对齐。
describe('MemoryLifecycle authority alignment (R6)', () => {
  let dir: string
  let store: MemoryStore
  let life: MemoryLifecycle
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-life-r6-'))
    store = new MemoryStore(dir)
    life = new MemoryLifecycle(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('resolveConflict on an already-superseded pair keeps the live authority, not the archived one', async () => {
    const newer = await store.create('note', 'Newer', 'truth', {
      status: 'verified',
      confidence: 0.7,
    })
    const older = await store.create('note', 'Older', 'stale', {
      status: 'verified',
      confidence: 0.95,
    })
    // older 已被 newer 取代（older.supersededBy=newer），older conf 更高
    await store.update('note', older.id, { status: 'archived', supersededBy: newer.id })
    const winner = await life.resolveConflict('note', older.id, newer.id)
    // 解析到活权威后两者同谱系 → 返回活权威 newer，绝不把 archived older 当 winner
    expect(winner?.id).toBe(newer.id)
    expect(store.get('note', newer.id)?.status).toBe('verified') // 活权威未被归档
  })

  test('resolveConflict archives loser WITH supersededBy so hits on loser redirect to winner', async () => {
    const a = await store.create('note', 'A', 'a', { status: 'verified', confidence: 0.9 })
    const b = await store.create('note', 'B', 'b', { status: 'verified', confidence: 0.5 })
    await life.resolveConflict('note', a.id, b.id) // a 胜（conf 高）
    const loser = store.get('note', b.id)
    expect(loser?.status).toBe('archived')
    expect(loser?.supersededBy).toBe(a.id) // 谱系指针存在 → 检索可重定向
    expect(store.get('note', a.id)?.related).toContain(b.id)
  })

  test('archiveOld does not archive a live authority still referenced by a supersededBy chain', async () => {
    const authority = await store.create('note', 'Auth', 'truth', { status: 'verified' })
    const old = await store.create('note', 'Old', 'old', { status: 'archived' })
    await store.update('note', old.id, { supersededBy: authority.id })
    // 强制 authority 的 updatedAt 很旧（稳定权威反而"显老"）
    const past = '2000-01-01T00:00:00.000Z'
    await store.save({ ...expectDefined(store.get('note', authority.id)), updatedAt: past })
    const n = await life.archiveOld('note', 30)
    // authority 被 old.supersededBy 引用 → 不应被归档（否则整条谱系召回坍塌）
    expect(store.get('note', authority.id)?.status).toBe('verified')
    expect(n).toBe(0)
  })
})

// 对抗R6观察点回归：verify 清谱系指针，避免 verified+supersededBy 僵尸态。
describe('MemoryLifecycle.verify clears lineage (R6 followup)', () => {
  let dir: string
  let store: MemoryStore
  let life: MemoryLifecycle
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-life-verify-'))
    store = new MemoryStore(dir)
    life = new MemoryLifecycle(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('verifying a superseded memory clears its lineage pointers (no zombie)', async () => {
    const m = await store.create('note', 'Z', 'z', { status: 'archived' })
    await store.update('note', m.id, { supersededBy: 'mem_other', mergedInto: 'mem_x' })
    const verified = await life.verify('note', m.id)
    expect(verified?.status).toBe('verified')
    expect(verified?.supersededBy).toBeUndefined()
    expect(verified?.mergedInto).toBeUndefined()
  })
})

describe('MemoryLifecycle cross-type authority (R7)', () => {
  let dir: string
  let store: MemoryStore
  let life: MemoryLifecycle
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-life-r7-'))
    store = new MemoryStore(dir)
    life = new MemoryLifecycle(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('archiveOld does not archive a live authority referenced cross-type', async () => {
    const auth = await store.create('note', 'Auth', 'truth', { status: 'verified' })
    const old = await store.create('decision', 'Old', 'old', { status: 'archived' })
    await store.update('decision', old.id, { supersededBy: auth.id }) // 跨 type 引用
    await store.save({
      ...expectDefined(store.get('note', auth.id)),
      updatedAt: '2000-01-01T00:00:00.000Z',
    })
    const n = await life.archiveOld('note', 30)
    expect(store.get('note', auth.id)?.status).toBe('verified') // 跨 type 引用 → 不归档
    expect(n).toBe(0)
  })

  test('resolveConflict resolves cross-type lineage to the real authority', async () => {
    const tail = await store.create('decision', 'Tail', 'truth', {
      status: 'verified',
      confidence: 0.95,
    })
    const h = await store.create('note', 'H', 'stale', { status: 'archived', confidence: 0.5 })
    await store.update('note', h.id, { supersededBy: tail.id }) // h 跨 type 指向 tail
    const other = await store.create('note', 'Other', 'o', { status: 'verified', confidence: 0.6 })
    const winner = await life.resolveConflict('note', h.id, other.id)
    // h 解析到跨 type 的活权威 tail(conf 0.95) → tail 胜，h 的谱系指针不被改写
    expect(winner?.id).toBe(tail.id)
    expect(store.get('note', h.id)?.supersededBy).toBe(tail.id) // 未被改写
  })

  test('resolveConflict same-lineage early-return revives an archived shared authority', async () => {
    const tail = await store.create('note', 'T', 't', { status: 'archived' })
    const a = await store.create('note', 'A', 'a', { status: 'archived' })
    const b = await store.create('note', 'B', 'b', { status: 'archived' })
    await store.update('note', a.id, { supersededBy: tail.id })
    await store.update('note', b.id, { supersededBy: tail.id })
    const winner = await life.resolveConflict('note', a.id, b.id) // 同权威 tail
    expect(winner?.id).toBe(tail.id)
    expect(winner?.status).toBe('verified') // 复活，不返回 archived
  })
})

describe('MemoryLifecycle endpoint-integration hardening (R9)', () => {
  let dir: string
  let store: MemoryStore
  let life: MemoryLifecycle
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-life-r9-'))
    store = new MemoryStore(dir)
    life = new MemoryLifecycle(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('concurrent resolveConflict on the same winner accumulates related (no lost update)', async () => {
    const a = await store.create('note', 'A', 'a', { status: 'verified', confidence: 0.9 })
    const b = await store.create('note', 'B', 'b', { status: 'verified', confidence: 0.4 })
    const cc = await store.create('note', 'C', 'c', { status: 'verified', confidence: 0.5 })
    await Promise.all([
      life.resolveConflict('note', a.id, b.id),
      life.resolveConflict('note', a.id, cc.id),
    ])
    const winner = store.get('note', a.id)
    expect(winner?.related.sort()).toEqual([b.id, cc.id].sort()) // 两条反向关联都在
    expect(store.get('note', b.id)?.supersededBy).toBe(a.id)
    expect(store.get('note', cc.id)?.supersededBy).toBe(a.id)
  })

  test('resolveConflict resolves cross-type top-level args', async () => {
    const rb = await store.create('runbook', 'RB', 'x', { status: 'verified', confidence: 0.9 })
    const nt = await store.create('note', 'NT', 'x', { status: 'verified', confidence: 0.3 })
    // 入参 type=runbook，但 id2 是 note：仍应裁决成功（不返回 undefined）
    const winner = await life.resolveConflict('runbook', rb.id, nt.id)
    expect(winner?.id).toBe(rb.id)
    expect(store.get('note', nt.id)?.status).toBe('archived')
  })

  test('archiveOld clamps huge olderThanDays (no RangeError)', async () => {
    await store.create('note', 'X', 'x', { status: 'verified' })
    expect(await life.archiveOld('note', 1e308)).toBeGreaterThanOrEqual(0) // 不抛
  })
})
