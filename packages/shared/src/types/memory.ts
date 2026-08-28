export type MemoryType =
  | 'session'
  | 'incident'
  | 'runbook'
  | 'decision'
  | 'note'
  | 'preference'
  | 'inbox'

export const ALL_MEMORY_TYPES: MemoryType[] = [
  'note',
  'decision',
  'preference',
  'runbook',
  'incident',
  'session',
  'inbox',
]

export type MemoryStatus = 'draft' | 'verified' | 'archived' | 'conflict'

export const MEMORY_STATUSES: MemoryStatus[] = ['draft', 'verified', 'archived', 'conflict']

/** 运行时校验 status 枚举（写路径绕过 TS 类型，需统一校验）。 */
export function isMemoryStatus(s: unknown): s is MemoryStatus {
  return typeof s === 'string' && (MEMORY_STATUSES as string[]).includes(s)
}

/** confidence 语义为 [0,1] 概率；非有限数返回 undefined，否则钳制到 [0,1]。 */
export function clampConfidence(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  return Math.min(1, Math.max(0, n))
}

/** 记忆之间带类型的边（关联柱）。不复用 related[]，避免与 resolveConflict 的裸 id 双写污染。 */
export type MemoryEdgeKind =
  | 'same-as' // 纯重复
  | 'subsumes' // 包含
  | 'same-topic' // 互补，共享 topicKey
  | 'supersedes' // 演进取代
  | 'contradicts' // 冲突
  | 'derived-from' // 派生

export interface MemoryEdge {
  toId: string
  kind: MemoryEdgeKind
}

export interface Memory {
  id: string
  type: MemoryType
  title: string
  createdAt: string
  updatedAt: string
  accessCount?: number
  lastAccessedAt?: string
  status: MemoryStatus
  sessionId?: string
  confidence: number
  tags: string[]
  related: string[]
  // 记忆重构方向（关联/发展）的字段，均可选、空库零影响；聚类/裁决在 P1/P2 落地。
  topicKey?: string
  supersededBy?: string
  mergedInto?: string
  edges?: MemoryEdge[]
  content: string
}

export interface MemoryScoreBreakdown {
  keyword: number
  recency: number
  vector?: number
  /** 使用反馈回路:该记忆的近期使用度(0..1),封顶权重远小于相关性权重。 */
  usage?: number
}

/**
 * 使用反馈信号的类别。injected 仅记观测账;read/used 计正向;harmful/unused
 * 留给治理回路消费(超阈值路由治理队列),不直接进检索评分。
 */
export type MemoryUsageKind = 'injected' | 'read' | 'used' | 'harmful' | 'unused'

/** 结构化最小接口,MemoryUsageTracker 结构满足之;埋点方只依赖此形状。 */
export interface MemoryUsageRecorder {
  record(id: string, kind: MemoryUsageKind, sessionId?: string): void
}

export interface ScoredMemoryMatch {
  memory: Memory
  score: number
  scoreBreakdown: MemoryScoreBreakdown
  /** 发展柱：该权威条由哪些已被取代/并入的命中条沿谱系链重定向而来（原命中 id）。 */
  resolvedFrom?: string[]
}

export interface MemorySearchOptions {
  topN?: number
  confidenceThreshold?: number
  minScore?: number
  types?: MemoryType[]
  tags?: string[]
  status?: MemoryStatus[]
  sessionId?: string
}
