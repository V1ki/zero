import { computeCheckpointDigest } from './candidate'
import { stableDigest, stableJson } from './hash'
import type { TraceReduction } from './reducer'
import type {
  CompactionCheckpointCandidate,
  CompactionRunLimits,
  CompactionValidationResult,
  TraceSnapshot,
} from './types'

const forbiddenRawKeys = ['query', 'command', 'request', 'response', 'evidence', 'input', 'output']

export function validateCheckpointCandidate(options: {
  candidate: CompactionCheckpointCandidate
  snapshot: TraceSnapshot
  reduction: TraceReduction
  limits: CompactionRunLimits
}): CompactionValidationResult {
  const { candidate, snapshot, reduction, limits } = options
  const errors: string[] = []
  const warnings: string[] = []
  const candidateJson = stableJson(candidate)
  const ledgerJson = stableJson(reduction.ledger)
  const candidateChars = candidateJson.length
  const candidateBytes = Buffer.byteLength(candidateJson, 'utf8')
  const ledgerChars = ledgerJson.length
  const ledgerBytes = Buffer.byteLength(ledgerJson, 'utf8')
  const publishedPayloadBytes = candidateBytes + ledgerBytes
  const checkpointOnlyTraceShrinkPercent = percent(
    snapshot.stats.sourceBytes - candidateBytes,
    snapshot.stats.sourceBytes,
  )
  const publishedPayloadTraceShrinkPercent = percent(
    snapshot.stats.sourceBytes - publishedPayloadBytes,
    snapshot.stats.sourceBytes,
  )
  const sourceRefs = new Set(snapshot.observations.map((item) => item.ref))
  const ledgerIntervalIds = new Set(reduction.ledger.intervals.map((item) => item.id))

  if (candidate.candidateKind !== 'trace_diagnostic_checkpoint') {
    errors.push('invalid_candidate_kind')
  }
  if (candidate.semanticReplacementEvaluated !== false) {
    errors.push('semantic_replacement_claim_not_supported')
  }
  if (candidate.sessionBinding) {
    const binding = candidate.sessionBinding
    if (
      !binding.messagesRevision ||
      !binding.messagesDigest ||
      !binding.compactionBlocksRevision ||
      !binding.compactionBlocksDigest ||
      !binding.activeBlockHeadsDigest ||
      !binding.coveredMessageDigest
    ) {
      errors.push('incomplete_session_binding')
    }
    if (!Number.isInteger(binding.rollbackGeneration) || binding.rollbackGeneration < 0) {
      errors.push('invalid_rollback_generation')
    }
    const range = binding.coveredMessageRange
    if (!Number.isInteger(range.messageCount) || range.messageCount < 0) {
      errors.push('invalid_covered_message_count')
    }
    if (range.messageCount > 0 && (!range.fromMessageId || !range.toMessageId)) {
      errors.push('incomplete_covered_message_range')
    }
  }
  if (candidate.sourceSessionId !== snapshot.sourceSessionId) errors.push('source_session_mismatch')
  if (candidate.sourceRevision !== snapshot.sourceRevision) errors.push('source_revision_mismatch')
  if (candidate.sourceDigest !== snapshot.sourceDigest) errors.push('source_digest_mismatch')
  if (candidate.ledgerDigest !== reduction.ledger.digest) errors.push('ledger_digest_mismatch')
  if (candidate.checkpointDigest !== computeCheckpointDigest(candidate)) {
    errors.push('checkpoint_digest_mismatch')
  }
  if (candidate.metrics.sourceBytes !== snapshot.stats.sourceBytes) {
    errors.push('source_byte_metric_mismatch')
  }
  if (candidate.metrics.projectedObservationChars !== snapshot.stats.projectedObservationChars) {
    errors.push('projected_observation_metric_mismatch')
  }
  if (
    reduction.ledger.digest !==
    stableDigest({
      observationCount: reduction.ledger.observationCount,
      intervals: reduction.ledger.intervals,
      sideEffects: reduction.ledger.sideEffects,
    })
  ) {
    errors.push('ledger_content_digest_mismatch')
  }

  if (snapshot.stats.invalidJsonLines > 0) errors.push('invalid_json_lines_present')
  if (snapshot.stats.invalidShapeLines > 0) errors.push('invalid_trace_shapes_present')
  if (snapshot.stats.foreignSessionLines > 0) errors.push('foreign_session_lines_present')
  if (snapshot.stats.uniqueSpans !== snapshot.observations.length) {
    errors.push('unique_span_count_mismatch')
  }

  const intervalObservations = reduction.ledger.intervals.reduce(
    (total, interval) => total + interval.count,
    0,
  )
  const activityObservations = reduction.activities.reduce(
    (total, activity) => total + activity.count,
    0,
  )
  const sourceErrorObservations = snapshot.observations.filter(
    (item) => item.lane === 'source' && item.status === 'error',
  ).length
  const diagnosticErrorObservations = snapshot.observations.filter(
    (item) => item.lane !== 'source' && item.status === 'error',
  ).length
  const sourceIncidentObservations = reduction.incidents
    .filter((item) => item.lane === 'source')
    .reduce((total, incident) => total + incident.count, 0)
  const diagnosticIncidentObservations = reduction.incidents
    .filter((item) => item.lane !== 'source')
    .reduce((total, incident) => total + incident.count, 0)
  const sideEffectObservations = snapshot.observations.filter((item) => item.sideEffect).length

  if (reduction.ledger.observationCount !== snapshot.observations.length) {
    errors.push('ledger_observation_count_mismatch')
  }
  if (intervalObservations !== snapshot.observations.length) {
    errors.push('interval_coverage_mismatch')
  }
  if (activityObservations !== snapshot.observations.length) {
    errors.push('activity_coverage_mismatch')
  }
  if (sourceIncidentObservations !== sourceErrorObservations) {
    errors.push('source_error_incident_coverage_mismatch')
  }
  if (diagnosticIncidentObservations !== diagnosticErrorObservations) {
    errors.push('diagnostic_error_incident_coverage_mismatch')
  }
  if (reduction.sideEffects.length !== sideEffectObservations) {
    errors.push('side_effect_coverage_mismatch')
  }
  if (reduction.ledger.sideEffects.length !== sideEffectObservations) {
    errors.push('mutation_ledger_recall_below_100_percent')
  }
  if (candidate.coverage.accountedObservations !== snapshot.observations.length) {
    errors.push('candidate_accounted_observations_mismatch')
  }
  if (candidate.coverage.errorObservations !== candidate.coverage.incidentErrorObservations) {
    errors.push('candidate_source_error_coverage_mismatch')
  }
  if (
    candidate.coverage.diagnosticErrorObservations !==
    candidate.coverage.diagnosticIncidentErrorObservations
  ) {
    errors.push('candidate_diagnostic_error_coverage_mismatch')
  }
  if (candidate.coverage.retainedSideEffects !== candidate.coverage.sideEffectObservations) {
    errors.push('candidate_mutation_ledger_coverage_mismatch')
  }
  if (candidate.coverage.selectedSideEffects !== candidate.sideEffects.length) {
    errors.push('candidate_selected_side_effect_count_mismatch')
  }

  if (candidateChars > limits.maxCandidateChars) errors.push('candidate_exceeds_char_budget')
  if (ledgerChars > limits.maxLedgerChars) errors.push('ledger_exceeds_char_budget')
  if (ledgerBytes > limits.maxLedgerBytes) errors.push('ledger_exceeds_byte_budget')
  if (publishedPayloadBytes > limits.maxPublishedPayloadBytes) {
    errors.push('published_payload_exceeds_byte_budget')
  }
  if (candidate.incidents.length > limits.maxIncidents) errors.push('incident_budget_exceeded')
  if (candidate.sideEffects.length > limits.maxSideEffects)
    errors.push('side_effect_budget_exceeded')
  if (candidate.changePoints.length > limits.maxChangePoints) {
    errors.push('change_point_budget_exceeded')
  }
  if (candidate.transitions.length > limits.maxTransitions)
    errors.push('transition_budget_exceeded')
  if (candidate.latestState.length > limits.maxLatestStates)
    errors.push('latest_state_budget_exceeded')

  if (candidate.activities.some((activity) => activity.lane !== 'source')) {
    errors.push('self_compaction_leaked_into_source_activities')
  }
  const invalidRefs = collectCandidateRefs(candidate).filter((ref) => !sourceRefs.has(ref))
  if (invalidRefs.length > 0) errors.push(`invalid_candidate_refs:${invalidRefs.length}`)
  if (candidate.changePoints.some((item) => !ledgerIntervalIds.has(item.id))) {
    errors.push('invalid_change_point_interval')
  }
  for (const interval of reduction.ledger.intervals) {
    if (interval.sampleRefs.some((ref) => !sourceRefs.has(ref))) {
      errors.push('invalid_ledger_ref')
      break
    }
  }
  if (reduction.ledger.sideEffects.some((item) => !sourceRefs.has(item.ref))) {
    errors.push('invalid_mutation_ledger_ref')
  }

  for (const key of forbiddenRawKeys) {
    if (candidateJson.includes(`\"${key}\":`)) errors.push(`candidate_contains_raw_field:${key}`)
    if (ledgerJson.includes(`\"${key}\":`)) errors.push(`ledger_contains_raw_field:${key}`)
  }
  if (candidateBytes >= snapshot.stats.sourceBytes) errors.push('candidate_not_smaller_than_source')
  if (publishedPayloadBytes >= snapshot.stats.sourceBytes) {
    errors.push('published_payload_not_smaller_than_source')
  }

  if (
    candidate.activities.length <
    reduction.activities.filter((item) => item.lane === 'source').length
  ) {
    warnings.push('source_activity_groups_selected_by_budget')
  }
  if (candidate.changePoints.length < reduction.ledger.intervals.length) {
    warnings.push('low_signal_change_points_remain_in_ledger_only')
  }
  if (
    candidate.incidents.length < reduction.incidents.filter((item) => item.lane === 'source').length
  ) {
    warnings.push('source_incidents_selected_by_budget')
  }
  if (
    candidate.transitions.length <
    reduction.transitions.filter((item) => item.lane === 'source').length
  ) {
    warnings.push('source_transitions_selected_by_budget')
  }
  if (
    candidate.latestState.length <
    reduction.latestState.filter((item) => item.lane === 'source').length
  ) {
    warnings.push('latest_entity_states_selected_by_budget')
  }
  if (candidate.sideEffects.length < reduction.ledger.sideEffects.length) {
    warnings.push('older_side_effects_remain_in_mutation_ledger_only')
  }
  if (candidate.coverage.runningObservations > 0)
    warnings.push('terminal_snapshot_has_running_spans')

  return {
    status: errors.length > 0 ? 'failed' : 'passed',
    errors,
    warnings,
    candidateChars,
    candidateBytes,
    ledgerChars,
    ledgerBytes,
    publishedPayloadBytes,
    checkpointOnlyTraceShrinkPercent,
    publishedPayloadTraceShrinkPercent,
    maxCandidateChars: limits.maxCandidateChars,
    maxLedgerChars: limits.maxLedgerChars,
    maxLedgerBytes: limits.maxLedgerBytes,
    maxPublishedPayloadBytes: limits.maxPublishedPayloadBytes,
  }
}

function collectCandidateRefs(candidate: CompactionCheckpointCandidate): string[] {
  return [
    ...candidate.activities.flatMap((item) => item.sampleRefs),
    ...candidate.incidents.flatMap((item) => item.sampleRefs),
    ...candidate.sideEffects.map((item) => item.ref),
    ...candidate.changePoints.flatMap((item) => item.sampleRefs),
    ...candidate.transitions.map((item) => item.ref),
    ...candidate.latestState.map((item) => item.ref),
  ]
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 10_000) / 100
}
