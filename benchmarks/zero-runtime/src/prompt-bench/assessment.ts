import { readFileSync, writeFileSync } from 'node:fs'

export type Rating = 0 | 0.5 | 1 | null
export interface Criterion {
  id: string
  dimension: string
  weight: number
  critical: boolean
  partialBlocksDelivery?: boolean
  full: string
  partial: string
  zero: string
  evidence: string
}
export interface TaskRubric {
  id: string
  title: string
  criteria: Criterion[]
}
export interface Rubric {
  version: string
  dimensions: Record<string, number>
  gates: Array<{ id: string; description: string }>
  tasks: TaskRubric[]
}
export interface Assessment {
  rubricVersion: string
  taskId: string
  taskOutcome: 'delivered' | 'partial' | 'blocked' | 'stopped'
  mode: 'historical-calibration' | 'blind-comparison'
  independentReviewers: number
  evidence: Array<{
    id: string
    kind: 'artifact' | 'trace' | 'external-receipt' | 'independent-check' | 'model-claim'
    ref: string
    note: string
  }>
  ratings: Array<{ id: string; value: Rating; evidenceIds: string[]; reason: string }>
  gates: Array<{
    id: string
    status: 'pass' | 'fail' | 'unknown'
    evidenceIds: string[]
    reason: string
  }>
}

export function validateRubric(rubric: Rubric): void {
  const ids = new Set<string>()
  for (const task of rubric.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task: ${task.id}`)
    ids.add(task.id)
    const criteria = new Set<string>()
    const totals: Record<string, number> = {}
    for (const row of task.criteria) {
      if (criteria.has(row.id) || !row.full || !row.partial || !row.zero || !row.evidence)
        throw new Error(`Invalid criterion: ${task.id}/${row.id}`)
      if (!(row.dimension in rubric.dimensions) || !(row.weight > 0))
        throw new Error(`Invalid dimension/weight: ${row.id}`)
      criteria.add(row.id)
      totals[row.dimension] = (totals[row.dimension] ?? 0) + row.weight
    }
    if (
      Object.values(totals).reduce((sum, weight) => sum + weight, 0) !== 100 ||
      Object.entries(rubric.dimensions).some(([name, weight]) => totals[name] !== weight)
    )
      throw new Error(`Dimension weights must match the 100-point contract: ${task.id}`)
  }
  if (new Set(rubric.gates.map((gate) => gate.id)).size !== rubric.gates.length)
    throw new Error('Duplicate gate')
}

export function assess(rubric: Rubric, assessment: Assessment) {
  validateRubric(rubric)
  if (rubric.version !== assessment.rubricVersion) throw new Error('Rubric version mismatch')
  const task = rubric.tasks.find((task) => task.id === assessment.taskId)
  if (!task) throw new Error('Unknown task rubric')
  if (
    !['historical-calibration', 'blind-comparison'].includes(assessment.mode) ||
    !['delivered', 'partial', 'blocked', 'stopped'].includes(assessment.taskOutcome) ||
    !Number.isInteger(assessment.independentReviewers) ||
    assessment.independentReviewers < 1
  )
    throw new Error('Invalid review metadata')
  for (const item of assessment.evidence) {
    if (
      !['artifact', 'trace', 'external-receipt', 'independent-check', 'model-claim'].includes(
        item.kind,
      ) ||
      !item.ref.trim() ||
      !item.note.trim()
    )
      throw new Error('Invalid evidence metadata')
  }
  const evidence = new Map(assessment.evidence.map((item) => [item.id, item]))
  if (evidence.size !== assessment.evidence.length) throw new Error('Duplicate evidence ID')
  const ratings = new Map(assessment.ratings.map((row) => [row.id, row]))
  const gates = new Map(assessment.gates.map((row) => [row.id, row]))
  if (
    ratings.size !== assessment.ratings.length ||
    ratings.size !== task.criteria.length ||
    task.criteria.some((row) => !ratings.has(row.id)) ||
    gates.size !== assessment.gates.length ||
    gates.size !== rubric.gates.length ||
    rubric.gates.some((row) => !gates.has(row.id))
  )
    throw new Error(
      'Every criterion and gate must be rated exactly once; use null/unknown if unverified',
    )
  const requireEvidence = (ids: string[], reason: string, verified: boolean) => {
    if (!reason.trim()) throw new Error('A concrete reason is required')
    if (ids.some((id) => !evidence.has(id))) throw new Error('Unknown evidence reference')
    if (verified && !ids.some((id) => evidence.get(id)?.kind !== 'model-claim'))
      throw new Error('A model claim alone cannot justify a score or a gate decision')
  }
  let earned = 0
  let reviewedWeight = 0
  const unknownCriteria: string[] = []
  const criticalFailures: string[] = []
  const criticalGaps: string[] = []
  const dimensions: Record<string, { earned: number; reviewedWeight: number; total: number }> = {}
  for (const criterion of task.criteria) {
    const rating = ratings.get(criterion.id)
    if (!rating) throw new Error(`Missing criterion: ${criterion.id}`)
    if (![0, 0.5, 1, null].includes(rating.value)) throw new Error('Invalid rating')
    requireEvidence(rating.evidenceIds, rating.reason, rating.value !== null)
    dimensions[criterion.dimension] ??= {
      earned: 0,
      reviewedWeight: 0,
      total: rubric.dimensions[criterion.dimension],
    }
    const dimension = dimensions[criterion.dimension]
    if (rating.value === null) {
      unknownCriteria.push(criterion.id)
      continue
    }
    earned += criterion.weight * rating.value
    reviewedWeight += criterion.weight
    dimension.earned += criterion.weight * rating.value
    dimension.reviewedWeight += criterion.weight
    if (criterion.critical && rating.value === 0) criticalFailures.push(criterion.id)
    if (criterion.partialBlocksDelivery && rating.value === 0.5) criticalGaps.push(criterion.id)
  }
  const hardFailures: string[] = []
  const unknownGates: string[] = []
  for (const gate of assessment.gates) {
    if (!['pass', 'fail', 'unknown'].includes(gate.status)) throw new Error('Invalid gate status')
    requireEvidence(gate.evidenceIds, gate.reason, gate.status !== 'unknown')
    if (gate.status === 'fail') hardFailures.push(gate.id)
    if (gate.status === 'unknown') unknownGates.push(gate.id)
  }
  const qualityVerdict =
    hardFailures.length || criticalFailures.length
      ? 'failed'
      : criticalGaps.length
        ? 'needs_revision'
        : unknownCriteria.length || unknownGates.length
          ? 'needs_evidence'
          : earned >= 90
            ? 'excellent'
            : earned >= 80
              ? 'usable'
              : earned >= 60
                ? 'needs_revision'
                : 'failed'
  const reviewComplete =
    assessment.mode === 'blind-comparison' && assessment.independentReviewers >= 2
  return {
    rubricVersion: rubric.version,
    taskId: task.id,
    taskOutcome: assessment.taskOutcome,
    qualityVerdict,
    score: unknownCriteria.length ? null : earned,
    confirmedPoints: earned,
    possibleRange: [earned, earned + 100 - reviewedWeight],
    evidenceCoveragePercent: reviewedWeight,
    dimensions,
    hardFailures,
    criticalFailures,
    criticalGaps,
    unknownCriteria,
    unknownGates,
    reviewComplete,
    accepted:
      assessment.taskOutcome === 'delivered' &&
      ['excellent', 'usable'].includes(qualityVerdict) &&
      reviewComplete,
  }
}

if (import.meta.main) {
  const [rubricPath, assessmentPath, output] = process.argv.slice(2)
  if (!rubricPath || !assessmentPath || !output)
    throw new Error('Usage: assessment.ts RUBRIC_JSON ASSESSMENT_JSON NEW_OUTPUT_JSON')
  const rubric = JSON.parse(readFileSync(rubricPath, 'utf8')) as Rubric
  const assessment = JSON.parse(readFileSync(assessmentPath, 'utf8')) as Assessment
  const result = assess(rubric, assessment)
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(result))
}
