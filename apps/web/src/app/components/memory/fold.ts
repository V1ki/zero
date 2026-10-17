// 「按主题折叠」的纯数据层:把扁平记忆列表分组成簇,供浏览列表渲染封面 + 侧面。
// 无副作用、无 React 依赖,便于单测。

export interface FoldableMemory {
  id: string
  type: string
  sessionId?: string
  topicKey?: string
  status: string
  confidence: number
  updatedAt: string
}

export interface SemanticClusterInput {
  suggestedWinnerId?: string
  members: { id: string }[]
}

/** 语义簇(/api/memory/clusters,余弦 ≥0.90 连通分量)→ 成员 id 到簇键的映射。 */
export function buildSemanticClusterIndex(clusters: SemanticClusterInput[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const cluster of clusters) {
    const anchor = cluster.suggestedWinnerId ?? cluster.members[0]?.id
    if (!anchor) continue
    for (const member of cluster.members) index.set(member.id, `sem:${anchor}`)
  }
  return index
}

/**
 * 折叠键优先级:topicKey(一等字段) > 语义簇(治跨会话近重复) > 会话+类型(治会话内快照爆发) > 自身。
 */
export function clusterKey(memory: FoldableMemory, semanticIndex?: Map<string, string>): string {
  if (memory.topicKey) return `topic:${memory.topicKey}`
  const semantic = semanticIndex?.get(memory.id)
  if (semantic) return semantic
  if (memory.sessionId) return `sess:${memory.sessionId}|${memory.type}`
  return `id:${memory.id}`
}

function memoryStatusRank(status: string): number {
  if (status === 'verified') return 0
  if (status === 'archived') return 3
  return 1
}

/** 封面 = 权威条:verified 优先 → confidence → updatedAt 末位兜底(与后端簇权威排序一致)。 */
export function pickCover<T extends FoldableMemory>(group: T[]): T {
  return [...group].sort((a, b) => {
    const ra = memoryStatusRank(a.status)
    const rb = memoryStatusRank(b.status)
    if (ra !== rb) return ra - rb
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })[0]
}

/** 按折叠键分组,保持输入顺序(组按首个成员出现的位置排列)。 */
export function groupByCluster<T extends FoldableMemory>(
  items: T[],
  semanticIndex?: Map<string, string>,
): [string, T[]][] {
  const map = new Map<string, T[]>()
  for (const memory of items) {
    const key = clusterKey(memory, semanticIndex)
    const existing = map.get(key)
    if (existing) existing.push(memory)
    else map.set(key, [memory])
  }
  return [...map.entries()]
}
