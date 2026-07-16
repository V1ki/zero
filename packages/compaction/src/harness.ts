import { buildCheckpointCandidate } from './candidate'
import {
  createTraceReductionNode,
  finalizeTraceReductionNode,
  mergeTraceReductionNodes,
} from './reducer'
import { readTraceSnapshot } from './trace-source'
import type {
  CompactionCheckpointPublisher,
  CompactionRunEvent,
  CompactionRunLimits,
  CompactionRunPhase,
  CompactionRunRequest,
  CompactionRunResult,
  TraceSnapshot,
} from './types'
import { validateCheckpointCandidate } from './validator'

export const DEFAULT_COMPACTION_RUN_LIMITS: CompactionRunLimits = {
  maxTraceLineChars: 8 * 1024 * 1024,
  maxTraceObservations: 200_000,
  maxLeafObservations: 256,
  maxMergeFanIn: 8,
  maxMergeDepth: 5,
  maxWorkItems: 512,
  maxCandidateChars: 100_000,
  maxLedgerChars: 1_000_000,
  maxLedgerBytes: 1_500_000,
  maxPublishedPayloadBytes: 2_000_000,
  maxActivities: 128,
  maxIncidents: 128,
  maxSideEffects: 64,
  maxChangePoints: 64,
  maxTransitions: 128,
  maxLatestStates: 96,
  sampleRefsPerGroup: 3,
  incidentGapMs: 2 * 60 * 60 * 1000,
}

export async function runCompactionHarness(
  request: CompactionRunRequest,
  dependencies: {
    publisher?: CompactionCheckpointPublisher
    onEvent?: (event: CompactionRunEvent) => void
  } = {},
): Promise<CompactionRunResult> {
  const startedAt = performance.now()
  const events: CompactionRunEvent[] = []
  const limits: CompactionRunLimits = {
    ...DEFAULT_COMPACTION_RUN_LIMITS,
    ...request.limits,
  }
  const sessionBinding = request.sessionBinding
  let phase: CompactionRunPhase = 'planned'
  let snapshot: TraceSnapshot | undefined
  let workItems = 0
  let mergeDepth = 0

  const transition = (nextPhase: CompactionRunPhase, detail?: string) => {
    phase = nextPhase
    const event: CompactionRunEvent = { phase: nextPhase, ...(detail ? { detail } : {}) }
    events.push(event)
    dependencies.onEvent?.(event)
  }

  transition('planned', `mode=${request.mode}`)

  try {
    assertValidLimits(limits)
    if (request.mode === 'publish' && !sessionBinding) {
      throw new Error('session_binding_required_for_publish')
    }
    transition('reading_snapshot')
    snapshot = await readTraceSnapshot({
      tracePath: request.tracePath,
      sourceSessionId: request.sourceSessionId,
      ...(request.allowedTraceRoot ? { allowedTraceRoot: request.allowedTraceRoot } : {}),
      maxLineChars: limits.maxTraceLineChars,
      maxObservations: limits.maxTraceObservations,
    })

    transition('reducing', `observations=${snapshot.observations.length}`)
    const leaves = chunkObservations(snapshot.observations, limits.maxLeafObservations)
    workItems = leaves.length
    if (workItems > limits.maxWorkItems) throw new Error('compaction_work_item_budget_exceeded')
    transition('summarizing_leaves', `leaves=${leaves.length}`)
    let nodes = leaves.map((leaf) => createTraceReductionNode(leaf, limits.sampleRefsPerGroup))
    while (nodes.length > 1) {
      mergeDepth++
      if (mergeDepth > limits.maxMergeDepth) throw new Error('compaction_merge_depth_exceeded')
      transition('merging', `depth=${mergeDepth} nodes=${nodes.length}`)
      const nextNodes = []
      for (let index = 0; index < nodes.length; index += limits.maxMergeFanIn) {
        nextNodes.push(
          mergeTraceReductionNodes(
            nodes.slice(index, index + limits.maxMergeFanIn),
            limits.sampleRefsPerGroup,
          ),
        )
      }
      workItems += nextNodes.length
      if (workItems > limits.maxWorkItems) throw new Error('compaction_work_item_budget_exceeded')
      nodes = nextNodes
    }
    const reduction = finalizeTraceReductionNode(nodes[0], {
      sampleRefsPerGroup: limits.sampleRefsPerGroup,
      incidentGapMs: limits.incidentGapMs,
    })
    const candidate = buildCheckpointCandidate({
      runId: request.runId,
      schemaVersion: request.schemaVersion,
      strategyVersion: request.strategyVersion,
      snapshot,
      reduction,
      limits,
      ...(sessionBinding ? { sessionBinding } : {}),
    })

    transition('validating')
    const validation = validateCheckpointCandidate({ candidate, snapshot, reduction, limits })
    if (validation.status === 'failed') {
      transition('failed', validation.errors.join(','))
      return {
        runId: request.runId,
        mode: request.mode,
        phase,
        source: sourceResult(snapshot),
        candidate,
        ledger: reduction.ledger,
        diagnosticActivities: reduction.activities.filter((item) => item.lane !== 'source'),
        diagnosticIncidents: reduction.incidents.filter((item) => item.lane !== 'source'),
        validation,
        events,
        workItems,
        mergeDepth,
        durationMs: elapsedMs(startedAt),
        error: 'candidate_validation_failed',
      }
    }

    transition('ready_to_commit')
    if (request.mode === 'dry_run') {
      return {
        runId: request.runId,
        mode: request.mode,
        phase,
        source: sourceResult(snapshot),
        candidate,
        ledger: reduction.ledger,
        diagnosticActivities: reduction.activities.filter((item) => item.lane !== 'source'),
        diagnosticIncidents: reduction.incidents.filter((item) => item.lane !== 'source'),
        validation,
        events,
        workItems,
        mergeDepth,
        durationMs: elapsedMs(startedAt),
        publishStatus: 'not_requested',
      }
    }

    if (!dependencies.publisher) throw new Error('publisher_not_configured')
    if (!sessionBinding) throw new Error('session_binding_required_for_publish')
    transition('publishing')
    const publishStatus = await dependencies.publisher.publish({
      candidate,
      ledger: reduction.ledger,
      expectedTraceRevision: snapshot.sourceRevision,
      expectedTraceDigest: snapshot.sourceDigest,
      expectedSessionBinding: sessionBinding,
    })
    if (publishStatus === 'stale') {
      transition('stale')
      return {
        runId: request.runId,
        mode: request.mode,
        phase,
        source: sourceResult(snapshot),
        candidate,
        ledger: reduction.ledger,
        diagnosticActivities: reduction.activities.filter((item) => item.lane !== 'source'),
        diagnosticIncidents: reduction.incidents.filter((item) => item.lane !== 'source'),
        validation,
        events,
        workItems,
        mergeDepth,
        durationMs: elapsedMs(startedAt),
        publishStatus,
      }
    }

    transition('committed')
    return {
      runId: request.runId,
      mode: request.mode,
      phase,
      source: sourceResult(snapshot),
      candidate,
      ledger: reduction.ledger,
      diagnosticActivities: reduction.activities.filter((item) => item.lane !== 'source'),
      diagnosticIncidents: reduction.incidents.filter((item) => item.lane !== 'source'),
      validation,
      events,
      workItems,
      mergeDepth,
      durationMs: elapsedMs(startedAt),
      publishStatus,
    }
  } catch (error) {
    const message = normalizeCompactionError(error)
    transition('failed', message)
    return {
      runId: request.runId,
      mode: request.mode,
      phase,
      ...(snapshot ? { source: sourceResult(snapshot) } : {}),
      events,
      workItems,
      mergeDepth,
      durationMs: elapsedMs(startedAt),
      error: message,
    }
  }
}

function chunkObservations<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [[]]
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function assertValidLimits(limits: CompactionRunLimits): void {
  const entries = Object.entries(limits)
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_compaction_limit:${key}`)
  }
  if (limits.maxMergeFanIn < 2) throw new Error('invalid_compaction_limit:maxMergeFanIn')
}

function sourceResult(snapshot: TraceSnapshot): NonNullable<CompactionRunResult['source']> {
  return {
    ...snapshot.stats,
    sourceSessionId: snapshot.sourceSessionId,
    sourceRevision: snapshot.sourceRevision,
    sourceDigest: snapshot.sourceDigest,
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function normalizeCompactionError(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) {
      return `trace_source_error:${code.toLowerCase()}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}
