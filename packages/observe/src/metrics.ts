import { Database } from 'bun:sqlite'

export interface CostByModel {
  model: string
  provider: string
  totalCost: number
  totalInput: number
  totalOutput: number
  requestCount: number
}

export interface CostByPeriod {
  period: string
  totalCost: number
  totalTokens: number
}

export interface CostByDayModel {
  period: string
  model: string
  cost: number
}

export interface CacheHitRate {
  period: string
  hitRate: number
}

export interface SessionStatsSummary {
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  effectiveInputTokens: number
  cacheHitRate: number
  requestCount: number
}

export interface CacheByModelRecord {
  provider: string
  model: string
  requestCount: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  effectiveInput: number
  hitRate: number
  cost: number
}

export interface TaskSuccessRate {
  period: string
  successRate: number
  total: number
}

export interface AvgDuration {
  period: string
  avgMs: number
}

export interface RepairEntry {
  sessionId?: string
  status: 'success' | 'failed'
  diagnosis: string
  action: string
  result: string
}

export interface RepairStats {
  total: number
  successCount: number
  successRate: number
}

export interface RepairByDay {
  period: string
  total: number
  success: number
}

export interface CostDetailRecord {
  date: string
  provider: string
  model: string
  requestCount: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  reasoningTokens: number
  effectiveInput: number
  hitRate: number
  cost: number
}

export interface ToolErrorByDay {
  period: string
  tool: string
  total: number
  errors: number
}

export type UsageCategory = 'completion' | 'aggregated' | 'embedding'

export const USAGE_PURPOSES = [
  'agent_loop',
  'sub_agent',
  'task_closure',
  'compression',
  'tool_io_digest',
  'memory_retrieval',
  'session_judge',
  'embedding',
  'memory_nudge',
] as const

export type UsagePurpose = (typeof USAGE_PURPOSES)[number]

const usagePurposeSet = new Set<string>(USAGE_PURPOSES)

export function isUsagePurpose(value: string): value is UsagePurpose {
  return usagePurposeSet.has(value)
}

export interface UsageLedgerEntry {
  id: string
  sessionId: string | null
  category: UsageCategory
  purpose: UsagePurpose
  parentSessionId?: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  cost: number
  durationMs: number
  metadata?: string
  createdAt: string
}

export interface UsageSummaryRow {
  purpose: UsagePurpose
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  eventCount: number
}

export interface UsageTotals {
  totalCost: number
  totalTokens: number
  eventCount: number
}

export interface SessionUsageByPurposeRow {
  purpose: UsagePurpose
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  requestCount: number
}

export interface EvaluationDimensionEntry {
  key: string
  label: string
  score: number
  maxScore: number
  rationale: string
}

export interface EvaluationFindingEntry {
  severity: string
  title: string
  evidence: string
}

export interface EvaluationEntry {
  id?: number
  sessionId: string
  model: string
  overallScore: number
  verdict: string
  confidence: string
  summary?: string
  dimensions: EvaluationDimensionEntry[]
  findings: EvaluationFindingEntry[]
  signals?: Record<string, unknown>
  generatedAt: string
  createdAt: string
}

export interface EvaluationTrendRow {
  period: string
  avgScore: number
  evalCount: number
  strongCount: number
  mixedCount: number
  weakCount: number
}

export interface EvaluationDimensionAverageRow {
  dimensionKey: string
  avgScore: number
  count: number
}

export interface TopFindingRow {
  title: string
  severity: string
  count: number
}

export interface CostByChannelRow {
  source: string
  channelName: string
  totalCost: number
  sessionCount: number
  requestCount: number
}

export interface CostBySourceRow {
  source: string
  totalCost: number
  sessionCount: number
}

/**
 * SQLite-based metrics aggregation for ZeRo OS observability.
 */
export class MetricsDB {
  private db: Database
  private attachedSessionsDbPath?: string

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.configureConnection()
    this.initSchema()
  }

  static createInMemory(): MetricsDB {
    return new MetricsDB(':memory:')
  }

  private configureConnection(): void {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        event TEXT NOT NULL,
        success INTEGER DEFAULT 1,
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        status TEXT NOT NULL,
        diagnosis TEXT,
        action TEXT,
        result TEXT,
        created_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        category TEXT NOT NULL,
        purpose TEXT NOT NULL,
        parent_session_id TEXT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        overall_score INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT,
        dimensions_json TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        signals_json TEXT,
        generated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_requests_session_created ON requests(session_id, created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_operations_tool ON operations(tool)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_operations_session ON operations(session_id)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_repairs_created ON repairs(created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_session ON usage_ledger(session_id)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_purpose ON usage_ledger(purpose)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON usage_ledger(created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_parent ON usage_ledger(parent_session_id)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_evaluations_session ON evaluations(session_id)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_evaluations_created ON evaluations(created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_evaluations_verdict ON evaluations(verdict)
    `)

    this.ensureUsageLedgerColumns()
    this.migrateLegacyRequestsToUsageLedger()
  }

  private ensureUsageLedgerColumns(): void {
    try {
      this.db.run('ALTER TABLE usage_ledger ADD COLUMN reasoning_tokens INTEGER DEFAULT 0')
    } catch {
      // Column already exists on upgraded installations.
    }
  }

  private migrateLegacyRequestsToUsageLedger(): void {
    const boundary = this.db
      .query(
        `SELECT MIN(created_at) as firstCreatedAt
         FROM usage_ledger
         WHERE purpose = 'agent_loop'`,
      )
      .get() as { firstCreatedAt: string | null } | null

    const firstUsageCreatedAt = boundary?.firstCreatedAt ?? null
    // The initial rollout mirrored fresh agent_loop traffic into usage_ledger with
    // new local IDs, so migration can't de-duplicate by request ID alone. The
    // equality branch keeps same-timestamp legacy rows from being skipped while
    // still avoiding duplicate inserts for rows that were already mirrored.
    const whereClause = firstUsageCreatedAt
      ? `WHERE r.created_at < ?
           OR (
             r.created_at = ?
             AND NOT EXISTS (
               SELECT 1
               FROM usage_ledger u
               WHERE u.purpose = 'agent_loop'
                 AND u.session_id = r.session_id
                 AND u.parent_session_id IS NULL
                 AND u.model = r.model
                 AND u.provider = r.provider
                 AND u.input_tokens = r.input_tokens
                 AND u.output_tokens = r.output_tokens
                 AND u.cache_write_tokens = r.cache_write_tokens
                 AND u.cache_read_tokens = r.cache_read_tokens
                 AND u.reasoning_tokens = 0
                 AND ABS(u.cost - r.cost) < 0.0000001
                 AND u.duration_ms = r.duration_ms
                 AND u.created_at = r.created_at
             )
           )`
      : ''

    this.db.run(
      `INSERT OR IGNORE INTO usage_ledger (
         id, session_id, category, purpose, parent_session_id, model, provider,
         input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
         reasoning_tokens, cost, duration_ms, metadata, created_at
       )
       SELECT
         'migrated_' || r.id,
         r.session_id,
         'completion',
         'agent_loop',
         NULL,
         r.model,
         r.provider,
         r.input_tokens,
         r.output_tokens,
         r.cache_write_tokens,
         r.cache_read_tokens,
         0,
         r.cost,
         r.duration_ms,
         NULL,
         r.created_at
       FROM requests r
       ${whereClause}`,
      firstUsageCreatedAt ? [firstUsageCreatedAt, firstUsageCreatedAt] : [],
    )
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
   * Deprecated: read paths now aggregate from usage_ledger.
   */
  recordRequest(_entry: {
    id: string
    sessionId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    cost: number
    durationMs: number
    createdAt: string
  }): void {}

  /**
   * Record a tool operation.
   */
  recordOperation(entry: {
    sessionId: string
    tool: string
    event: string
    success: boolean
    durationMs: number
    createdAt: string
  }): void {
    this.db.run(
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

  recordUsage(entry: UsageLedgerEntry): void {
    if (!isUsagePurpose(entry.purpose)) {
      throw new Error(`Invalid usage purpose: ${entry.purpose}`)
    }

    this.db.run(
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

  recordEvaluation(entry: EvaluationEntry): void {
    this.db.run(
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

  evaluationsBySession(sessionId: string): EvaluationEntry[] {
    const rows = this.db
      .query(
        `SELECT *
         FROM evaluations
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(sessionId) as EvaluationRow[]

    return rows.map((row) => this.mapEvaluationRow(row))
  }

  evaluationTrend(range = '30d'): EvaluationTrendRow[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                AVG(overall_score) as avgScore,
                COUNT(*) as evalCount,
                SUM(CASE WHEN verdict = 'strong' THEN 1 ELSE 0 END) as strongCount,
                SUM(CASE WHEN verdict = 'mixed' THEN 1 ELSE 0 END) as mixedCount,
                SUM(CASE WHEN verdict = 'weak' THEN 1 ELSE 0 END) as weakCount
         FROM evaluations
         WHERE created_at >= ?
         GROUP BY period
         ORDER BY period`,
      )
      .all(since) as EvaluationTrendRow[]
  }

  evaluationDimensionAvg(range = '30d'): EvaluationDimensionAverageRow[] {
    const aggregates = new Map<string, { total: number; count: number }>()

    for (const evaluation of this.listEvaluationsSince(rangeToCutoff(range))) {
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

  topFindings(range = '30d', limit = 10): TopFindingRow[] {
    const counts = new Map<string, TopFindingRow>()

    for (const evaluation of this.listEvaluationsSince(rangeToCutoff(range))) {
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

  sessionUsageByPurpose(sessionId: string): SessionUsageByPurposeRow[] {
    return this.db
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

  costByChannel(range = '7d'): CostByChannelRow[] {
    this.requireSessionsDbAttached()
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT s.source as source,
                COALESCE(s.channel_name, 'unknown') as channelName,
                COALESCE(SUM(u.cost), 0) as totalCost,
                COUNT(DISTINCT COALESCE(u.parent_session_id, u.session_id)) as sessionCount,
                COUNT(*) as requestCount
         FROM usage_ledger u
         JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
         WHERE u.created_at >= ?
         GROUP BY s.source, s.channel_name
         ORDER BY totalCost DESC, requestCount DESC`,
      )
      .all(since) as CostByChannelRow[]
  }

  costBySource(range = '7d'): CostBySourceRow[] {
    this.requireSessionsDbAttached()
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT s.source as source,
                COALESCE(SUM(u.cost), 0) as totalCost,
                COUNT(DISTINCT COALESCE(u.parent_session_id, u.session_id)) as sessionCount
         FROM usage_ledger u
         JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
         WHERE u.created_at >= ?
         GROUP BY s.source
         ORDER BY totalCost DESC, sessionCount DESC`,
      )
      .all(since) as CostBySourceRow[]
  }

  channelCostByDay(channelName: string, range = '30d', source?: string): CostByPeriod[] {
    this.requireSessionsDbAttached()
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(u.created_at, 1, 10) as period,
                COALESCE(SUM(u.cost), 0) as totalCost,
                COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as totalTokens
         FROM usage_ledger u
         JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
         WHERE u.created_at >= ?
           AND COALESCE(s.channel_name, 'unknown') = ?
           AND (? IS NULL OR s.source = ?)
         GROUP BY period
         ORDER BY period`,
      )
      .all(since, channelName, source ?? null, source ?? null) as CostByPeriod[]
  }

  channelPurposeBreakdown(
    channelName: string,
    range = '30d',
    source?: string,
  ): SessionUsageByPurposeRow[] {
    this.requireSessionsDbAttached()
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT u.purpose as purpose,
                COALESCE(SUM(u.cost), 0) as totalCost,
                COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as totalTokens,
                COALESCE(SUM(u.reasoning_tokens), 0) as reasoningTokens,
                COUNT(*) as requestCount
         FROM usage_ledger u
         JOIN sdb.sessions s ON COALESCE(u.parent_session_id, u.session_id) = s.id
         WHERE u.created_at >= ?
           AND COALESCE(s.channel_name, 'unknown') = ?
           AND (? IS NULL OR s.source = ?)
         GROUP BY u.purpose
         ORDER BY totalCost DESC, requestCount DESC`,
      )
      .all(since, channelName, source ?? null, source ?? null) as SessionUsageByPurposeRow[]
  }

  /**
   * Get cost breakdown by model for a time range.
   */
  costByModel(range = '7d'): CostByModel[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT model, provider,
                SUM(cost) as totalCost,
                SUM(input_tokens) as totalInput,
                SUM(output_tokens) as totalOutput,
                COUNT(*) as requestCount
         FROM usage_ledger
         WHERE created_at >= ?
         GROUP BY model, provider
         ORDER BY totalCost DESC`,
      )
      .all(since) as CostByModel[]
  }

  /**
   * Get daily cost aggregation.
   */
  costByDay(range = '30d'): CostByPeriod[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                SUM(cost) as totalCost,
                SUM(input_tokens + output_tokens) as totalTokens
         FROM usage_ledger
         WHERE created_at >= ?
         GROUP BY period
         ORDER BY period DESC`,
      )
      .all(since) as CostByPeriod[]
  }

  /**
   * Get total cost and token usage summary.
   */
  summary(range = '7d'): { totalCost: number; totalTokens: number; requestCount: number } {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COUNT(*) as requestCount
         FROM usage_ledger
         WHERE created_at >= ?`,
      )
      .get(since) as { totalCost: number; totalTokens: number; requestCount: number }
  }

  /**
   * Get tool usage statistics.
   */
  toolStats(
    range = '7d',
  ): { tool: string; count: number; successRate: number; avgDurationMs: number }[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT tool,
                COUNT(*) as count,
                AVG(success) as successRate,
                AVG(duration_ms) as avgDurationMs
         FROM operations
         WHERE created_at >= ?
         GROUP BY tool
         ORDER BY count DESC`,
      )
      .all(since) as { tool: string; count: number; successRate: number; avgDurationMs: number }[]
  }

  /**
   * Get per-session aggregated stats.
   */
  sessionStats(sessionId: string): SessionStatsSummary {
    return this.db
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

  sessionFullCost(sessionId: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost
         FROM usage_ledger
         WHERE session_id = ? OR parent_session_id = ?`,
      )
      .get(sessionId, sessionId) as { totalCost: number }
    return row.totalCost
  }

  sessionAuxiliaryCost(sessionId: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost
         FROM usage_ledger
         WHERE (session_id = ? OR parent_session_id = ?)
           AND purpose NOT IN ('agent_loop', 'sub_agent')`,
      )
      .get(sessionId, sessionId) as { totalCost: number }
    return row.totalCost
  }

  /**
   * Count tool operations for a session.
   */
  sessionToolCallCount(sessionId: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) as count
         FROM operations
         WHERE session_id = ?`,
      )
      .get(sessionId) as { count: number } | null

    return row?.count ?? 0
  }

  /**
   * Batch version of sessionStats to avoid N+1 queries.
   */
  sessionStatsBatch(sessionIds: string[]): Map<string, SessionStatsSummary> {
    const result = new Map<string, SessionStatsSummary>()
    if (sessionIds.length === 0) return result

    for (const sessionId of sessionIds) {
      result.set(sessionId, createZeroSessionStatsSummary())
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = this.db
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

  /**
   * Cache hit rate by day.
   * Effective input is normalized to input + cache_write + cache_read across providers.
   */
  cacheHitRate(range = '30d'): CacheHitRate[] {
    const since = rangeToCutoff(range)
    return this.db
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
           GROUP BY period, provider
         )
         GROUP BY period
         ORDER BY period`,
      )
      .all(since) as CacheHitRate[]
  }

  /**
   * Task success rate by day from operations table.
   */
  taskSuccessRate(range = '30d'): TaskSuccessRate[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                AVG(success) as successRate,
                COUNT(*) as total
         FROM operations
         WHERE created_at >= ?
         GROUP BY period
         ORDER BY period`,
      )
      .all(since) as TaskSuccessRate[]
  }

  /**
   * Average operation duration by day.
   */
  avgDurationByDay(range = '30d'): AvgDuration[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                AVG(duration_ms) as avgMs
         FROM operations
         WHERE created_at >= ?
         GROUP BY period
         ORDER BY period`,
      )
      .all(since) as AvgDuration[]
  }

  /**
   * Cost grouped by day and model (for stacked bar chart).
   */
  costByDayModel(range = '30d'): CostByDayModel[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                model,
                SUM(cost) as cost
         FROM usage_ledger
         WHERE created_at >= ?
         GROUP BY period, model
         ORDER BY period, cost DESC`,
      )
      .all(since) as CostByDayModel[]
  }

  usageSummaryByPurpose(range = '7d'): UsageSummaryRow[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT purpose,
                COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
                COUNT(*) as eventCount
         FROM usage_ledger
         WHERE created_at >= ?
         GROUP BY purpose
         ORDER BY totalCost DESC, eventCount DESC`,
      )
      .all(since) as UsageSummaryRow[]
  }

  /**
   * Cache usage grouped by provider and model.
   */
  cacheByModel(range = '30d'): CacheByModelRecord[] {
    const since = rangeToCutoff(range)
    return this.db
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
         GROUP BY provider, model
         ORDER BY cacheRead DESC, hitRate DESC, cost DESC`,
      )
      .all(since) as CacheByModelRecord[]
  }

  /**
   * Record a self-repair attempt.
   */
  recordRepair(entry: RepairEntry): void {
    this.db.run(
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

  /**
   * Aggregate repair statistics.
   */
  repairStats(range = '30d'): RepairStats {
    const since = rangeToCutoff(range)
    const row = this.db
      .query(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount
         FROM repairs
         WHERE created_at >= ?`,
      )
      .get(since) as { total: number; successCount: number | null }
    return {
      total: row.total,
      successCount: row.successCount ?? 0,
      successRate: row.total > 0 ? (row.successCount ?? 0) / row.total : 0,
    }
  }

  /**
   * Repair trend by day.
   */
  repairByDay(range = '30d'): RepairByDay[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
         FROM repairs
         WHERE created_at >= ?
         GROUP BY period
         ORDER BY period`,
      )
      .all(since) as RepairByDay[]
  }

  /**
   * Detailed cost records grouped by date and model.
   */
  costDetailRecords(range = '30d'): CostDetailRecord[] {
    const since = rangeToCutoff(range)
    return this.db
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
         GROUP BY date, provider, model
         ORDER BY date DESC, cost DESC`,
      )
      .all(since) as CostDetailRecord[]
  }

  /**
   * Tool error counts by day and tool.
   */
  toolErrorByDay(range = '30d'): ToolErrorByDay[] {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT substr(created_at, 1, 10) as period,
                tool,
                COUNT(*) as total,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
         FROM operations
         WHERE created_at >= ?
         GROUP BY period, tool
         ORDER BY period, errors DESC`,
      )
      .all(since) as ToolErrorByDay[]
  }

  systemCosts(range = '7d'): UsageTotals {
    const since = rangeToCutoff(range)
    return this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COUNT(*) as eventCount
         FROM usage_ledger
         WHERE session_id IS NULL AND created_at >= ?`,
      )
      .get(since) as UsageTotals
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

  close(): void {
    this.db.close()
  }

  private requireSessionsDbAttached(): void {
    if (!this.attachedSessionsDbPath) {
      throw new Error('Sessions database is not attached')
    }
  }

  private listEvaluationsSince(since: string): EvaluationEntry[] {
    const rows = this.db
      .query(
        `SELECT *
         FROM evaluations
         WHERE created_at >= ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(since) as EvaluationRow[]

    return rows.map((row) => this.mapEvaluationRow(row))
  }

  private mapEvaluationRow(row: EvaluationRow): EvaluationEntry {
    return {
      id: row.id,
      sessionId: row.session_id,
      model: row.model,
      overallScore: row.overall_score,
      verdict: row.verdict,
      confidence: row.confidence,
      summary: row.summary ?? undefined,
      dimensions: parseJson(row.dimensions_json, []),
      findings: parseJson(row.findings_json, []),
      signals: row.signals_json ? parseJson(row.signals_json, {}) : undefined,
      generatedAt: row.generated_at,
      createdAt: row.created_at,
    }
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

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rangeToCutoff(range: string): string {
  const now = Date.now()
  const match = range.match(/^(\d+)(d|h|m)$/)
  if (!match) return new Date(now - 7 * 86_400_000).toISOString()

  const value = Number.parseInt(match[1])
  const unit = match[2]
  const ms = unit === 'd' ? value * 86_400_000 : unit === 'h' ? value * 3_600_000 : value * 60_000
  return new Date(now - ms).toISOString()
}
