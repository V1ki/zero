import { expect, test } from 'bun:test'
import { type Assessment, type Rubric, assess } from '../assessment'

const rubric: Rubric = {
  version: 'test-v1',
  dimensions: { accuracy: 30, coverage: 25, verification: 20, boundary: 15, delivery: 10 },
  gates: [{ id: 'fabrication', description: 'Contradicted completion claim' }],
  tasks: [
    {
      id: 'task',
      title: 'Task',
      criteria: Object.entries({
        accuracy: 30,
        coverage: 25,
        verification: 20,
        boundary: 15,
        delivery: 10,
      }).map(([dimension, weight]) => ({
        id: dimension,
        dimension,
        weight,
        critical: dimension === 'accuracy',
        partialBlocksDelivery: dimension === 'accuracy',
        full: 'Correct',
        partial: 'Minor defect',
        zero: 'Wrong',
        evidence: 'artifact',
      })),
    },
  ],
}
function complete(): Assessment {
  return {
    rubricVersion: 'test-v1',
    taskId: 'task',
    taskOutcome: 'delivered',
    mode: 'blind-comparison',
    independentReviewers: 2,
    evidence: [{ id: 'file', kind: 'independent-check', ref: 'fixture', note: 'Checked result' }],
    ratings: rubric.tasks[0].criteria.map((row) => ({
      id: row.id,
      value: 1,
      evidenceIds: ['file'],
      reason: 'Matches independent expected result',
    })),
    gates: [
      {
        id: 'fabrication',
        status: 'pass',
        evidenceIds: ['file'],
        reason: 'Claims match checked trace and artifact',
      },
    ],
  }
}
test('unverified criteria do not become zero or a passing normalized score', () => {
  const input = complete()
  input.ratings[2].value = null
  const result = assess(rubric, input)
  expect(result.score).toBeNull()
  expect(result.possibleRange).toEqual([80, 100])
  expect(result.qualityVerdict).toBe('needs_evidence')
  expect(result.accepted).toBe(false)
})
test('a hard failure overrides 100 points', () => {
  const input = complete()
  input.gates[0].status = 'fail'
  expect(assess(rubric, input).qualityVerdict).toBe('failed')
})

test('unknown gates block delivery while a scored minor presentation defect need not', () => {
  const unknown = complete()
  unknown.gates[0].status = 'unknown'
  expect(assess(rubric, unknown).score).toBe(100)
  expect(assess(rubric, unknown).accepted).toBe(false)
  const minor = complete()
  minor.ratings[4].value = 0.5
  expect(assess(rubric, minor).score).toBe(95)
  expect(assess(rubric, minor).accepted).toBe(true)
})
test('a partially fulfilled critical requirement blocks a numerically usable score', () => {
  const input = complete()
  input.ratings[0].value = 0.5
  expect(assess(rubric, input).score).toBe(85)
  expect(assess(rubric, input).qualityVerdict).toBe('needs_revision')
})
test('claims alone and omitted criteria cannot justify assessment', () => {
  const input = complete()
  input.evidence[0].kind = 'model-claim'
  expect(() => assess(rubric, input)).toThrow('model claim alone')
  const missing = complete()
  missing.ratings.pop()
  expect(() => assess(rubric, missing)).toThrow('Every criterion')
})
test('a historical single review cannot become a formally accepted comparison', () => {
  const input = complete()
  input.mode = 'historical-calibration'
  input.independentReviewers = 1
  expect(assess(rubric, input).qualityVerdict).toBe('excellent')
  expect(assess(rubric, input).accepted).toBe(false)
  expect(assess(rubric, complete()).accepted).toBe(true)
  const blocked = complete()
  blocked.taskOutcome = 'blocked'
  expect(assess(rubric, blocked).accepted).toBe(false)
})
