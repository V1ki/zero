import { ALL_MEMORY_TYPES, type Memory, type MemoryType } from '@zero-os/shared'
import { invalidateClusterCache } from './clustering'
import type { EmbeddingProvider } from './embedding'
import type { MemoryRepository } from './store'
import type { MemoryVectorMeta, VectorIndexLike } from './vector-index'

const REINDEX_BATCH_SIZE = 10

export class IndexedMemoryStore implements MemoryRepository {
  constructor(
    private store: MemoryRepository,
    private embeddingClient: EmbeddingProvider,
    private vectorIndex: VectorIndexLike,
  ) {}

  // 按 memory id 串行化的 promise 链：store 写 + 向量 upsert + 失败回滚是跨 await 的复合操作，
  // 无串行化时并发同 id 写会(A)回滚用旧快照覆盖并发已提交的写、(B)磁盘与向量索引分叉（对抗实测 R14）。
  private readonly idChains = new Map<string, Promise<unknown>>()

  private async withIdLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.idChains.get(id) ?? Promise.resolve()
    // 串到上一持有者之后（忽略其成败），再运行 fn
    const run = prev.then(
      () => fn(),
      () => fn(),
    )
    const tail = run.then(
      () => {},
      () => {},
    )
    this.idChains.set(id, tail)
    try {
      return await run
    } finally {
      // 没有更晚的调用接在后面才清理，避免 map 泄漏
      if (this.idChains.get(id) === tail) this.idChains.delete(id)
    }
  }

  // P3a: 按内容找语义近邻，供活文档折叠治 tag 漂移漏判。
  // 给定 candidateIds（少数几条会话活文档）时直接取候选向量算精确余弦——
  // 全库 topK 召回会被历史同主题近重复挤掉候选（实测库里有 24 条同主题簇），不可靠。
  async findSimilar(
    input: { title: string; content: string; tags: string[] },
    opts?: { topK?: number; candidateIds?: string[]; minScore?: number },
  ): Promise<{ id: string; type: MemoryType; score: number } | undefined> {
    // 折叠是 best-effort：embedding/向量查询失败绝不能让上游的 memory create 失败。
    try {
      return await this.findSimilarUnsafe(input, opts)
    } catch {
      return undefined
    }
  }

  private async findSimilarUnsafe(
    input: { title: string; content: string; tags: string[] },
    opts?: { topK?: number; candidateIds?: string[]; minScore?: number },
  ): Promise<{ id: string; type: MemoryType; score: number } | undefined> {
    const text = this.embeddingClient.memoryToText({
      title: input.title,
      content: input.content,
      tags: input.tags,
    } as Memory)
    const vector = await this.embeddingClient.embed(text)
    const minScore = opts?.minScore ?? 0.9

    if (opts?.candidateIds?.length && this.vectorIndex.getVector) {
      let queryNorm = 0
      for (const x of vector) queryNorm += x * x
      queryNorm = Math.sqrt(queryNorm) || 1
      let best: { id: string; score: number } | undefined
      for (const id of opts.candidateIds) {
        const cand = await this.vectorIndex.getVector(id)
        if (!cand || cand.length !== vector.length) continue
        let dot = 0
        let candNorm = 0
        for (let d = 0; d < vector.length; d++) {
          dot += vector[d] * cand[d]
          candNorm += cand[d] * cand[d]
        }
        const score = dot / (queryNorm * (Math.sqrt(candNorm) || 1))
        if (!best || score > best.score) best = { id, score }
      }
      if (!best || best.score < minScore) return undefined
      const meta = await this.vectorIndex.getMetadata?.(best.id)
      const type = meta?.type as MemoryType | undefined
      return type ? { id: best.id, type, score: best.score } : undefined
    }

    const hits = await this.vectorIndex.query(vector, opts?.topK ?? 20)
    for (const hit of hits) {
      if (hit.score < minScore) return undefined
      const meta = await this.vectorIndex.getMetadata?.(hit.memoryId)
      const type = meta?.type as MemoryType | undefined
      if (type) return { id: hit.memoryId, type, score: hit.score }
    }
    return undefined
  }

  async create(
    type: MemoryType,
    title: string,
    content: string,
    options?: Partial<Memory>,
  ): Promise<Memory> {
    const memory = await this.store.create(type, title, content, options)

    try {
      await this.upsertMemory(memory, options?.sessionId)
      // 失效簇缓存：新成员入索引 → 簇组成变化。下沉到此处统一覆盖【所有写路径】(HTTP 端点/
      // session 删除/agent 工具/未来新路径)，避免散落在路由层漏调致陈旧簇(对抗实测 R12/R13)。
      invalidateClusterCache()
      return memory
    } catch (error) {
      await this.store.delete(type, memory.id)
      throw error
    }
  }

  async save(memory: Memory): Promise<void> {
    await this.store.save(memory)
  }

  get(type: MemoryType, id: string): Memory | undefined {
    return this.store.get(type, id)
  }

  getRelativePath(type: MemoryType, id: string): string {
    return this.store.getRelativePath(type, id)
  }

  list(type: MemoryType): Memory[] {
    return this.store.list(type)
  }

  searchByTags(tags: string[], types?: MemoryType[]): Memory[] {
    return this.store.searchByTags(tags, types)
  }

  async update(
    type: MemoryType,
    id: string,
    updates: Partial<Memory> | ((current: Memory) => Partial<Memory>),
    context?: { sessionId?: string; precondition?: (current: Memory) => boolean },
  ): Promise<Memory | undefined> {
    // 按 id 串行化：store 写 + upsert + 回滚 对同 id 原子，杜绝并发覆盖/分叉（R14）。
    return this.withIdLock(id, async () => {
      const existing = this.store.get(type, id)
      if (!existing) return undefined

      const updated = await this.store.update(type, id, updates, context)
      if (!updated) return undefined

      try {
        await this.upsertMemory(updated, context?.sessionId)
        invalidateClusterCache() // status/内容/向量变化 → 簇成员与权威建议变化
        return updated
      } catch (error) {
        // 持锁期间 existing 必为真实前像（无并发提交插入），回滚不会覆盖他人的写
        await this.store.save(existing)
        throw error
      }
    })
  }

  async delete(type: MemoryType, id: string): Promise<boolean> {
    return this.withIdLock(id, async () => {
      const existing = this.store.get(type, id)
      if (!existing) return false

      await this.vectorIndex.delete(id)
      const deleted = await this.store.delete(type, id)
      if (deleted) {
        invalidateClusterCache() // 成员移除 → 簇组成变化（覆盖 session 删除/agent 工具/任意删除路径）
        return true
      }

      await this.upsertMemory(existing)
      return false
    })
  }

  getAgentPreference(agentName: string): string {
    return this.store.getAgentPreference(agentName)
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const allTypes = ALL_MEMORY_TYPES
    let deleted = 0

    for (const type of allTypes) {
      for (const memory of this.store.list(type)) {
        if (memory.sessionId !== sessionId) continue
        if (await this.delete(type, memory.id)) {
          deleted++
        }
      }
    }

    return deleted
  }

  readByPath(
    path: string,
    options?: { from?: number; lines?: number },
  ): { path: string; text: string } | undefined {
    return this.store.readByPath(path, options)
  }

  async reindexAll(): Promise<number> {
    await this.vectorIndex.ensureIndex()

    const allTypes = ALL_MEMORY_TYPES
    const memories: Memory[] = []

    for (const type of allTypes) {
      memories.push(...this.store.list(type))
    }

    const pending: Memory[] = []

    for (const memory of memories) {
      const existingMeta = await this.vectorIndex.getMetadata?.(memory.id)
      if (existingMeta && this.isIndexedMemoryCurrent(memory, existingMeta)) {
        continue
      }

      pending.push(memory)
    }

    for (let index = 0; index < pending.length; index += REINDEX_BATCH_SIZE) {
      const batch = pending.slice(index, index + REINDEX_BATCH_SIZE)
      const texts = batch.map((memory) => this.embeddingClient.memoryToText(memory))
      const vectors = await this.embeddingClient.embedBatch(texts)

      for (const [offset, memory] of batch.entries()) {
        const vector = vectors[offset]
        if (!vector) {
          throw new Error(`Missing embedding vector for memory ${memory.id}`)
        }

        await this.vectorIndex.upsert(memory.id, vector, this.toVectorMeta(memory))
      }
    }

    return memories.length
  }

  private async upsertMemory(memory: Memory, sessionId?: string): Promise<void> {
    const vector = await this.embeddingClient.embed(
      this.embeddingClient.memoryToText(memory),
      sessionId,
    )
    await this.vectorIndex.upsert(memory.id, vector, this.toVectorMeta(memory))
  }

  private toVectorMeta(memory: Memory): MemoryVectorMeta {
    return {
      memoryId: memory.id,
      type: memory.type,
      title: memory.title,
      updatedAt: memory.updatedAt,
    }
  }

  private isIndexedMemoryCurrent(memory: Memory, meta: MemoryVectorMeta): boolean {
    return (
      meta.memoryId === memory.id &&
      meta.type === memory.type &&
      meta.title === memory.title &&
      meta.updatedAt === memory.updatedAt
    )
  }
}
