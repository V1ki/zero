import {
  ALL_MEMORY_TYPES,
  type Memory,
  type MemorySearchOptions,
  type MemoryType,
  type ScoredMemoryMatch,
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
    const {
      topN = 5,
      confidenceThreshold = 0.6,
      minScore = 0,
      types,
      tags,
      status,
      sessionId,
    } = options
    if (!query.trim() || !this.embeddingClient || !this.vectorIndex) return []

    const targetTypes = types ?? DEFAULT_TYPES
    const targetTypeSet = new Set(targetTypes)

    let vectorResults: Array<{ memoryId: string; score: number }>
    try {
      const queryVector = await this.embeddingClient.embed(query, sessionId)
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

    // 发展柱（只取权威条）：命中条若已被取代/并入，沿 supersededBy/mergedInto 谱系链
    // 重定向到活的权威条——查到旧内容也要交付当前真相，且评分继承命中条的向量分。
    // 关联柱：多个命中重定向到同一权威条时去重，保留最高向量分。
    // 注：权威条可能跨 type（merge 可跨类型），不再按 targetTypes 二次过滤——重定向交付真相优先。
    const byAuthority = new Map<
      string,
      {
        memory: Memory
        vector: number
        resolvedFrom: string[]
        gateConfidence: number
        gateTags: Set<string>
      }
    >()
    for (const hit of matchedMemories) {
      const authority = this.resolveAuthority(hit)
      const vector = vectorScoreMap.get(hit.id) ?? 0
      const entry = byAuthority.get(authority.id)
      if (entry) {
        entry.vector = Math.max(entry.vector, vector)
        entry.gateConfidence = Math.max(entry.gateConfidence, hit.confidence)
        for (const t of hit.tags) entry.gateTags.add(t)
        if (authority.id !== hit.id) entry.resolvedFrom.push(hit.id)
      } else {
        byAuthority.set(authority.id, {
          memory: authority,
          vector,
          resolvedFrom: authority.id !== hit.id ? [hit.id] : [],
          gateConfidence: Math.max(authority.confidence, hit.confidence),
          gateTags: new Set([...authority.tags, ...hit.tags]),
        })
      }
    }

    // 门槛语义：status 必须看权威条（不能交付已归档内容）；
    // confidence/tags 取"命中条或权威条任一满足"——否则权威后继降置信/换 tag 会让
    // 高相关命中整条静默丢弃（对抗实测的召回坍塌），既拿不到权威条也拿不到命中条。
    const filtered = [...byAuthority.values()]
      .filter(({ memory }) => {
        if (status) return status.includes(memory.status)
        return memory.status === 'verified'
      })
      .filter(({ gateConfidence }) => gateConfidence >= confidenceThreshold)
      .filter(({ gateTags }) => {
        if (!tags?.length) return true
        return tags.some((tag) => gateTags.has(tag))
      })

    const scored = filtered.map(({ memory, vector, resolvedFrom }) => {
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
        ...(resolvedFrom.length > 0 ? { resolvedFrom } : {}),
      }
    })

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.memory.confidence - a.memory.confidence
    })

    return scored.filter((entry) => entry.score >= minScore).slice(0, topN)
  }

  // 谱系指针只存 id 不存 type（merge 可跨类型），先按提示 type 查、再扫全类型。
  private findById(id: string, hintType?: MemoryType): Memory | undefined {
    if (hintType) {
      const hinted = this.store.get(hintType, id)
      if (hinted) return hinted
    }
    for (const type of ALL_MEMORY_TYPES) {
      if (type === hintType) continue
      const memory = this.store.get(type, id)
      if (memory) return memory
    }
    return undefined
  }

  // 沿 supersededBy/mergedInto 链走到底（环由 visited 守卫；跳数上限仅是远超现实链长的保险丝，
  // 截断停在中间节点会交付陈旧"权威"——对抗实测确认，故上限必须远大于真实链深）。
  private resolveAuthority(memory: Memory): Memory {
    let current = memory
    const visited = new Set<string>([memory.id])
    for (let hops = 0; hops < 100; hops++) {
      const nextId = current.supersededBy ?? current.mergedInto
      if (!nextId || visited.has(nextId)) break
      const next = this.findById(nextId, current.type)
      if (!next) break
      visited.add(nextId)
      current = next
    }
    return current
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
