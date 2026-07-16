import { describe, expect, test } from 'bun:test'
import {
  createTraceReductionNode,
  finalizeTraceReductionNode,
  mergeTraceReductionNodes,
  reduceTraceObservations,
} from '../reducer'
import type { TraceObservation } from '../types'

describe('trace reducer', () => {
  test('preserves A-B-A change-point intervals instead of flattening repeated state', () => {
    const observations = [
      ...repeatObservation('A', 50, 0),
      ...repeatObservation('B', 21, 50),
      ...repeatObservation('A', 10, 71),
    ]

    const reduction = reduceTraceObservations(observations, {
      sampleRefsPerGroup: 3,
      incidentGapMs: 60_000,
    })

    expect(reduction.ledger.intervals.map((item) => item.count)).toEqual([50, 21, 10])
    expect(reduction.ledger.intervals.map((item) => item.subjectDigest)).toEqual(['A', 'B', 'A'])
    expect(reduction.activities).toHaveLength(1)
    expect(reduction.activities[0]?.count).toBe(81)
    expect(reduction.activities[0]?.uniqueSubjectCount).toBe(2)
  })

  test('keeps distinct error intervals and recovery boundaries', () => {
    const observations = [
      observation(0, 'success', 'subject', 'ok'),
      ...Array.from({ length: 5 }, (_, index) =>
        observation(index + 1, 'error', 'subject', 'failure_a', 'timeout'),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        observation(index + 6, 'error', 'subject', 'failure_b', 'permission_error'),
      ),
      observation(8, 'success', 'subject', 'recovered'),
    ]

    const reduction = reduceTraceObservations(observations, {
      sampleRefsPerGroup: 3,
      incidentGapMs: 60_000,
    })

    expect(reduction.incidents).toHaveLength(2)
    expect(reduction.incidents.map((item) => [item.errorClass, item.count])).toEqual([
      ['timeout', 5],
      ['permission_error', 2],
    ])
    expect(reduction.incidents.every((item) => item.recoveredAt !== undefined)).toBe(true)
    expect(reduction.transitions.map((item) => item.toStatus)).toEqual([
      'error:timeout',
      'error:permission_error',
      'success',
    ])
  })

  test('bounded leaf and tree merge is equivalent to one-pass reduction', () => {
    const observations = [
      ...repeatObservation('A', 50, 0),
      ...repeatObservation('B', 21, 50),
      ...repeatObservation('A', 10, 71),
      observation(81, 'error', 'A', 'failure', 'timeout'),
      observation(82, 'success', 'A', 'recovered'),
    ]
    const options = { sampleRefsPerGroup: 3, incidentGapMs: 60_000 }
    const direct = reduceTraceObservations(observations, options)
    const leaves = [
      observations.slice(0, 20),
      observations.slice(20, 60),
      observations.slice(60),
    ].map((leaf) => createTraceReductionNode(leaf, options.sampleRefsPerGroup))
    const firstMerge = mergeTraceReductionNodes(leaves.slice(0, 2), options.sampleRefsPerGroup)
    const root = mergeTraceReductionNodes([firstMerge, leaves[2]], options.sampleRefsPerGroup)
    const merged = finalizeTraceReductionNode(root, options)

    expect(merged.ledger.digest).toBe(direct.ledger.digest)
    expect(merged.activities).toEqual(direct.activities)
    expect(merged.incidents).toEqual(direct.incidents)
    expect(merged.latestState).toEqual(direct.latestState)
  })

  test('isolates recovery, transitions, and latest state by operation and subject', () => {
    const beforeRecovery = [
      observation(0, 'error', 'subject_a', 'failure_a', 'timeout'),
      observation(1, 'success', 'subject_b', 'success_b'),
    ]
    const options = { sampleRefsPerGroup: 3, incidentGapMs: 60_000 }
    const isolated = reduceTraceObservations(beforeRecovery, options)

    expect(isolated.incidents).toHaveLength(1)
    expect(isolated.incidents[0]?.subjectDigest).toBe('subject_a')
    expect(isolated.incidents[0]?.recoveredAt).toBeUndefined()
    expect(isolated.transitions).toHaveLength(0)
    expect(isolated.latestState.map((item) => item.subjectDigest)).toEqual([
      'subject_a',
      'subject_b',
    ])

    const observations = [...beforeRecovery, observation(2, 'success', 'subject_a', 'recovered_a')]
    const direct = reduceTraceObservations(observations, options)
    const leaves = observations.map((item) =>
      createTraceReductionNode([item], options.sampleRefsPerGroup),
    )
    const merged = finalizeTraceReductionNode(
      mergeTraceReductionNodes(leaves, options.sampleRefsPerGroup),
      options,
    )

    expect(direct.incidents[0]?.recoveredAt).toBe(observations[2]?.startedAt)
    expect(direct.transitions).toHaveLength(1)
    expect(direct.transitions[0]?.subjectDigest).toBe('subject_a')
    expect(merged).toEqual(direct)
  })
})

function repeatObservation(subject: string, count: number, offset: number): TraceObservation[] {
  return Array.from({ length: count }, (_, index) =>
    observation(index + offset, 'success', subject, `outcome_${subject}`),
  )
}

function observation(
  index: number,
  status: 'success' | 'error',
  subjectDigest: string,
  outcomeDigest: string,
  errorClass?: string,
): TraceObservation {
  const at = new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
  return {
    ref: `span:span_${index}`,
    spanId: `span_${index}`,
    sourceLine: index + 1,
    sessionId: 'sess_reducer',
    kind: 'tool_call',
    operation: 'tool:x_search',
    lane: 'source',
    status,
    startedAt: at,
    endedAt: at,
    subjectDigest,
    outcomeDigest,
    ...(errorClass ? { errorClass } : {}),
    sideEffect: false,
    payloadChars: 100,
    metrics: {},
  }
}
