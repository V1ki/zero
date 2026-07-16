export type CompactionRunPhase =
  | 'planned'
  | 'reading_snapshot'
  | 'reducing'
  | 'summarizing_leaves'
  | 'merging'
  | 'validating'
  | 'repairing'
  | 'ready_to_commit'
  | 'publishing'
  | 'committed'
  | 'stale'
  | 'failed'

export type CompactionRunMode = 'dry_run' | 'publish'

export interface CompactionRunLimits {
  maxTraceLineChars: number
  maxTraceObservations: number
  maxLeafObservations: number
  maxMergeFanIn: number
  maxMergeDepth: number
  maxWorkItems: number
  maxCandidateChars: number
  maxLedgerChars: number
  maxLedgerBytes: number
  maxPublishedPayloadBytes: number
  maxActivities: number
  maxIncidents: number
  maxSideEffects: number
  maxChangePoints: number
  maxTransitions: number
  maxLatestStates: number
  sampleRefsPerGroup: number
  incidentGapMs: number
}

export interface CompactionSessionBinding {
  messagesRevision: string
  messagesDigest: string
  compactionBlocksRevision: string
  compactionBlocksDigest: string
  activeBlockHeadsDigest: string
  previousCheckpointHead?: string
  rollbackGeneration: number
  coveredMessageDigest: string
  coveredMessageRange: {
    fromMessageId?: string
    toMessageId?: string
    messageCount: number
  }
}

export interface CompactionRunRequest {
  runId: string
  sourceSessionId: string
  tracePath: string
  allowedTraceRoot?: string
  mode: CompactionRunMode
  strategyVersion: string
  schemaVersion: string
  sessionBinding?: CompactionSessionBinding
  limits?: Partial<CompactionRunLimits>
}

export interface TraceEntryLike {
  spanId?: unknown
  parentSpanId?: unknown
  sessionId?: unknown
  kind?: unknown
  name?: unknown
  agentName?: unknown
  startTime?: unknown
  endTime?: unknown
  durationMs?: unknown
  status?: unknown
  data?: unknown
  metadata?: unknown
}

export interface TraceObservation {
  ref: string
  spanId: string
  parentSpanId?: string
  sourceLine: number
  sessionId: string
  kind: string
  operation: string
  lane: 'source' | 'diagnostic' | 'control'
  status: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  subjectDigest: string
  outcomeDigest: string
  errorClass?: string
  sideEffect: boolean
  payloadChars: number
  metrics: Record<string, number>
}

export interface TraceSnapshotStats {
  sourcePath: string
  sourceBytes: number
  sourceLines: number
  parsedLines: number
  invalidJsonLines: number
  invalidShapeLines: number
  foreignSessionLines: number
  lifecycleEntries: number
  supersededLifecycleEntries: number
  supersededPayloadChars: number
  uniqueSpans: number
  terminalPayloadChars: number
  projectedObservationChars: number
  maxLineChars: number
}

export interface TraceSnapshot {
  sourceSessionId: string
  sourceRevision: string
  sourceDigest: string
  coveredRange: {
    fromLine: number
    toLine: number
  }
  observations: TraceObservation[]
  stats: TraceSnapshotStats
}

export interface MetricSummary {
  count: number
  min: number
  max: number
  sum: number
}

export interface CompactionActivity {
  id: string
  kind: string
  operation: string
  lane: TraceObservation['lane']
  status: string
  errorClass?: string
  count: number
  firstAt: string
  lastAt: string
  firstSourceLine: number
  lastSourceLine: number
  totalPayloadChars: number
  uniqueSubjectCount: number
  uniqueOutcomeCount: number
  sampleRefs: string[]
  metrics: Record<string, MetricSummary>
}

export interface CompactionIncident {
  id: string
  operation: string
  lane: TraceObservation['lane']
  errorClass: string
  subjectDigest: string
  count: number
  firstAt: string
  lastAt: string
  recoveredAt?: string
  uniqueSubjectCount: number
  sampleSubjectDigests: string[]
  sampleRefs: string[]
}

export interface CompactionSideEffect {
  operation: string
  status: string
  at: string
  ref: string
  subjectDigest: string
  outcomeDigest: string
  errorClass?: string
}

export interface CompactionTransition {
  operation: string
  lane: TraceObservation['lane']
  fromStatus: string
  toStatus: string
  at: string
  ref: string
  subjectDigest: string
  outcomeDigest: string
  errorClass?: string
}

export interface CompactionLatestState {
  operation: string
  kind: string
  status: string
  at: string
  ref: string
  subjectDigest: string
  outcomeDigest: string
  lane: TraceObservation['lane']
  errorClass?: string
  metrics: Record<string, number>
}

export interface CompactionInterval {
  id: string
  operation: string
  kind: string
  lane: TraceObservation['lane']
  status: string
  errorClass?: string
  subjectDigest: string
  outcomeDigest: string
  sideEffect: boolean
  count: number
  firstAt: string
  lastAt: string
  firstSourceLine: number
  lastSourceLine: number
  sampleRefs: string[]
}

export interface CompactionTraceLedger {
  digest: string
  observationCount: number
  intervals: CompactionInterval[]
  sideEffects: CompactionSideEffect[]
}

export interface CompactionCoverage {
  sourceTraceEntries: number
  uniqueSpans: number
  observations: number
  accountedObservations: number
  errorObservations: number
  incidentErrorObservations: number
  diagnosticErrorObservations: number
  diagnosticIncidentErrorObservations: number
  runningObservations: number
  sideEffectObservations: number
  retainedSideEffects: number
  selectedSideEffects: number
  activityGroups: number
  incidentGroups: number
  transitionCount: number
  sourceLaneObservations: number
  diagnosticLaneObservations: number
  controlLaneObservations: number
}

export interface CompactionCheckpointCandidate {
  candidateKind: 'trace_diagnostic_checkpoint'
  semanticReplacementEvaluated: false
  schemaVersion: string
  strategyVersion: string
  runId: string
  sourceSessionId: string
  sourceRevision: string
  sourceDigest: string
  ledgerDigest: string
  checkpointDigest: string
  sessionBinding?: CompactionSessionBinding
  coveredRange: TraceSnapshot['coveredRange']
  summary: string
  activities: CompactionActivity[]
  incidents: CompactionIncident[]
  sideEffects: CompactionSideEffect[]
  changePoints: CompactionInterval[]
  transitions: CompactionTransition[]
  latestState: CompactionLatestState[]
  coverage: CompactionCoverage
  metrics: {
    sourceBytes: number
    projectedObservationChars: number
    lifecycleCollapsePercent: number
  }
}

export interface CompactionValidationResult {
  status: 'passed' | 'failed'
  errors: string[]
  warnings: string[]
  candidateChars: number
  candidateBytes: number
  ledgerChars: number
  ledgerBytes: number
  publishedPayloadBytes: number
  checkpointOnlyTraceShrinkPercent: number
  publishedPayloadTraceShrinkPercent: number
  maxCandidateChars: number
  maxLedgerChars: number
  maxLedgerBytes: number
  maxPublishedPayloadBytes: number
}

export interface CompactionRunEvent {
  phase: CompactionRunPhase
  detail?: string
}

export interface CompactionRunResult {
  runId: string
  mode: CompactionRunMode
  phase: CompactionRunPhase
  source?: TraceSnapshotStats & {
    sourceSessionId: string
    sourceRevision: string
    sourceDigest: string
  }
  candidate?: CompactionCheckpointCandidate
  ledger?: CompactionTraceLedger
  diagnosticActivities?: CompactionActivity[]
  diagnosticIncidents?: CompactionIncident[]
  validation?: CompactionValidationResult
  events: CompactionRunEvent[]
  workItems: number
  mergeDepth: number
  durationMs: number
  publishStatus?: 'not_requested' | 'published' | 'stale'
  error?: string
}

export interface CompactionCheckpointPublisher {
  publish(input: {
    candidate: CompactionCheckpointCandidate
    ledger: CompactionTraceLedger
    expectedTraceRevision: string
    expectedTraceDigest: string
    expectedSessionBinding: CompactionSessionBinding
  }): Promise<'published' | 'stale'>
}
