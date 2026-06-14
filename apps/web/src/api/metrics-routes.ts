import type { ModelPricing } from '@zero-os/shared'
import { Hono } from 'hono'
import type { ZeroOS } from '../../../server/src/main'

export function formatModelLabel(providerName: string, modelName: string) {
  return `${providerName}/${modelName}`
}

function resolvePricing(
  zero: ZeroOS,
  providerName: string,
  modelName: string,
): ModelPricing | undefined {
  const candidates = [modelName]
  if (!modelName.startsWith(`${providerName}/`)) {
    candidates.push(formatModelLabel(providerName, modelName))
  }

  for (const candidate of candidates) {
    const resolved = zero.modelRouter.resolveModel(candidate)
    if (resolved && resolved.providerName === providerName) {
      return resolved.modelConfig.pricing
    }
  }

  return undefined
}

function computeCacheEconomics(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  pricing?: ModelPricing,
) {
  const perMillion = 1_000_000
  const cacheReadCost =
    pricing?.cacheRead !== undefined ? (cacheReadTokens * pricing.cacheRead) / perMillion : 0
  const cacheWriteCost =
    pricing?.cacheWrite !== undefined ? (cacheWriteTokens * pricing.cacheWrite) / perMillion : 0
  const grossAvoidedInputCost =
    pricing?.input !== undefined ? (cacheReadTokens * pricing.input) / perMillion : 0
  const uncachedBaselineCost =
    pricing?.input !== undefined
      ? ((cacheReadTokens + cacheWriteTokens) * pricing.input) / perMillion
      : 0

  return {
    cacheReadCost,
    cacheWriteCost,
    grossAvoidedInputCost,
    netSavings: uncachedBaselineCost - cacheReadCost - cacheWriteCost,
  }
}

export function createSessionCacheEconomicsSummarizer(zero: ZeroOS) {
  return (sessionId: string) => {
    const requests = zero.observability.readSessionRequests(sessionId)
    let cacheReadCost = 0
    let cacheWriteCost = 0
    let grossAvoidedInputCost = 0
    let netSavings = 0

    for (const request of requests) {
      const pricing = resolvePricing(zero, request.provider, request.model)
      const economics = computeCacheEconomics(
        request.tokens.cacheRead ?? 0,
        request.tokens.cacheWrite ?? 0,
        pricing,
      )
      cacheReadCost += economics.cacheReadCost
      cacheWriteCost += economics.cacheWriteCost
      grossAvoidedInputCost += economics.grossAvoidedInputCost
      netSavings += economics.netSavings
    }

    return {
      cacheReadCost,
      cacheWriteCost,
      grossAvoidedInputCost,
      netSavings,
    }
  }
}

export function createMetricsRoutes(zero: ZeroOS) {
  return new Hono()
    .get('/cost', (c) => {
      const range = c.req.query('range') ?? '7d'
      const byModel = zero.metrics.costByModel(range)
      const totalCost = byModel.reduce((sum, model) => sum + model.totalCost, 0)
      const totalTokens = byModel.reduce(
        (sum, model) => sum + model.totalInput + model.totalOutput,
        0,
      )
      return c.json({ range, totalCost, totalTokens, byModel })
    })

    .get('/summary', (c) => {
      const today = zero.metrics.summary('1d')
      const week = zero.metrics.summary('7d')
      const month = zero.metrics.summary('30d')
      return c.json({
        today: { cost: today.totalCost, tokens: today.totalTokens },
        week: { cost: week.totalCost, tokens: week.totalTokens },
        month: { cost: month.totalCost, tokens: month.totalTokens },
      })
    })

    .get('/usage-summary', (c) => {
      const range = c.req.query('range') ?? '7d'
      const data = zero.metrics.usageSummaryByPurpose(range)
      return c.json({ range, data })
    })

    .get('/system-costs', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({
        range,
        ...zero.metrics.systemCosts(range),
      })
    })

    .get('/cost-by-channel', (c) => {
      const range = c.req.query('range') ?? '7d'
      return c.json({ range, data: zero.metrics.costByChannel(range) })
    })

    .get('/cost-by-source', (c) => {
      const range = c.req.query('range') ?? '7d'
      return c.json({ range, data: zero.metrics.costBySource(range) })
    })

    .get('/channel/:name/cost-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const source = c.req.query('source') ?? undefined
      const name = decodeURIComponent(c.req.param('name'))
      return c.json({
        range,
        channelName: name,
        source: source ?? null,
        data: zero.metrics.channelCostByDay(name, range, source),
      })
    })

    .get('/channel/:name/purpose-breakdown', (c) => {
      const range = c.req.query('range') ?? '30d'
      const source = c.req.query('source') ?? undefined
      const name = decodeURIComponent(c.req.param('name'))
      return c.json({
        range,
        channelName: name,
        source: source ?? null,
        data: zero.metrics.channelPurposeBreakdown(name, range, source),
      })
    })

    .get('/evaluations/trend', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.evaluationTrend(range) })
    })

    .get('/evaluations/dimensions', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.evaluationDimensionAvg(range) })
    })

    .get('/evaluations/top-findings', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.topFindings(range) })
    })

    .get('/cost-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costByDay(range)
      return c.json({ data })
    })

    .get('/tool-stats', (c) => {
      const range = c.req.query('range') ?? '7d'
      const data = zero.metrics.toolStats(range)
      return c.json({ data })
    })

    .get('/cache-hit-rate', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.cacheHitRate(range)
      return c.json({ data })
    })

    .get('/cache-by-model', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.cacheByModel(range).map((row) => {
        const pricing = resolvePricing(zero, row.provider, row.model)
        return {
          ...row,
          ...computeCacheEconomics(row.cacheRead, row.cacheWrite, pricing),
        }
      })
      return c.json({ data })
    })

    .get('/task-success-rate', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.taskSuccessRate(range)
      return c.json({ data })
    })

    .get('/health', (c) => {
      const range = c.req.query('range') ?? '30d'
      const repairs = zero.metrics.repairStats(range)
      const repairTrend = zero.metrics.repairByDay(range)
      return c.json({ repairs, repairTrend })
    })

    .get('/cost-by-day-model', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costByDayModel(range)
      return c.json({ data })
    })

    .get('/avg-duration', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.avgDurationByDay(range)
      return c.json({ data })
    })

    .get('/cost-detail', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costDetailRecords(range).map((row) => {
        const pricing = resolvePricing(zero, row.provider, row.model)
        return {
          ...row,
          ...computeCacheEconomics(row.cacheRead, row.cacheWrite, pricing),
        }
      })
      return c.json({ data })
    })

    .get('/tool-error-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.toolErrorByDay(range)
      return c.json({ data })
    })
}
