import { afterAll, describe, expect, test } from 'bun:test'
import { MetricsDB } from '../metrics'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('MetricsDB', () => {
  let db: MetricsDB

  afterAll(() => {
    db?.close()
  })

  test('initialize and record requests', () => {
    db = MetricsDB.createInMemory()

    db.recordRequest({
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

    db.recordRequest({
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
    db.recordRequest({
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

  test('costByDay returns daily aggregation', () => {
    const daily = db.costByDay('30d')
    expect(daily.length).toBeGreaterThanOrEqual(1)
    expect(daily[0].totalCost).toBeGreaterThan(0)
  })

  test('cacheHitRate returns daily ratio', () => {
    const cacheDb = MetricsDB.createInMemory()
    const createdAt = new Date().toISOString()

    cacheDb.recordRequest({
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
    cacheDb.recordRequest({
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

    cacheDb.recordRequest({
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

    cacheDb.recordRequest({
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

    costDb.recordRequest({
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
    costDb.recordRequest({
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

    cacheDb.recordRequest({
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
})
