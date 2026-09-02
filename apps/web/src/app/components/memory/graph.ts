// 记忆关系图的纯数据层:从扁平记忆列表构建节点/连线,供 SVG 力导向渲染。
// 无副作用、无 React 依赖,便于单测。

export type GraphLinkKind =
  | 'superseded-by'
  | 'merged-into'
  | 'same-as'
  | 'subsumes'
  | 'same-topic'
  | 'contradicts'
  | 'derived-from'

export interface GraphNode {
  id: string
  type: string
  title: string
  status: string
  /** usage 得分 [0,1];无记录为 0。驱动节点半径。 */
  usageScore: number
  /** 使用热度桶,驱动描边光圈:hot=30天内用过 / cold=有历史超30天 / never=无记录。 */
  heat: 'hot' | 'cold' | 'never'
  total: number
  degree: number
}

export interface GraphLink {
  key: string
  source: string
  target: string
  kind: GraphLinkKind
  /** lineage(取代/并入)画实线箭头,显式边画虚线。 */
  category: 'lineage' | 'edge'
}

export interface MemoryGraphInput {
  id: string
  type: string
  title: string
  status: string
  supersededBy?: string
  mergedInto?: string
  edges?: Array<{ toId: string; kind: string }>
}

export interface UsageInput {
  score: number
  total: number
  lastAccessedAt: string
}

const EDGE_KINDS = new Set<string>([
  'same-as',
  'subsumes',
  'same-topic',
  'supersedes',
  'contradicts',
  'derived-from',
])

const HOT_CUTOFF_MS = 30 * 86_400_000

/**
 * 构建关系图:lineage(supersededBy/mergedInto)+ 显式 edges 去重合并。
 * 指向不存在目标的连线直接丢弃(死链不进图)。默认只保留有连线的节点,
 * 孤立记忆在图里没有信息量,由调用方用 includeIsolated 控制。
 */
export function buildMemoryGraph(
  memories: MemoryGraphInput[],
  usageById: Record<string, UsageInput> = {},
  options?: { includeIsolated?: boolean },
): { nodes: GraphNode[]; links: GraphLink[] } {
  const ids = new Set(memories.map((memory) => memory.id))
  const links: GraphLink[] = []
  const seen = new Set<string>()

  const pushLink = (
    source: string,
    target: string,
    kind: GraphLinkKind,
    category: GraphLink['category'],
  ) => {
    if (!ids.has(target) || target === source) return
    const key = `${kind}:${source}:${target}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ key, source, target, kind, category })
  }

  for (const memory of memories) {
    if (memory.supersededBy) pushLink(memory.id, memory.supersededBy, 'superseded-by', 'lineage')
    if (memory.mergedInto) pushLink(memory.id, memory.mergedInto, 'merged-into', 'lineage')
    for (const edge of memory.edges ?? []) {
      if (EDGE_KINDS.has(edge.kind)) {
        pushLink(memory.id, edge.toId, edge.kind as GraphLinkKind, 'edge')
      }
    }
  }

  const degree = new Map<string, number>()
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
  }

  const now = Date.now()
  const nodes: GraphNode[] = []
  for (const memory of memories) {
    const nodeDegree = degree.get(memory.id) ?? 0
    if (nodeDegree === 0 && !options?.includeIsolated) continue
    const usage = usageById[memory.id]
    let heat: GraphNode['heat'] = 'never'
    if (usage && usage.total > 0) {
      heat = now - new Date(usage.lastAccessedAt).getTime() <= HOT_CUTOFF_MS ? 'hot' : 'cold'
    }
    nodes.push({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      status: memory.status,
      usageScore: usage?.score ?? 0,
      heat,
      total: usage?.total ?? 0,
      degree: nodeDegree,
    })
  }

  return { nodes, links }
}

export interface Point {
  x: number
  y: number
}

const REPEL = 22_000
const LINK_DISTANCE = 110
const DAMPING = 0.85
const GRAVITY = 0.006

/** 可复现的伪随机:同一份图数据每次布局结果一致,避免视图"跳"。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 简化力导向:成对斥力 + 连线弹簧 + 向心重力,速度阻尼收敛。
 * 同步跑完迭代返回最终坐标;O(n²) 斥力在几百节点量级可接受(一次性 ~几十 ms)。
 */
export function computeForceLayout(
  nodes: Array<{ id: string; degree: number }>,
  links: Array<{ source: string; target: string }>,
  options?: { width?: number; height?: number; iterations?: number; seed?: number },
): Map<string, Point> {
  const width = options?.width ?? 800
  const height = options?.height ?? 560
  const iterations = options?.iterations ?? 260
  const random = mulberry32(options?.seed ?? 42)

  const positions = new Map<string, Point>()
  nodes.forEach((node, index) => {
    // 黄金角圆周初始化:比纯随机更均匀,收敛更快
    const angle = index * 2.399963 + random() * 0.5
    const radius = 60 + Math.sqrt(index + 1) * 26
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    })
  })

  const velocities = new Map<string, Point>(nodes.map((node) => [node.id, { x: 0, y: 0 }]))
  const degreeBoost = new Map<string, number>(
    nodes.map((node) => [node.id, 1 + Math.min(node.degree, 8) * 0.25]),
  )

  for (let step = 0; step < iterations; step++) {
    const alpha = 1 - step / iterations

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      const pa = positions.get(a.id)
      const va = velocities.get(a.id)
      if (!pa || !va) continue
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        const pb = positions.get(b.id)
        const vb = velocities.get(b.id)
        if (!pb || !vb) continue
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let distSq = dx * dx + dy * dy
        if (distSq < 1) {
          dx = random() - 0.5
          dy = random() - 0.5
          distSq = 1
        }
        if (distSq > 160_000) continue // 400px 外无相互作用
        const dist = Math.sqrt(distSq)
        const force = (REPEL * alpha) / distSq
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        const boostA = degreeBoost.get(a.id) ?? 1
        const boostB = degreeBoost.get(b.id) ?? 1
        va.x += fx / boostB
        va.y += fy / boostB
        vb.x -= fx / boostA
        vb.y -= fy / boostA
      }
    }

    for (const link of links) {
      const pa = positions.get(link.source)
      const pb = positions.get(link.target)
      const va = velocities.get(link.source)
      const vb = velocities.get(link.target)
      if (!pa || !pb || !va || !vb) continue
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const force = (dist - LINK_DISTANCE) * 0.04 * alpha
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      va.x += fx
      va.y += fy
      vb.x -= fx
      vb.y -= fy
    }

    for (const node of nodes) {
      const p = positions.get(node.id)
      const v = velocities.get(node.id)
      if (!p || !v) continue
      v.x += (width / 2 - p.x) * GRAVITY * alpha
      v.y += (height / 2 - p.y) * GRAVITY * alpha
      v.x *= DAMPING
      v.y *= DAMPING
      p.x += Math.max(-24, Math.min(24, v.x))
      p.y += Math.max(-24, Math.min(24, v.y))
    }
  }

  return positions
}
