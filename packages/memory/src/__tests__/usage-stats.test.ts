import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryUsageTracker } from '../usage-stats'

describe('MemoryUsageTracker', () => {
  let tmpDir: string
  let statsPath: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zero-usage-stats-'))
    statsPath = join(tmpDir, 'usage-stats.json')
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function createTracker(overrides?: Partial<ConstructorParameters<typeof MemoryUsageTracker>[0]>) {
    return new MemoryUsageTracker({
      statsPath,
      flushIntervalMs: 60_000,
      ...overrides,
    })
  }

  test('score is 0 for unknown memory', () => {
    const tracker = createTracker()
    expect(tracker.score('mem_unknown')).toBe(0)
    expect(tracker.decayedView('mem_unknown')).toBeUndefined()
  })

  test('snapshot enumerates all records with decayed counts and score', () => {
    const tracker = createTracker({ saturation: 5 })
    tracker.record('mem_s1', 'read')
    tracker.record('mem_s1', 'read')
    tracker.record('mem_s1', 'used')
    tracker.record('mem_s2', 'injected')

    const snapshot = tracker.snapshot()
    expect(snapshot).toHaveLength(2)

    const s1 = snapshot.find((entry) => entry.id === 'mem_s1')
    expect(s1).toBeDefined()
    expect(s1?.read).toBeCloseTo(2, 5)
    expect(s1?.used).toBeCloseTo(1, 5)
    expect(s1?.total).toBe(3)
    // (2*2 + 1) / 5 = 1 → 封顶
    expect(s1?.score).toBe(1)
    expect(Date.parse(s1?.lastAccessedAt ?? '')).not.toBeNaN()

    const s2 = snapshot.find((entry) => entry.id === 'mem_s2')
    expect(s2?.score).toBe(0)
    expect(s2?.total).toBe(1)
  })

  test('snapshot of empty tracker is an empty array', () => {
    const tracker = createTracker()
    expect(tracker.snapshot()).toEqual([])
  })

  test('read counts double and saturates linearly', () => {
    const tracker = createTracker({ saturation: 5 })
    tracker.record('mem_a', 'read')
    tracker.record('mem_a', 'read')

    // (2*read)/5 = 2*2/5 = 0.8
    expect(tracker.score('mem_a')).toBeCloseTo(0.8, 5)

    tracker.record('mem_a', 'used')
    tracker.record('mem_a', 'used')
    tracker.record('mem_a', 'used')
    // positive = 2*2 + 3 = 7 ≥ 5 → 封顶 1
    expect(tracker.score('mem_a')).toBe(1)
  })

  test('injected alone does not feed score (observability only)', () => {
    const tracker = createTracker()
    tracker.record('mem_b', 'injected')
    tracker.record('mem_b', 'injected')
    expect(tracker.score('mem_b')).toBe(0)
    expect(tracker.decayedView('mem_b')?.injected).toBeCloseTo(2, 5)
    expect(tracker.decayedView('mem_b')?.total).toBe(2)
  })

  test('harmful/unused are tracked but do not feed score', () => {
    const tracker = createTracker()
    tracker.record('mem_c', 'harmful')
    tracker.record('mem_c', 'unused')
    expect(tracker.score('mem_c')).toBe(0)
    expect(tracker.decayedView('mem_c')?.harmful).toBeCloseTo(1, 5)
    expect(tracker.decayedView('mem_c')?.unused).toBeCloseTo(1, 5)
  })

  test('same kind in same session counts once', () => {
    const tracker = createTracker()
    tracker.record('mem_d', 'read', 'sess_1')
    tracker.record('mem_d', 'read', 'sess_1')
    tracker.record('mem_d', 'read', 'sess_1')
    expect(tracker.decayedView('mem_d')?.read).toBeCloseTo(1, 5)

    tracker.record('mem_d', 'read', 'sess_2')
    expect(tracker.decayedView('mem_d')?.read).toBeCloseTo(2, 5)
  })

  test('different kinds in same session count independently', () => {
    const tracker = createTracker()
    tracker.record('mem_e', 'read', 'sess_1')
    tracker.record('mem_e', 'used', 'sess_1')
    expect(tracker.decayedView('mem_e')?.read).toBeCloseTo(1, 5)
    expect(tracker.decayedView('mem_e')?.used).toBeCloseTo(1, 5)
  })

  test('counts decay with half-life', () => {
    // 用一份 lastAccessedAt 拨回 30 天的 stats 文件模拟时间流逝(半衰期 30 天)
    const stalePath = join(tmpDir, 'stale-stats.json')
    writeFileSync(
      stalePath,
      JSON.stringify({
        version: 1,
        records: {
          mem_stale: {
            read: 4,
            used: 0,
            injected: 0,
            harmful: 0,
            unused: 0,
            total: 4,
            lastAccessedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          },
        },
      }),
      'utf-8',
    )
    const staleTracker = new MemoryUsageTracker({ statsPath: stalePath })
    staleTracker.load()
    // 30 天 = 恰一个半衰期:read 4 → 2,score = 2*2/5 = 0.8
    expect(staleTracker.decayedView('mem_stale')?.read).toBeCloseTo(2, 3)
    expect(staleTracker.score('mem_stale')).toBeCloseTo(0.8, 3)
  })

  test('flush and load roundtrip persists decayed records', async () => {
    const tracker = createTracker()
    tracker.record('mem_g', 'read', 'sess_1')
    tracker.record('mem_g', 'used', 'sess_1')
    tracker.record('mem_h', 'injected', 'sess_1')
    await tracker.flush()

    expect(existsSync(statsPath)).toBe(true)

    const reloaded = createTracker()
    reloaded.load()
    expect(reloaded.size).toBe(2)
    expect(reloaded.decayedView('mem_g')?.read).toBeCloseTo(1, 5)
    expect(reloaded.decayedView('mem_g')?.used).toBeCloseTo(1, 5)
    expect(reloaded.decayedView('mem_h')?.injected).toBeCloseTo(1, 5)
  })

  test('corrupt stats file is tolerated and starts empty', () => {
    const corruptPath = join(tmpDir, 'corrupt-stats.json')
    writeFileSync(corruptPath, '{not json at all', 'utf-8')
    const tracker = new MemoryUsageTracker({ statsPath: corruptPath })
    expect(() => tracker.load()).not.toThrow()
    expect(tracker.size).toBe(0)
  })

  test('records without usable fields are skipped on load', () => {
    const sparsePath = join(tmpDir, 'sparse-stats.json')
    writeFileSync(
      sparsePath,
      JSON.stringify({
        version: 1,
        records: { mem_junk: { total: 3 }, mem_ok: { read: 1 } },
      }),
      'utf-8',
    )
    const tracker = new MemoryUsageTracker({ statsPath: sparsePath })
    tracker.load()
    expect(tracker.size).toBe(1)
    expect(tracker.decayedView('mem_ok')?.read).toBeCloseTo(1, 5)
  })

  test('flush writes versioned payload with tmp+rename (no tmp residue)', async () => {
    const tracker = createTracker()
    tracker.record('mem_k', 'read')
    await tracker.flush()
    expect(existsSync(join(tmpDir, '.usage-stats.tmp'))).toBe(false)
    const payload = JSON.parse(readFileSync(statsPath, 'utf-8')) as { version: number }
    expect(payload.version).toBe(1)
  })
})
