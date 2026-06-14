export interface CostByModel {
  model: string
  provider: string
  totalCost: number
  totalInput: number
  totalOutput: number
  requestCount: number
}

export interface CostByPeriod {
  period: string
  totalCost: number
  totalTokens: number
}

export interface CostByDayModel {
  period: string
  model: string
  cost: number
}

export interface CacheHitRate {
  period: string
  hitRate: number
}

export interface SessionStatsSummary {
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  effectiveInputTokens: number
  cacheHitRate: number
  requestCount: number
}

export interface CacheByModelRecord {
  provider: string
  model: string
  requestCount: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  effectiveInput: number
  hitRate: number
  cost: number
}

export interface TaskSuccessRate {
  period: string
  successRate: number
  total: number
}

export interface AvgDuration {
  period: string
  avgMs: number
}

export interface RepairEntry {
  sessionId?: string
  status: 'success' | 'failed'
  diagnosis: string
  action: string
  result: string
}

export interface RepairStats {
  total: number
  successCount: number
  successRate: number
}

export interface RepairByDay {
  period: string
  total: number
  success: number
}

export interface CostDetailRecord {
  date: string
  provider: string
  model: string
  requestCount: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  reasoningTokens: number
  effectiveInput: number
  hitRate: number
  cost: number
}

export interface ToolErrorByDay {
  period: string
  tool: string
  total: number
  errors: number
}

export type UsageCategory = 'completion' | 'aggregated' | 'embedding'

export const USAGE_PURPOSES = [
  'agent_loop',
  'sub_agent',
  'task_closure',
  'compression',
  'tool_io_digest',
  'memory_retrieval',
  'session_judge',
  'embedding',
  'memory_nudge',
] as const

export type UsagePurpose = (typeof USAGE_PURPOSES)[number]

const usagePurposeSet = new Set<string>(USAGE_PURPOSES)

export function isUsagePurpose(value: string): value is UsagePurpose {
  return usagePurposeSet.has(value)
}

export interface UsageLedgerEntry {
  id: string
  sessionId: string | null
  category: UsageCategory
  purpose: UsagePurpose
  parentSessionId?: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  cost: number
  durationMs: number
  metadata?: string
  createdAt: string
}

export interface UsageSummaryRow {
  purpose: UsagePurpose
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  eventCount: number
}

export interface UsageTotals {
  totalCost: number
  totalTokens: number
  eventCount: number
}

export interface SessionUsageByPurposeRow {
  purpose: UsagePurpose
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  requestCount: number
}

export interface EvaluationDimensionEntry {
  key: string
  label: string
  score: number
  maxScore: number
  rationale: string
}

export interface EvaluationFindingEntry {
  severity: string
  title: string
  evidence: string
}

export interface EvaluationEntry {
  id?: number
  sessionId: string
  model: string
  overallScore: number
  verdict: string
  confidence: string
  summary?: string
  dimensions: EvaluationDimensionEntry[]
  findings: EvaluationFindingEntry[]
  signals?: Record<string, unknown>
  generatedAt: string
  createdAt: string
}

export interface EvaluationTrendRow {
  period: string
  avgScore: number
  evalCount: number
  strongCount: number
  mixedCount: number
  weakCount: number
}

export interface EvaluationDimensionAverageRow {
  dimensionKey: string
  avgScore: number
  count: number
}

export interface TopFindingRow {
  title: string
  severity: string
  count: number
}

export interface CostByChannelRow {
  source: string
  channelName: string
  totalCost: number
  sessionCount: number
  requestCount: number
}

export interface CostBySourceRow {
  source: string
  totalCost: number
  sessionCount: number
}
