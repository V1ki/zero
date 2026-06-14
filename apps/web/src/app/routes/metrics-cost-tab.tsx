import { useCallback, useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiFetch } from '../lib/api'
import { formatCost, formatNumber } from '../lib/format'
import {
  CHART_GRID,
  CHART_TEXT,
  type CacheHitRate,
  ChartCard,
  ChartEmpty,
  type CostByDayModel,
  type CostDetail,
  MODEL_COLORS,
  StatCard,
  TOOLTIP_STYLE,
  type TimeRange,
  formatCurrency,
  formatExactNumber,
  pctFormatter,
  pctTickFormatter,
  pivotBy,
  signedCostFormatter,
  totalTokensForDetail,
} from './metrics-shared'

export function CostTab({ range }: { range: TimeRange }) {
  const {
    loading,
    cacheHitRate,
    costTrendData,
    costModels,
    tokenUsageData,
    costSummary,
    dayCount,
    modelCount,
    cacheSummaryHitRate,
    dailyRows,
    modelSpendRows,
  } = useCostTabData(range)

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-5 xl:col-span-12">
        <StatCard
          label="Total Cost"
          value={loading ? '...' : formatCurrency(costSummary.cost)}
          detail={`${formatExactNumber(costSummary.requests)} requests`}
          delay={0}
        />
        <StatCard
          label="Total Tokens"
          value={loading ? '...' : formatNumber(costSummary.totalTokens)}
          detail={`${formatExactNumber(costSummary.totalTokens)} exact`}
          delay={40}
        />
        <StatCard
          label="Models"
          value={loading ? '...' : modelCount}
          detail={`${dayCount} active days`}
          delay={80}
        />
        <StatCard
          label="Input / Output"
          value={
            loading
              ? '...'
              : `${formatNumber(costSummary.input)} / ${formatNumber(costSummary.output)}`
          }
          detail="non-cache token usage"
          delay={120}
        />
        <StatCard
          label="Cache Hit Rate"
          value={loading ? '...' : pctFormatter(cacheSummaryHitRate)}
          detail={signedCostFormatter(costSummary.netSavings)}
          delay={160}
        />
      </div>

      <ChartCard title="Cost Trend" delay={0} className="xl:col-span-7">
        <div className="h-[240px]">
          {loading || costTrendData.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => `$${formatCost(v)}`}
                />
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
                <Legend wrapperStyle={{ color: CHART_TEXT, fontSize: 11 }} />
                {costModels.map((model, i) => (
                  <Bar
                    key={model}
                    dataKey={model}
                    stackId="cost"
                    fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                    radius={i === costModels.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ChartCard title="Daily Tokens" delay={60} className="xl:col-span-5">
        <div className="h-[240px]">
          {loading || tokenUsageData.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tokenUsageData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => formatNumber(v)}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => formatExactNumber(value)}
                />
                <Legend wrapperStyle={{ color: CHART_TEXT, fontSize: 11 }} />
                <Bar
                  dataKey="input"
                  name="Input"
                  stackId="tokens"
                  fill="#22d3ee"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="output"
                  name="Output"
                  stackId="tokens"
                  fill="#0891b2"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="cache"
                  name="Cache"
                  stackId="tokens"
                  fill="#34d399"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="reasoning"
                  name="Reasoning"
                  stackId="tokens"
                  fill="#fbbf24"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <div className="xl:col-span-12">
        <ChartCard title="Daily Model Spend" delay={120}>
          {loading ? (
            <div className="py-6 text-center text-[13px] text-[#93a4b8]">Loading...</div>
          ) : dailyRows.length === 0 ? (
            <div className="py-6 text-center text-[13px] text-[#93a4b8]">No daily model spend</div>
          ) : (
            <DailyModelSpendTable rows={dailyRows} />
          )}
        </ChartCard>
      </div>

      <div className="xl:col-span-7">
        <ChartCard title="Model Spend Summary" delay={180}>
          {loading ? (
            <div className="py-6 text-center text-[13px] text-[#93a4b8]">Loading...</div>
          ) : modelSpendRows.length === 0 ? (
            <div className="py-6 text-center text-[13px] text-[#93a4b8]">No model spend</div>
          ) : (
            <ModelSpendSummaryTable rows={modelSpendRows} />
          )}
        </ChartCard>
      </div>

      <ChartCard title="Cache Efficiency" delay={220} className="xl:col-span-5">
        <div className="h-[190px]">
          {loading || cacheHitRate.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cacheHitRate}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={pctTickFormatter}
                  domain={[0, 1]}
                />
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => pctFormatter(value)} />
                <Line
                  type="monotone"
                  dataKey="hitRate"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-[#7f8ea3]">CACHE READ</p>
            <p className="mt-1 font-mono text-[#d7e0ea]">
              {formatExactNumber(costSummary.cacheRead)}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-[#7f8ea3]">CACHE WRITE</p>
            <p className="mt-1 font-mono text-[#d7e0ea]">
              {formatExactNumber(costSummary.cacheWrite)}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-[#7f8ea3]">HIT RATE</p>
            <p className="mt-1 font-mono text-[#d7e0ea]">{pctFormatter(cacheSummaryHitRate)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-[#7f8ea3]">NET SAVINGS</p>
            <p className="mt-1 font-mono text-[#d7e0ea]">
              {signedCostFormatter(costSummary.netSavings)}
            </p>
          </div>
        </div>
      </ChartCard>
    </div>
  )
}

interface TokenUsageRow {
  period: string
  input: number
  output: number
  cache: number
  reasoning: number
}

interface CostSummary {
  cost: number
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  effectiveInput: number
  totalTokens: number
  netSavings: number
}

type DailyCostRow = CostDetail & { totalTokens: number }

function useCostTabData(range: TimeRange) {
  const [loading, setLoading] = useState(true)
  const [costByDayModel, setCostByDayModel] = useState<CostByDayModel[]>([])
  const [costDetail, setCostDetail] = useState<CostDetail[]>([])
  const [cacheHitRate, setCacheHitRate] = useState<CacheHitRate[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<{ data: CostByDayModel[] }>(`/api/metrics/cost-by-day-model?range=${r}`),
      apiFetch<{ data: CostDetail[] }>(`/api/metrics/cost-detail?range=${r}`),
      apiFetch<{ data: CacheHitRate[] }>(`/api/metrics/cache-hit-rate?range=${r}`),
    ])
      .then(([dayModelRes, detailRes, cacheRes]) => {
        setCostByDayModel(dayModelRes.data)
        setCostDetail(detailRes.data)
        setCacheHitRate(cacheRes.data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData(range)
  }, [range, fetchData])

  const { data: costTrendData, keys: costModels } = pivotBy(
    costByDayModel,
    'period',
    'model',
    'cost',
  )
  const tokenUsageData = buildTokenUsageData(costDetail)
  const costSummary = summarizeCostDetails(costDetail)
  const dayCount = new Set(costDetail.map((row) => row.date)).size
  const modelCount = new Set(costDetail.map((row) => `${row.provider}:${row.model}`)).size
  const cacheSummaryHitRate =
    costSummary.effectiveInput > 0 ? costSummary.cacheRead / costSummary.effectiveInput : 0
  const dailyRows = costDetail.map((row) => ({
    ...row,
    totalTokens: totalTokensForDetail(row),
  }))
  const modelSpendRows = buildModelSpendRows(costDetail)

  return {
    loading,
    cacheHitRate,
    costTrendData,
    costModels,
    tokenUsageData,
    costSummary,
    dayCount,
    modelCount,
    cacheSummaryHitRate,
    dailyRows,
    modelSpendRows,
  }
}

function buildTokenUsageData(costDetail: CostDetail[]): TokenUsageRow[] {
  const tokenUsageMap = new Map<string, TokenUsageRow>()
  for (const row of costDetail) {
    const existing = tokenUsageMap.get(row.date)
    if (existing) {
      existing.input += row.input
      existing.output += row.output
      existing.cache += row.cacheRead + row.cacheWrite
      existing.reasoning += row.reasoningTokens
    } else {
      tokenUsageMap.set(row.date, {
        period: row.date,
        input: row.input,
        output: row.output,
        cache: row.cacheRead + row.cacheWrite,
        reasoning: row.reasoningTokens,
      })
    }
  }
  return Array.from(tokenUsageMap.values()).sort((left, right) =>
    left.period.localeCompare(right.period),
  )
}

function summarizeCostDetails(costDetail: CostDetail[]): CostSummary {
  return costDetail.reduce(
    (acc, row) => {
      acc.cost += row.cost
      acc.requests += row.requestCount
      acc.input += row.input
      acc.output += row.output
      acc.cacheRead += row.cacheRead
      acc.cacheWrite += row.cacheWrite
      acc.effectiveInput += row.effectiveInput
      acc.netSavings += row.netSavings
      acc.totalTokens += totalTokensForDetail(row)
      return acc
    },
    {
      cost: 0,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      effectiveInput: 0,
      totalTokens: 0,
      netSavings: 0,
    },
  )
}

function buildModelSpendRows(costDetail: CostDetail[]): DailyCostRow[] {
  const modelSpendMap = new Map<string, DailyCostRow>()
  for (const row of costDetail) {
    const key = `${row.provider}:${row.model}`
    const existing = modelSpendMap.get(key)
    if (existing) {
      existing.requestCount += row.requestCount
      existing.input += row.input
      existing.output += row.output
      existing.cacheWrite += row.cacheWrite
      existing.cacheRead += row.cacheRead
      existing.reasoningTokens += row.reasoningTokens
      existing.effectiveInput += row.effectiveInput
      existing.cacheReadCost += row.cacheReadCost
      existing.cacheWriteCost += row.cacheWriteCost
      existing.grossAvoidedInputCost += row.grossAvoidedInputCost
      existing.netSavings += row.netSavings
      existing.cost += row.cost
      existing.totalTokens += totalTokensForDetail(row)
    } else {
      modelSpendMap.set(key, { ...row, totalTokens: totalTokensForDetail(row) })
    }
  }

  return Array.from(modelSpendMap.values())
    .sort((left, right) => right.cost - left.cost)
    .slice(0, 8)
}

function DailyModelSpendTable({ rows }: { rows: DailyCostRow[] }) {
  return (
    <div className="overflow-x-auto" style={{ maxHeight: 420 }}>
      <table className="w-full min-w-[1040px] text-[12px]">
        <thead className="sticky top-0 z-10 bg-[#111820]">
          <tr className="border-b border-[#253244] text-left text-[10px] font-semibold tracking-wide text-[#7f8ea3]">
            <th className="pb-2 pr-4">Date</th>
            <th className="pb-2 pr-4">Provider</th>
            <th className="pb-2 pr-4">Model</th>
            <th className="pb-2 pr-4 text-right">Requests</th>
            <th className="pb-2 pr-4 text-right">Input Tokens</th>
            <th className="pb-2 pr-4 text-right">Output Tokens</th>
            <th className="pb-2 pr-4 text-right">Cache Read</th>
            <th className="pb-2 pr-4 text-right">Cache Write</th>
            <th className="pb-2 pr-4 text-right">Total Tokens</th>
            <th className="pb-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.date}-${row.provider}-${row.model}`}
              className="border-b border-[#1f2a3a] transition-colors last:border-0 hover:bg-white/[0.04]"
            >
              <td className="py-2 pr-4 font-mono text-[#b8c7d9]">{row.date}</td>
              <td className="py-2 pr-4 text-[#93a4b8]">{row.provider}</td>
              <td className="max-w-[260px] truncate py-2 pr-4 font-mono text-[#67e8f9]">
                {row.model}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.requestCount)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.input)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.output)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#9fb0c4]">
                {formatExactNumber(row.cacheRead)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#9fb0c4]">
                {formatExactNumber(row.cacheWrite)}
              </td>
              <td className="py-2 pr-4 text-right font-mono font-semibold text-[#f8fafc]">
                {formatExactNumber(row.totalTokens)}
              </td>
              <td className="py-2 text-right font-mono font-semibold text-[#f8fafc]">
                {formatCurrency(row.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ModelSpendSummaryTable({ rows }: { rows: DailyCostRow[] }) {
  return (
    <div className="overflow-x-auto" style={{ maxHeight: 320 }}>
      <table className="w-full min-w-[760px] text-[12px]">
        <thead>
          <tr className="border-b border-[#253244] text-left text-[10px] font-semibold tracking-wide text-[#7f8ea3]">
            <th className="pb-2 pr-4">Provider</th>
            <th className="pb-2 pr-4">Model</th>
            <th className="pb-2 pr-4 text-right">Requests</th>
            <th className="pb-2 pr-4 text-right">Input</th>
            <th className="pb-2 pr-4 text-right">Output</th>
            <th className="pb-2 pr-4 text-right">Total Tokens</th>
            <th className="pb-2 pr-4 text-right">Net Savings</th>
            <th className="pb-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.provider}-${row.model}`}
              className="border-b border-[#1f2a3a] transition-colors last:border-0 hover:bg-white/[0.04]"
            >
              <td className="py-2 pr-4 text-[#93a4b8]">{row.provider}</td>
              <td className="max-w-[230px] truncate py-2 pr-4 font-mono text-[#67e8f9]">
                {row.model}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.requestCount)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.input)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#d7e0ea]">
                {formatExactNumber(row.output)}
              </td>
              <td className="py-2 pr-4 text-right font-mono font-semibold text-[#f8fafc]">
                {formatExactNumber(row.totalTokens)}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-[#9fb0c4]">
                {signedCostFormatter(row.netSavings)}
              </td>
              <td className="py-2 text-right font-mono font-semibold text-[#f8fafc]">
                {formatCurrency(row.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
