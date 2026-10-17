import { createHash } from 'node:crypto'
import type { Evaluation, Measurements, Operation, TrialRecord, Usage } from './types'

export function canonical(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Non-finite JSON number')
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Expected JSON-serializable value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}
export function hash(value: unknown): string {
  return digest(canonical(value))
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
export const unknownUsage = (): Usage => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
})
export const unknownMeasurements = (): Measurements => ({
  modelCalls: null,
  toolCalls: null,
  toolErrors: null,
  tools: {},
  usage: unknownUsage(),
  costs: [],
  unknownCostOperations: null,
})

export function measure(operations: Operation[]): Measurements {
  const models = operations.filter((o) => o.kind === 'model')
  const tools: Measurements['tools'] = Object.create(null)
  for (const op of operations.filter((o) => o.kind === 'tool')) {
    const row = tools[op.name] ?? { calls: 0, errors: 0, durationMs: 0 }
    row.calls++
    row.errors += Number(op.status === 'error')
    row.durationMs = (row.durationMs ?? 0) + op.durationMs
    tools[op.name] = row
  }
  const usage = unknownUsage()
  for (const key of Object.keys(usage) as Array<keyof Usage>) {
    usage[key] = models.every((o) => o.usage?.[key] != null)
      ? models.reduce((sum, o) => sum + (o.usage?.[key] ?? 0), 0)
      : null
  }
  const costs: Measurements['costs'] = []
  for (const { cost } of operations) {
    if (!cost) continue
    const entry = costs.find((c) => c.currency === cost.currency && c.basis === cost.basis)
    if (entry) entry.amount += cost.amount
    else costs.push({ currency: cost.currency, basis: cost.basis, amount: cost.amount })
  }
  return {
    modelCalls: models.length,
    toolCalls: operations.length - models.length,
    toolErrors: Object.values(tools).reduce((n, t) => n + t.errors, 0),
    tools,
    usage,
    costs,
    unknownCostOperations: operations.filter((o) => !o.cost).length,
  }
}

export function validateEvaluation(evaluation: Evaluation, evidenceIds: string[]): void {
  if (
    !evaluation.evaluator ||
    !evaluation.version ||
    !['passed', 'failed', 'needs_review'].includes(evaluation.verdict)
  )
    throw new Error('Invalid evaluation')
  const ids = new Set<string>()
  for (const check of evaluation.checks) {
    if (!check.id || ids.has(check.id) || ![true, false, null].includes(check.passed))
      throw new Error('Invalid or duplicate check')
    ids.add(check.id)
    if (
      check.evidenceIds.some((id) => !evidenceIds.includes(id)) ||
      (check.passed !== null && !check.evidenceIds.length)
    )
      throw new Error('Check requires evidence')
  }
  if (
    evaluation.verdict === 'passed' &&
    (!evaluation.checks.length || evaluation.checks.some((c) => c.passed !== true))
  )
    throw new Error('Cannot pass incomplete evaluation')
  const metricIds = new Set<string>()
  for (const metric of evaluation.metrics) {
    if (
      !metric.id ||
      metricIds.has(metric.id) ||
      (metric.value !== null && !Number.isFinite(metric.value))
    )
      throw new Error('Invalid metric')
    metricIds.add(metric.id)
  }
}
export function accepted(row: TrialRecord): boolean {
  return row.status === 'ok' && row.outcome === 'completed' && row.evaluation?.verdict === 'passed'
}
