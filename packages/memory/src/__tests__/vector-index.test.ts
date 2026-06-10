import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VectorIndex } from '../vector-index'

describe('VectorIndex', () => {
  let dir: string
  let index: VectorIndex

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-vector-index-'))
    index = new VectorIndex(dir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('ensureIndex creates an empty index', async () => {
    await index.ensureIndex()
    await expect(index.getStats()).resolves.toEqual({ itemCount: 0 })
  })

  test('upsert/query/delete round-trip', async () => {
    await index.upsert('mem_1', [1, 0], {
      memoryId: 'mem_1',
      type: 'note',
      title: 'Deploy',
      updatedAt: '2026-03-11T00:00:00.000Z',
    })
    await index.upsert('mem_2', [0, 1], {
      memoryId: 'mem_2',
      type: 'note',
      title: 'Database',
      updatedAt: '2026-03-11T00:00:00.000Z',
    })

    const results = await index.query([1, 0], 2)
    expect(results[0].memoryId).toBe('mem_1')
    expect(results[0].score).toBeGreaterThan(0.9)

    await index.delete('mem_1')
    const afterDelete = await index.query([1, 0], 2)
    expect(afterDelete.some((entry) => entry.memoryId === 'mem_1')).toBe(false)
  })

  test('getVector and listAll expose stored vectors', async () => {
    await index.upsert('mem_v', [0.6, 0.8], {
      memoryId: 'mem_v',
      type: 'runbook',
      title: 'Vectorized',
      updatedAt: '2026-03-12T00:00:00.000Z',
    })

    expect(await index.getVector('mem_v')).toEqual([0.6, 0.8])
    expect(await index.getVector('does-not-exist')).toBeUndefined()

    const all = await index.listAll()
    const entry = all.find((it) => it.memoryId === 'mem_v')
    expect(entry?.vector).toEqual([0.6, 0.8])
    expect(entry?.meta.title).toBe('Vectorized')
    expect(typeof entry?.norm).toBe('number')
  })
})
