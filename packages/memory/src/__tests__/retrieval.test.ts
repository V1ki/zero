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
    await expect(
      retriever.retrieve('session memory', { confidenceThreshold: 0.1 }),
    ).resolves.toEqual([])

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

// P3/读柱：检索只取权威条 —— supersededBy/mergedInto 谱系重定向 + 权威去重。
describe('MemoryRetriever authority resolution', () => {
  let dir: string
  let store: MemoryStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-retrieval-authority-'))
    store = new MemoryStore(dir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRetriever(
    hits: Array<{ memoryId: string; score: number }>,
    metadataById: Map<string, MemoryVectorMeta>,
  ) {
    return new MemoryRetriever(
      store,
      createEmbeddingClient({ q: 1 }),
      createVectorIndex({ resultsByVector: { 1: hits }, metadataById }),
    )
  }

  const meta = (m: { id: string; type: string; title: string; updatedAt: string }): [
    string,
    MemoryVectorMeta,
  ] => [m.id, { memoryId: m.id, type: m.type, title: m.title, updatedAt: m.updatedAt }]

  test('superseded hit redirects to live authority (score inherited from hit)', async () => {
    const authority = await store.create('runbook', 'Deploy v2', 'new truth', {
      status: 'verified',
      confidence: 0.9,
    })
    const old = await store.create('runbook', 'Deploy v1', 'old truth', {
      status: 'archived',
      confidence: 0.85,
      supersededBy: authority.id,
    })
    const retriever = makeRetriever([{ memoryId: old.id, score: 0.95 }], new Map([meta(old)]))
    const results = await retriever.retrieveScored('q', { types: ['runbook'] })
    expect(results.length).toBe(1)
    expect(results[0]?.memory.id).toBe(authority.id)
    expect(results[0]?.resolvedFrom).toEqual([old.id])
    expect(results[0]?.scoreBreakdown.vector).toBe(0.95)
  })

  test('transitive chain resolves to final authority and dedupes multiple hits', async () => {
    const final = await store.create('note', 'Truth v3', 'final', {
      status: 'verified',
      confidence: 0.9,
    })
    const mid = await store.create('note', 'Truth v2', 'mid', {
      status: 'archived',
      confidence: 0.85,
      supersededBy: final.id,
    })
    const first = await store.create('note', 'Truth v1', 'first', {
      status: 'archived',
      confidence: 0.85,
      supersededBy: mid.id,
    })
    const retriever = makeRetriever(
      [
        { memoryId: first.id, score: 0.9 },
        { memoryId: mid.id, score: 0.8 },
        { memoryId: final.id, score: 0.7 },
      ],
      new Map([meta(first), meta(mid), meta(final)]),
    )
    const results = await retriever.retrieveScored('q', { types: ['note'] })
    expect(results.length).toBe(1)
    expect(results[0]?.memory.id).toBe(final.id)
    expect(results[0]?.scoreBreakdown.vector).toBe(0.9) // 取所有重定向命中的最高向量分
    expect(new Set(results[0]?.resolvedFrom)).toEqual(new Set([first.id, mid.id]))
  })

  test('cycle in lineage terminates and archived endpoints stay filtered', async () => {
    const a = await store.create('note', 'Cycle A', 'a', { status: 'archived', confidence: 0.9 })
    const b = await store.create('note', 'Cycle B', 'b', {
      status: 'archived',
      confidence: 0.9,
      supersededBy: a.id,
    })
    await store.update('note', a.id, { supersededBy: b.id })
    const retriever = makeRetriever([{ memoryId: a.id, score: 0.9 }], new Map([meta(a)]))
    const results = await retriever.retrieveScored('q', { types: ['note'] })
    expect(results).toEqual([]) // 不死循环；环内全归档 → 被状态过滤
  })

  test('broken pointer stays on current node; mergedInto redirects cross-type', async () => {
    const broken = await store.create('note', 'Broken ptr', 'x', {
      status: 'verified',
      confidence: 0.9,
      supersededBy: 'mem_missing_target',
    })
    const canonical = await store.create('runbook', 'Canonical doc', 'merged truth', {
      status: 'verified',
      confidence: 0.9,
    })
    const absorbed = await store.create('note', 'Absorbed note', 'y', {
      status: 'archived',
      confidence: 0.85,
      mergedInto: canonical.id,
    })
    const retriever = makeRetriever(
      [
        { memoryId: broken.id, score: 0.9 },
        { memoryId: absorbed.id, score: 0.8 },
      ],
      new Map([meta(broken), meta(absorbed)]),
    )
    const results = await retriever.retrieveScored('q', { types: ['note'] })
    expect(results.length).toBe(2)
    const ids = results.map((r) => r.memory.id)
    expect(ids).toContain(broken.id) // 指针断裂 → 留在原条（verified 仍可返回）
    expect(ids).toContain(canonical.id) // mergedInto 跨 type 重定向到权威条
  })
})

// 对抗评审修复回归锁：门槛回退(命中条或权威条任一满足) + 深链解析。
describe('MemoryRetriever authority gates & deep chains', () => {
  let dir: string
  let store: MemoryStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-retrieval-gates-'))
    store = new MemoryStore(dir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const meta2 = (m: { id: string; type: string; title: string; updatedAt: string }): [
    string,
    MemoryVectorMeta,
  ] => [m.id, { memoryId: m.id, type: m.type, title: m.title, updatedAt: m.updatedAt }]
  function mk(
    hits: Array<{ memoryId: string; score: number }>,
    metadataById: Map<string, MemoryVectorMeta>,
  ) {
    return new MemoryRetriever(
      store,
      createEmbeddingClient({ q: 1 }),
      createVectorIndex({ resultsByVector: { 1: hits }, metadataById }),
    )
  }

  test('confidence/tags gates pass when hit OR authority satisfies (authority delivered)', async () => {
    const lowConfAuth = await store.create('note', 'Auth low conf', 'truth', {
      status: 'verified',
      confidence: 0.3,
      tags: ['newtag'],
    })
    const highConfHit = await store.create('note', 'Hit high conf', 'old', {
      status: 'archived',
      confidence: 0.95,
      tags: ['oldtag'],
      supersededBy: lowConfAuth.id,
    })
    const retriever = mk([{ memoryId: highConfHit.id, score: 0.9 }], new Map([meta2(highConfHit)]))
    // 默认 confidenceThreshold 0.6：权威条 0.3 不够，但命中条 0.95 满足 → 仍交付权威条
    const byConf = await retriever.retrieveScored('q', { types: ['note'] })
    expect(byConf.length).toBe(1)
    expect(byConf[0]?.memory.id).toBe(lowConfAuth.id)
    // 按命中条历史 tag 查询：权威条没有该 tag，但命中条有 → 仍交付权威条
    const byTag = await retriever.retrieveScored('q', { types: ['note'], tags: ['oldtag'] })
    expect(byTag.length).toBe(1)
    expect(byTag[0]?.memory.id).toBe(lowConfAuth.id)
  })

  test('deep lineage chain (12 hops) resolves to final authority', async () => {
    const final = await store.create('note', 'Deep final', 'truth', {
      status: 'verified',
      confidence: 0.9,
    })
    let nextId = final.id
    let head = final
    for (let i = 0; i < 12; i++) {
      head = await store.create('note', `Deep n${i}`, `v${i}`, {
        status: 'archived',
        confidence: 0.8,
        supersededBy: nextId,
      })
      nextId = head.id
    }
    const retriever = mk([{ memoryId: head.id, score: 0.9 }], new Map([meta2(head)]))
    const results = await retriever.retrieveScored('q', { types: ['note'] })
    expect(results.length).toBe(1)
    expect(results[0]?.memory.id).toBe(final.id)
  })
})
