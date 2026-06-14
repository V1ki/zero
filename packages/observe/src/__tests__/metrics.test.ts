import type { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetricsDB } from '../metrics'
import { migrateLegacyRequestsToUsageLedger } from '../metrics-schema'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

function recordUsageRequest(
  db: MetricsDB,
  entry: {
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
  },
) {
  db.recordUsage({
    id: `usage_${entry.id}`,
    sessionId: entry.sessionId,
    category: 'completion',
    purpose: 'agent_loop',
    model: entry.model,
    provider: entry.provider,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    cacheReadTokens: entry.cacheReadTokens,
    reasoningTokens: 0,
    cost: entry.cost,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt,
  })
}

describe('MetricsDB', () => {
  let db: MetricsDB

  afterAll(() => {
    db?.close()
  })

  test('initialize and record requests', () => {
    db = MetricsDB.createInMemory()

    recordUsageRequest(db, {
      id: 'req_001',
      sessionId: 'sess_001',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 3200,
      outputTokens: 1800,
      cost: 0.028,
      durationMs: 1500,
      createdAt: new Date().toISOString(),
    })

    recordUsageRequest(db, {
      id: 'req_002',
      sessionId: 'sess_001',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 1500,
      outputTokens: 800,
      cost: 0.014,
      durationMs: 900,
      createdAt: new Date().toISOString(),
    })

    const summary = db.summary('1d')
    expect(summary.totalCost).toBeCloseTo(0.042, 3)
    expect(summary.requestCount).toBe(2)
    expect(summary.totalTokens).toBe(7300)
  })

  test('costByModel returns grouped data', () => {
    const costs = db.costByModel('1d')
    expect(costs.length).toBe(1)
    expect(costs[0].model).toBe('gpt-5.3-codex-medium')
    expect(costs[0].requestCount).toBe(2)
  })

  test('sessionStats returns cache metrics', () => {
    recordUsageRequest(db, {
      id: 'req_session_cache_001',
      sessionId: 'sess_001',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 500,
      outputTokens: 200,
      cacheWriteTokens: 100,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 100,
      createdAt: new Date().toISOString(),
    })

    const stats = db.sessionStats('sess_001')
    expect(stats.cacheWriteTokens).toBe(100)
    expect(stats.cacheReadTokens).toBe(400)
    expect(stats.effectiveInputTokens).toBe(5700)
    expect(stats.cacheHitRate).toBeCloseTo(400 / 5700, 3)
  })

  test('record and query tool operations', () => {
    db.recordOperation({
      sessionId: 'sess_001',
      tool: 'bash',
      event: 'tool_call',
      success: true,
      durationMs: 45,
      createdAt: new Date().toISOString(),
    })

    db.recordOperation({
      sessionId: 'sess_001',
      tool: 'bash',
      event: 'tool_call',
      success: false,
      durationMs: 100,
      createdAt: new Date().toISOString(),
    })

    const stats = db.toolStats('1d')
    expect(stats.length).toBe(1)
    expect(stats[0].tool).toBe('bash')
    expect(stats[0].count).toBe(2)
    expect(stats[0].successRate).toBe(0.5)
  })

  test('sessionToolCallCount returns per-session operation totals', () => {
    db.recordOperation({
      sessionId: 'sess_001',
      tool: 'read',
      event: 'tool_call',
      success: true,
      durationMs: 20,
      createdAt: new Date().toISOString(),
    })
    db.recordOperation({
      sessionId: 'sess_001',
      tool: 'bash',
      event: 'tool_call',
      success: true,
      durationMs: 30,
      createdAt: new Date().toISOString(),
    })
    db.recordOperation({
      sessionId: 'sess_002',
      tool: 'write',
      event: 'tool_call',
      success: true,
      durationMs: 40,
      createdAt: new Date().toISOString(),
    })

    expect(db.sessionToolCallCount('sess_001')).toBe(4)
    expect(db.sessionToolCallCount('sess_missing')).toBe(0)
  })

  test('recordUsage rejects invalid purposes at runtime', () => {
    const runtimeDb = MetricsDB.createInMemory()

    expect(() =>
      runtimeDb.recordUsage({
        id: 'usage_invalid_001',
        sessionId: 'sess_invalid_001',
        category: 'completion',
        purpose: 'not_a_real_purpose' as never,
        model: 'chatgpt/gpt-5.4',
        provider: 'chatgpt',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.01,
        durationMs: 10,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow('Invalid usage purpose')

    runtimeDb.close()
  })

  test('costByDay returns daily aggregation', () => {
    const daily = db.costByDay('30d')
    expect(daily.length).toBeGreaterThanOrEqual(1)
    expect(daily[0].totalCost).toBeGreaterThan(0)
  })

  test('cacheHitRate returns daily ratio', () => {
    const cacheDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    recordUsageRequest(cacheDb, {
      id: 'req_cache_001',
      sessionId: 'sess_002',
      model: 'claude-opus',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      cacheWriteTokens: 200,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 800,
      createdAt,
    })
    recordUsageRequest(cacheDb, {
      id: 'req_cache_002',
      sessionId: 'sess_003',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 600,
      outputTokens: 500,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 800,
      createdAt,
    })

    const rates = cacheDb.cacheHitRate('1d')
    expect(rates.length).toBeGreaterThanOrEqual(1)
    const todayRate = expectDefined(
      rates.find((r) => r.period === new Date().toISOString().slice(0, 10)),
    )
    expect(todayRate.hitRate).toBeCloseTo(800 / 2600, 3)

    cacheDb.close()
  })

  test('cacheHitRate uses effective input across providers', () => {
    const cacheDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    recordUsageRequest(cacheDb, {
      id: 'req_cache_003',
      sessionId: 'sess_004',
      model: 'claude-opus',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      cacheWriteTokens: 200,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 800,
      createdAt,
    })

    const rates = cacheDb.cacheHitRate('1d')
    const todayRate = expectDefined(
      rates.find((r) => r.period === new Date().toISOString().slice(0, 10)),
    )
    expect(todayRate.hitRate).toBeCloseTo(400 / 1600, 3)

    cacheDb.close()
  })

  test('cacheHitRate uses normalized effective input for non-anthropic requests', () => {
    const cacheDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    recordUsageRequest(cacheDb, {
      id: 'req_cache_004',
      sessionId: 'sess_005',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 400,
      outputTokens: 500,
      cacheWriteTokens: 200,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 800,
      createdAt,
    })

    const rates = cacheDb.cacheHitRate('1d')
    const todayRate = expectDefined(
      rates.find((r) => r.period === new Date().toISOString().slice(0, 10)),
    )
    expect(todayRate.hitRate).toBeCloseTo(400 / 1000, 3)

    cacheDb.close()
  })

  test('taskSuccessRate returns daily success rate', () => {
    const rates = db.taskSuccessRate('1d')
    expect(rates.length).toBeGreaterThanOrEqual(1)
    const today = expectDefined(
      rates.find((r) => r.period === new Date().toISOString().slice(0, 10)),
    )
    expect(today.successRate).toBe(0.8)
    expect(today.total).toBe(5)
  })

  test('avgDurationByDay returns average operation duration', () => {
    const durations = db.avgDurationByDay('1d')
    expect(durations.length).toBeGreaterThanOrEqual(1)
    const today = expectDefined(
      durations.find((d) => d.period === new Date().toISOString().slice(0, 10)),
    )
    expect(today.avgMs).toBeCloseTo(47, 0)
  })

  test('costByDayModel returns per-model daily cost', () => {
    const costDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    recordUsageRequest(costDb, {
      id: 'req_cost_day_001',
      sessionId: 'sess_cost_001',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 3200,
      outputTokens: 1800,
      cost: 0.028,
      durationMs: 1500,
      createdAt,
    })
    recordUsageRequest(costDb, {
      id: 'req_cost_day_002',
      sessionId: 'sess_cost_002',
      model: 'claude-opus',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.01,
      durationMs: 800,
      createdAt,
    })

    const data = costDb.costByDayModel('1d')
    expect(data.length).toBeGreaterThanOrEqual(1)
    const models = new Set(data.map((d) => d.model))
    expect(models.has('gpt-5.3-codex-medium')).toBe(true)
    expect(models.has('claude-opus')).toBe(true)

    costDb.close()
  })

  test('cacheByModel returns provider and cache aggregates', () => {
    const cacheDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    recordUsageRequest(cacheDb, {
      id: 'req_cache_by_model_001',
      sessionId: 'sess_cache_by_model_001',
      model: 'claude-opus',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 100,
      cacheWriteTokens: 200,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 100,
      createdAt,
    })

    const rows = cacheDb.cacheByModel('1d')
    expect(rows.length).toBe(1)
    expect(rows[0].provider).toBe('anthropic')
    expect(rows[0].cacheWrite).toBe(200)
    expect(rows[0].cacheRead).toBe(400)
    expect(rows[0].effectiveInput).toBe(1600)
    expect(rows[0].hitRate).toBeCloseTo(400 / 1600, 3)

    cacheDb.close()
  })

  test('recordRepair and repairStats', () => {
    db.recordRepair({
      sessionId: 'sess_001',
      status: 'success',
      diagnosis: 'API timeout detected',
      action: 'Retried with fallback model',
      result: 'Verification passed',
    })

    db.recordRepair({
      sessionId: 'sess_001',
      status: 'failed',
      diagnosis: 'Connection refused',
      action: 'Attempted reconnect',
      result: 'Verification failed',
    })

    const stats = db.repairStats('1d')
    expect(stats.total).toBe(2)
    expect(stats.successCount).toBe(1)
    expect(stats.successRate).toBeCloseTo(0.5, 2)
  })

  test('repairByDay returns daily repair trend', () => {
    const trend = db.repairByDay('1d')
    expect(trend.length).toBeGreaterThanOrEqual(1)
    const today = expectDefined(
      trend.find((t) => t.period === new Date().toISOString().slice(0, 10)),
    )
    expect(today.total).toBe(2)
    expect(today.success).toBe(1)
  })

  test('costDetailRecords returns per-model daily breakdown', () => {
    const records = db.costDetailRecords('1d')
    expect(records.length).toBeGreaterThanOrEqual(1)
    const first = records[0]
    expect(first.date).toBeDefined()
    expect(first.provider).toBeDefined()
    expect(first.model).toBeDefined()
    expect(typeof first.requestCount).toBe('number')
    expect(typeof first.input).toBe('number')
    expect(typeof first.output).toBe('number')
    expect(typeof first.cacheWrite).toBe('number')
    expect(typeof first.cacheRead).toBe('number')
    expect(typeof first.effectiveInput).toBe('number')
    expect(typeof first.hitRate).toBe('number')
    expect(typeof first.cost).toBe('number')
  })

  test('toolErrorByDay returns per-tool daily error counts', () => {
    db.recordOperation({
      sessionId: 'sess_001',
      tool: 'read',
      event: 'tool_call',
      success: false,
      durationMs: 30,
      createdAt: new Date().toISOString(),
    })

    const errors = db.toolErrorByDay('1d')
    expect(errors.length).toBeGreaterThanOrEqual(1)
    const tools = new Set(errors.map((e) => e.tool))
    expect(tools.has('bash')).toBe(true)
    expect(tools.has('read')).toBe(true)
    expect(expectDefined(errors.find((e) => e.tool === 'bash')).errors).toBe(1)
    expect(expectDefined(errors.find((e) => e.tool === 'read')).errors).toBe(1)
  })

  test('recordUsage supports auxiliary, system, and parent session aggregation', () => {
    const usageDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    usageDb.recordUsage({
      id: 'usage_agent_001',
      sessionId: 'sess_usage_001',
      category: 'completion',
      purpose: 'agent_loop',
      model: 'gpt-5',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.1,
      durationMs: 100,
      createdAt,
    })
    usageDb.recordUsage({
      id: 'usage_sub_001',
      sessionId: 'sess_usage_child_001',
      parentSessionId: 'sess_usage_001',
      category: 'completion',
      purpose: 'sub_agent',
      model: 'gpt-5',
      provider: 'openai',
      inputTokens: 80,
      outputTokens: 20,
      cost: 0.08,
      durationMs: 80,
      createdAt,
    })
    usageDb.recordUsage({
      id: 'usage_closure_001',
      sessionId: 'sess_usage_001',
      category: 'completion',
      purpose: 'task_closure',
      model: 'gpt-5-mini',
      provider: 'openai',
      inputTokens: 40,
      outputTokens: 10,
      cost: 0.04,
      durationMs: 40,
      createdAt,
    })
    usageDb.recordUsage({
      id: 'usage_tool_digest_001',
      sessionId: 'sess_usage_001',
      category: 'completion',
      purpose: 'tool_io_digest',
      model: 'chatgpt/gpt-5.5',
      provider: 'chatgpt',
      inputTokens: 30,
      outputTokens: 12,
      cost: 0.03,
      durationMs: 30,
      createdAt,
    })
    usageDb.recordUsage({
      id: 'usage_embedding_001',
      sessionId: null,
      category: 'embedding',
      purpose: 'embedding',
      model: 'text-embedding-v4',
      provider: 'embedding',
      inputTokens: 70,
      outputTokens: 0,
      cost: 0.02,
      durationMs: 0,
      metadata: JSON.stringify({ batchSize: 2 }),
      createdAt,
    })

    expect(usageDb.sessionFullCost('sess_usage_001')).toBeCloseTo(0.25, 6)
    expect(usageDb.sessionAuxiliaryCost('sess_usage_001')).toBeCloseTo(0.07, 6)

    const usageSummary = usageDb.usageSummaryByPurpose('1d')
    expect(usageSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: 'agent_loop',
          totalCost: 0.1,
        }),
        expect.objectContaining({
          purpose: 'embedding',
          totalCost: 0.02,
        }),
        expect.objectContaining({
          purpose: 'tool_io_digest',
          totalCost: 0.03,
        }),
      ]),
    )

    expect(usageDb.systemCosts('1d')).toEqual({
      totalCost: 0.02,
      totalTokens: 70,
      eventCount: 1,
    })

    usageDb.close()
  })

  test('migrateLegacyRequestsToUsageLedger includes same-timestamp legacy requests without duplicating mirrored usage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'metrics-migrate-'))
    const migrationDb = new MetricsDB(join(tempDir, 'metrics.db'))
    const internals = migrationDb as unknown as {
      db: Database
    }
    const boundary = '2026-04-01T00:00:00.123Z'

    try {
      internals.db.run(
        `INSERT INTO usage_ledger (
           id, session_id, category, purpose, parent_session_id, model, provider,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
           reasoning_tokens, cost, duration_ms, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'usage_existing_boundary',
          'sess_boundary_existing',
          'completion',
          'agent_loop',
          null,
          'chatgpt/gpt-5.4',
          'chatgpt',
          10,
          5,
          0,
          0,
          0,
          0.15,
          120,
          null,
          boundary,
        ],
      )

      internals.db.run(
        `INSERT INTO requests (
           id, session_id, model, provider, input_tokens, output_tokens,
           cache_write_tokens, cache_read_tokens, cost, duration_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'req_skip_existing',
          'sess_boundary_existing',
          'chatgpt/gpt-5.4',
          'chatgpt',
          10,
          5,
          0,
          0,
          0.15,
          120,
          boundary,
        ],
      )

      internals.db.run(
        `INSERT INTO requests (
           id, session_id, model, provider, input_tokens, output_tokens,
           cache_write_tokens, cache_read_tokens, cost, duration_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'req_migrate_boundary',
          'sess_boundary_missing',
          'chatgpt/gpt-5.4',
          'chatgpt',
          11,
          6,
          0,
          0,
          0.16,
          121,
          boundary,
        ],
      )

      migrateLegacyRequestsToUsageLedger(internals.db)

      const rows = internals.db
        .query(
          `SELECT id, session_id
           FROM usage_ledger
           WHERE created_at = ?
           ORDER BY id`,
        )
        .all(boundary) as Array<{ id: string; session_id: string | null }>

      expect(rows).toEqual([
        { id: 'migrated_req_migrate_boundary', session_id: 'sess_boundary_missing' },
        { id: 'usage_existing_boundary', session_id: 'sess_boundary_existing' },
      ])
    } finally {
      migrationDb.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
