import type { SecretFilter } from '@zero-os/shared'

export { ObservabilityStore } from './observability-store'
export type {
  LogLevel,
  LogEntry,
  EventLogEntry,
  RequestLogEntry,
  RequestMemoryInjectionEntry,
  RequestQueuedInjectionEntry,
  RequestQueuedInjectionMessageEntry,
  RequestToolCallEntry,
  RequestToolResultEntry,
  SnapshotEntry,
  ClosureLogEntry,
  ClosureLogEntryInput,
  DecisionType,
  DecisionLogEntry,
  SessionRunLogSummary,
  TaskClosureClassifierResponse,
} from './observability-store'
export { MetricsDB, USAGE_PURPOSES, isUsagePurpose } from './metrics'
export type {
  CostByModel,
  CostByPeriod,
  CostByDayModel,
  CacheHitRate,
  SessionStatsSummary,
  TaskSuccessRate,
  AvgDuration,
  RepairEntry,
  RepairStats,
  RepairByDay,
  CostDetailRecord,
  ToolErrorByDay,
  UsageCategory,
  UsagePurpose,
  UsageLedgerEntry,
  UsageSummaryRow,
  UsageTotals,
} from './metrics'
export { SessionDB } from './session-db'
export type { SessionRow } from './session-db'
export { Tracer } from './trace'
export type {
  RunLogEntry,
  RunLogLevel,
  StartSpanOptions,
  TraceEntry,
  TraceKind,
  TraceSpan,
  TraceStatus,
  UpdateSpanInput,
} from './trace-types'
export {
  projectSessionDecisionsFromTraceEntries,
  projectSessionClosuresFromTraceEntries,
  projectSessionRequestsFromTraceEntries,
  projectSessionSnapshotsFromTraceEntries,
} from './trace-projections'
export { asRecord, asString, flattenTraceSpans } from './utils'

/**
 * Wrap a writer so text is filtered before observe writes it.
 */
export function createFilteredWriter(
  filter: SecretFilter,
  writer: (text: string) => void,
): (text: string) => void {
  return (text: string) => {
    writer(filter.filter(text))
  }
}

/**
 * Filter string fields in a log entry without mutating the original object.
 */
export function filterLogEntry<T extends Record<string, unknown>>(
  filter: SecretFilter,
  entry: T,
): T {
  const filtered = { ...entry }
  for (const [key, value] of Object.entries(filtered)) {
    if (typeof value === 'string') {
      ;(filtered as Record<string, unknown>)[key] = filter.filter(value)
    }
  }
  return filtered
}
