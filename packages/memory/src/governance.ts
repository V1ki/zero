import {
  ALL_MEMORY_TYPES,
  type Memory,
  type MemoryEdge,
  type MemoryEdgeKind,
  type MemoryStatus,
  type MemoryType,
  clampConfidence,
  isMemoryStatus,
  toErrorMessage,
} from '@zero-os/shared'
import { type ClusterResult, getMemoryClusters, invalidateClusterCache } from './clustering'
import type { MemoryLifecycle } from './lifecycle'
import {
  type LineageEntry,
  type RelatedMemoryHit,
  buildMemoryLineage,
  computeRelatedMemories,
} from './related'
import type { MemoryRepository } from './store'
import type { VectorIndexLike } from './vector-index'

export type MemoryGovernanceErrorStatus = 400 | 404 | 409 | 503

export type MemoryGovernanceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: MemoryGovernanceErrorStatus; error: string; detail?: string }

export type MemoryRelationRemoveSpec = string | { toId: string; kind: string }

export interface MemoryNeighbor {
  memoryId: string
  type?: string
  title?: string
  score: number
  status?: string
  supersededBy?: string
  mergedInto?: string
}

export interface MemoryNeighborResult {
  neighbors: MemoryNeighbor[]
  reason?: string
}

export interface MemoryRelatedResult {
  related: RelatedMemoryHit[]
  lineage: LineageEntry[]
}

interface MemoryGovernanceDeps {
  store: MemoryRepository
  lifecycle: MemoryLifecycle
  vectorIndex?: VectorIndexLike
}

const EDGE_KINDS = new Set<string>([
  'same-as',
  'subsumes',
  'same-topic',
  'supersedes',
  'contradicts',
  'derived-from',
])

function isMemoryEdgeKind(kind: string): kind is MemoryEdgeKind {
  return EDGE_KINDS.has(kind)
}

function toMemoryEdge(value: unknown): MemoryEdge | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.toId !== 'string' || typeof candidate.kind !== 'string') return undefined
  if (!isMemoryEdgeKind(candidate.kind)) return undefined
  return { toId: candidate.toId, kind: candidate.kind }
}

/**
 * Owns memory governance semantics so HTTP routes stay as thin transport adapters.
 */
export class MemoryGovernanceService {
  constructor(private deps: MemoryGovernanceDeps) {}

  async createMemory(input: {
    type: MemoryType
    title: string
    content: string
    tags?: unknown
    status?: unknown
    confidence?: unknown
  }): Promise<Memory> {
    const memory = await this.deps.store.create(input.type, input.title, input.content, {
      tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string') : [],
      status: isMemoryStatus(input.status) ? input.status : 'draft',
      confidence: clampConfidence(input.confidence) ?? 0.5,
    })
    invalidateClusterCache()
    return memory
  }

  async updateMemoryFields(
    type: MemoryType,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Memory | undefined> {
    const safe: Record<string, unknown> = {}
    if (typeof body.title === 'string') safe.title = body.title
    if (typeof body.content === 'string') safe.content = body.content
    if (Array.isArray(body.tags) && body.tags.every((t) => typeof t === 'string')) {
      safe.tags = body.tags
    }
    const clampedConfidence = clampConfidence(body.confidence)
    if (clampedConfidence !== undefined) safe.confidence = clampedConfidence

    const updated = await this.deps.store.update(type, id, safe)
    if (updated) invalidateClusterCache()
    return updated
  }

  async archive(type: MemoryType, id: string): Promise<Memory | undefined> {
    const updated = await this.deps.store.update(type, id, {
      status: 'archived' as MemoryStatus,
    })
    if (updated) invalidateClusterCache()
    return updated
  }

  async verify(type: MemoryType, id: string): Promise<Memory | undefined> {
    const updated = await this.deps.store.update(type, id, {
      status: 'verified' as MemoryStatus,
      confidence: 0.9,
      supersededBy: undefined,
      mergedInto: undefined,
    })
    if (updated) invalidateClusterCache()
    return updated
  }

  async supersede(
    type: MemoryType,
    id: string,
    targetId: string | undefined,
  ): Promise<MemoryGovernanceResult<Memory>> {
    if (!targetId) {
      return { ok: false, status: 400, error: 'bySupersededId is required' }
    }
    if (targetId === id) {
      return { ok: false, status: 400, error: 'cannot supersede a memory by itself' }
    }

    const target = this.findById(targetId)
    if (!target) {
      return { ok: false, status: 404, error: `supersede target not found: ${targetId}` }
    }

    let cursor: Memory | undefined = target
    let lastLive: Memory | undefined = target.status !== 'archived' ? target : undefined
    const visited = new Set<string>([targetId])
    while (cursor) {
      const nextId: string | undefined = cursor.supersededBy ?? cursor.mergedInto
      if (!nextId || visited.has(nextId)) break
      if (nextId === id) {
        return { ok: false, status: 409, error: 'supersede would create a lineage cycle' }
      }
      visited.add(nextId)
      const next = this.findById(nextId)
      if (!next) break
      cursor = next
      if (cursor.status !== 'archived') lastLive = cursor
    }

    const authorityId = lastLive?.id ?? targetId
    const updated = await this.deps.store.update(type, id, {
      status: 'archived' as MemoryStatus,
      supersededBy: authorityId,
    })
    if (!updated) return { ok: false, status: 404, error: 'Memory not found' }

    invalidateClusterCache()
    return { ok: true, value: updated }
  }

  async resolveConflict(
    type: MemoryType,
    id: string,
    otherId: string | undefined,
  ): Promise<MemoryGovernanceResult<Memory>> {
    if (!otherId) return { ok: false, status: 400, error: 'otherId is required' }
    if (otherId === id) {
      return { ok: false, status: 400, error: 'cannot resolve a memory against itself' }
    }

    try {
      const winner = await this.deps.lifecycle.resolveConflict(type, id, otherId)
      if (!winner) return { ok: false, status: 404, error: 'one or both memories not found' }
      invalidateClusterCache()
      return { ok: true, value: winner }
    } catch (error) {
      invalidateClusterCache()
      return {
        ok: false,
        status: 503,
        error: 'resolve-conflict interrupted mid-apply; state is safe, retry to complete',
        detail: toErrorMessage(error),
      }
    }
  }

  async archiveOld(input: {
    type?: MemoryType
    olderThanDays?: number
  }): Promise<MemoryGovernanceResult<{ archived: number }>> {
    if (!input.type || !ALL_MEMORY_TYPES.includes(input.type)) {
      return { ok: false, status: 400, error: 'valid type is required' }
    }

    const olderThanDays =
      typeof input.olderThanDays === 'number' && Number.isFinite(input.olderThanDays)
        ? Math.max(0, input.olderThanDays)
        : 30

    try {
      const archived = await this.deps.lifecycle.archiveOld(input.type, olderThanDays)
      if (archived > 0) invalidateClusterCache()
      return { ok: true, value: { archived } }
    } catch (error) {
      invalidateClusterCache()
      return {
        ok: false,
        status: 503,
        error: 'archive-old interrupted; partial progress applied, retry to complete',
        detail: toErrorMessage(error),
      }
    }
  }

  async updateRelations(input: {
    type: MemoryType
    id: string
    add?: unknown[]
    remove?: MemoryRelationRemoveSpec[]
  }): Promise<Memory | undefined> {
    const memory = this.deps.store.get(input.type, input.id)
    if (!memory) return undefined

    const seen = new Set((memory.edges ?? []).map((edge) => `${edge.kind}:${edge.toId}`))
    const additions: MemoryEdge[] = []
    for (const raw of input.add ?? []) {
      const edge = toMemoryEdge(raw)
      if (!edge) continue
      const key = `${edge.kind}:${edge.toId}`
      if (seen.has(key)) continue
      seen.add(key)
      additions.push(edge)
    }

    const removeAll = new Set<string>()
    const removeExact = new Set<string>()
    for (const raw of input.remove ?? []) {
      if (typeof raw === 'string') {
        removeAll.add(raw)
      } else if (raw && typeof raw.toId === 'string' && typeof raw.kind === 'string') {
        removeExact.add(`${raw.kind}:${raw.toId}`)
      }
    }

    const edges = [...(memory.edges ?? []), ...additions].filter(
      (edge) => !removeAll.has(edge.toId) && !removeExact.has(`${edge.kind}:${edge.toId}`),
    )
    const updated = await this.deps.store.update(input.type, input.id, { edges })
    if (updated) invalidateClusterCache()
    return updated
  }

  async getNeighbors(_type: MemoryType, id: string, topK: number): Promise<MemoryNeighborResult> {
    const index = this.deps.vectorIndex
    if (!index?.getVector) {
      return { neighbors: [], reason: 'vector index unavailable' }
    }

    const vector = await index.getVector(id)
    if (!vector) {
      return { neighbors: [], reason: 'no vector for this memory' }
    }

    const hits = await index.query(vector, topK + 1)
    const neighbors: MemoryNeighbor[] = []
    for (const hit of hits) {
      if (hit.memoryId === id) continue
      const meta = await index.getMetadata?.(hit.memoryId)
      const live = meta?.type
        ? this.deps.store.get(meta.type as MemoryType, hit.memoryId)
        : undefined
      if (!live) continue
      neighbors.push({
        memoryId: hit.memoryId,
        type: live.type,
        title: live.title,
        score: hit.score,
        status: live.status,
        ...(live.supersededBy ? { supersededBy: live.supersededBy } : {}),
        ...(live.mergedInto ? { mergedInto: live.mergedInto } : {}),
      })
      if (neighbors.length >= topK) break
    }
    return { neighbors }
  }

  getClusters(input: { threshold?: number; force?: boolean }): Promise<ClusterResult> {
    return getMemoryClusters(this.deps.vectorIndex, this.deps.store, input)
  }

  /**
   * 组合式关系视图:显式边 + 语义近邻 + 共享标签 + 同源会话合并排序,
   * 附带完整谱系链(向后到权威条、向前含所有前驱)。全库 list 在百级记忆下开销可忽略。
   */
  async getRelated(type: MemoryType, id: string): Promise<MemoryRelatedResult | undefined> {
    const anchor = this.deps.store.get(type, id)
    if (!anchor) return undefined

    const memories = ALL_MEMORY_TYPES.flatMap((memoryType) => this.deps.store.list(memoryType))
    const neighborResult = await this.getNeighbors(type, id, 8)
    const neighbors = neighborResult.neighbors.map((neighbor) => ({
      id: neighbor.memoryId,
      similarity: neighbor.score,
    }))

    return {
      related: computeRelatedMemories({ anchor, memories, neighbors }),
      lineage: buildMemoryLineage(anchor, memories),
    }
  }

  async deleteMemory(type: MemoryType, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(type, id)
    if (!deleted) return false

    try {
      await this.deps.vectorIndex?.delete(id)
    } catch {
      // Index cleanup is best-effort; the memory file is already deleted.
    }
    invalidateClusterCache()
    return true
  }

  private findById(id: string): Memory | undefined {
    for (const type of ALL_MEMORY_TYPES) {
      const memory = this.deps.store.get(type, id)
      if (memory) return memory
    }
    return undefined
  }
}
