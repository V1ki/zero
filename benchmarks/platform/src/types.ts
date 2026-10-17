/** v1 contracts. Unknown measurements are null, never an invented zero. */
export type Mode = 'simulated' | 'controlled' | 'live' | 'offline'
export type Phase = 'execution' | 'evaluation'
export interface Usage {
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
  /** Informational subset; never added to output for billing. */
  reasoning: number | null
}
export interface Cost {
  amount: number
  currency: string
  basis: 'billed' | 'estimated' | 'declared-free'
  rateCard?: string
}
export interface Evidence {
  id: string
  kind: 'artifact' | 'trace' | 'source'
  ref: string
  sha256: string | null
}
export interface OperationResult<T> {
  value: T
  status?: 'ok' | 'error'
  usage?: Usage
  cost?: Cost
  actualModel?: string
}
export interface Operation {
  id: string
  phase: Phase
  kind: 'model' | 'tool'
  name: string
  startedAt: string
  durationMs: number
  status: 'ok' | 'error'
  inputHash: string
  outputHash: string | null
  inputBytes: number
  outputBytes: number | null
  usage: Usage | null
  cost: Cost | null
  actualModel: string | null
}
export interface BenchmarkCase {
  id: string
  family: string
  sourceGroup: string
  inputHash: string
  contractHash: string
}
export interface Variant {
  id: string
  fingerprint: string
}
export interface Evaluation {
  evaluator: string
  version: string
  verdict: 'passed' | 'failed' | 'needs_review'
  checks: Array<{ id: string; passed: boolean | null; evidenceIds: string[] }>
  /** Each plugin owns metric meaning and scale; no cross-suite composite score. */
  metrics: Array<{
    id: string
    value: number | null
    unit: string
    direction: 'higher' | 'lower' | 'none'
  }>
}
export interface Execution {
  outcome: 'completed' | 'partial' | 'blocked' | 'stopped'
  /** In-memory handoff to evaluator; not automatically published. */
  value?: unknown
}
export interface Limits {
  timeoutMs: number
  maxModelCalls: number
  maxToolCalls: number
}
export interface Context {
  case: BenchmarkCase
  variant: Variant
  target: string
  rep: number
  workspace: string
  signal: AbortSignal
  model<T>(
    name: string,
    input: unknown,
    run: (signal: AbortSignal) => Promise<OperationResult<T>>,
  ): Promise<T>
  tool<T>(
    name: string,
    input: unknown,
    run: (signal: AbortSignal) => Promise<OperationResult<T>>,
  ): Promise<T>
  artifact(name: string, content: string | Uint8Array): Evidence
}
export interface BenchmarkPlugin {
  apiVersion: 1
  id: string
  version: string
  environment: { mode: Mode; fingerprint: string }
  evaluator: { id: string; version: string }
  cases: BenchmarkCase[]
  variants: Variant[]
  targets: string[]
  setup?(context: Context): Promise<void>
  execute(context: Context): Promise<Execution>
  evaluate(context: Context, execution: Execution): Promise<Evaluation>
  cleanup?(context: Context): Promise<void>
}
export interface Measurements {
  modelCalls: number | null
  toolCalls: number | null
  toolErrors: number | null
  tools: Record<string, { calls: number; errors: number; durationMs: number | null }>
  usage: Usage
  /** Unknown costs stay unknown; known subtotal is not a complete bill. */
  costs: Array<{ currency: string; basis: Cost['basis']; amount: number }>
  unknownCostOperations: number | null
}
export interface TrialRecord {
  schemaVersion: 1
  id: string
  suite: string
  suiteVersion: string
  case: BenchmarkCase
  variant: Variant
  target: string
  rep: number
  block: string
  environment: BenchmarkPlugin['environment']
  /** Binds cases, tools/environment, evaluator, runner and budgets, excluding variant. */
  comparisonKey: string
  status: 'ok' | 'error' | 'timeout' | 'budget_exceeded'
  failureStage: 'setup' | 'execution' | 'evaluation' | 'cleanup' | null
  outcome: Execution['outcome'] | null
  durationMs: number | null
  evaluation: Evaluation | null
  evidence: Evidence[]
  operations: Operation[]
  measurements: { execution: Measurements; evaluation: Measurements }
  provenance: { kind: 'native' | 'import'; source: string; sha256: string }
  limitations: string[]
}
export interface RunOptions {
  out: string
  reps: number
  seed: string
  limits: Limits
  concurrency?: number
}

export interface TrialJob {
  id: string
  case: BenchmarkCase
  variant: Variant
  target: string
  rep: number
  block: string
  comparisonKey: string
}
export interface TrialExecutor {
  execute(
    plugin: BenchmarkPlugin,
    job: TrialJob,
    workspace: string,
    limits: Limits,
  ): Promise<TrialRecord>
  dispose?(): void
}
export interface RunHooks {
  executor?: TrialExecutor
  onTrial?(row: TrialRecord): void | Promise<void>
}
