import { compareText, stableDigest } from './hash'
import type {
  CompactionActivity,
  CompactionIncident,
  CompactionInterval,
  CompactionLatestState,
  CompactionSideEffect,
  CompactionTraceLedger,
  CompactionTransition,
  MetricSummary,
  TraceObservation,
} from './types'

interface ActivityAccumulator {
  activity: CompactionActivity
  subjectDigests: Set<string>
  outcomeDigests: Set<string>
}

export interface TraceReductionNode {
  observationCount: number
  activities: Map<string, ActivityAccumulator>
  intervalsByOperation: Map<string, CompactionInterval[]>
  latestByEntity: Map<string, TraceObservation>
  sideEffects: CompactionSideEffect[]
}

export interface TraceReduction {
  ledger: CompactionTraceLedger
  activities: CompactionActivity[]
  incidents: CompactionIncident[]
  transitions: CompactionTransition[]
  latestState: CompactionLatestState[]
  sideEffects: CompactionSideEffect[]
}

export function reduceTraceObservations(
  observations: TraceObservation[],
  options: {
    sampleRefsPerGroup: number
    incidentGapMs: number
  },
): TraceReduction {
  return finalizeTraceReductionNode(
    createTraceReductionNode(observations, options.sampleRefsPerGroup),
    options,
  )
}

export function createTraceReductionNode(
  observations: TraceObservation[],
  sampleRefsPerGroup: number,
): TraceReductionNode {
  const sorted = [...observations].sort(compareObservation)
  const intervals = buildIntervals(sorted, sampleRefsPerGroup)
  const latestByEntity = new Map<string, TraceObservation>()
  for (const observation of sorted) latestByEntity.set(entityKey(observation), observation)
  return {
    observationCount: sorted.length,
    activities: buildActivityAccumulators(sorted, sampleRefsPerGroup),
    intervalsByOperation: groupBy(intervals, (item) => item.operation),
    latestByEntity,
    sideEffects: sorted.filter((item) => item.sideEffect).map(toSideEffect),
  }
}

export function mergeTraceReductionNodes(
  nodes: TraceReductionNode[],
  sampleRefsPerGroup: number,
): TraceReductionNode {
  const merged: TraceReductionNode = {
    observationCount: 0,
    activities: new Map(),
    intervalsByOperation: new Map(),
    latestByEntity: new Map(),
    sideEffects: [],
  }

  for (const node of nodes) {
    merged.observationCount += node.observationCount
    for (const [key, accumulator] of node.activities) {
      const current = merged.activities.get(key)
      if (!current) {
        merged.activities.set(key, cloneActivityAccumulator(accumulator))
        continue
      }
      mergeActivityAccumulator(current, accumulator, sampleRefsPerGroup)
    }
    for (const [operation, intervals] of node.intervalsByOperation) {
      const target = merged.intervalsByOperation.get(operation) ?? []
      for (const interval of intervals) {
        const previous = target.at(-1)
        if (previous && intervalKey(previous) === intervalKey(interval)) {
          previous.count += interval.count
          previous.lastAt = interval.lastAt
          previous.lastSourceLine = interval.lastSourceLine
          previous.sampleRefs = mergeSampleRefs(
            previous.sampleRefs,
            interval.sampleRefs,
            sampleRefsPerGroup,
          )
        } else {
          target.push(cloneInterval(interval))
        }
      }
      merged.intervalsByOperation.set(operation, target)
    }
    for (const [entity, observation] of node.latestByEntity) {
      const current = merged.latestByEntity.get(entity)
      if (!current || compareObservation(current, observation) <= 0) {
        merged.latestByEntity.set(entity, observation)
      }
    }
    merged.sideEffects.push(...node.sideEffects)
  }

  merged.sideEffects.sort(
    (left, right) => compareText(left.at, right.at) || compareText(left.ref, right.ref),
  )
  return merged
}

export function finalizeTraceReductionNode(
  node: TraceReductionNode,
  options: {
    sampleRefsPerGroup: number
    incidentGapMs: number
  },
): TraceReduction {
  const activities = [...node.activities.values()]
    .map((item) => {
      item.activity.uniqueSubjectCount = item.subjectDigests.size
      item.activity.uniqueOutcomeCount = item.outcomeDigests.size
      return item.activity
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareText(left.firstAt, right.firstAt) ||
        compareText(left.operation, right.operation),
    )
  const intervals = [...node.intervalsByOperation.values()]
    .flat()
    .sort(
      (left, right) =>
        compareText(left.firstAt, right.firstAt) || left.firstSourceLine - right.firstSourceLine,
    )
  const sideEffects = node.sideEffects
  const ledger: CompactionTraceLedger = {
    digest: stableDigest({
      observationCount: node.observationCount,
      intervals,
      sideEffects,
    }),
    observationCount: node.observationCount,
    intervals,
    sideEffects,
  }

  return {
    ledger,
    activities,
    incidents: buildIncidents(intervals, options),
    transitions: buildTransitions(intervals),
    latestState: buildLatestState(node.latestByEntity.values()),
    sideEffects,
  }
}

function buildActivityAccumulators(
  observations: TraceObservation[],
  sampleRefsPerGroup: number,
): Map<string, ActivityAccumulator> {
  const groups = new Map<string, ActivityAccumulator>()

  for (const observation of observations) {
    const key = [
      observation.lane,
      observation.kind,
      observation.operation,
      observation.status,
      observation.errorClass ?? '',
    ].join('|')
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        activity: {
          id: `activity_${stableDigest(key, 16)}`,
          lane: observation.lane,
          kind: observation.kind,
          operation: observation.operation,
          status: observation.status,
          ...(observation.errorClass ? { errorClass: observation.errorClass } : {}),
          count: 1,
          firstAt: observation.startedAt,
          lastAt: observation.endedAt ?? observation.startedAt,
          firstSourceLine: observation.sourceLine,
          lastSourceLine: observation.sourceLine,
          totalPayloadChars: observation.payloadChars,
          uniqueSubjectCount: 1,
          uniqueOutcomeCount: 1,
          sampleRefs: [observation.ref],
          metrics: summarizeMetrics(observation.metrics),
        },
        subjectDigests: new Set([observation.subjectDigest]),
        outcomeDigests: new Set([observation.outcomeDigest]),
      })
      continue
    }

    const activity = existing.activity
    activity.count++
    activity.lastAt = observation.endedAt ?? observation.startedAt
    activity.lastSourceLine = observation.sourceLine
    activity.totalPayloadChars += observation.payloadChars
    activity.sampleRefs = mergeSampleRefs(
      activity.sampleRefs,
      [observation.ref],
      sampleRefsPerGroup,
    )
    mergeMetricSummaries(activity.metrics, observation.metrics)
    existing.subjectDigests.add(observation.subjectDigest)
    existing.outcomeDigests.add(observation.outcomeDigest)
    activity.uniqueSubjectCount = existing.subjectDigests.size
    activity.uniqueOutcomeCount = existing.outcomeDigests.size
  }

  return groups
}

function buildIntervals(
  observations: TraceObservation[],
  sampleRefsPerGroup: number,
): CompactionInterval[] {
  const byOperation = new Map<string, CompactionInterval[]>()

  for (const observation of observations) {
    const intervals = byOperation.get(observation.operation) ?? []
    const previous = intervals.at(-1)
    const key = intervalKey(observation)
    if (previous && intervalKey(previous) === key) {
      previous.count++
      previous.lastAt = observation.endedAt ?? observation.startedAt
      previous.lastSourceLine = observation.sourceLine
      previous.sampleRefs = mergeSampleRefs(
        previous.sampleRefs,
        [observation.ref],
        sampleRefsPerGroup,
      )
    } else {
      intervals.push({
        id: `interval_${stableDigest(`${observation.operation}:${observation.sourceLine}`, 16)}`,
        operation: observation.operation,
        kind: observation.kind,
        lane: observation.lane,
        status: observation.status,
        ...(observation.errorClass ? { errorClass: observation.errorClass } : {}),
        subjectDigest: observation.subjectDigest,
        outcomeDigest: observation.outcomeDigest,
        sideEffect: observation.sideEffect,
        count: 1,
        firstAt: observation.startedAt,
        lastAt: observation.endedAt ?? observation.startedAt,
        firstSourceLine: observation.sourceLine,
        lastSourceLine: observation.sourceLine,
        sampleRefs: [observation.ref],
      })
    }
    byOperation.set(observation.operation, intervals)
  }

  return [...byOperation.values()]
    .flat()
    .sort(
      (left, right) =>
        compareText(left.firstAt, right.firstAt) || left.firstSourceLine - right.firstSourceLine,
    )
}

function buildIncidents(
  intervals: CompactionInterval[],
  options: { sampleRefsPerGroup: number; incidentGapMs: number },
): CompactionIncident[] {
  const byEntity = groupBy(intervals, entityKey)
  const incidents: CompactionIncident[] = []

  for (const entityIntervals of byEntity.values()) {
    const firstIncidentIndex = incidents.length
    const sorted = [...entityIntervals].sort((left, right) =>
      compareText(left.firstAt, right.firstAt),
    )
    let current:
      | (CompactionIncident & {
          subjects: Set<string>
        })
      | undefined

    for (let index = 0; index < sorted.length; index++) {
      const interval = sorted[index]
      if (interval.status !== 'error') {
        if (current) {
          incidents.push(stripIncidentInternals(current))
          current = undefined
        }
        continue
      }

      const previousAt = current ? new Date(current.lastAt).getTime() : 0
      const nextAt = new Date(interval.firstAt).getTime()
      const sameIncident =
        current &&
        current.errorClass === (interval.errorClass ?? 'unknown_error') &&
        nextAt - previousAt <= options.incidentGapMs
      if (sameIncident && current) {
        current.count += interval.count
        current.lastAt = interval.lastAt
        current.subjects.add(interval.subjectDigest)
        current.sampleSubjectDigests = mergeSampleRefs(
          current.sampleSubjectDigests,
          [interval.subjectDigest],
          options.sampleRefsPerGroup,
        )
        current.sampleRefs = mergeSampleRefs(
          current.sampleRefs,
          interval.sampleRefs,
          options.sampleRefsPerGroup,
        )
        current.uniqueSubjectCount = current.subjects.size
        continue
      }

      if (current) incidents.push(stripIncidentInternals(current))
      current = {
        id: `incident_${stableDigest(
          `${interval.operation}:${interval.errorClass}:${interval.firstSourceLine}`,
          16,
        )}`,
        operation: interval.operation,
        lane: interval.lane,
        errorClass: interval.errorClass ?? 'unknown_error',
        subjectDigest: interval.subjectDigest,
        count: interval.count,
        firstAt: interval.firstAt,
        lastAt: interval.lastAt,
        uniqueSubjectCount: 1,
        sampleSubjectDigests: [interval.subjectDigest],
        sampleRefs: interval.sampleRefs.slice(0, options.sampleRefsPerGroup),
        subjects: new Set([interval.subjectDigest]),
      }
    }

    if (current) incidents.push(stripIncidentInternals(current))
    for (const incident of incidents.slice(firstIncidentIndex)) {
      if (incident.recoveredAt) continue
      const recovery = sorted.find(
        (interval) => interval.status !== 'error' && interval.firstAt > incident.lastAt,
      )
      if (recovery) incident.recoveredAt = recovery.firstAt
    }
  }

  return incidents.sort(
    (left, right) => right.count - left.count || compareText(left.firstAt, right.firstAt),
  )
}

function stripIncidentInternals(
  incident: CompactionIncident & { subjects: Set<string> },
): CompactionIncident {
  const { subjects: _subjects, ...result } = incident
  return result
}

function buildTransitions(intervals: CompactionInterval[]): CompactionTransition[] {
  const transitions: CompactionTransition[] = []
  const byEntity = groupBy(intervals, entityKey)
  for (const entityIntervals of byEntity.values()) {
    const sorted = [...entityIntervals].sort((left, right) =>
      compareText(left.firstAt, right.firstAt),
    )
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]
      const current = sorted[index]
      const fromStatus = statusLabel(previous)
      const toStatus = statusLabel(current)
      if (fromStatus === toStatus) continue
      transitions.push({
        operation: current.operation,
        lane: current.lane,
        fromStatus,
        toStatus,
        at: current.firstAt,
        ref: current.sampleRefs[0] ?? current.id,
        subjectDigest: current.subjectDigest,
        outcomeDigest: current.outcomeDigest,
        ...(current.errorClass ? { errorClass: current.errorClass } : {}),
      })
    }
  }
  return transitions.sort(
    (left, right) => compareText(left.at, right.at) || compareText(left.ref, right.ref),
  )
}

function buildLatestState(observations: Iterable<TraceObservation>): CompactionLatestState[] {
  return [...observations]
    .map((observation) => ({
      operation: observation.operation,
      kind: observation.kind,
      lane: observation.lane,
      status: observation.status,
      at: observation.endedAt ?? observation.startedAt,
      ref: observation.ref,
      subjectDigest: observation.subjectDigest,
      outcomeDigest: observation.outcomeDigest,
      ...(observation.errorClass ? { errorClass: observation.errorClass } : {}),
      metrics: observation.metrics,
    }))
    .sort(
      (left, right) =>
        compareText(left.operation, right.operation) ||
        compareText(left.subjectDigest, right.subjectDigest),
    )
}

function cloneActivityAccumulator(source: ActivityAccumulator): ActivityAccumulator {
  return {
    activity: {
      ...source.activity,
      sampleRefs: [...source.activity.sampleRefs],
      metrics: Object.fromEntries(
        Object.entries(source.activity.metrics).map(([key, metric]) => [key, { ...metric }]),
      ),
    },
    subjectDigests: new Set(source.subjectDigests),
    outcomeDigests: new Set(source.outcomeDigests),
  }
}

function mergeActivityAccumulator(
  target: ActivityAccumulator,
  source: ActivityAccumulator,
  sampleRefsPerGroup: number,
): void {
  target.activity.count += source.activity.count
  if (source.activity.firstAt < target.activity.firstAt) {
    target.activity.firstAt = source.activity.firstAt
    target.activity.firstSourceLine = source.activity.firstSourceLine
  }
  if (source.activity.lastAt >= target.activity.lastAt) {
    target.activity.lastAt = source.activity.lastAt
    target.activity.lastSourceLine = source.activity.lastSourceLine
  }
  target.activity.totalPayloadChars += source.activity.totalPayloadChars
  target.activity.sampleRefs = mergeSampleRefs(
    target.activity.sampleRefs,
    source.activity.sampleRefs,
    sampleRefsPerGroup,
  )
  mergeMetricSummaryRecords(target.activity.metrics, source.activity.metrics)
  for (const digest of source.subjectDigests) target.subjectDigests.add(digest)
  for (const digest of source.outcomeDigests) target.outcomeDigests.add(digest)
}

function cloneInterval(interval: CompactionInterval): CompactionInterval {
  return { ...interval, sampleRefs: [...interval.sampleRefs] }
}

function toSideEffect(observation: TraceObservation): CompactionSideEffect {
  return {
    operation: observation.operation,
    status: observation.status,
    at: observation.endedAt ?? observation.startedAt,
    ref: observation.ref,
    subjectDigest: observation.subjectDigest,
    outcomeDigest: observation.outcomeDigest,
    ...(observation.errorClass ? { errorClass: observation.errorClass } : {}),
  }
}

function summarizeMetrics(metrics: Record<string, number>): Record<string, MetricSummary> {
  return Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [
      key,
      { count: 1, min: value, max: value, sum: value },
    ]),
  )
}

function mergeMetricSummaries(
  target: Record<string, MetricSummary>,
  metrics: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(metrics)) {
    const current = target[key]
    if (!current) {
      target[key] = { count: 1, min: value, max: value, sum: value }
      continue
    }
    current.count++
    current.min = Math.min(current.min, value)
    current.max = Math.max(current.max, value)
    current.sum += value
  }
}

function mergeMetricSummaryRecords(
  target: Record<string, MetricSummary>,
  source: Record<string, MetricSummary>,
): void {
  for (const [key, metric] of Object.entries(source)) {
    const current = target[key]
    if (!current) {
      target[key] = { ...metric }
      continue
    }
    current.count += metric.count
    current.min = Math.min(current.min, metric.min)
    current.max = Math.max(current.max, metric.max)
    current.sum += metric.sum
  }
}

function intervalKey(item: TraceObservation | CompactionInterval): string {
  return [
    item.operation,
    item.status,
    item.errorClass ?? '',
    item.subjectDigest,
    item.outcomeDigest,
    item.sideEffect ? 'mutation' : 'read_only',
  ].join('|')
}

function statusLabel(interval: CompactionInterval): string {
  return interval.errorClass ? `${interval.status}:${interval.errorClass}` : interval.status
}

function mergeSampleRefs(current: string[], incoming: string[], limit: number): string[] {
  if (limit <= 0) return []
  const result = [...current]
  for (const ref of incoming) {
    if (result.includes(ref)) continue
    if (result.length < limit) result.push(ref)
    else result[result.length - 1] = ref
  }
  return result
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = result.get(key) ?? []
    group.push(item)
    result.set(key, group)
  }
  return result
}

function compareObservation(left: TraceObservation, right: TraceObservation): number {
  return compareText(left.startedAt, right.startedAt) || left.sourceLine - right.sourceLine
}

function entityKey(item: { operation: string; subjectDigest: string }): string {
  return `${item.operation}\0${item.subjectDigest}`
}
