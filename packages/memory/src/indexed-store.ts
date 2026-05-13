import { ALL_MEMORY_TYPES, type Memory, type MemoryType } from '@zero-os/shared'
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

  async create(
    type: MemoryType,
    title: string,
    content: string,
    options?: Partial<Memory>,
  ): Promise<Memory> {
    const memory = await this.store.create(type, title, content, options)

    try {
      await this.upsertMemory(memory, options?.sessionId)
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
    updates: Partial<Memory>,
    context?: { sessionId?: string },
  ): Promise<Memory | undefined> {
    const existing = this.store.get(type, id)
    if (!existing) return undefined

    const updated = await this.store.update(type, id, updates, context)
    if (!updated) return undefined

    try {
      await this.upsertMemory(updated, context?.sessionId)
      return updated
    } catch (error) {
      await this.store.save(existing)
      throw error
    }
  }

  async delete(type: MemoryType, id: string): Promise<boolean> {
    const existing = this.store.get(type, id)
    if (!existing) return false

    await this.vectorIndex.delete(id)
    const deleted = await this.store.delete(type, id)
    if (deleted) return true

    await this.upsertMemory(existing)
    return false
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
