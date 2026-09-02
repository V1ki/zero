import type { Memory, MemoryEdgeKind, MemoryStatus, MemoryType } from '@zero-os/shared'

/** 相关性来源:显式边(双向)、语义近邻、共享标签、同源会话。 */
export type RelatedReason = 'edge' | 'neighbor' | 'shared-tags' | 'same-session'

export interface RelatedMemoryHit {
  id: string
  type: MemoryType
  title: string
  status: MemoryStatus
  reasons: RelatedReason[]
  /** 与锚点存在显式边时,列出边的种类(正向锚点声明 + 反向他人声明都算)。 */
  edgeKinds: MemoryEdgeKind[]
  /** 语义近邻的余弦相似度(仅 neighbor 来源携带)。 */
  similarity?: number
}

/** 谱系关系:从锚点视角描述链条上每一跳。 */
export type LineageRelation = 'superseded-by' | 'merged-into' | 'supersedes' | 'merged-from'

export interface LineageEntry {
  id: string
  type: MemoryType
  title: string
  status: MemoryStatus
  relation: LineageRelation
}

/** 防御坏数据:谱系链最长 16 跳,权重相同的候选按标题稳定排序。 */
const MAX_LINEAGE_DEPTH = 16
const DEFAULT_RELATED_LIMIT = 8

interface Candidate {
  memory: Memory
  weight: number
  reasons: Set<RelatedReason>
  edgeKinds: Set<MemoryEdgeKind>
  similarity?: number
}

/**
 * 组合式"相关记忆"视图:不新增存储,由已有信号计算而来。
 * 权重 edge(显式声明,最强) > neighbor(2×相似度) > shared-tags(交集≥2) > same-session。
 * 排除锚点自身与 archived(谱系视图负责展示退役条目,这里只给活的)。
 */
export function computeRelatedMemories(input: {
  anchor: Memory
  memories: Memory[]
  neighbors: Array<{ id: string; similarity: number }>
  limit?: number
}): RelatedMemoryHit[] {
  const { anchor, memories, neighbors } = input
  const limit = input.limit ?? DEFAULT_RELATED_LIMIT
  const anchorTags = new Set(anchor.tags)
  const candidates = new Map<string, Candidate>()

  const upsert = (memory: Memory): Candidate => {
    let candidate = candidates.get(memory.id)
    if (!candidate) {
      candidate = {
        memory,
        weight: 0,
        reasons: new Set(),
        edgeKinds: new Set(),
      }
      candidates.set(memory.id, candidate)
    }
    return candidate
  }

  for (const memory of memories) {
    if (memory.id === anchor.id || memory.status === 'archived') continue

    // 正向边:锚点自己声明的 edges
    const forwardKinds = (anchor.edges ?? [])
      .filter((edge) => edge.toId === memory.id)
      .map((edge) => edge.kind)
    // 反向边:他人记忆声明了指向锚点的边
    const backwardKinds = (memory.edges ?? [])
      .filter((edge) => edge.toId === anchor.id)
      .map((edge) => edge.kind)

    const sharedTags = memory.tags.filter((tag) => anchorTags.has(tag)).length
    const sameSession = Boolean(anchor.sessionId) && memory.sessionId === anchor.sessionId

    if (forwardKinds.length === 0 && backwardKinds.length === 0 && sharedTags < 2 && !sameSession) {
      continue
    }

    const candidate = upsert(memory)
    if (forwardKinds.length > 0 || backwardKinds.length > 0) {
      candidate.weight += 3
      candidate.reasons.add('edge')
      for (const kind of [...forwardKinds, ...backwardKinds]) candidate.edgeKinds.add(kind)
    }
    if (sharedTags >= 2) {
      candidate.weight += 1
      candidate.reasons.add('shared-tags')
    }
    if (sameSession) {
      candidate.weight += 0.5
      candidate.reasons.add('same-session')
    }
  }

  for (const neighbor of neighbors) {
    if (neighbor.id === anchor.id) continue
    const memory = memories.find((m) => m.id === neighbor.id)
    if (!memory || memory.status === 'archived') continue
    const candidate = upsert(memory)
    candidate.weight += 2 * neighbor.similarity
    candidate.reasons.add('neighbor')
    candidate.similarity = neighbor.similarity
  }

  return [...candidates.values()]
    .sort((a, b) => b.weight - a.weight || a.memory.title.localeCompare(b.memory.title))
    .slice(0, limit)
    .map((candidate) => ({
      id: candidate.memory.id,
      type: candidate.memory.type,
      title: candidate.memory.title,
      status: candidate.memory.status,
      reasons: [...candidate.reasons],
      edgeKinds: [...candidate.edgeKinds],
      ...(candidate.similarity !== undefined ? { similarity: candidate.similarity } : {}),
    }))
}

/**
 * 完整谱系链:向后沿 supersededBy/mergedInto 走到权威条,
 * 向前递归收录所有被本条(或其前身)取代/并入的直接与间接前驱。
 */
export function buildMemoryLineage(anchor: Memory, memories: Memory[]): LineageEntry[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]))
  const entries: LineageEntry[] = []
  const visited = new Set<string>([anchor.id])

  const push = (memory: Memory, relation: LineageRelation) => {
    if (visited.has(memory.id)) return false
    visited.add(memory.id)
    entries.push({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      status: memory.status,
      relation,
    })
    return true
  }

  // 向后:锚点 → 权威条
  let cursor: Memory | undefined = anchor
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && cursor; depth++) {
    const nextId = cursor.supersededBy ?? cursor.mergedInto
    if (!nextId) break
    const next = byId.get(nextId)
    if (!next) break
    if (!push(next, cursor.supersededBy ? 'superseded-by' : 'merged-into')) break
    cursor = next
  }

  // 向前:谁被本条取代/并入(含链式前驱,visited 防环)
  let frontier = [anchor]
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && frontier.length > 0; depth++) {
    const predecessors: Memory[] = []
    for (const current of frontier) {
      for (const memory of memories) {
        if (memory.supersededBy === current.id || memory.mergedInto === current.id) {
          if (visited.has(memory.id)) continue
          push(memory, memory.supersededBy ? 'supersedes' : 'merged-from')
          predecessors.push(memory)
        }
      }
    }
    frontier = predecessors
  }

  return entries
}
