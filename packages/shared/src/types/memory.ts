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
  content: string
}

export interface MemoryScoreBreakdown {
  keyword: number
  recency: number
  vector?: number
}

export interface ScoredMemoryMatch {
  memory: Memory
  score: number
  scoreBreakdown: MemoryScoreBreakdown
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
