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

/**
 * SQLite-based metrics aggregation for ZeRo OS observability.
 */
export class MetricsDB {
  private db: Database

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
  }

  /**
   * Record an LLM request.
   */
  recordRequest(entry: {
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
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO requests (id, session_id, model, provider, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.sessionId,
        entry.model,
        entry.provider,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheWriteTokens ?? 0,
        entry.cacheReadTokens ?? 0,
        entry.cost,
        entry.durationMs,
        entry.createdAt,
      ],
    )
  }

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
         FROM requests
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
         FROM requests
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
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COUNT(*) as requestCount
         FROM requests
         WHERE created_at >= ?`,
      )
      .get(since) as { totalCost: number; totalTokens: number; requestCount: number }
    return row
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
  sessionStats(sessionId: string): {
    totalCost: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    effectiveInputTokens: number
    cacheHitRate: number
    requestCount: number
  } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens,
                COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
                COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
                COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as effectiveInputTokens,
                COALESCE(
                  SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0),
                  0
                ) as cacheHitRate,
                COUNT(*) as requestCount
         FROM requests
         WHERE session_id = ?`,
      )
      .get(sessionId) as {
      totalCost: number
      totalTokens: number
      inputTokens: number
      outputTokens: number
      cacheWriteTokens: number
      cacheReadTokens: number
      effectiveInputTokens: number
      cacheHitRate: number
      requestCount: number
    }
    return row
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
  sessionStatsBatch(sessionIds: string[]): Map<
    string,
    SessionStatsSummary
  > {
    const result = new Map<string, SessionStatsSummary>()
    if (sessionIds.length === 0) return result

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = this.db
      .query(
        `SELECT session_id,
                COALESCE(SUM(cost), 0) as totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens,
                COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
                COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
                COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as effectiveInputTokens,
                COALESCE(
                  SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0),
                  0
                ) as cacheHitRate,
                COUNT(*) as requestCount
         FROM requests
         WHERE session_id IN (${placeholders})
         GROUP BY session_id`,
      )
      .all(...sessionIds) as {
      session_id: string
      totalCost: number
      totalTokens: number
      inputTokens: number
      outputTokens: number
      cacheWriteTokens: number
      cacheReadTokens: number
      effectiveInputTokens: number
      cacheHitRate: number
      requestCount: number
    }[]

    for (const row of rows) {
      result.set(row.session_id, {
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        cacheReadTokens: row.cacheReadTokens,
        effectiveInputTokens: row.effectiveInputTokens,
        cacheHitRate: row.cacheHitRate,
        requestCount: row.requestCount,
      })
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
           FROM requests
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
         FROM requests
         WHERE created_at >= ?
         GROUP BY period, model
         ORDER BY period, cost DESC`,
      )
      .all(since) as CostByDayModel[]
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
         FROM requests
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
      .get(since) as { total: number; successCount: number }
    return {
      total: row.total,
      successCount: row.successCount,
      successRate: row.total > 0 ? row.successCount / row.total : 0,
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
                SUM(input_tokens + cache_write_tokens + cache_read_tokens) as effectiveInput,
                SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0) as hitRate,
                SUM(cost) as cost
         FROM requests
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

  /**
   * Delete all metrics data for a session.
   */
  deleteSessionMetrics(sessionId: string): void {
    this.db.run('DELETE FROM requests WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM operations WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM repairs WHERE session_id = ?', [sessionId])
  }

  close(): void {
    this.db.close()
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
