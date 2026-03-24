import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddingProvider } from '../embedding'
import { MemoryRetriever } from '../retrieval'
import { MemoryStore } from '../store'
import type { MemoryVectorMeta, VectorIndexLike } from '../vector-index'

function createEmbeddingClient(vectorsByText: Record<string, number>): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      return [vectorsByText[text] ?? 0]
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [vectorsByText[text] ?? 0])
    },
    memoryToText(memory) {
      return memory.title
    },
  }
}

function createVectorIndex(options: {
  resultsByVector: Record<number, Array<{ memoryId: string; score: number }>>
  metadataById?: Map<string, MemoryVectorMeta>
  failQuery?: boolean
}): VectorIndexLike {
  return {
    async ensureIndex() {},
    async upsert() {},
    async query(vector) {
      if (options.failQuery) {
        throw new Error('boom')
      }
      return options.resultsByVector[vector[0] ?? 0] ?? []
    },
    async delete() {},
    async getMetadata(memoryId) {
      return options.metadataById?.get(memoryId)
    },
    async getStats() {
      return { itemCount: options.metadataById?.size ?? 0 }
    },
  }
}

describe('MemoryRetriever', () => {
  let tmpDir: string
  let store: MemoryStore
  let retriever: MemoryRetriever
  let metadataById: Map<string, MemoryVectorMeta>

  let deployId = ''
  let databaseId = ''
  let redisId = ''
  let archivedId = ''
  let lowConfidenceId = ''
  let sessionId = ''

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zero-retrieval-'))
    store = new MemoryStore(tmpDir)

    const deploy = await store.create('note', 'Deploy API gateway', 'Deployed nginx API gateway', {
      tags: ['deploy', 'api', 'nginx'],
      status: 'verified',
      confidence: 0.9,
    })
    const database = await store.create(
      'incident',
      'Database timeout error',
      'Connection pool exhausted during peak load',
      {
        tags: ['incident', 'database', 'timeout'],
        status: 'verified',
        confidence: 0.85,
      },
    )
    const redis = await store.create('note', 'Setup guide for Redis', 'Install Redis for caching', {
      tags: ['redis', 'setup', 'cache'],
      status: 'verified',
      confidence: 0.7,
    })
    const archived = await store.create('note', 'Old archived note', 'This was archived', {
      tags: ['old'],
      status: 'archived',
      confidence: 0.5,
    })
    const lowConfidence = await store.create(
      'note',
      'Low confidence note',
      'Some uncertain information',
      {
        tags: ['uncertain'],
        status: 'verified',
        confidence: 0.3,
      },
    )
    const sessionMemory = await store.create(
      'session',
      'Session deploy history',
      'Historical deploy notes',
      {
        tags: ['deploy', 'session'],
        status: 'verified',
        confidence: 0.95,
      },
    )

    deployId = deploy.id
    databaseId = database.id
    redisId = redis.id
    archivedId = archived.id
    lowConfidenceId = lowConfidence.id
    sessionId = sessionMemory.id

    metadataById = new Map(
      [deploy, database, redis, archived, lowConfidence, sessionMemory].map((memory) => [
        memory.id,
        {
          memoryId: memory.id,
          type: memory.type,
          title: memory.title,
          updatedAt: memory.updatedAt,
        },
      ]),
    )

    retriever = new MemoryRetriever(
      store,
      createEmbeddingClient({
        deploy: 1,
        'database timeout': 2,
        'archived note': 3,
        uncertain: 4,
        'session memory': 5,
        'mixed results': 6,
        'missing metadata': 7,
      }),
      createVectorIndex({
        metadataById,
        resultsByVector: {
          1: [
            { memoryId: deployId, score: 0.95 },
            { memoryId: databaseId, score: 0.2 },
          ],
          2: [
            { memoryId: databaseId, score: 0.93 },
            { memoryId: deployId, score: 0.1 },
          ],
          3: [{ memoryId: archivedId, score: 0.96 }],
          4: [{ memoryId: lowConfidenceId, score: 0.95 }],
          5: [{ memoryId: sessionId, score: 0.98 }],
          6: [
            { memoryId: deployId, score: 0.92 },
            { memoryId: redisId, score: 0.91 },
            { memoryId: databaseId, score: 0.9 },
          ],
          7: [{ memoryId: deployId, score: 0.94 }],
        },
      }),
      {
        vectorWeight: 0.8,
        recencyWeight: 0.2,
        recencyHalfLifeDays: 30,
      },
    )
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('empty query on empty store returns empty array', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'zero-retrieval-empty-'))
    const emptyStore = new MemoryStore(emptyDir)
    const emptyRetriever = new MemoryRetriever(emptyStore)

    const results = await emptyRetriever.retrieve('')
    expect(results).toEqual([])

    rmSync(emptyDir, { recursive: true, force: true })
  })

  test('returns empty when no vector capability is configured', async () => {
    const noVectorRetriever = new MemoryRetriever(store)

    await expect(noVectorRetriever.retrieveScored('deploy')).resolves.toEqual([])
  })

  test('vector scoring returns deploy memory with vector contribution only', async () => {
    const results = await retriever.retrieveScored('deploy', { topN: 3 })

    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.memory.title).toBe('Deploy API gateway')
    expect(results[0]?.scoreBreakdown.vector).toBeDefined()
    expect(results[0]?.scoreBreakdown.keyword).toBe(0)
  })

  test('tag filter narrows vector matches after retrieval', async () => {
    const results = await retriever.retrieve('mixed results', { tags: ['database'] })

    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Database timeout error')
  })

  test('confidenceThreshold filters low confidence memories', async () => {
    const results = await retriever.retrieve('uncertain')

    expect(results).toEqual([])
  })

  test('low confidenceThreshold includes low confidence memories', async () => {
    const results = await retriever.retrieve('uncertain', { confidenceThreshold: 0.1 })

    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Low confidence note')
  })

  test('topN limits results', async () => {
    const results = await retriever.retrieve('mixed results', { topN: 1 })

    expect(results).toHaveLength(1)
  })

  test('default excludes archived status', async () => {
    const results = await retriever.retrieve('archived note', { confidenceThreshold: 0.1 })

    expect(results).toEqual([])
  })

  test('specified status filter returns archived memories', async () => {
    const results = await retriever.retrieve('archived note', {
      status: ['archived'],
      confidenceThreshold: 0.1,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(archivedId)
  })

  test('default retrieval excludes session memories but explicit types can include them', async () => {
    await expect(retriever.retrieve('session memory', { confidenceThreshold: 0.1 })).resolves.toEqual(
      [],
    )

    const results = await retriever.retrieve('session memory', {
      confidenceThreshold: 0.1,
      types: ['session'],
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(sessionId)
  })

  test('minScore filters out lower scoring matches', async () => {
    const results = await retriever.retrieveScored('deploy', { minScore: 0.7 })

    expect(results).toHaveLength(1)
    expect(results[0]?.memory.id).toBe(deployId)
  })

  test('vector failure returns empty results', async () => {
    const failingRetriever = new MemoryRetriever(
      store,
      createEmbeddingClient({ 'database timeout': 2 }),
      createVectorIndex({
        metadataById,
        resultsByVector: {},
        failQuery: true,
      }),
    )

    await expect(failingRetriever.retrieveScored('database timeout')).resolves.toEqual([])
  })

  test('falls back to store scans when vector metadata is unavailable', async () => {
    const fallbackRetriever = new MemoryRetriever(
      store,
      createEmbeddingClient({ 'missing metadata': 7 }),
      createVectorIndex({
        resultsByVector: {
          7: [{ memoryId: deployId, score: 0.94 }],
        },
      }),
    )

    const results = await fallbackRetriever.retrieve('missing metadata')

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(deployId)
  })

  test('recency boosts newer memories when vector signal is tied', async () => {
    const recentDir = mkdtempSync(join(tmpdir(), 'zero-retrieval-recency-'))
    const recentStore = new MemoryStore(recentDir)
    const oldMemory = await recentStore.create('note', 'Deploy notes old', 'deploy notes', {
      tags: ['deploy'],
      status: 'verified',
      confidence: 0.8,
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    const recentMemory = await recentStore.create('note', 'Deploy notes recent', 'deploy notes', {
      tags: ['deploy'],
      status: 'verified',
      confidence: 0.8,
      updatedAt: '2026-03-10T00:00:00.000Z',
    })

    const recentMetadata = new Map(
      [oldMemory, recentMemory].map((memory) => [
        memory.id,
        {
          memoryId: memory.id,
          type: memory.type,
          title: memory.title,
          updatedAt: memory.updatedAt,
        },
      ]),
    )
    const recentRetriever = new MemoryRetriever(
      recentStore,
      createEmbeddingClient({ deploy: 1 }),
      createVectorIndex({
        metadataById: recentMetadata,
        resultsByVector: {
          1: [
            { memoryId: oldMemory.id, score: 0.8 },
            { memoryId: recentMemory.id, score: 0.8 },
          ],
        },
      }),
      {
        vectorWeight: 0.8,
        recencyWeight: 0.2,
        recencyHalfLifeDays: 30,
      },
    )

    const results = await recentRetriever.retrieveScored('deploy')

    expect(results[0]?.memory.id).toBe(recentMemory.id)
    expect(results[1]?.memory.id).toBe(oldMemory.id)

    rmSync(recentDir, { recursive: true, force: true })
  })
})
