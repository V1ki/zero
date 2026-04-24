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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'cost' | 'purpose' | 'attribution' | 'evaluations' | 'events' | 'health'
type TimeRange = '7d' | '30d' | '90d' | 'custom'

interface CostByDayModel {
  period: string
  model: string
  cost: number
}
interface CostDetail {
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
  cacheReadCost: number
  cacheWriteCost: number
  grossAvoidedInputCost: number
  netSavings: number
  cost: number
}
interface CacheHitRate {
  period: string
  hitRate: number
}
interface ToolStat {
  tool: string
  count: number
  successRate: number
  avgDurationMs: number
}
interface TaskSuccess {
  period: string
  successRate: number
  total: number
}
interface AvgDuration {
  period: string
  avgMs: number
}
interface ToolErrorByDay {
  period: string
  tool: string
  total: number
  errors: number
}
interface HealthData {
  repairs: { total: number; successCount: number; successRate: number }
  repairTrend: { period: string; total: number; success: number }[]
}
interface UsageSummary {
  purpose: string
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  eventCount: number
}
interface CostByChannel {
  source: string
  channelName: string
  totalCost: number
  sessionCount: number
  requestCount: number
}
interface CostBySource {
  source: string
  totalCost: number
  sessionCount: number
}
interface SessionUsageByPurpose {
  purpose: string
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  requestCount: number
}
interface EvaluationTrend {
  period: string
  avgScore: number
  evalCount: number
  strongCount: number
  mixedCount: number
  weakCount: number
}
interface EvaluationDimensionAverage {
  dimensionKey: string
  avgScore: number
  count: number
}
interface TopFinding {
  title: string
  severity: string
  count: number
}
interface LogEntry {
  ts: string
  event?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_COLORS = [
  '#22d3ee',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb7185',
  '#94a3b8',
]
const CHART_GRID = 'rgba(148, 163, 184, 0.14)'
const CHART_TEXT = '#93a4b8'
const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#121a24',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 8,
    fontSize: 12,
    color: '#e6edf3',
  },
  labelStyle: { color: '#cbd5e1' },
  itemStyle: { color: '#e6edf3' },
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'evaluations', label: 'Evaluations' },
  { key: 'events', label: 'Events' },
  { key: 'health', label: 'Health' },
]

const RANGES: TimeRange[] = ['7d', '30d', '90d', 'custom']

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

function ChartCard({
  title,
  delay = 0,
  className = '',
  children,
}: { title: string; delay?: number; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`animate-fade-up rounded-lg border border-[#253244] bg-[#111820]/95 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <h3 className="mb-3 text-[14px] font-semibold text-[#d7e0ea]">{title}</h3>
      {children}
    </div>
  )
}

function ChartEmpty({ loading, message = 'No data' }: { loading: boolean; message?: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-[#93a4b8]">
      {loading ? 'Loading...' : message}
    </div>
  )
}

function StatCard({
  label,
  value,
  detail,
  delay = 0,
}: { label: string; value: string | number; detail?: string; delay?: number }) {
  return (
    <div
      className="animate-fade-up rounded-lg border border-[#253244] bg-[#111820]/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <p className="mb-1 text-[11px] font-medium text-[#93a4b8]">{label}</p>
      <p className="text-[26px] font-bold tracking-tight text-[#f8fafc]">{value}</p>
      {detail && <p className="mt-1 text-[11px] text-[#7f8ea3]">{detail}</p>}
    </div>
  )
}

function pctFormatter(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

function pctTickFormatter(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

function signedCostFormatter(v: number): string {
  const abs = formatCost(Math.abs(v))
  if (v > 0) return `+$${abs}`
  if (v < 0) return `-$${abs}`
  return `$${abs}`
}

function formatCurrency(v: number): string {
  return `$${formatCost(v)}`
}

function formatExactNumber(v: number): string {
  return Math.round(v).toLocaleString()
}

function totalTokensForDetail(row: CostDetail): number {
  return row.input + row.output + row.cacheWrite + row.cacheRead + row.reasoningTokens
}

// ---------------------------------------------------------------------------
// Pivot helper — turns array of { period, key, value } into pivoted rows
// ---------------------------------------------------------------------------

function pivotBy<T extends object>(
  rows: T[],
  periodKey: keyof T,
  groupKey: keyof T,
  valueKey: keyof T,
): { data: Record<string, unknown>[]; keys: string[] } {
  const grouped = new Map<string, Record<string, unknown>>()
  const keySet = new Set<string>()

  for (const row of rows) {
    const period = String(row[periodKey])
    const group = String(row[groupKey])
    const value = row[valueKey] as unknown
    keySet.add(group)
    let periodGroup = grouped.get(period)
    if (!periodGroup) {
      periodGroup = { period }
      grouped.set(period, periodGroup)
    }
    periodGroup[group] = value
  }

  return { data: Array.from(grouped.values()), keys: Array.from(keySet) }
}

// ---------------------------------------------------------------------------
// CostTab
// ---------------------------------------------------------------------------

function CostTab({ range }: { range: TimeRange }) {
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

  // Pivoted cost-by-day-model for stacked bar chart
  const { data: costTrendData, keys: costModels } = pivotBy(
    costByDayModel,
    'period',
    'model',
    'cost',
  )

  const tokenUsageMap = new Map<
    string,
    { period: string; input: number; output: number; cache: number; reasoning: number }
  >()
  for (const d of costDetail) {
    const existing = tokenUsageMap.get(d.date)
    if (existing) {
      existing.input += d.input
      existing.output += d.output
      existing.cache += d.cacheRead + d.cacheWrite
      existing.reasoning += d.reasoningTokens
    } else {
      tokenUsageMap.set(d.date, {
        period: d.date,
        input: d.input,
        output: d.output,
        cache: d.cacheRead + d.cacheWrite,
        reasoning: d.reasoningTokens,
      })
    }
  }
  const tokenUsageData = Array.from(tokenUsageMap.values()).sort((left, right) =>
    left.period.localeCompare(right.period),
  )

  const costSummary = costDetail.reduce(
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
  const dayCount = new Set(costDetail.map((row) => row.date)).size
  const modelCount = new Set(costDetail.map((row) => `${row.provider}:${row.model}`)).size
  const cacheSummaryHitRate =
    costSummary.effectiveInput > 0 ? costSummary.cacheRead / costSummary.effectiveInput : 0

  const dailyRows = costDetail.map((row) => ({
    ...row,
    totalTokens: totalTokensForDetail(row),
  }))

  const modelSpendMap = new Map<string, CostDetail & { totalTokens: number }>()
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
  const modelSpendRows = Array.from(modelSpendMap.values())
    .sort((left, right) => right.cost - left.cost)
    .slice(0, 8)

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
                  {dailyRows.map((row) => (
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
                  {modelSpendRows.map((row) => (
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

// ---------------------------------------------------------------------------
// PurposeTab
// ---------------------------------------------------------------------------

function PurposeTab({ range }: { range: TimeRange }) {
  const [loading, setLoading] = useState(true)
  const [usage, setUsage] = useState<UsageSummary[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    apiFetch<{ data: UsageSummary[] }>(`/api/metrics/usage-summary?range=${r}`)
      .then((response) => setUsage(response.data))
      .catch(() => setUsage([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData(range)
  }, [range, fetchData])

  const totalCost = usage.reduce((sum, row) => sum + row.totalCost, 0)
  const totalReasoning = usage.reduce((sum, row) => sum + row.reasoningTokens, 0)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:col-span-2">
        <StatCard label="Tracked Purposes" value={loading ? '...' : usage.length} delay={0} />
        <StatCard
          label="Purpose Cost"
          value={loading ? '...' : `$${formatCost(totalCost)}`}
          delay={40}
        />
        <StatCard
          label="Reasoning Tokens"
          value={loading ? '...' : formatNumber(totalReasoning)}
          delay={80}
        />
      </div>

      <ChartCard title="Cost by Purpose" delay={0}>
        <div className="h-[280px]">
          {loading || usage.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={usage} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(value: number) => `$${formatCost(value)}`}
                />
                <YAxis
                  type="category"
                  dataKey="purpose"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  width={110}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => `$${formatCost(value)}`}
                />
                <Bar dataKey="totalCost" fill="#f59e0b" radius={[0, 4, 4, 0]} name="Cost" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ChartCard title="Purpose Detail" delay={60}>
        {loading ? (
          <ChartEmpty loading />
        ) : usage.length === 0 ? (
          <ChartEmpty loading={false} />
        ) : (
          <div className="max-h-[280px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] tracking-wide text-[var(--color-text-disabled)]">
                  <th className="pb-2 pr-4">Purpose</th>
                  <th className="pb-2 pr-4 text-right">Events</th>
                  <th className="pb-2 pr-4 text-right">Tokens</th>
                  <th className="pb-2 pr-4 text-right">Reasoning</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr
                    key={row.purpose}
                    className="border-b border-[var(--color-border)] last:border-0"
                  >
                    <td className="py-2 pr-4 font-mono uppercase text-[var(--color-text-secondary)]">
                      {row.purpose}
                    </td>
                    <td className="py-2 pr-4 text-right text-[var(--color-text-muted)]">
                      {formatNumber(row.eventCount)}
                    </td>
                    <td className="py-2 pr-4 text-right text-[var(--color-text-muted)]">
                      {formatNumber(row.totalTokens)}
                    </td>
                    <td className="py-2 pr-4 text-right text-[var(--color-text-muted)]">
                      {formatNumber(row.reasoningTokens)}
                    </td>
                    <td className="py-2 text-right">${formatCost(row.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AttributionTab
// ---------------------------------------------------------------------------

function AttributionTab({ range }: { range: TimeRange }) {
  const [loading, setLoading] = useState(true)
  const [channels, setChannels] = useState<CostByChannel[]>([])
  const [sources, setSources] = useState<CostBySource[]>([])
  const [selectedChannelKey, setSelectedChannelKey] = useState<string>('')
  const [trend, setTrend] = useState<{ period: string; totalCost: number }[]>([])
  const [breakdown, setBreakdown] = useState<SessionUsageByPurpose[]>([])

  const selectedChannel =
    channels.find((row) => `${row.source}::${row.channelName}` === selectedChannelKey) ??
    channels[0]

  const fetchOverview = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<{ data: CostByChannel[] }>(`/api/metrics/cost-by-channel?range=${r}`),
      apiFetch<{ data: CostBySource[] }>(`/api/metrics/cost-by-source?range=${r}`),
    ])
      .then(([channelRes, sourceRes]) => {
        setChannels(channelRes.data)
        setSources(sourceRes.data)
        const first = channelRes.data[0]
        if (first) {
          const nextKey = `${first.source}::${first.channelName}`
          setSelectedChannelKey((current) => current || nextKey)
        } else {
          setSelectedChannelKey('')
        }
      })
      .catch(() => {
        setChannels([])
        setSources([])
        setSelectedChannelKey('')
      })
      .finally(() => setLoading(false))
  }, [])

  const fetchChannelDetail = useCallback((channel: CostByChannel | undefined, r: TimeRange) => {
    if (!channel) {
      setTrend([])
      setBreakdown([])
      return
    }

    const name = encodeURIComponent(channel.channelName)
    const sourceQuery = `&source=${encodeURIComponent(channel.source)}`

    Promise.all([
      apiFetch<{ data: { period: string; totalCost: number }[] }>(
        `/api/metrics/channel/${name}/cost-by-day?range=${r}${sourceQuery}`,
      ),
      apiFetch<{ data: SessionUsageByPurpose[] }>(
        `/api/metrics/channel/${name}/purpose-breakdown?range=${r}${sourceQuery}`,
      ),
    ])
      .then(([trendRes, breakdownRes]) => {
        setTrend(trendRes.data)
        setBreakdown(breakdownRes.data)
      })
      .catch(() => {
        setTrend([])
        setBreakdown([])
      })
  }, [])

  useEffect(() => {
    fetchOverview(range)
  }, [range, fetchOverview])

  useEffect(() => {
    fetchChannelDetail(selectedChannel, range)
  }, [range, selectedChannel, fetchChannelDetail])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartCard title="Channel Cost" delay={0}>
        {loading ? (
          <ChartEmpty loading />
        ) : channels.length === 0 ? (
          <ChartEmpty loading={false} />
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] tracking-wide text-[var(--color-text-disabled)]">
                  <th className="pb-2 pr-4">Channel</th>
                  <th className="pb-2 pr-4">Source</th>
                  <th className="pb-2 pr-4 text-right">Sessions</th>
                  <th className="pb-2 pr-4 text-right">Calls</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((row) => {
                  const key = `${row.source}::${row.channelName}`
                  const active = selectedChannelKey === key
                  return (
                    <tr
                      key={key}
                      className={`border-b border-[var(--color-border)] last:border-0 ${
                        active ? 'bg-white/[0.04]' : ''
                      }`}
                    >
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-secondary)]">
                        <button
                          type="button"
                          onClick={() => setSelectedChannelKey(key)}
                          aria-pressed={active}
                          className="text-left font-mono text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent)]"
                        >
                          {row.channelName}
                        </button>
                      </td>
                      <td className="py-2 pr-4 text-[var(--color-text-muted)]">{row.source}</td>
                      <td className="py-2 pr-4 text-right text-[var(--color-text-muted)]">
                        {formatNumber(row.sessionCount)}
                      </td>
                      <td className="py-2 pr-4 text-right text-[var(--color-text-muted)]">
                        {formatNumber(row.requestCount)}
                      </td>
                      <td className="py-2 text-right">${formatCost(row.totalCost)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>

      <ChartCard title="Source Summary" delay={60}>
        {loading ? (
          <ChartEmpty loading />
        ) : sources.length === 0 ? (
          <ChartEmpty loading={false} />
        ) : (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sources}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="source" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(value: number) => `$${formatCost(value)}`}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => `$${formatCost(value)}`}
                />
                <Bar dataKey="totalCost" fill="#14b8a6" radius={[4, 4, 0, 0]} name="Cost" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      <ChartCard
        title={selectedChannel ? `Daily Cost · ${selectedChannel.channelName}` : 'Daily Cost'}
        delay={120}
      >
        <div className="h-[260px]">
          {loading || trend.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(value: number) => `$${formatCost(value)}`}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => `$${formatCost(value)}`}
                />
                <Line
                  type="monotone"
                  dataKey="totalCost"
                  stroke="#14b8a6"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ChartCard
        title={selectedChannel ? `Purpose Mix · ${selectedChannel.channelName}` : 'Purpose Mix'}
        delay={180}
      >
        <div className="h-[260px]">
          {loading || breakdown.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdown} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(value: number) => `$${formatCost(value)}`}
                />
                <YAxis
                  type="category"
                  dataKey="purpose"
                  width={110}
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => `$${formatCost(value)}`}
                />
                <Bar dataKey="totalCost" fill="#38bdf8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EvaluationTab
// ---------------------------------------------------------------------------

function EvaluationTab({ range }: { range: TimeRange }) {
  const [loading, setLoading] = useState(true)
  const [trend, setTrend] = useState<EvaluationTrend[]>([])
  const [dimensions, setDimensions] = useState<EvaluationDimensionAverage[]>([])
  const [findings, setFindings] = useState<TopFinding[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<{ data: EvaluationTrend[] }>(`/api/metrics/evaluations/trend?range=${r}`),
      apiFetch<{ data: EvaluationDimensionAverage[] }>(
        `/api/metrics/evaluations/dimensions?range=${r}`,
      ),
      apiFetch<{ data: TopFinding[] }>(`/api/metrics/evaluations/top-findings?range=${r}`),
    ])
      .then(([trendRes, dimRes, findingsRes]) => {
        setTrend(trendRes.data)
        setDimensions(dimRes.data)
        setFindings(findingsRes.data)
      })
      .catch(() => {
        setTrend([])
        setDimensions([])
        setFindings([])
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData(range)
  }, [range, fetchData])

  const totalEvaluations = trend.reduce((sum, row) => sum + row.evalCount, 0)
  const latestAverage = trend.at(-1)?.avgScore ?? 0

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:col-span-2">
        <StatCard
          label="Evaluations"
          value={loading ? '...' : formatNumber(totalEvaluations)}
          delay={0}
        />
        <StatCard
          label="Latest Avg Score"
          value={loading ? '...' : latestAverage.toFixed(2)}
          delay={40}
        />
        <StatCard label="Frequent Findings" value={loading ? '...' : findings.length} delay={80} />
      </div>

      <ChartCard title="Average Score Trend" delay={0}>
        <div className="h-[260px]">
          {loading || trend.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis tick={{ fontSize: 10, fill: CHART_TEXT }} domain={[0, 5]} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Line
                  type="monotone"
                  dataKey="avgScore"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ChartCard title="Dimension Averages" delay={60}>
        <div className="h-[260px]">
          {loading || dimensions.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dimensions}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="dimensionKey" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis tick={{ fontSize: 10, fill: CHART_TEXT }} domain={[0, 5]} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="avgScore" fill="#a78bfa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ChartCard title="Top Findings" delay={120}>
        {loading ? (
          <ChartEmpty loading />
        ) : findings.length === 0 ? (
          <ChartEmpty loading={false} />
        ) : (
          <div className="max-h-[260px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] tracking-wide text-[var(--color-text-disabled)]">
                  <th className="pb-2 pr-4">Severity</th>
                  <th className="pb-2 pr-4">Title</th>
                  <th className="pb-2 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr
                    key={`${finding.severity}:${finding.title}`}
                    className="border-b border-[var(--color-border)] last:border-0"
                  >
                    <td className="py-2 pr-4 uppercase text-[var(--color-text-muted)]">
                      {finding.severity}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-secondary)]">
                      {finding.title}
                    </td>
                    <td className="py-2 text-right text-[var(--color-text-muted)]">
                      {formatNumber(finding.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>

      <ChartCard title="Verdict Mix" delay={180}>
        <div className="h-[260px]">
          {loading || trend.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="strongCount" stackId="verdict" fill="#22c55e" />
                <Bar dataKey="mixedCount" stackId="verdict" fill="#f59e0b" />
                <Bar dataKey="weakCount" stackId="verdict" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EventsTab
// ---------------------------------------------------------------------------

function EventsTab({ range }: { range: TimeRange }) {
  const [loading, setLoading] = useState(true)
  const [taskSuccess, setTaskSuccess] = useState<TaskSuccess[]>([])
  const [toolStats, setToolStats] = useState<ToolStat[]>([])
  const [avgDuration, setAvgDuration] = useState<AvgDuration[]>([])
  const [toolErrorByDay, setToolErrorByDay] = useState<ToolErrorByDay[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<{ data: TaskSuccess[] }>(`/api/metrics/task-success-rate?range=${r}`),
      apiFetch<{ data: ToolStat[] }>(`/api/metrics/tool-stats?range=${r}`),
      apiFetch<{ data: AvgDuration[] }>(`/api/metrics/avg-duration?range=${r}`),
      apiFetch<{ data: ToolErrorByDay[] }>(`/api/metrics/tool-error-by-day?range=${r}`),
    ])
      .then(([taskRes, toolRes, durRes, errRes]) => {
        setTaskSuccess(taskRes.data)
        setToolStats(toolRes.data)
        setAvgDuration(durRes.data)
        setToolErrorByDay(errRes.data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData(range)
  }, [range, fetchData])

  // Pivoted tool errors for stacked bar chart
  const { data: toolErrorData, keys: errorTools } = pivotBy(
    toolErrorByDay,
    'period',
    'tool',
    'errors',
  )

  // Sort tool stats descending by count for horizontal bar chart
  const sortedToolStats = [...toolStats].sort((a, b) => b.count - a.count)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 1. Task Completion Rate */}
      <ChartCard title="Task Completion Rate" delay={0}>
        <div className="h-[240px]">
          {loading || taskSuccess.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={taskSuccess}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  domain={[0, 1]}
                />
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => pctFormatter(value)} />
                <Line
                  type="monotone"
                  dataKey="successRate"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  name="Success Rate"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 2. Tool Call Distribution — horizontal BarChart */}
      <ChartCard title="Tool Call Distribution" delay={60}>
        <div className="h-[240px]">
          {loading || sortedToolStats.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sortedToolStats} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => formatNumber(v)}
                />
                <YAxis
                  type="category"
                  dataKey="tool"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  width={80}
                />
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => formatNumber(value)} />
                <Bar dataKey="count" fill="#22d3ee" radius={[0, 4, 4, 0]} name="Calls" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 3. Avg Execution Time — LineChart in seconds */}
      <ChartCard title="Avg Execution Time" delay={120}>
        <div className="h-[240px]">
          {loading || avgDuration.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={avgDuration.map((d) => ({ period: d.period, avgSec: d.avgMs / 1000 }))}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => `${v.toFixed(1)}s`}
                />
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => `${value.toFixed(2)}s`} />
                <Line
                  type="monotone"
                  dataKey="avgSec"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  name="Avg Duration"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 4. Tool Error Rate — stacked BarChart by tool */}
      <ChartCard title="Tool Error Rate" delay={180}>
        <div className="h-[240px]">
          {loading || toolErrorData.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={toolErrorData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {errorTools.map((tool, i) => (
                  <Bar
                    key={tool}
                    dataKey={tool}
                    stackId="errors"
                    fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                    radius={i === errorTools.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HealthTab
// ---------------------------------------------------------------------------

function HealthTab({ range }: { range: TimeRange }) {
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [fuseEvents, setFuseEvents] = useState<LogEntry[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<HealthData>(`/api/metrics/health?range=${r}`),
      apiFetch<{ entries: LogEntry[] }>('/api/logs?type=events&limit=50'),
    ])
      .then(([healthRes, logsRes]) => {
        setHealth(healthRes)
        setFuseEvents(
          logsRes.entries.filter((e) => e.event && String(e.event).toLowerCase().includes('fuse')),
        )
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData(range)
  }, [range, fetchData])

  const repairs = health?.repairs
  const repairTrend = health?.repairTrend ?? []

  // System availability placeholder: 100% constant line using repairTrend periods
  const availabilityData =
    repairTrend.length > 0 ? repairTrend.map((d) => ({ period: d.period, availability: 1 })) : []

  return (
    <div className="space-y-4">
      {/* 1. Self-Repair Stats */}
      <ChartCard title="Self-Repair Stats" delay={0}>
        {/* Top: 3 stat cards */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <StatCard
            label="Total Repairs"
            value={loading ? '...' : formatNumber(repairs?.total ?? 0)}
          />
          <StatCard
            label="Success Count"
            value={loading ? '...' : formatNumber(repairs?.successCount ?? 0)}
            delay={30}
          />
          <StatCard
            label="Success Rate"
            value={loading ? '...' : `${((repairs?.successRate ?? 0) * 100).toFixed(1)}%`}
            delay={60}
          />
        </div>

        {/* Bottom: repair trend line chart */}
        <div className="h-[200px]">
          {loading || repairTrend.length === 0 ? (
            <ChartEmpty loading={loading} />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={repairTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <YAxis tick={{ fontSize: 10, fill: CHART_TEXT }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#64748b"
                  strokeWidth={2}
                  dot={false}
                  name="Total Repairs"
                />
                <Line
                  type="monotone"
                  dataKey="success"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  name="Successful"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 2. System Availability */}
        <ChartCard title="System Availability" delay={60}>
          <div className="h-[200px]">
            {loading || availabilityData.length === 0 ? (
              <ChartEmpty loading={loading} message="No data" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={availabilityData}>
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
                    dataKey="availability"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    name="Availability"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </ChartCard>

        {/* 3. Fuse Events */}
        <ChartCard title="Fuse Events" delay={120}>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {loading ? (
              <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
                Loading...
              </div>
            ) : fuseEvents.length === 0 ? (
              <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
                No fuse events
              </div>
            ) : (
              <table className="w-full text-[12px] font-mono">
                <thead>
                  <tr className="text-left text-[10px] text-[var(--color-text-disabled)] tracking-wide border-b border-[var(--color-border)]">
                    <th className="pb-2 pr-4">Time</th>
                    <th className="pb-2">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {fuseEvents.map((e) => (
                    <tr
                      key={`${e.ts}-${String(e.event ?? '')}`}
                      className="border-b border-[var(--color-border)] last:border-0 hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="py-1.5 pr-4 text-[var(--color-text-muted)] whitespace-nowrap">
                        {e.ts
                          ? new Date(e.ts).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '-'}
                      </td>
                      <td className="py-1.5 text-[var(--color-text-secondary)]">
                        {String(e.event ?? '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </ChartCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MetricsPage
// ---------------------------------------------------------------------------

export function MetricsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('cost')
  const [range, setRange] = useState<TimeRange>('30d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  // For custom range, compute a matching preset-style range to pass to tabs
  // (Tabs already accept range as a string for API calls)
  const effectiveRange = range === 'custom' ? 'custom' : range

  return (
    <div className="min-h-screen bg-[#0a0f14] text-[#e6edf3]">
      <div className="mx-auto max-w-[1440px] p-6">
        <h1 className="mb-4 text-[20px] font-bold tracking-tight text-[#f8fafc]">Metrics</h1>

        {/* Tab bar + time range selector */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Tabs */}
          <div className="flex flex-wrap gap-1.5">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-md px-4 py-1.5 text-[13px] transition-colors ${
                  activeTab === tab.key
                    ? 'bg-cyan-400/10 text-cyan-200'
                    : 'text-[#93a4b8] hover:text-[#d7e0ea]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Time range */}
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
                  range === r
                    ? 'bg-cyan-400/10 text-cyan-200'
                    : 'text-[#93a4b8] hover:text-[#d7e0ea]'
                }`}
              >
                {r === 'custom' ? 'Custom' : r}
              </button>
            ))}
          </div>
        </div>

        {/* Custom time range picker */}
        {range === 'custom' && (
          <div className="animate-fade-up mb-4 flex items-center gap-3 rounded-lg border border-[#253244] bg-[#111820]/95 p-3">
            <span className="text-[12px] text-[#93a4b8]">From</span>
            <input
              type="date"
              className="input-field text-[12px]"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
            />
            <span className="text-[12px] text-[#93a4b8]">To</span>
            <input
              type="date"
              className="input-field text-[12px]"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'cost' && <CostTab range={effectiveRange} />}
        {activeTab === 'purpose' && <PurposeTab range={effectiveRange} />}
        {activeTab === 'attribution' && <AttributionTab range={effectiveRange} />}
        {activeTab === 'evaluations' && <EvaluationTab range={effectiveRange} />}
        {activeTab === 'events' && <EventsTab range={effectiveRange} />}
        {activeTab === 'health' && <HealthTab range={effectiveRange} />}
      </div>
    </div>
  )
}
