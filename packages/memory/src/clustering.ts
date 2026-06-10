import type { MemoryType } from '@zero-os/shared'
import type { VectorIndexLike } from './vector-index'

export interface ClusterMember {
  id: string
  type: string
  title: string
  status: string
  confidence: number
  updatedAt: string
}

export interface MemoryCluster {
  size: number
  suggestedWinnerId?: string
  members: ClusterMember[]
}

export interface ClusterResult {
  clusters: MemoryCluster[]
  total: number
  memoriesInClusters: number
  reason?: string
}

interface ClusterMemoryStore {
  get(
    type: MemoryType,
    id: string,
  ): { title: string; status: string; confidence: number; updatedAt: string } | undefined
}

// 权威条排序：verified 最优、archived 最次；与设计 3.4 一致（updatedAt 已被污染，仅作末位兜底）。
const statusRank = (s: string): number => (s === 'verified' ? 0 : s === 'archived' ? 3 : 1)

/**
 * 对全库向量做 cos≥threshold 的连通聚类（union-find），返回近重复簇 + 每簇建议权威条。
 * 同步 O(n²) 暴力比对；调用方负责缓存/异步化。供 /api/memory/clusters 端点与后台检测任务共用。
 */
export async function computeMemoryClusters(
  vectorIndex: VectorIndexLike | undefined,
  store: ClusterMemoryStore,
  opts?: { threshold?: number },
): Promise<ClusterResult> {
  if (!vectorIndex?.listAll) {
    return { clusters: [], total: 0, memoriesInClusters: 0, reason: 'vector index unavailable' }
  }
  const threshold = Math.min(0.99, Math.max(0.8, opts?.threshold ?? 0.9))
  const items = await vectorIndex.listAll()
  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x])
    return parent[x]
  }
  for (let i = 0; i < n; i++) {
    const vi = items[i].vector
    const ni = items[i].norm || 1
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue
      const vj = items[j].vector
      if (vj.length !== vi.length) continue
      let dot = 0
      for (let d = 0; d < vi.length; d++) dot += vi[d] * vj[d]
      if (dot / (ni * (items[j].norm || 1)) >= threshold) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const arr = groups.get(r)
    if (arr) arr.push(i)
    else groups.set(r, [i])
  }
  const clusters: MemoryCluster[] = []
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    // store 里已不存在的幽灵向量（降级线路下删除未同步索引）直接剔除，不进治理队列。
    const members: ClusterMember[] = []
    for (const i of idxs) {
      const meta = items[i].meta
      const mem = store.get(meta.type as MemoryType, meta.memoryId)
      if (!mem) continue
      members.push({
        id: meta.memoryId,
        type: meta.type,
        title: mem.title,
        status: mem.status,
        confidence: mem.confidence,
        updatedAt: mem.updatedAt,
      })
    }
    if (members.length < 2) continue
    const winner = [...members].sort((a, b) => {
      const ra = statusRank(a.status)
      const rb = statusRank(b.status)
      if (ra !== rb) return ra - rb
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.updatedAt.localeCompare(a.updatedAt)
    })[0]
    clusters.push({ size: members.length, suggestedWinnerId: winner?.id, members })
  }
  clusters.sort((a, b) => b.size - a.size)
  return {
    clusters,
    total: clusters.length,
    memoriesInClusters: clusters.reduce((s, cl) => s + cl.size, 0),
  }
}

// P3c: 进程内 TTL 缓存，避免治理 UI 每次加载都重算 O(n²)。后台检测任务也可调本入口预热。
let clusterCache: { at: number; threshold: number; result: ClusterResult } | null = null

export async function getMemoryClusters(
  vectorIndex: VectorIndexLike | undefined,
  store: ClusterMemoryStore,
  opts?: { threshold?: number; maxAgeMs?: number; force?: boolean },
): Promise<ClusterResult> {
  const threshold = opts?.threshold ?? 0.9
  const maxAge = opts?.maxAgeMs ?? 60_000
  if (
    !opts?.force &&
    clusterCache &&
    clusterCache.threshold === threshold &&
    Date.now() - clusterCache.at < maxAge
  ) {
    return clusterCache.result
  }
  const result = await computeMemoryClusters(vectorIndex, store, { threshold })
  clusterCache = { at: Date.now(), threshold, result }
  return result
}

// 写入（归档/取代等）后调用，使缓存失效，下次重算。
export function invalidateClusterCache(): void {
  clusterCache = null
}
