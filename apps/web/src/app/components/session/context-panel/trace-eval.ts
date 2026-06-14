import { type TraceSpan as ObserveTraceSpan, flattenTraceSpans } from '@zero-os/observe'
import type { SessionTaskClosureEvent, TraceSpan } from '../timeline/timeline'
import { getTaskClosureTraceDetails } from '../timeline/timeline'

export interface TraceEvalRequestEntry {
  id: string
  stopReason: string
  toolUseCount: number
  durationMs?: number
  cost: number
  ts: string
}

export type EvalVerdict = 'resolved' | 'blocked' | 'needs_review'
export type EvalConfidence = 'high' | 'medium' | 'low'
export type EvalTone = 'good' | 'warn' | 'bad'

export interface TraceEvalClosureEvent {
  ts: string
  event: SessionTaskClosureEvent['event']
  action?: SessionTaskClosureEvent['action']
  reason: string
  failureStage?: SessionTaskClosureEvent['failureStage']
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
}

export interface TraceEvalBreakdownItem {
  key: 'outcome' | 'execution' | 'efficiency' | 'trace_quality'
  label: string
  score: number
  maxScore: number
  note: string
}

export interface TraceEvalHighlight {
  tone: EvalTone
  text: string
}

export interface TraceEvalMetrics {
  turnCount: number
  llmRequestSpanCount: number
  projectedRequestCount: number
  toolCallCount: number
  toolErrorCount: number
  llmErrorCount: number
  closureCount: number
  finishCount: number
  blockCount: number
  continueCount: number
  requestCoverage: number
  avgRequestsPerTurn: number
  runningSpanCount: number
  latestAction?: SessionTaskClosureEvent['action']
  latestReason?: string
  subAgentCount: number
  subAgentSuccessRate: number
  subAgentTotalDurationMs: number
}

export interface TraceEvalReport {
  score: number
  verdict: EvalVerdict
  confidence: EvalConfidence
  summary: string
  breakdown: TraceEvalBreakdownItem[]
  highlights: TraceEvalHighlight[]
  metrics: TraceEvalMetrics
}

interface TraceEvalSpanSets {
  llmRequestSpans: TraceSpan[]
  toolCallSpans: TraceSpan[]
  turnSpans: TraceSpan[]
  runningSpanCount: number
  subAgentSpans: TraceSpan[]
}

export function evaluateTraceSession({
  traces = [],
  taskClosureEvents = [],
  llmRequests = [],
}: {
  traces?: TraceSpan[]
  taskClosureEvents?: SessionTaskClosureEvent[]
  llmRequests?: TraceEvalRequestEntry[]
}): TraceEvalReport {
  const flattened = flattenTraceSpans(traces as ObserveTraceSpan[]) as TraceSpan[]
  const spanSets = collectTraceEvalSpanSets(flattened)
  const closures = collectTraceEvalClosures({ flattened, taskClosureEvents })
  const metrics = buildTraceEvalMetrics({ spanSets, llmRequests, closures })
  const assessment = buildTraceEvalAssessment({
    latestClosure: closures.at(-1),
    metrics,
  })

  return {
    ...assessment,
    metrics,
  }
}

function collectTraceEvalClosures({
  flattened,
  taskClosureEvents,
}: {
  flattened: TraceSpan[]
  taskClosureEvents: SessionTaskClosureEvent[]
}): TraceEvalClosureEvent[] {
  return dedupeClosures([
    ...taskClosureEvents.map(normalizePersistedClosureEvent),
    ...flattened
      .map(normalizeTraceClosureSpan)
      .filter((item): item is TraceEvalClosureEvent => item !== null),
  ]).sort((left, right) => getClosureTimestamp(left).localeCompare(getClosureTimestamp(right)))
}

function normalizePersistedClosureEvent(event: SessionTaskClosureEvent): TraceEvalClosureEvent {
  return {
    ts: event.ts,
    event: event.event,
    action: event.action,
    reason: event.reason,
    failureStage: event.failureStage,
    assistantMessageId: event.assistantMessageId,
    assistantMessageCreatedAt: event.assistantMessageCreatedAt,
  }
}

function normalizeTraceClosureSpan(span: TraceSpan): TraceEvalClosureEvent | null {
  if (span.name !== 'task_closure_decision' && span.name !== 'task_closure_failed') return null

  const details = getTaskClosureTraceDetails(span)
  if (details.called === false) return null

  const event = details.event
  const reason = details.reason
  if (!event || !reason) return null

  return {
    ts: span.endTime ?? span.startTime,
    event,
    action: details.action,
    reason,
    failureStage: details.failureStage,
    assistantMessageId: details.assistantMessageId,
    assistantMessageCreatedAt: details.assistantMessageCreatedAt,
  }
}

function dedupeClosures(events: TraceEvalClosureEvent[]): TraceEvalClosureEvent[] {
  const deduped = new Map<string, TraceEvalClosureEvent>()
  for (const event of events) {
    deduped.set(getClosureKey(event), event)
  }
  return Array.from(deduped.values())
}

function getClosureKey(event: TraceEvalClosureEvent): string {
  return [
    event.event,
    event.action ?? '',
    event.failureStage ?? '',
    event.reason,
    event.assistantMessageId ?? '',
  ].join('|')
}

function getClosureTimestamp(event: TraceEvalClosureEvent): string {
  return event.assistantMessageCreatedAt ?? event.ts
}

function collectTraceEvalSpanSets(flattened: TraceSpan[]): TraceEvalSpanSets {
  return {
    llmRequestSpans: flattened.filter((span) => span.name === 'llm_request'),
    toolCallSpans: flattened.filter((span) => span.name.startsWith('tool:')),
    turnSpans: flattened.filter((span) => span.name.startsWith('turn:')),
    runningSpanCount: flattened.filter((span) => span.status === 'running').length,
    subAgentSpans: flattened.filter(isSubAgentSpan),
  }
}

function buildTraceEvalMetrics({
  spanSets,
  llmRequests,
  closures,
}: {
  spanSets: TraceEvalSpanSets
  llmRequests: TraceEvalRequestEntry[]
  closures: TraceEvalClosureEvent[]
}): TraceEvalMetrics {
  const subAgentCount = spanSets.subAgentSpans.length
  const subAgentSuccessCount = spanSets.subAgentSpans.filter(
    (span) => span.status === 'success' || span.data?.success === true,
  ).length
  const subAgentSuccessRate = subAgentCount > 0 ? subAgentSuccessCount / subAgentCount : 0
  const subAgentTotalDurationMs = spanSets.subAgentSpans.reduce(
    (sum, span) => sum + ((span.data?.durationMs as number | undefined) ?? span.durationMs ?? 0),
    0,
  )
  const llmErrorCount = spanSets.llmRequestSpans.filter((span) => span.status === 'error').length
  const toolErrorCount = spanSets.toolCallSpans.filter((span) => span.status === 'error').length
  const requestCoverage =
    spanSets.llmRequestSpans.length > 0
      ? clamp(llmRequests.length / spanSets.llmRequestSpans.length, 0, 1)
      : llmRequests.length > 0
        ? 1
        : 0
  const turnCount = Math.max(spanSets.turnSpans.length, llmRequests.length > 0 ? 1 : 0)
  const avgRequestsPerTurn = llmRequests.length / Math.max(turnCount, 1)
  const latestClosure = closures.at(-1)

  return {
    turnCount,
    llmRequestSpanCount: spanSets.llmRequestSpans.length,
    projectedRequestCount: llmRequests.length,
    toolCallCount: spanSets.toolCallSpans.length,
    toolErrorCount,
    llmErrorCount,
    closureCount: closures.length,
    finishCount: closures.filter((closure) => closure.action === 'finish').length,
    blockCount: closures.filter((closure) => closure.action === 'block').length,
    continueCount: closures.filter((closure) => closure.action === 'continue').length,
    requestCoverage,
    avgRequestsPerTurn,
    runningSpanCount: spanSets.runningSpanCount,
    latestAction: latestClosure?.action,
    latestReason: latestClosure?.reason,
    subAgentCount,
    subAgentSuccessRate,
    subAgentTotalDurationMs,
  }
}

function isSubAgentSpan(span: TraceSpan): boolean {
  return (
    span.name === 'sub_agent' ||
    span.name.startsWith('sub_agent:') ||
    span.data?.kind === 'sub_agent' ||
    span.metadata?.kind === 'sub_agent'
  )
}

function buildTraceEvalAssessment({
  latestClosure,
  metrics,
}: {
  latestClosure?: TraceEvalClosureEvent
  metrics: TraceEvalMetrics
}): Omit<TraceEvalReport, 'metrics'> {
  const { breakdown, score } = buildTraceEvalBreakdown({ latestClosure, metrics })
  const verdict = inferTraceEvalVerdict(latestClosure, score)
  const confidence = inferTraceEvalConfidence(
    metrics.requestCoverage,
    metrics.closureCount,
    metrics.runningSpanCount,
  )

  return {
    score,
    verdict,
    confidence,
    summary: buildTraceEvalSummary(verdict, confidence, latestClosure),
    breakdown,
    highlights: buildTraceEvalHighlights(latestClosure, metrics),
  }
}

function buildTraceEvalBreakdown({
  latestClosure,
  metrics,
}: {
  latestClosure?: TraceEvalClosureEvent
  metrics: TraceEvalMetrics
}): { breakdown: TraceEvalBreakdownItem[]; score: number } {
  const breakdown = [
    scoreOutcome(latestClosure),
    scoreExecution(metrics.toolCallCount, metrics.toolErrorCount, metrics.llmErrorCount),
    scoreEfficiency(
      metrics.avgRequestsPerTurn,
      metrics.projectedRequestCount,
      metrics.toolCallCount,
    ),
    scoreTraceQuality(metrics.requestCoverage, metrics.closureCount, metrics.runningSpanCount),
  ]
  const score = breakdown.reduce((sum, item) => sum + item.score, 0)

  return { breakdown, score }
}

function scoreOutcome(closure: TraceEvalClosureEvent | undefined): TraceEvalBreakdownItem {
  if (!closure) {
    return {
      key: 'outcome',
      label: 'Outcome',
      score: 14,
      maxScore: 45,
      note: 'No task-closure result yet; outcome confidence is limited.',
    }
  }

  if (closure.event === 'task_closure_failed') {
    return {
      key: 'outcome',
      label: 'Outcome',
      score: 8,
      maxScore: 45,
      note: `Task closure failed at ${closure.failureStage ?? 'unknown stage'}.`,
    }
  }

  if (closure.action === 'finish') {
    return {
      key: 'outcome',
      label: 'Outcome',
      score: 45,
      maxScore: 45,
      note: 'Latest turn is classified as completed.',
    }
  }

  if (closure.action === 'block') {
    return {
      key: 'outcome',
      label: 'Outcome',
      score: closure.reason.trim().length > 0 ? 36 : 28,
      maxScore: 45,
      note: 'Latest turn is blocked, but the trace preserves an explicit reason.',
    }
  }

  return {
    key: 'outcome',
    label: 'Outcome',
    score: 20,
    maxScore: 45,
    note: 'Latest turn still requires continuation.',
  }
}

function scoreExecution(
  toolCallCount: number,
  toolErrorCount: number,
  llmErrorCount: number,
): TraceEvalBreakdownItem {
  if (toolCallCount === 0) {
    return {
      key: 'execution',
      label: 'Execution',
      score: llmErrorCount > 0 ? 18 : 25,
      maxScore: 25,
      note:
        llmErrorCount > 0
          ? 'Model-only run, but at least one request errored.'
          : 'Model-only run with no tool failures.',
    }
  }

  const successRate = clamp((toolCallCount - toolErrorCount) / toolCallCount, 0, 1)
  const llmPenalty = Math.min(llmErrorCount * 2, 4)
  return {
    key: 'execution',
    label: 'Execution',
    score: clamp(Math.round(25 * successRate) - llmPenalty, 0, 25),
    maxScore: 25,
    note: `${toolCallCount - toolErrorCount}/${toolCallCount} tool calls succeeded.`,
  }
}

function scoreEfficiency(
  avgRequestsPerTurn: number,
  requestCount: number,
  toolCallCount: number,
): TraceEvalBreakdownItem {
  let score = 15
  if (avgRequestsPerTurn > 3) score -= 3
  if (avgRequestsPerTurn > 5) score -= 3
  if (avgRequestsPerTurn > 8) score -= 3
  if (toolCallCount > requestCount * 2 && requestCount > 0) score -= 2

  return {
    key: 'efficiency',
    label: 'Efficiency',
    score: clamp(score, 0, 15),
    maxScore: 15,
    note: `${requestCount} requests across ${Math.max(1, Math.round(requestCount / Math.max(avgRequestsPerTurn, 1)))} turn-equivalent(s).`,
  }
}

function scoreTraceQuality(
  requestCoverage: number,
  closureCount: number,
  runningSpanCount: number,
): TraceEvalBreakdownItem {
  const closureSignal = closureCount > 0 ? 1 : 0.4
  const runningSignal = runningSpanCount === 0 ? 1 : 0.5
  const score = Math.round(15 * (requestCoverage * 0.5 + closureSignal * 0.3 + runningSignal * 0.2))

  return {
    key: 'trace_quality',
    label: 'Trace Quality',
    score: clamp(score, 0, 15),
    maxScore: 15,
    note:
      runningSpanCount === 0
        ? `Coverage ${Math.round(requestCoverage * 100)}% with ${closureCount} closure event${closureCount === 1 ? '' : 's'}.`
        : `Coverage ${Math.round(requestCoverage * 100)}% with ${runningSpanCount} running span${runningSpanCount === 1 ? '' : 's'}.`,
  }
}

function buildTraceEvalHighlights(
  latestClosure: TraceEvalClosureEvent | undefined,
  metrics: TraceEvalMetrics,
): TraceEvalHighlight[] {
  const highlights: TraceEvalHighlight[] = []

  if (latestClosure?.event === 'task_closure_decision' && latestClosure.action) {
    highlights.push({
      tone:
        latestClosure.action === 'finish'
          ? 'good'
          : latestClosure.action === 'block'
            ? 'warn'
            : 'warn',
      text: `Latest closure: ${latestClosure.action}${latestClosure.reason ? ` · ${latestClosure.reason}` : ''}`,
    })
  } else if (latestClosure?.event === 'task_closure_failed') {
    highlights.push({
      tone: 'bad',
      text: `Task closure failed at ${latestClosure.failureStage ?? 'unknown stage'} · ${latestClosure.reason}`,
    })
  } else if (metrics.projectedRequestCount > 0) {
    highlights.push({
      tone: 'warn',
      text: 'No task closure decision found yet; score relies on execution evidence only.',
    })
  } else {
    highlights.push({
      tone: 'warn',
      text: 'Trace data is still too sparse to derive a stable score.',
    })
  }

  if (metrics.toolCallCount > 0) {
    const successCount = metrics.toolCallCount - metrics.toolErrorCount
    highlights.push({
      tone:
        metrics.toolErrorCount === 0
          ? 'good'
          : metrics.toolErrorCount / metrics.toolCallCount <= 0.25
            ? 'warn'
            : 'bad',
      text: `Tool calls: ${successCount}/${metrics.toolCallCount} succeeded${metrics.toolErrorCount > 0 ? `, ${metrics.toolErrorCount} errored` : ''}.`,
    })
  }

  if (metrics.requestCoverage < 1) {
    highlights.push({
      tone: metrics.requestCoverage >= 0.8 ? 'warn' : 'bad',
      text: `Projected request coverage: ${Math.round(metrics.requestCoverage * 100)}% (${metrics.projectedRequestCount}/${metrics.llmRequestSpanCount || metrics.projectedRequestCount}).`,
    })
  }

  if (metrics.runningSpanCount > 0) {
    highlights.push({
      tone: 'warn',
      text: `${metrics.runningSpanCount} trace span${metrics.runningSpanCount > 1 ? 's are' : ' is'} still running; outcome may change.`,
    })
  }

  return highlights
}

function buildTraceEvalSummary(
  verdict: EvalVerdict,
  confidence: EvalConfidence,
  latestClosure: TraceEvalClosureEvent | undefined,
): string {
  const verdictLabel =
    verdict === 'resolved' ? 'Resolved' : verdict === 'blocked' ? 'Blocked' : 'Needs review'
  const suffix = latestClosure?.reason ? ` · ${latestClosure.reason}` : ''
  return `${verdictLabel} · ${confidence} confidence${suffix}`
}

function inferTraceEvalVerdict(
  closure: TraceEvalClosureEvent | undefined,
  score: number,
): EvalVerdict {
  if (closure?.event === 'task_closure_decision') {
    if (closure.action === 'finish') return 'resolved'
    if (closure.action === 'block') return 'blocked'
  }

  if (score >= 75) return 'resolved'
  return 'needs_review'
}

function inferTraceEvalConfidence(
  requestCoverage: number,
  closureCount: number,
  runningSpanCount: number,
): EvalConfidence {
  if (requestCoverage >= 0.9 && closureCount > 0 && runningSpanCount === 0) return 'high'
  if (requestCoverage >= 0.6) return 'medium'
  return 'low'
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
