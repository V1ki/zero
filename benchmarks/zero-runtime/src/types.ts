import type { Message } from '@zero-os/shared'

export const BENCHMARK_PHASES = ['compatibility', 'runtime', 'artifact', 'expansion'] as const

export type BenchmarkPhase = (typeof BENCHMARK_PHASES)[number]

export type BenchmarkToolName = 'bash' | 'fetch' | 'read' | 'write'

export type SecretSource = 'env' | 'vault'

export interface ArtifactExpectation {
  path: string
  minBytes?: number
  contains?: string[]
}

export interface ValidationSpec {
  finalTextIncludes?: string[]
  finalTextExcludes?: string[]
  disallowTools?: boolean
  minToolCalls?: number
  requiredToolNames?: string[]
  requiredTraceKinds?: string[]
  expectedArtifacts?: ArtifactExpectation[]
}

export interface QualityRubricItem {
  key: string
  maxScore: number
  description: string
}

export interface BenchmarkCase {
  id: string
  title: string
  phase: BenchmarkPhase
  category: string
  description: string
  userPrompt: string
  agentInstruction: string
  allowedTools: BenchmarkToolName[]
  validation: ValidationSpec
  qualityRubric: QualityRubricItem[]
  timeoutMs?: number
  tags?: string[]
}

export interface ModelTarget {
  id: string
  label: string
  model: string
  taskClosureModel?: string
}

export interface CliOptions {
  command: 'plan' | 'run'
  cases: string[]
  configPath: string
  modelConfigPath?: string
  dataDir: string
  outDir: string
  models: ModelTarget[]
  runId: string
  secretSource: SecretSource
  timeoutMs?: number
}

export interface PromptVars {
  artifactDir: string
  fixtureDir: string
  projectRoot: string
  runDir: string
  workspace: string
}

export interface BenchmarkPlanEntry {
  caseId: string
  caseTitle: string
  phase: BenchmarkPhase
  category: string
  modelId: string
  model: string
  label: string
}

export interface TraceMetrics {
  rawEntryCount: number
  collapsedEntryCount: number
  llmRequestCount: number
  toolCallCount: number
  toolErrorCount: number
  closureFailedCount: number
  turnSuccessCount: number
  stopReasons: Record<string, number>
  toolNames: Record<string, number>
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cost: number
}

export interface ValidationCheck {
  name: string
  passed: boolean
  detail?: string
}

export interface ValidationResult {
  ok: boolean
  checks: ValidationCheck[]
}

export interface CaseRunResult {
  caseId: string
  model: ModelTarget
  sessionId?: string
  status: 'success' | 'error'
  startedAt: string
  endedAt: string
  durationMs: number
  runDir: string
  workspace: string
  tracePath?: string
  runLogPath?: string
  finalText: string
  messages: Message[]
  trace: TraceMetrics
  validation: ValidationResult
  error?: string
}

export interface BenchmarkSummary {
  runId: string
  generatedAt: string
  plan: BenchmarkPlanEntry[]
  results: CaseRunResult[]
}
