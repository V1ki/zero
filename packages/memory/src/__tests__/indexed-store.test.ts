import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddingProvider } from '../embedding'
import { IndexedMemoryStore } from '../indexed-store'
import { MemoryStore } from '../store'
import type { MemoryVectorMeta, VectorIndexLike } from '../vector-index'

describe('IndexedMemoryStore', () => {
  let dir: string
  let baseStore: MemoryStore
  let upserts: string[]
  let deletes: string[]
  let batchCalls: string[][]
  let failNextUpsert = false
  let metadataById: Map<string, MemoryVectorMeta>

  const embeddingClient: EmbeddingProvider = {
    async embed(text: string): Promise<number[]> {
      return [text.length, 1]
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      batchCalls.push(texts)
      return texts.map((text) => [text.length, 1])
    },
    memoryToText(memory) {
      return `${memory.title}\n${memory.content}`
    },
  }

  const vectorIndex: VectorIndexLike = {
    async ensureIndex() {},
    async upsert(memoryId) {
      if (failNextUpsert) {
        failNextUpsert = false
        throw new Error('upsert failed')
      }
      upserts.push(memoryId)
    },
    async query() {
      return []
    },
    async delete(memoryId) {
      deletes.push(memoryId)
    },
    async getMetadata(memoryId) {
      return metadataById.get(memoryId)
    },
    async getStats() {
      return { itemCount: upserts.length }
    },
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-indexed-store-'))
    baseStore = new MemoryStore(dir)
    upserts = []
    deletes = []
    batchCalls = []
    metadataById = new Map()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('create writes both store and vector index', async () => {
    const store = new IndexedMemoryStore(baseStore, embeddingClient, vectorIndex)
    const memory = await store.create('note', 'Deploy', 'Ship it', {
      status: 'verified',
    })

    expect(baseStore.get('note', memory.id)?.title).toBe('Deploy')
    expect(upserts).toContain(memory.id)
  })

  test('create rolls back file when vector upsert fails', async () => {
    const store = new IndexedMemoryStore(baseStore, embeddingClient, vectorIndex)
    failNextUpsert = true

    await expect(store.create('note', 'Broken', 'Should rollback')).rejects.toThrow('upsert failed')
    expect(baseStore.list('note').some((memory) => memory.title === 'Broken')).toBe(false)
  })

  test('update restores previous memory when vector upsert fails', async () => {
    const store = new IndexedMemoryStore(baseStore, embeddingClient, vectorIndex)
    const memory = await store.create('note', 'Stable', 'Before update', {
      status: 'verified',
    })

    failNextUpsert = true
    await expect(store.update('note', memory.id, { content: 'After update' })).rejects.toThrow(
      'upsert failed',
    )
    expect(baseStore.get('note', memory.id)?.content).toBe('Before update')
  })

  test('delete removes vector and markdown file', async () => {
    const store = new IndexedMemoryStore(baseStore, embeddingClient, vectorIndex)
    const memory = await store.create('note', 'Remove me', 'bye', {
      status: 'verified',
    })

    await expect(store.delete('note', memory.id)).resolves.toBe(true)
    expect(baseStore.get('note', memory.id)).toBeUndefined()
    expect(deletes).toContain(memory.id)
  })

  test('reindexAll replays all memories into vector index', async () => {
    const reindexDir = mkdtempSync(join(tmpdir(), 'zero-indexed-reindex-'))
    const reindexBaseStore = new MemoryStore(reindexDir)
    await reindexBaseStore.create('note', 'One', 'first', { status: 'verified' })
    await reindexBaseStore.create('note', 'Two', 'second', { status: 'verified' })

    const seen: string[] = []
    const reindexStore = new IndexedMemoryStore(reindexBaseStore, embeddingClient, {
      async ensureIndex() {},
      async upsert(memoryId) {
        seen.push(memoryId)
      },
      async query() {
        return []
      },
      async delete() {},
      async getStats() {
        return { itemCount: seen.length }
      },
    })

    await expect(reindexStore.reindexAll()).resolves.toBe(2)
    expect(seen).toHaveLength(2)

    rmSync(reindexDir, { recursive: true, force: true })
  })

  test('reindexAll skips memories with current vector metadata', async () => {
    const reindexDir = mkdtempSync(join(tmpdir(), 'zero-indexed-skip-'))
    const reindexBaseStore = new MemoryStore(reindexDir)
    const current = await reindexBaseStore.create('note', 'Current', 'same', { status: 'verified' })
    const stale = await reindexBaseStore.create('note', 'Stale', 'needs update', {
      status: 'verified',
    })

    const seen: string[] = []
    const embedTexts: string[][] = []
    const reindexStore = new IndexedMemoryStore(
      reindexBaseStore,
      {
        async embed(): Promise<number[]> {
          throw new Error('reindexAll should use embedBatch')
        },
        async embedBatch(texts: string[]): Promise<number[][]> {
          embedTexts.push(texts)
          return texts.map((text) => [text.length, 1])
        },
        memoryToText(memory) {
          return `${memory.title}\n${memory.content}`
        },
      },
      {
        async ensureIndex() {},
        async upsert(memoryId) {
          seen.push(memoryId)
        },
        async query() {
          return []
        },
        async delete() {},
        async getMetadata(memoryId) {
          if (memoryId === current.id) {
            return {
              memoryId: current.id,
              type: current.type,
              title: current.title,
              updatedAt: current.updatedAt,
            }
          }
          return undefined
        },
        async getStats() {
          return { itemCount: seen.length }
        },
      },
    )

    await expect(reindexStore.reindexAll()).resolves.toBe(2)
    expect(seen).toEqual([stale.id])
    expect(embedTexts).toHaveLength(1)
    expect(embedTexts[0]).toEqual([`${stale.title}\n${stale.content}`])

    rmSync(reindexDir, { recursive: true, force: true })
  })

  test('reindexAll splits pending memories into provider-safe batches', async () => {
    const reindexDir = mkdtempSync(join(tmpdir(), 'zero-indexed-batches-'))
    const reindexBaseStore = new MemoryStore(reindexDir)
    const memoryCount = 21

    for (let index = 0; index < memoryCount; index++) {
      await reindexBaseStore.create('note', `Batch ${index}`, `content ${index}`, {
        status: 'verified',
      })
    }

    const batchSizes: number[] = []
    const seen: string[] = []
    const reindexStore = new IndexedMemoryStore(
      reindexBaseStore,
      {
        async embed(): Promise<number[]> {
          throw new Error('reindexAll should use embedBatch')
        },
        async embedBatch(texts: string[]): Promise<number[][]> {
          batchSizes.push(texts.length)
          if (texts.length > 10) {
            throw new Error(`batch too large: ${texts.length}`)
          }
          return texts.map((text) => [text.length, 1])
        },
        memoryToText(memory) {
          return `${memory.title}\n${memory.content}`
        },
      },
      {
        async ensureIndex() {},
        async upsert(memoryId) {
          seen.push(memoryId)
        },
        async query() {
          return []
        },
        async delete() {},
        async getStats() {
          return { itemCount: seen.length }
        },
      },
    )

    await expect(reindexStore.reindexAll()).resolves.toBe(memoryCount)
    expect(batchSizes).toEqual([10, 10, 1])
    expect(seen).toHaveLength(memoryCount)

    rmSync(reindexDir, { recursive: true, force: true })
  })

  test('findSimilar with candidates uses direct cosine via getVector (immune to topK recall)', async () => {
    const fixedEmbedding: EmbeddingProvider = {
      async embed() {
        return [1, 0]
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => [1, 0])
      },
      memoryToText(memory) {
        return `${memory.title}\n${memory.content}`
      },
    }
    const vectors = new Map<string, number[]>([
      ['doc1', [1, 0]], // cos = 1
      ['doc2', [0, 1]], // cos = 0
    ])
    const meta = new Map<string, MemoryVectorMeta>([
      ['doc1', { memoryId: 'doc1', type: 'runbook', title: 'D1', updatedAt: 'x' }],
    ])
    const store = new IndexedMemoryStore(baseStore, fixedEmbedding, {
      async ensureIndex() {},
      async upsert() {},
      async query() {
        throw new Error('candidate path must not call global query')
      },
      async delete() {},
      async getMetadata(id) {
        return meta.get(id)
      },
      async getVector(id) {
        return vectors.get(id)
      },
      async getStats() {
        return { itemCount: 0 }
      },
    })
    const match = await store.findSimilar(
      { title: 't', content: 'c', tags: [] },
      { candidateIds: ['doc1', 'doc2'], minScore: 0.9 },
    )
    expect(match?.id).toBe('doc1')
    expect(match?.type).toBe('runbook')
    expect(match?.score).toBeCloseTo(1, 5)

    const below = await store.findSimilar(
      { title: 't', content: 'c', tags: [] },
      { candidateIds: ['doc2'], minScore: 0.9 },
    )
    expect(below).toBeUndefined()
  })

  test('findSimilar without candidates falls back to global query path', async () => {
    const store = new IndexedMemoryStore(baseStore, embeddingClient, {
      async ensureIndex() {},
      async upsert() {},
      async query() {
        return [{ memoryId: 'doc2', score: 0.8 }]
      },
      async delete() {},
      async getMetadata() {
        return undefined
      },
      async getStats() {
        return { itemCount: 0 }
      },
    })
    const match = await store.findSimilar(
      { title: 't', content: 'c', tags: [] },
      { minScore: 0.92 },
    )
    expect(match).toBeUndefined()
  })
})
