import {
  MemorySearchOptions,
  ScoredMemoryMatch,
  type Memory,
  type MemoryType,
  toErrorMessage,
} from '@zero-os/shared'
import type { EmbeddingProvider } from './embedding'
import type { MemoryRepository } from './store'
import type { VectorIndexLike } from './vector-index'

const DEFAULT_TYPES: MemoryType[] = ['preference', 'decision', 'note', 'runbook', 'incident']

export interface MemoryRetrieverConfig {
  vectorWeight?: number
  recencyWeight?: number
  recencyHalfLifeDays?: number
}

/**
 * Memory retriever — searches memories by relevance.
 * Uses vector retrieval plus recency ranking.
 */
export class MemoryRetriever {
  constructor(
    private store: MemoryRepository,
    private embeddingClient?: EmbeddingProvider,
    private vectorIndex?: VectorIndexLike,
    private config: MemoryRetrieverConfig = {},
  ) {}

  async retrieve(query: string, options: MemorySearchOptions = {}): Promise<Memory[]> {
    return (await this.retrieveScored(query, options)).map((entry) => entry.memory)
  }

  async retrieveScored(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<ScoredMemoryMatch[]> {
    const { topN = 5, confidenceThreshold = 0.6, minScore = 0, types, tags, status } = options
    if (!query.trim() || !this.embeddingClient || !this.vectorIndex) return []

    const targetTypes = types ?? DEFAULT_TYPES
    const targetTypeSet = new Set(targetTypes)

    let vectorResults: Array<{ memoryId: string; score: number }>
    try {
      const queryVector = await this.embeddingClient.embed(query)
      vectorResults = await this.vectorIndex.query(queryVector, Math.max(topN * 3, topN))
    } catch (error) {
      console.warn('[memory] vector retrieval failed', {
        message: toErrorMessage(error),
      })
      return []
    }

    if (vectorResults.length === 0) return []

    const vectorScoreMap = new Map(vectorResults.map((result) => [result.memoryId, result.score]))
    const unresolvedIds = new Set(vectorScoreMap.keys())
    const matchedMemories: Memory[] = []

    for (const memoryId of vectorScoreMap.keys()) {
      const meta = await this.vectorIndex.getMetadata?.(memoryId)
      if (!meta || !targetTypeSet.has(meta.type as MemoryType)) continue
      const memory = this.store.get(meta.type as MemoryType, memoryId)
      if (!memory) continue
      matchedMemories.push(memory)
      unresolvedIds.delete(memoryId)
    }

    if (unresolvedIds.size > 0) {
      for (const type of targetTypes) {
        for (const memory of this.store.list(type)) {
          if (!unresolvedIds.has(memory.id)) continue
          matchedMemories.push(memory)
          unresolvedIds.delete(memory.id)
        }
        if (unresolvedIds.size === 0) {
          break
        }
      }
    }

    const filtered = matchedMemories
      .filter((memory) => {
        if (status) return status.includes(memory.status)
        return memory.status === 'verified'
      })
      .filter((memory) => memory.confidence >= confidenceThreshold)
      .filter((memory) => {
        if (!tags?.length) return true
        return tags.some((tag) => memory.tags.includes(tag))
      })

    const scored = filtered.map((memory) => {
      const vector = vectorScoreMap.get(memory.id) ?? 0
      const recency = computeRecencyScore(memory, this.recencyHalfLifeDays)
      const scoreBreakdown = {
        keyword: 0,
        recency,
        vector,
      }
      const score = this.vectorWeight * vector + this.recencyWeight * recency

      return {
        memory,
        score,
        scoreBreakdown,
      }
    })

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.memory.confidence - a.memory.confidence
    })

    return scored.filter((entry) => entry.score >= minScore).slice(0, topN)
  }

  private get vectorWeight(): number {
    return this.config.vectorWeight ?? 0.8
  }

  private get recencyWeight(): number {
    return this.config.recencyWeight ?? 0.2
  }

  private get recencyHalfLifeDays(): number {
    return this.config.recencyHalfLifeDays ?? 30
  }
}

function computeRecencyScore(memory: Memory, recencyHalfLifeDays: number): number {
  const ageInDays = (Date.now() - new Date(memory.updatedAt).getTime()) / 86_400_000
  if (!Number.isFinite(ageInDays) || ageInDays < 0) return 1
  return Math.exp(-ageInDays / recencyHalfLifeDays)
}
