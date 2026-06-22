import { Database } from 'bun:sqlite'
import { initializeMetricsSchema } from './metrics-schema'
import type {
  AvgDuration,
  CacheByModelRecord,
  CacheHitRate,
  CostByChannelRow,
  CostByDayModel,
  CostByModel,
  CostByPeriod,
  CostBySourceRow,
  CostDetailRecord,
  EvaluationDimensionAverageRow,
  EvaluationEntry,
  EvaluationTrendRow,
  RepairByDay,
  RepairEntry,
  RepairStats,
  SessionStatsSummary,
  SessionUsageByPurposeRow,
  TaskSuccessRate,
  ToolErrorByDay,
  TopFindingRow,
  UsageLedgerEntry,
  UsageSummaryRow,
  UsageTotals,
} from './metrics-types'
import { isUsagePurpose } from './metrics-types'

export { USAGE_PURPOSES, isUsagePurpose } from './metrics-types'
export type {
  AvgDuration,
  CacheByModelRecord,
  CacheHitRate,
  CostByChannelRow,
  CostByDayModel,
  CostByModel,
  CostByPeriod,
  CostBySourceRow,
  CostDetailRecord,
  EvaluationDimensionAverageRow,
  EvaluationDimensionEntry,
  EvaluationEntry,
  EvaluationFindingEntry,
  EvaluationTrendRow,
  RepairByDay,
  RepairEntry,
  RepairStats,
  SessionStatsSummary,
  SessionUsageByPurposeRow,
  TaskSuccessRate,
  ToolErrorByDay,
  TopFindingRow,
  UsageCategory,
  UsageLedgerEntry,
  UsagePurpose,
  UsageSummaryRow,
  UsageTotals,
} from './metrics-types'

export interface OperationEntry {
  sessionId: string
  tool: string
  event: string
  success: boolean
  durationMs: number
  createdAt: string
}

export interface ToolStatsRow {
  tool: string
  count: number
  successRate: number
  avgDurationMs: number
}

interface MetricsRangeWindow {
  since: string
  until: string | null
}

function normalizeDateRangeBoundary(value: string, boundary: 'start' | 'end'): string | null {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const time = boundary === 'start' ? '00:00:00.000Z' : '23:59:59.999Z'
    return new Date(`${trimmed}T${time}`).toISOString()
  }

  const timestamp = Date.parse(trimmed)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function rangeToWindow(range: string): MetricsRangeWindow {
  const now = Date.now()
  const dateRange = range.match(/^(.+)\.\.(.+)$/)
  if (dateRange) {
    const since = normalizeDateRangeBoundary(dateRange[1], 'start')
    const until = normalizeDateRangeBoundary(dateRange[2], 'end')
    if (since && until) {
      return since <= until ? { since, until } : { since: until, until: since }
    }
  }

  const match = range.match(/^(\d+)(d|h|m)$/)
  if (!match) return { since: new Date(now - 7 * 86_400_000).toISOString(), until: null }

  const value = Number.parseInt(match[1])
  const unit = match[2]
  const ms = unit === 'd' ? value * 86_400_000 : unit === 'h' ? value * 3_600_000 : value * 60_000
  return { since: new Date(now - ms).toISOString(), until: null }
}

function rangeParams(range: string): [string, string | null, string | null] {
  const window = rangeToWindow(range)
  return [window.since, window.until, window.until]
}

function querySessionUsageByPurpose(db: Database, sessionId: string): SessionUsageByPurposeRow[] {
  return db
    .query(
      `SELECT purpose,
              COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
              COUNT(*) as requestCount
       FROM usage_ledger
       WHERE session_id = ? OR parent_session_id = ?
       GROUP BY purpose
       ORDER BY totalCost DESC, requestCount DESC`,
    )
    .all(sessionId, sessionId) as SessionUsageByPurposeRow[]
}

function queryCostByChannel(db: Database, range = '7d'): CostByChannelRow[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT s.source as source,
              COALESCE(s.channel_name, 'unknown') as channelName,
              COALESCE(SUM(u.cost), 0) as totalCost,
              COUNT(DISTINCT COALESCE(u.parent_session_id, u.session_id)) as sessionCount,
              COUNT(*) as requestCount
       FROM usage_ledger u
       JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
       WHERE u.created_at >= ?
         AND (? IS NULL OR u.created_at <= ?)
       GROUP BY s.source, s.channel_name
       ORDER BY totalCost DESC, requestCount DESC`,
    )
    .all(since, untilFilter, until) as CostByChannelRow[]
}

function queryCostBySource(db: Database, range = '7d'): CostBySourceRow[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT s.source as source,
              COALESCE(SUM(u.cost), 0) as totalCost,
              COUNT(DISTINCT COALESCE(u.parent_session_id, u.session_id)) as sessionCount
       FROM usage_ledger u
       JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
       WHERE u.created_at >= ?
         AND (? IS NULL OR u.created_at <= ?)
       GROUP BY s.source
       ORDER BY totalCost DESC, sessionCount DESC`,
    )
    .all(since, untilFilter, until) as CostBySourceRow[]
}

function queryChannelCostByDay(
  db: Database,
  channelName: string,
  range = '30d',
  source?: string,
): CostByPeriod[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(u.created_at, 1, 10) as period,
              COALESCE(SUM(u.cost), 0) as totalCost,
              COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as totalTokens
       FROM usage_ledger u
       JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
       WHERE u.created_at >= ?
         AND (? IS NULL OR u.created_at <= ?)
         AND COALESCE(s.channel_name, 'unknown') = ?
         AND (? IS NULL OR s.source = ?)
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, untilFilter, until, channelName, source ?? null, source ?? null) as CostByPeriod[]
}

function queryChannelPurposeBreakdown(
  db: Database,
  channelName: string,
  range = '30d',
  source?: string,
): SessionUsageByPurposeRow[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT u.purpose as purpose,
              COALESCE(SUM(u.cost), 0) as totalCost,
              COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as totalTokens,
              COALESCE(SUM(u.reasoning_tokens), 0) as reasoningTokens,
              COUNT(*) as requestCount
       FROM usage_ledger u
       JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
       WHERE u.created_at >= ?
         AND (? IS NULL OR u.created_at <= ?)
         AND COALESCE(s.channel_name, 'unknown') = ?
         AND (? IS NULL OR s.source = ?)
       GROUP BY u.purpose
       ORDER BY totalCost DESC, requestCount DESC`,
    )
    .all(
      since,
      untilFilter,
      until,
      channelName,
      source ?? null,
      source ?? null,
    ) as SessionUsageByPurposeRow[]
}

function queryCostByModel(db: Database, range = '7d'): CostByModel[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT model, provider,
              SUM(cost) as totalCost,
              SUM(input_tokens) as totalInput,
              SUM(output_tokens) as totalOutput,
              COUNT(*) as requestCount
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY model, provider
       ORDER BY totalCost DESC`,
    )
    .all(since, untilFilter, until) as CostByModel[]
}

function queryCostByDay(db: Database, range = '30d'): CostByPeriod[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              SUM(cost) as totalCost,
              SUM(input_tokens + output_tokens) as totalTokens
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period
       ORDER BY period DESC`,
    )
    .all(since, untilFilter, until) as CostByPeriod[]
}

function querySummary(
  db: Database,
  range = '7d',
): { totalCost: number; totalTokens: number; requestCount: number } {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COUNT(*) as requestCount
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)`,
    )
    .get(since, untilFilter, until) as {
    totalCost: number
    totalTokens: number
    requestCount: number
  }
}

function queryCacheHitRate(db: Database, range = '30d'): CacheHitRate[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT period,
              SUM(cacheRead) * 1.0 / NULLIF(SUM(denominator), 0) as hitRate
       FROM (
         SELECT substr(created_at, 1, 10) as period,
                provider,
                SUM(cache_read_tokens) as cacheRead,
                SUM(input_tokens + cache_write_tokens + cache_read_tokens) as denominator
         FROM usage_ledger
         WHERE created_at >= ?
           AND (? IS NULL OR created_at <= ?)
         GROUP BY period, provider
       )
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, untilFilter, until) as CacheHitRate[]
}

function queryCostByDayModel(db: Database, range = '30d'): CostByDayModel[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              model,
              SUM(cost) as cost
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period, model
       ORDER BY period, cost DESC`,
    )
    .all(since, untilFilter, until) as CostByDayModel[]
}

function queryUsageSummaryByPurpose(db: Database, range = '7d'): UsageSummaryRow[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT purpose,
              COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
              COUNT(*) as eventCount
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY purpose
       ORDER BY totalCost DESC, eventCount DESC`,
    )
    .all(since, untilFilter, until) as UsageSummaryRow[]
}

function queryCacheByModel(db: Database, range = '30d'): CacheByModelRecord[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT provider,
              model,
              COUNT(*) as requestCount,
              SUM(input_tokens) as input,
              SUM(output_tokens) as output,
              SUM(cache_write_tokens) as cacheWrite,
              SUM(cache_read_tokens) as cacheRead,
              SUM(input_tokens + cache_write_tokens + cache_read_tokens) as effectiveInput,
              SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as hitRate,
              SUM(cost) as cost
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY provider, model
       ORDER BY cacheRead DESC, hitRate DESC, cost DESC`,
    )
    .all(since, untilFilter, until) as CacheByModelRecord[]
}

function queryCostDetailRecords(db: Database, range = '30d'): CostDetailRecord[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as date,
              provider,
              model,
              COUNT(*) as requestCount,
              SUM(input_tokens) as input,
              SUM(output_tokens) as output,
              SUM(cache_write_tokens) as cacheWrite,
              SUM(cache_read_tokens) as cacheRead,
              SUM(reasoning_tokens) as reasoningTokens,
              SUM(input_tokens + cache_write_tokens + cache_read_tokens) as effectiveInput,
              SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as hitRate,
              SUM(cost) as cost
       FROM usage_ledger
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY date, provider, model
       ORDER BY date DESC, cost DESC`,
    )
    .all(since, untilFilter, until) as CostDetailRecord[]
}

function querySystemCosts(db: Database, range = '7d'): UsageTotals {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COUNT(*) as eventCount
       FROM usage_ledger
       WHERE session_id IS NULL
         AND created_at >= ?
         AND (? IS NULL OR created_at <= ?)`,
    )
    .get(since, untilFilter, until) as UsageTotals
}

/**
 * SQLite-based metrics aggregation for ZeRo OS observability.
 */
export class MetricsDB {
  private db: Database
  private attachedSessionsDbPath?: string

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    initializeMetricsSchema(this.db)
  }

  static createInMemory(): MetricsDB {
    return new MetricsDB(':memory:')
  }

  attachSessionsDb(sessionsDbPath: string): void {
    if (this.attachedSessionsDbPath === sessionsDbPath) return

    if (this.attachedSessionsDbPath) {
      try {
        this.db.run('DETACH DATABASE sdb')
      } catch {
        // Ignore stale attach state and replace it below.
      }
    }

    this.db.run('ATTACH DATABASE ? AS sdb', [sessionsDbPath])
    this.attachedSessionsDbPath = sessionsDbPath
  }

  /**
   * Record a tool operation.
   */
  recordOperation(entry: OperationEntry): void {
    recordOperation(this.db, entry)
  }

  recordUsage(entry: UsageLedgerEntry): void {
    recordUsageEntry(this.db, entry)
  }

  recordEvaluation(entry: EvaluationEntry): void {
    recordEvaluation(this.db, entry)
  }

  evaluationsBySession(sessionId: string): EvaluationEntry[] {
    return evaluationsBySession(this.db, sessionId)
  }

  evaluationTrend(range = '30d'): EvaluationTrendRow[] {
    const window = rangeToWindow(range)
    return evaluationTrend(this.db, window.since, window.until)
  }

  evaluationDimensionAvg(range = '30d'): EvaluationDimensionAverageRow[] {
    const window = rangeToWindow(range)
    return evaluationDimensionAvg(this.db, window.since, window.until)
  }

  topFindings(range = '30d', limit = 10): TopFindingRow[] {
    const window = rangeToWindow(range)
    return topFindings(this.db, window.since, window.until, limit)
  }

  sessionUsageByPurpose(sessionId: string): SessionUsageByPurposeRow[] {
    return querySessionUsageByPurpose(this.db, sessionId)
  }

  costByChannel(range = '7d'): CostByChannelRow[] {
    this.requireSessionsDbAttached()
    return queryCostByChannel(this.db, range)
  }

  costBySource(range = '7d'): CostBySourceRow[] {
    this.requireSessionsDbAttached()
    return queryCostBySource(this.db, range)
  }

  channelCostByDay(channelName: string, range = '30d', source?: string): CostByPeriod[] {
    this.requireSessionsDbAttached()
    return queryChannelCostByDay(this.db, channelName, range, source)
  }

  channelPurposeBreakdown(
    channelName: string,
    range = '30d',
    source?: string,
  ): SessionUsageByPurposeRow[] {
    this.requireSessionsDbAttached()
    return queryChannelPurposeBreakdown(this.db, channelName, range, source)
  }

  /**
   * Get cost breakdown by model for a time range.
   */
  costByModel(range = '7d'): CostByModel[] {
    return queryCostByModel(this.db, range)
  }

  /**
   * Get daily cost aggregation.
   */
  costByDay(range = '30d'): CostByPeriod[] {
    return queryCostByDay(this.db, range)
  }

  /**
   * Get total cost and token usage summary.
   */
  summary(range = '7d'): { totalCost: number; totalTokens: number; requestCount: number } {
    return querySummary(this.db, range)
  }

  /**
   * Get tool usage statistics.
   */
  toolStats(range = '7d'): ToolStatsRow[] {
    return queryToolStats(this.db, range)
  }

  /**
   * Get per-session aggregated stats.
   */
  sessionStats(sessionId: string): SessionStatsSummary {
    return querySessionStats(this.db, sessionId)
  }

  sessionFullCost(sessionId: string): number {
    return querySessionFullCost(this.db, sessionId)
  }

  sessionAuxiliaryCost(sessionId: string): number {
    return querySessionAuxiliaryCost(this.db, sessionId)
  }

  /**
   * Count tool operations for a session.
   */
  sessionToolCallCount(sessionId: string): number {
    return querySessionToolCallCount(this.db, sessionId)
  }

  /**
   * Batch version of sessionStats to avoid N+1 queries.
   */
  sessionStatsBatch(sessionIds: string[]): Map<string, SessionStatsSummary> {
    return querySessionStatsBatch(this.db, sessionIds)
  }

  /**
   * Cache hit rate by day.
   * Effective input is normalized to input + cache_write + cache_read across providers.
   */
  cacheHitRate(range = '30d'): CacheHitRate[] {
    return queryCacheHitRate(this.db, range)
  }

  /**
   * Task success rate by day from operations table.
   */
  taskSuccessRate(range = '30d'): TaskSuccessRate[] {
    return queryTaskSuccessRate(this.db, range)
  }

  /**
   * Average operation duration by day.
   */
  avgDurationByDay(range = '30d'): AvgDuration[] {
    return queryAvgDurationByDay(this.db, range)
  }

  /**
   * Cost grouped by day and model (for stacked bar chart).
   */
  costByDayModel(range = '30d'): CostByDayModel[] {
    return queryCostByDayModel(this.db, range)
  }

  usageSummaryByPurpose(range = '7d'): UsageSummaryRow[] {
    return queryUsageSummaryByPurpose(this.db, range)
  }

  /**
   * Cache usage grouped by provider and model.
   */
  cacheByModel(range = '30d'): CacheByModelRecord[] {
    return queryCacheByModel(this.db, range)
  }

  /**
   * Record a self-repair attempt.
   */
  recordRepair(entry: RepairEntry): void {
    recordRepair(this.db, entry)
  }

  /**
   * Aggregate repair statistics.
   */
  repairStats(range = '30d'): RepairStats {
    return queryRepairStats(this.db, range)
  }

  /**
   * Repair trend by day.
   */
  repairByDay(range = '30d'): RepairByDay[] {
    return queryRepairByDay(this.db, range)
  }

  /**
   * Detailed cost records grouped by date and model.
   */
  costDetailRecords(range = '30d'): CostDetailRecord[] {
    return queryCostDetailRecords(this.db, range)
  }

  /**
   * Tool error counts by day and tool.
   */
  toolErrorByDay(range = '30d'): ToolErrorByDay[] {
    return queryToolErrorByDay(this.db, range)
  }

  systemCosts(range = '7d'): UsageTotals {
    return querySystemCosts(this.db, range)
  }

  /**
   * Delete all metrics data for a session.
   */
  deleteSessionMetrics(sessionId: string): void {
    this.db.run('DELETE FROM requests WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM operations WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM repairs WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM usage_ledger WHERE session_id = ? OR parent_session_id = ?', [
      sessionId,
      sessionId,
    ])
    this.db.run('DELETE FROM evaluations WHERE session_id = ?', [sessionId])
  }

  private requireSessionsDbAttached(): void {
    if (!this.attachedSessionsDbPath) {
      throw new Error('Sessions database is not attached')
    }
  }

  close(): void {
    this.db.close()
  }
}

function recordEvaluation(db: Database, entry: EvaluationEntry): void {
  db.run(
    `INSERT INTO evaluations (
       session_id, model, overall_score, verdict, confidence, summary,
       dimensions_json, findings_json, signals_json, generated_at, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.sessionId,
      entry.model,
      entry.overallScore,
      entry.verdict,
      entry.confidence,
      entry.summary ?? null,
      JSON.stringify(entry.dimensions),
      JSON.stringify(entry.findings),
      entry.signals ? JSON.stringify(entry.signals) : null,
      entry.generatedAt,
      entry.createdAt,
    ],
  )
}

function evaluationsBySession(db: Database, sessionId: string): EvaluationEntry[] {
  const rows = db
    .query(
      `SELECT *
       FROM evaluations
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId) as EvaluationRow[]

  return rows.map(mapEvaluationRow)
}

function evaluationTrend(db: Database, since: string, until: string | null): EvaluationTrendRow[] {
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              AVG(overall_score) as avgScore,
              COUNT(*) as evalCount,
              SUM(CASE WHEN verdict = 'strong' THEN 1 ELSE 0 END) as strongCount,
              SUM(CASE WHEN verdict = 'mixed' THEN 1 ELSE 0 END) as mixedCount,
              SUM(CASE WHEN verdict = 'weak' THEN 1 ELSE 0 END) as weakCount
       FROM evaluations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, until, until) as EvaluationTrendRow[]
}

function evaluationDimensionAvg(
  db: Database,
  since: string,
  until: string | null,
): EvaluationDimensionAverageRow[] {
  const aggregates = new Map<string, { total: number; count: number }>()

  for (const evaluation of listEvaluationsSince(db, since, until)) {
    for (const dimension of evaluation.dimensions) {
      const current = aggregates.get(dimension.key) ?? { total: 0, count: 0 }
      current.total += dimension.score
      current.count += 1
      aggregates.set(dimension.key, current)
    }
  }

  return [...aggregates.entries()]
    .map(([dimensionKey, value]) => ({
      dimensionKey,
      avgScore: value.count > 0 ? value.total / value.count : 0,
      count: value.count,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.dimensionKey.localeCompare(right.dimensionKey),
    )
}

function topFindings(
  db: Database,
  since: string,
  until: string | null,
  limit = 10,
): TopFindingRow[] {
  const counts = new Map<string, TopFindingRow>()

  for (const evaluation of listEvaluationsSince(db, since, until)) {
    for (const finding of evaluation.findings) {
      const key = `${finding.severity}::${finding.title}`
      const current = counts.get(key) ?? {
        title: finding.title,
        severity: finding.severity,
        count: 0,
      }
      current.count += 1
      counts.set(key, current)
    }
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
    .slice(0, limit)
}

function listEvaluationsSince(
  db: Database,
  since: string,
  until: string | null,
): EvaluationEntry[] {
  const rows = db
    .query(
      `SELECT *
       FROM evaluations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       ORDER BY created_at DESC, id DESC`,
    )
    .all(since, until, until) as EvaluationRow[]

  return rows.map(mapEvaluationRow)
}

function mapEvaluationRow(row: EvaluationRow): EvaluationEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    model: row.model,
    overallScore: row.overall_score,
    verdict: row.verdict,
    confidence: row.confidence,
    summary: row.summary ?? undefined,
    dimensions: parseEvaluationJson(row.dimensions_json, []),
    findings: parseEvaluationJson(row.findings_json, []),
    signals: row.signals_json ? parseEvaluationJson(row.signals_json, {}) : undefined,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  }
}

interface EvaluationRow {
  id: number
  session_id: string
  model: string
  overall_score: number
  verdict: string
  confidence: string
  summary: string | null
  dimensions_json: string
  findings_json: string
  signals_json: string | null
  generated_at: string
  created_at: string
}

function parseEvaluationJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function recordOperation(db: Database, entry: OperationEntry): void {
  db.run(
    `INSERT INTO operations (session_id, tool, event, success, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.sessionId,
      entry.tool,
      entry.event,
      entry.success ? 1 : 0,
      entry.durationMs,
      entry.createdAt,
    ],
  )
}

function queryToolStats(db: Database, range = '7d'): ToolStatsRow[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT tool,
              COUNT(*) as count,
              AVG(success) as successRate,
              AVG(duration_ms) as avgDurationMs
       FROM operations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY tool
       ORDER BY count DESC`,
    )
    .all(since, untilFilter, until) as ToolStatsRow[]
}

function querySessionToolCallCount(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count
       FROM operations
       WHERE session_id = ?`,
    )
    .get(sessionId) as { count: number } | null

  return row?.count ?? 0
}

function queryTaskSuccessRate(db: Database, range = '30d'): TaskSuccessRate[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              AVG(success) as successRate,
              COUNT(*) as total
       FROM operations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, untilFilter, until) as TaskSuccessRate[]
}

function queryAvgDurationByDay(db: Database, range = '30d'): AvgDuration[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              AVG(duration_ms) as avgMs
       FROM operations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, untilFilter, until) as AvgDuration[]
}

function queryToolErrorByDay(db: Database, range = '30d'): ToolErrorByDay[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              tool,
              COUNT(*) as total,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
       FROM operations
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period, tool
       ORDER BY period, errors DESC`,
    )
    .all(since, untilFilter, until) as ToolErrorByDay[]
}

function recordRepair(db: Database, entry: RepairEntry): void {
  db.run(
    `INSERT INTO repairs (session_id, status, diagnosis, action, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.sessionId ?? null,
      entry.status,
      entry.diagnosis,
      entry.action,
      entry.result,
      new Date().toISOString(),
    ],
  )
}

function queryRepairStats(db: Database, range = '30d'): RepairStats {
  const [since, untilFilter, until] = rangeParams(range)
  const row = db
    .query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount
       FROM repairs
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)`,
    )
    .get(since, untilFilter, until) as { total: number; successCount: number | null }
  return {
    total: row.total,
    successCount: row.successCount ?? 0,
    successRate: row.total > 0 ? (row.successCount ?? 0) / row.total : 0,
  }
}

function queryRepairByDay(db: Database, range = '30d'): RepairByDay[] {
  const [since, untilFilter, until] = rangeParams(range)
  return db
    .query(
      `SELECT substr(created_at, 1, 10) as period,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
       FROM repairs
       WHERE created_at >= ?
         AND (? IS NULL OR created_at <= ?)
       GROUP BY period
       ORDER BY period`,
    )
    .all(since, untilFilter, until) as RepairByDay[]
}

function querySessionStats(db: Database, sessionId: string): SessionStatsSummary {
  return db
    .query(
      `SELECT COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
              COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
              COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
              COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as effectiveInputTokens,
              COALESCE(
                SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0),
                0
              ) as cacheHitRate,
              COUNT(*) as requestCount
       FROM usage_ledger
       WHERE session_id = ? OR parent_session_id = ?`,
    )
    .get(sessionId, sessionId) as SessionStatsSummary
}

function querySessionFullCost(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(cost), 0) as totalCost
       FROM usage_ledger
       WHERE session_id = ? OR parent_session_id = ?`,
    )
    .get(sessionId, sessionId) as { totalCost: number }
  return row.totalCost
}

function querySessionAuxiliaryCost(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(cost), 0) as totalCost
       FROM usage_ledger
       WHERE (session_id = ? OR parent_session_id = ?)
         AND purpose NOT IN ('agent_loop', 'sub_agent')`,
    )
    .get(sessionId, sessionId) as { totalCost: number }
  return row.totalCost
}

function querySessionStatsBatch(
  db: Database,
  sessionIds: string[],
): Map<string, SessionStatsSummary> {
  const result = new Map<string, SessionStatsSummary>()
  if (sessionIds.length === 0) return result

  for (const sessionId of sessionIds) {
    result.set(sessionId, createZeroSessionStatsSummary())
  }

  const placeholders = sessionIds.map(() => '?').join(',')
  const rows = db
    .query(
      `SELECT session_id,
              parent_session_id,
              COALESCE(SUM(cost), 0) as totalCost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
              COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
              COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
              COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as effectiveInputTokens,
              COUNT(*) as requestCount
       FROM usage_ledger
       WHERE session_id IN (${placeholders}) OR parent_session_id IN (${placeholders})
       GROUP BY session_id, parent_session_id`,
    )
    .all(...sessionIds, ...sessionIds) as Array<
    {
      session_id: string | null
      parent_session_id: string | null
    } & SessionStatsSummary
  >

  const sessionIdSet = new Set(sessionIds)
  for (const row of rows) {
    const targets = new Set<string>()
    if (row.session_id && sessionIdSet.has(row.session_id)) {
      targets.add(row.session_id)
    }
    if (row.parent_session_id && sessionIdSet.has(row.parent_session_id)) {
      targets.add(row.parent_session_id)
    }

    for (const target of targets) {
      const current = result.get(target) ?? createZeroSessionStatsSummary()
      current.totalCost += row.totalCost
      current.totalTokens += row.totalTokens
      current.inputTokens += row.inputTokens
      current.outputTokens += row.outputTokens
      current.cacheWriteTokens += row.cacheWriteTokens
      current.cacheReadTokens += row.cacheReadTokens
      current.reasoningTokens += row.reasoningTokens
      current.effectiveInputTokens += row.effectiveInputTokens
      current.requestCount += row.requestCount
      result.set(target, current)
    }
  }

  for (const [sessionId, stats] of result) {
    stats.cacheHitRate =
      stats.effectiveInputTokens > 0 ? stats.cacheReadTokens / stats.effectiveInputTokens : 0
    result.set(sessionId, stats)
  }

  return result
}

function createZeroSessionStatsSummary(): SessionStatsSummary {
  return {
    totalCost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    effectiveInputTokens: 0,
    cacheHitRate: 0,
    requestCount: 0,
  }
}

function recordUsageEntry(db: Database, entry: UsageLedgerEntry): void {
  if (!isUsagePurpose(entry.purpose)) {
    throw new Error(`Invalid usage purpose: ${entry.purpose}`)
  }

  db.run(
    `INSERT OR REPLACE INTO usage_ledger (
       id, session_id, category, purpose, parent_session_id, model, provider,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       reasoning_tokens, cost, duration_ms, metadata, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.sessionId,
      entry.category,
      entry.purpose,
      entry.parentSessionId ?? null,
      entry.model,
      entry.provider,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheWriteTokens ?? 0,
      entry.cacheReadTokens ?? 0,
      entry.reasoningTokens ?? 0,
      entry.cost,
      entry.durationMs,
      entry.metadata ?? null,
      entry.createdAt,
    ],
  )
}
