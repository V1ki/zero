import { LocalIndex } from 'vectra'

export interface MemoryVectorMeta extends Record<string, string> {
  memoryId: string
  type: string
  title: string
  updatedAt: string
}

export interface VectorIndexLike {
  ensureIndex(): Promise<void>
  upsert(memoryId: string, vector: number[], meta: MemoryVectorMeta): Promise<void>
  query(vector: number[], topK: number): Promise<Array<{ memoryId: string; score: number }>>
  delete(memoryId: string): Promise<void>
  getMetadata?(memoryId: string): Promise<MemoryVectorMeta | undefined>
  getVector?(memoryId: string): Promise<number[] | undefined>
  listAll?(): Promise<
    Array<{ memoryId: string; vector: number[]; norm: number; meta: MemoryVectorMeta }>
  >
  getStats(): Promise<{ itemCount: number }>
}

export class VectorIndex implements VectorIndexLike {
  private index: LocalIndex<MemoryVectorMeta>

  constructor(indexPath: string) {
    this.index = new LocalIndex<MemoryVectorMeta>(indexPath)
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.index.isIndexCreated()
    if (exists) return

    await this.index.createIndex({
      version: 1,
    })
  }

  async upsert(memoryId: string, vector: number[], meta: MemoryVectorMeta): Promise<void> {
    await this.ensureIndex()
    await this.index.upsertItem({
      id: memoryId,
      vector,
      metadata: {
        ...meta,
        memoryId,
      },
    })
  }

  async query(vector: number[], topK: number): Promise<Array<{ memoryId: string; score: number }>> {
    await this.ensureIndex()
    const results = await this.index.queryItems(vector, topK)
    return results.map((result) => ({
      memoryId: result.item.id,
      score: normalizeScore(result.score),
    }))
  }

  async delete(memoryId: string): Promise<void> {
    const exists = await this.index.isIndexCreated()
    if (!exists) return
    const existing = await this.index.getItem(memoryId)
    if (!existing) return
    await this.index.deleteItem(memoryId)
  }

  async getMetadata(memoryId: string): Promise<MemoryVectorMeta | undefined> {
    const exists = await this.index.isIndexCreated()
    if (!exists) return undefined

    const item = await this.index.getItem(memoryId)
    return item?.metadata
  }

  async getVector(memoryId: string): Promise<number[] | undefined> {
    const exists = await this.index.isIndexCreated()
    if (!exists) return undefined

    const item = await this.index.getItem(memoryId)
    return item?.vector
  }

  // 列出全部 item（向量 + norm + 元数据），供离线/按需聚类用。
  async listAll(): Promise<
    Array<{ memoryId: string; vector: number[]; norm: number; meta: MemoryVectorMeta }>
  > {
    const exists = await this.index.isIndexCreated()
    if (!exists) return []
    const items = await this.index.listItems()
    return items.map((it) => ({
      memoryId: it.id,
      vector: it.vector,
      norm: it.norm,
      meta: it.metadata,
    }))
  }

  async getStats(): Promise<{ itemCount: number }> {
    const exists = await this.index.isIndexCreated()
    if (!exists) {
      return { itemCount: 0 }
    }

    const stats = await this.index.getIndexStats()
    return { itemCount: stats.items }
  }
}

function normalizeScore(score: number): number {
  if (Number.isNaN(score)) return 0
  if (score >= 0 && score <= 1) return score
  return Math.max(0, Math.min(1, (score + 1) / 2))
}
