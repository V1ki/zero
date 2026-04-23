import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore } from '../store'

const testDir = join(import.meta.dir, '__fixtures__/memory')

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('MemoryStore', () => {
  afterAll(() => {
    rmSync(join(import.meta.dir, '__fixtures__'), { recursive: true, force: true })
  })

  test('create and get memory', async () => {
    mkdirSync(testDir, { recursive: true })
    const store = new MemoryStore(testDir)

    const mem = await store.create('note', 'Test Note', 'This is a test note.', {
      tags: ['test', 'note'],
      confidence: 0.9,
    })

    expect(mem.id).toMatch(/^mem_/)
    expect(mem.type).toBe('note')
    expect(mem.title).toBe('Test Note')
    expect(mem.content).toBe('This is a test note.')
    expect(mem.tags).toContain('test')

    // Read it back
    const retrieved = store.get('note', mem.id)
    expect(expectDefined(retrieved).title).toBe('Test Note')
    expect(expectDefined(retrieved).content).toBe('This is a test note.')
  })

  test('create rejects duplicate explicit id across types', async () => {
    mkdirSync(testDir, { recursive: true })
    const store = new MemoryStore(testDir)

    const first = await store.create('note', 'First', 'Original', {
      id: 'mem_fixed_duplicate',
    })
    expect(first.id).toBe('mem_fixed_duplicate')

    await expect(
      store.create('decision', 'Second', 'Should fail', {
        id: 'mem_fixed_duplicate',
      }),
    ).rejects.toThrow('Memory id already exists')
  })

  test('save rejects duplicate id across types', async () => {
    const store = new MemoryStore(testDir)
    const first = await store.create('note', 'Saved Once', 'Original')

    await expect(
      store.save({
        ...first,
        type: 'decision',
        title: 'Conflicting copy',
      }),
    ).rejects.toThrow('Memory id already exists in another type')
  })

  test('create releases temporary id lock after success', async () => {
    const store = new MemoryStore(testDir)
    const created = await store.create('note', 'Lock Cleanup', 'No stale lock')

    const lockDir = join(testDir, '.id-locks')
    expect(created.id).toMatch(/^mem_/)
    if (existsSync(lockDir)) {
      expect(readdirSync(lockDir)).toHaveLength(0)
    }
  })

  test('list memories by type', async () => {
    const store = new MemoryStore(testDir)

    await store.create('incident', 'Incident 1', 'First incident')
    await store.create('incident', 'Incident 2', 'Second incident')
    await store.create('note', 'Note 1', 'A note')

    const incidents = store.list('incident')
    expect(incidents.length).toBeGreaterThanOrEqual(2)

    const notes = store.list('note')
    expect(notes.length).toBeGreaterThanOrEqual(1)
  })

  test('update memory', async () => {
    const store = new MemoryStore(testDir)
    const mem = await store.create('decision', 'Test Decision', 'Original content')

    const updated = await store.update('decision', mem.id, {
      content: 'Updated content',
      status: 'verified',
      confidence: 0.95,
    })

    const updatedMemory = expectDefined(updated)
    expect(updatedMemory.content).toBe('Updated content')
    expect(updatedMemory.status).toBe('verified')
    expect(updatedMemory.confidence).toBe(0.95)
  })

  test('delete memory', async () => {
    const store = new MemoryStore(testDir)
    const mem = await store.create('note', 'To Delete', 'Will be deleted')

    expect(await store.delete('note', mem.id)).toBe(true)
    expect(store.get('note', mem.id)).toBeUndefined()
    expect(await store.delete('note', mem.id)).toBe(false)
  })

  test('searchByTags finds matching memories', async () => {
    const store = new MemoryStore(testDir)
    await store.create('runbook', 'Deploy Process', 'Steps to deploy', {
      tags: ['deploy', 'ops'],
    })
    await store.create('runbook', 'Backup Process', 'Steps to backup', {
      tags: ['backup', 'ops'],
    })

    const results = store.searchByTags(['deploy'])
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].tags).toContain('deploy')
  })

  test('parseFile keeps optional access metadata when present', async () => {
    const store = new MemoryStore(testDir)
    const memory = await store.create('note', 'Accessed Note', 'Track access metadata', {
      accessCount: 3,
      lastAccessedAt: '2026-03-11T00:00:00.000Z',
    })

    const retrieved = store.get('note', memory.id)
    expect(retrieved?.accessCount).toBe(3)
    expect(retrieved?.lastAccessedAt).toBe('2026-03-11T00:00:00.000Z')
  })
})
