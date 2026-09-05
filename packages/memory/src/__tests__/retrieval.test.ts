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
    // v2:词面通道已实现,title/tags 命中查询 token 时 keyword > 0,gate 为门槛分
    expect(results[0]?.scoreBreakdown.keyword).toBeGreaterThan(0)
    expect(results[0]?.scoreBreakdown.gate).toBeDefined()
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

  test('usage score biases ordering between similarly relevant memories', async () => {
    const retrieverWithUsage = new MemoryRetriever(
      store,
      createEmbeddingClient({ 'mixed results': 6 }),
      createVectorIndex({
        metadataById,
        resultsByVector: {
          6: [
            { memoryId: deployId, score: 0.92 },
            { memoryId: redisId, score: 0.92 },
            { memoryId: databaseId, score: 0.9 },
          ],
        },
      }),
      {
        rankUsageBias: 0.05,
        usageScore: (id) => (id === redisId ? 1 : 0),
      },
    )

    const results = await retrieverWithUsage.retrieveScored('mixed results', {
      confidenceThreshold: 0.1,
    })

    // deploy/redis 向量同分(门槛分并列)→ 满 usage 的 redis 靠排序偏置反超;
    // 偏置只重排,不改变 database 门槛分最低的事实。
    expect(results[0]?.memory.id).toBe(redisId)
    expect(results[0]?.scoreBreakdown.usage).toBe(1)
    expect(results.find((entry) => entry.memory.id === deployId)?.scoreBreakdown.usage).toBe(0)
  })

  test('full usage cannot push a low-relevance memory past minScore', async () => {
    const retrieverWithUsage = new MemoryRetriever(
      store,
      createEmbeddingClient({ lowrel: 1 }),
      createVectorIndex({
        metadataById,
        resultsByVector: {
          1: [
            { memoryId: deployId, score: 0.95 },
            { memoryId: databaseId, score: 0.3 },
          ],
        },
      }),
      {
        rankUsageBias: 0.05,
        usageScore: (id) => (id === databaseId ? 1 : 0),
      },
    )

    const results = await retrieverWithUsage.retrieveScored('lowrel', {
      minScore: 0.7,
      confidenceThreshold: 0.1,
    })

    // database: 向量 0.3 校准后为 0,词面无命中 → 门槛分 0,满 usage 也只是排序偏置,
    // 不参与 minScore 判定——低相关穿不透门槛。
    expect(results.map((entry) => entry.memory.id)).toEqual([deployId])
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
        recencyHalfLifeDays: 30,
      },
    )

    const results = await recentRetriever.retrieveScored('deploy')

    expect(results[0]?.memory.id).toBe(recentMemory.id)
    expect(results[1]?.memory.id).toBe(oldMemory.id)

    rmSync(recentDir, { recursive: true, force: true })
  })

  // 对抗R8回归：不可解析的 updatedAt → recency=0（最旧），不被最高加成顶到前面。
  test('recency treats an unparseable updatedAt as oldest, not max-boosted', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'zero-retrieval-badrecency-'))
    const badStore = new MemoryStore(badDir)
    const good = await badStore.create('note', 'Good', 'deploy notes', {
      tags: ['deploy'],
      status: 'verified',
      confidence: 0.8,
      updatedAt: '2026-03-10T00:00:00.000Z',
    })
    const bad = await badStore.create('note', 'Bad', 'deploy notes', {
      tags: ['deploy'],
      status: 'verified',
      confidence: 0.8,
      updatedAt: 'not-a-date',
    })
    const metadata = new Map(
      [good, bad].map((m) => [
        m.id,
        { memoryId: m.id, type: m.type, title: m.title, updatedAt: m.updatedAt },
      ]),
    )
    const retriever = new MemoryRetriever(
      badStore,
      createEmbeddingClient({ deploy: 1 }),
      createVectorIndex({
        metadataById: metadata,
        resultsByVector: {
          1: [
            { memoryId: good.id, score: 0.8 },
            { memoryId: bad.id, score: 0.8 },
          ],
        },
      }),
      { recencyHalfLifeDays: 30 },
    )
    const results = await retriever.retrieveScored('deploy')
    expect(results[0]?.memory.id).toBe(good.id) // NaN 日期的 bad 不被顶到第一
    rmSync(badDir, { recursive: true, force: true })
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

// 打分 v2 回归锁:门槛分 = 校准向量 + 词面重叠(纯相关性),recency/usage 只做排序偏置。
describe('MemoryRetriever scoring v2 (relevance gate + ordering bias)', () => {
  let dir: string
  let store: MemoryStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-retrieval-v2-'))
    store = new MemoryStore(dir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const meta = (m: { id: string; type: string; title: string; updatedAt: string }): [
    string,
    MemoryVectorMeta,
  ] => [m.id, { memoryId: m.id, type: m.type, title: m.title, updatedAt: m.updatedAt }]

  function makeRetriever(
    hits: Array<{ memoryId: string; score: number }>,
    metadataById: Map<string, MemoryVectorMeta>,
  ) {
    return new MemoryRetriever(
      store,
      {
        // 任意查询都嵌入到向量 [1];词面通道由真实查询文本驱动
        async embed() {
          return [1]
        },
        async embedBatch(texts: string[]) {
          return texts.map(() => [1])
        },
        memoryToText(memory) {
          return memory.title
        },
      },
      createVectorIndex({ resultsByVector: { 1: hits }, metadataById }),
    )
  }

  test('minScore gates on relevance: stale exact-match survives, fresh zero-overlap drops', async () => {
    const stale = await store.create(
      'runbook',
      'ASR transcript pipeline',
      'yt-dlp download audio',
      {
        tags: ['asr'],
        status: 'verified',
        confidence: 0.9,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    )
    const fresh = await store.create('note', 'Cooking notes', 'recipes for dinner', {
      tags: ['cooking'],
      status: 'verified',
      confidence: 0.95,
    })
    const retriever = makeRetriever(
      [
        { memoryId: stale.id, score: 0.8 },
        { memoryId: fresh.id, score: 0.5 },
      ],
      new Map([meta(stale), meta(fresh)]),
    )

    const results = await retriever.retrieveScored('yt-dlp asr', {
      minScore: 0.5,
      confidenceThreshold: 0.5,
    })

    // 陈旧但词面精确命中 + 高向量 → 门槛 0.75+0.25*0.7=0.925 通过;新写但零重叠 →
    // 门槛 0.75*0.375≈0.281 被拦——recency 满分也救不了(排序偏置不参与门槛判定)。
    expect(results.map((entry) => entry.memory.id)).toEqual([stale.id])
    expect(results[0]?.scoreBreakdown.gate).toBeCloseTo(0.925, 3)
  })

  test('calibration anchors: floor→0, ceiling→1, beyond clamps; breakdown.vector stays raw', async () => {
    const a = await store.create('note', 'Alpha note', 'alpha', {
      status: 'verified',
      confidence: 0.9,
    })
    const b = await store.create('note', 'Beta note', 'beta', {
      status: 'verified',
      confidence: 0.9,
    })
    const c = await store.create('note', 'Gamma note', 'gamma', {
      status: 'verified',
      confidence: 0.9,
    })
    const retriever = makeRetriever(
      [
        { memoryId: a.id, score: 0.35 },
        { memoryId: b.id, score: 0.75 },
        { memoryId: c.id, score: 0.95 },
      ],
      new Map([meta(a), meta(b), meta(c)]),
    )

    const results = await retriever.retrieveScored('zzz unmatched', { confidenceThreshold: 0.5 })

    const byTitle = new Map(results.map((entry) => [entry.memory.title, entry]))
    // 查询与三条零词面重叠 → gate 纯由校准向量决定(默认锚点 0.35/0.75,向量权重 0.75)
    expect(byTitle.get('Alpha note')?.scoreBreakdown.gate).toBeCloseTo(0, 3)
    expect(byTitle.get('Beta note')?.scoreBreakdown.gate).toBeCloseTo(0.75, 3)
    expect(byTitle.get('Gamma note')?.scoreBreakdown.gate).toBeCloseTo(0.75, 3)
    // vector 字段保留原始 cosine,不被校准覆盖(UI/trace 兼容)
    expect(byTitle.get('Gamma note')?.scoreBreakdown.vector).toBe(0.95)
  })

  test('rare-token overlap outranks common-token overlap at equal vector score', async () => {
    const common = await store.create('note', 'video download', 'download video', {
      tags: ['video'],
      status: 'verified',
      confidence: 0.9,
    })
    const rare = await store.create('note', 'video yt-dlp', 'download video via yt-dlp', {
      tags: ['video'],
      status: 'verified',
      confidence: 0.9,
    })
    const other = await store.create('note', 'cooking recipes', 'dinner ideas', {
      tags: ['cooking'],
      status: 'verified',
      confidence: 0.9,
    })
    const retriever = makeRetriever(
      [
        { memoryId: common.id, score: 0.8 },
        { memoryId: rare.id, score: 0.8 },
        { memoryId: other.id, score: 0.8 },
      ],
      new Map([meta(common), meta(rare), meta(other)]),
    )

    const results = await retriever.retrieveScored('yt-dlp video', { confidenceThreshold: 0.5 })

    // 'video' 池内 2/3 命中(常见)权重低;'yt-dlp/yt/dlp' 仅 1/3 持有(稀有)权重高——
    // 等向量分下词面通道把稀有 token 命中者排到最前。
    expect(results.map((entry) => entry.memory.title)).toEqual([
      'video yt-dlp',
      'video download',
      'cooking recipes',
    ])
  })
})
