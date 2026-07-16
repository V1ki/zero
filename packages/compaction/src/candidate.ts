import { compareText, stableDigest } from './hash'
import type { TraceReduction } from './reducer'
import type {
  CompactionActivity,
  CompactionCheckpointCandidate,
  CompactionCoverage,
  CompactionInterval,
  CompactionLatestState,
  CompactionRunLimits,
  CompactionSessionBinding,
  CompactionSideEffect,
  CompactionTransition,
  TraceSnapshot,
} from './types'

export function buildCheckpointCandidate(options: {
  runId: string
  schemaVersion: string
  strategyVersion: string
  snapshot: TraceSnapshot
  reduction: TraceReduction
  limits: CompactionRunLimits
  sessionBinding?: CompactionSessionBinding
}): CompactionCheckpointCandidate {
  const { snapshot, reduction, limits } = options
  const mutationOperations = new Set(reduction.sideEffects.map((item) => item.operation))
  const activities = selectActivities(
    reduction.activities.filter((item) => item.lane === 'source'),
    limits.maxActivities,
    mutationOperations,
  )
  const incidents = selectIncidents(
    reduction.incidents.filter((item) => item.lane === 'source'),
    limits.maxIncidents,
  )
  const changePoints = selectChangePoints(reduction.ledger.intervals, limits.maxChangePoints)
  const transitions = selectTransitions(
    reduction.transitions.filter((item) => item.lane === 'source'),
    limits.maxTransitions,
  )
  const latestState = selectLatestStates(
    reduction.latestState.filter((item) => item.lane === 'source'),
    limits.maxLatestStates,
  )
  const sideEffects = selectSideEffects(reduction.sideEffects, limits.maxSideEffects)
  const coverage = buildCoverage(snapshot, reduction, sideEffects.length)

  const candidate: CompactionCheckpointCandidate = {
    candidateKind: 'trace_diagnostic_checkpoint',
    semanticReplacementEvaluated: false,
    schemaVersion: options.schemaVersion,
    strategyVersion: options.strategyVersion,
    runId: options.runId,
    sourceSessionId: snapshot.sourceSessionId,
    sourceRevision: snapshot.sourceRevision,
    sourceDigest: snapshot.sourceDigest,
    ledgerDigest: reduction.ledger.digest,
    checkpointDigest: '',
    ...(options.sessionBinding ? { sessionBinding: options.sessionBinding } : {}),
    coveredRange: snapshot.coveredRange,
    summary: buildSummary(coverage, incidents),
    activities,
    incidents,
    sideEffects,
    changePoints,
    transitions,
    latestState,
    coverage,
    metrics: {
      sourceBytes: snapshot.stats.sourceBytes,
      projectedObservationChars: snapshot.stats.projectedObservationChars,
      lifecycleCollapsePercent: percent(
        snapshot.stats.supersededLifecycleEntries,
        snapshot.stats.lifecycleEntries,
      ),
    },
  }
  candidate.checkpointDigest = computeCheckpointDigest(candidate)
  return candidate
}

export function computeCheckpointDigest(candidate: CompactionCheckpointCandidate): string {
  return stableDigest({
    candidateKind: candidate.candidateKind,
    semanticReplacementEvaluated: candidate.semanticReplacementEvaluated,
    schemaVersion: candidate.schemaVersion,
    strategyVersion: candidate.strategyVersion,
    sourceSessionId: candidate.sourceSessionId,
    sourceDigest: candidate.sourceDigest,
    ledgerDigest: candidate.ledgerDigest,
    sessionBinding: candidate.sessionBinding,
    coveredRange: candidate.coveredRange,
    summary: candidate.summary,
    activities: candidate.activities,
    incidents: candidate.incidents,
    sideEffects: candidate.sideEffects,
    changePoints: candidate.changePoints,
    transitions: candidate.transitions,
    latestState: candidate.latestState,
    coverage: candidate.coverage,
  })
}

function buildCoverage(
  snapshot: TraceSnapshot,
  reduction: TraceReduction,
  selectedSideEffects: number,
): CompactionCoverage {
  const observations = snapshot.observations
  const sourceErrors = observations.filter(
    (item) => item.lane === 'source' && item.status === 'error',
  ).length
  const diagnosticErrors = observations.filter(
    (item) => item.lane !== 'source' && item.status === 'error',
  ).length
  const sourceIncidentErrors = reduction.incidents
    .filter((item) => item.lane === 'source')
    .reduce((total, incident) => total + incident.count, 0)
  const diagnosticIncidentErrors = reduction.incidents
    .filter((item) => item.lane !== 'source')
    .reduce((total, incident) => total + incident.count, 0)
  const accountedObservations = reduction.activities.reduce(
    (total, activity) => total + activity.count,
    0,
  )

  return {
    sourceTraceEntries: snapshot.stats.sourceLines,
    uniqueSpans: snapshot.stats.uniqueSpans,
    observations: observations.length,
    accountedObservations,
    errorObservations: sourceErrors,
    incidentErrorObservations: sourceIncidentErrors,
    diagnosticErrorObservations: diagnosticErrors,
    diagnosticIncidentErrorObservations: diagnosticIncidentErrors,
    runningObservations: observations.filter((item) => item.status === 'running').length,
    sideEffectObservations: reduction.sideEffects.length,
    retainedSideEffects: reduction.ledger.sideEffects.length,
    selectedSideEffects,
    activityGroups: reduction.activities.length,
    incidentGroups: reduction.incidents.length,
    transitionCount: reduction.transitions.length,
    sourceLaneObservations: countLane(observations, 'source'),
    diagnosticLaneObservations: countLane(observations, 'diagnostic'),
    controlLaneObservations: countLane(observations, 'control'),
  }
}

function buildSummary(
  coverage: CompactionCoverage,
  incidents: CompactionCheckpointCandidate['incidents'],
): string {
  const topIncidents = incidents
    .slice(0, 5)
    .map((incident) => `${incident.operation}:${incident.errorClass}=${incident.count}`)
    .join(', ')
  return [
    `${coverage.sourceTraceEntries} trace entries collapsed to ${coverage.observations} terminal observations and ${coverage.activityGroups} typed activity groups.`,
    `${coverage.errorObservations} source errors are fully accounted for; ${incidents.length} high-priority incident intervals are inline and ${coverage.retainedSideEffects} potential side effects are retained in the immutable ledger.`,
    topIncidents ? `Top incidents: ${topIncidents}.` : 'No terminal error incident was observed.',
  ].join(' ')
}

function selectActivities(
  items: CompactionActivity[],
  limit: number,
  mutationOperations: Set<string>,
): CompactionActivity[] {
  return [...items]
    .sort(
      (left, right) =>
        activityPriority(right, mutationOperations) - activityPriority(left, mutationOperations) ||
        right.count - left.count ||
        compareText(left.operation, right.operation),
    )
    .slice(0, limit)
}

function activityPriority(activity: CompactionActivity, mutationOperations: Set<string>): number {
  if (activity.status === 'error') return 4
  if (mutationOperations.has(activity.operation)) return 3
  if (activity.status === 'running') return 2
  return 1
}

function selectChangePoints(intervals: CompactionInterval[], limit: number): CompactionInterval[] {
  const eligible = intervals.filter(
    (interval) => interval.lane === 'source' && !interval.sideEffect,
  )
  if (eligible.length <= limit) return eligible

  const boundaryIds = new Set<string>()
  const byEntity = new Map<string, CompactionInterval[]>()
  for (const interval of eligible) {
    const entity = entityKey(interval)
    const group = byEntity.get(entity) ?? []
    group.push(interval)
    byEntity.set(entity, group)
  }
  for (const group of byEntity.values()) {
    const sorted = [...group].sort((left, right) => compareText(left.firstAt, right.firstAt))
    const first = sorted[0]
    const last = sorted.at(-1)
    if (first) boundaryIds.add(first.id)
    if (last) boundaryIds.add(last.id)
  }

  return [...eligible]
    .sort(
      (left, right) =>
        changePointPriority(right, boundaryIds) - changePointPriority(left, boundaryIds) ||
        right.count - left.count ||
        compareText(right.lastAt, left.lastAt) ||
        compareText(left.id, right.id),
    )
    .slice(0, limit)
    .sort((left, right) => compareText(left.firstAt, right.firstAt))
}

function changePointPriority(interval: CompactionInterval, boundaryIds: Set<string>): number {
  let priority = boundaryIds.has(interval.id) ? 4 : 0
  if (interval.status === 'error') priority += 2
  if (interval.status === 'running') priority += 1
  return priority
}

function selectSideEffects(
  sideEffects: CompactionSideEffect[],
  limit: number,
): CompactionSideEffect[] {
  if (sideEffects.length <= limit) return sideEffects

  const mandatory = new Map<string, CompactionSideEffect>()
  const latestFailureByEntity = new Map<string, CompactionSideEffect>()
  for (const sideEffect of sideEffects) {
    if (sideEffect.status === 'error') {
      latestFailureByEntity.set(entityKey(sideEffect), sideEffect)
    }
  }
  for (const sideEffect of latestFailureByEntity.values()) mandatory.set(sideEffect.ref, sideEffect)
  if (mandatory.size >= limit) {
    return [...mandatory.values()]
      .sort((left, right) => compareText(right.at, left.at) || compareText(left.ref, right.ref))
      .slice(0, limit)
      .sort((left, right) => compareText(left.at, right.at) || compareText(left.ref, right.ref))
  }

  const selected = new Map(mandatory)
  const latestByEntity = new Map<string, CompactionSideEffect>()
  for (const sideEffect of sideEffects) latestByEntity.set(entityKey(sideEffect), sideEffect)
  for (const sideEffect of [...latestByEntity.values()].sort((left, right) =>
    compareText(right.at, left.at),
  )) {
    if (selected.size >= limit) break
    selected.set(sideEffect.ref, sideEffect)
  }
  for (const sideEffect of [...sideEffects].sort((left, right) => compareText(right.at, left.at))) {
    if (selected.size >= limit) break
    selected.set(sideEffect.ref, sideEffect)
  }
  return [...selected.values()].sort((left, right) => compareText(left.at, right.at))
}

function selectIncidents(
  incidents: CompactionCheckpointCandidate['incidents'],
  limit: number,
): CompactionCheckpointCandidate['incidents'] {
  return [...incidents]
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareText(right.lastAt, left.lastAt) ||
        compareText(left.id, right.id),
    )
    .slice(0, limit)
    .sort((left, right) => compareText(left.firstAt, right.firstAt))
}

function selectTransitions(
  transitions: CompactionTransition[],
  limit: number,
): CompactionTransition[] {
  if (transitions.length <= limit) return transitions
  return [...transitions]
    .sort((left, right) => compareText(right.at, left.at) || compareText(left.ref, right.ref))
    .slice(0, limit)
    .sort((left, right) => compareText(left.at, right.at) || compareText(left.ref, right.ref))
}

function selectLatestStates(
  items: CompactionLatestState[],
  limit: number,
): CompactionLatestState[] {
  if (items.length <= limit) return items
  const errors = items.filter((item) => item.status === 'error')
  if (errors.length >= limit) {
    return errors
      .sort((left, right) => compareText(right.at, left.at) || compareText(left.ref, right.ref))
      .slice(0, limit)
      .sort(
        (left, right) =>
          compareText(left.operation, right.operation) ||
          compareText(left.subjectDigest, right.subjectDigest),
      )
  }
  const selected = new Map(errors.map((item) => [entityKey(item), item]))
  for (const item of [...items].sort((left, right) => compareText(right.at, left.at))) {
    if (selected.size >= limit) break
    selected.set(entityKey(item), item)
  }
  return [...selected.values()].sort(
    (left, right) =>
      compareText(left.operation, right.operation) ||
      compareText(left.subjectDigest, right.subjectDigest),
  )
}

function entityKey(item: { operation: string; subjectDigest: string }): string {
  return `${item.operation}\0${item.subjectDigest}`
}

function countLane(
  observations: TraceSnapshot['observations'],
  lane: TraceSnapshot['observations'][number]['lane'],
): number {
  return observations.filter((item) => item.lane === lane).length
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 10_000) / 100
}
