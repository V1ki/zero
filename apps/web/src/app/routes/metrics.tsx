import { useCallback, useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
  effectiveInput: number
  hitRate: number
  cacheReadCost: number
  cacheWriteCost: number
  grossAvoidedInputCost: number
  netSavings: number
  cost: number
}
interface CacheByModel {
  provider: string
  model: string
  requestCount: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
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
  '#06b6d4',
  '#0891b2',
  '#0e7490',
  '#155e75',
  '#164e63',
  '#083344',
  '#67e8f9',
]
const CHART_GRID = 'rgba(255, 255, 255, 0.05)'
const CHART_TEXT = 'rgba(255, 255, 255, 0.4)'
const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#1a1a2e',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: 'rgba(255,255,255,0.6)' },
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
  children,
}: { title: string; delay?: number; children: React.ReactNode }) {
  return (
    <div className="card p-5 animate-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">{title}</h3>
      {children}
    </div>
  )
}

function ChartEmpty({ loading, message = 'No data' }: { loading: boolean; message?: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--color-text-muted)] text-[13px]">
      {loading ? 'Loading...' : message}
    </div>
  )
}

function StatCard({
  label,
  value,
  delay = 0,
}: { label: string; value: string | number; delay?: number }) {
  return (
    <div className="card p-4 animate-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-1">{label}</p>
      <p className="text-[28px] font-bold tracking-tight">{value}</p>
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
  const [cacheByModel, setCacheByModel] = useState<CacheByModel[]>([])
  const [costDetail, setCostDetail] = useState<CostDetail[]>([])
  const [cacheHitRate, setCacheHitRate] = useState<CacheHitRate[]>([])

  const fetchData = useCallback((r: TimeRange) => {
    setLoading(true)
    Promise.all([
      apiFetch<{ data: CostByDayModel[] }>(`/api/metrics/cost-by-day-model?range=${r}`),
      apiFetch<{ data: CacheByModel[] }>(`/api/metrics/cache-by-model?range=${r}`),
      apiFetch<{ data: CostDetail[] }>(`/api/metrics/cost-detail?range=${r}`),
      apiFetch<{ data: CacheHitRate[] }>(`/api/metrics/cache-hit-rate?range=${r}`),
    ])
      .then(([dayModelRes, cacheByModelRes, detailRes, cacheRes]) => {
        setCostByDayModel(dayModelRes.data)
        setCacheByModel(cacheByModelRes.data)
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

  // Token usage: group cost-detail by date for stacked input/output bars
  const tokenUsageMap = new Map<string, { period: string; input: number; output: number }>()
  for (const d of costDetail) {
    const existing = tokenUsageMap.get(d.date)
    if (existing) {
      existing.input += d.input
      existing.output += d.output
    } else {
      tokenUsageMap.set(d.date, { period: d.date, input: d.input, output: d.output })
    }
  }
  const tokenUsageData = Array.from(tokenUsageMap.values())

  const cacheSummary = cacheByModel.reduce(
    (acc, row) => {
      acc.cacheRead += row.cacheRead
      acc.cacheWrite += row.cacheWrite
      acc.effectiveInput += row.effectiveInput
      acc.netSavings += row.netSavings
      return acc
    },
    { cacheRead: 0, cacheWrite: 0, effectiveInput: 0, netSavings: 0 },
  )
  const cacheSummaryHitRate =
    cacheSummary.effectiveInput > 0 ? cacheSummary.cacheRead / cacheSummary.effectiveInput : 0
  const cacheSavingsData = [...cacheByModel]
    .sort((left, right) => right.netSavings - left.netSavings)
    .slice(0, 8)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-5 gap-4">
        <StatCard
          label="Cache Read"
          value={loading ? '...' : formatNumber(cacheSummary.cacheRead)}
          delay={0}
        />
        <StatCard
          label="Cache Write"
          value={loading ? '...' : formatNumber(cacheSummary.cacheWrite)}
          delay={40}
        />
        <StatCard
          label="Effective Input"
          value={loading ? '...' : formatNumber(cacheSummary.effectiveInput)}
          delay={80}
        />
        <StatCard
          label="Hit Rate"
          value={loading ? '...' : pctFormatter(cacheSummaryHitRate)}
          delay={120}
        />
        <StatCard
          label="Net Savings"
          value={loading ? '...' : signedCostFormatter(cacheSummary.netSavings)}
          delay={160}
        />
      </div>

      {/* 1. Cost Trend — stacked BarChart by model */}
      <ChartCard title="Cost Trend" delay={0}>
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
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => `$${formatCost(value)}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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

      {/* 2. Token Usage — stacked BarChart input/output */}
      <ChartCard title="Token Usage" delay={60}>
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
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => formatNumber(value)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 3. Cache Savings by Model */}
      <ChartCard title="Cache Savings by Model" delay={120}>
        <div className="h-[240px]">
          {loading || cacheSavingsData.length === 0 ? (
            <ChartEmpty loading={loading} message="No cache savings data" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cacheSavingsData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                  tickFormatter={(v: number) => signedCostFormatter(v)}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  width={120}
                  tick={{ fontSize: 10, fill: CHART_TEXT }}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value: number) => signedCostFormatter(value)}
                />
                <Bar dataKey="netSavings" radius={[0, 4, 4, 0]}>
                  {cacheSavingsData.map((row, index) => (
                    <Cell
                      key={`${row.provider}-${row.model}`}
                      fill={MODEL_COLORS[index % MODEL_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 4. Cache Hit Rate — LineChart */}
      <ChartCard title="Cache Hit Rate" delay={180}>
        <div className="h-[240px]">
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
      </ChartCard>

      {/* 5. Cache By Provider / Model */}
      <div className="lg:col-span-2">
        <ChartCard title="Cache By Provider / Model" delay={220}>
          {loading ? (
            <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
              Loading...
            </div>
          ) : cacheByModel.length === 0 ? (
            <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
              No cache data
            </div>
          ) : (
            <div className="overflow-x-auto" style={{ maxHeight: 280 }}>
              <table className="w-full text-[12px] font-mono">
                <thead>
                  <tr className="text-left text-[10px] text-[var(--color-text-disabled)] tracking-wide border-b border-[var(--color-border)]">
                    <th className="pb-2 pr-4">Provider</th>
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4 text-right">Requests</th>
                    <th className="pb-2 pr-4 text-right">Cache Read</th>
                    <th className="pb-2 pr-4 text-right">Cache Write</th>
                    <th className="pb-2 pr-4 text-right">Eff Input</th>
                    <th className="pb-2 pr-4 text-right">Hit Rate</th>
                    <th className="pb-2 text-right">Net Savings</th>
                  </tr>
                </thead>
                <tbody>
                  {cacheByModel.map((row) => (
                    <tr
                      key={`${row.provider}-${row.model}`}
                      className="border-b border-[var(--color-border)] last:border-0 hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="py-1.5 pr-4 text-[var(--color-text-muted)]">{row.provider}</td>
                      <td className="py-1.5 pr-4 text-[var(--color-accent)]">{row.model}</td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(row.requestCount)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(row.cacheRead)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(row.cacheWrite)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(row.effectiveInput)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-muted)]">
                        {pctFormatter(row.hitRate)}
                      </td>
                      <td className="py-1.5 text-right">{signedCostFormatter(row.netSavings)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </div>

      {/* 6. Detail Records — HTML table */}
      <div className="lg:col-span-2">
        <ChartCard title="Detail Records" delay={260}>
          {loading ? (
            <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
              Loading...
            </div>
          ) : costDetail.length === 0 ? (
            <div className="text-center text-[13px] text-[var(--color-text-muted)] py-6">
              No detail records
            </div>
          ) : (
            <div className="overflow-x-auto" style={{ maxHeight: 320 }}>
              <table className="w-full text-[12px] font-mono">
                <thead>
                  <tr className="text-left text-[10px] text-[var(--color-text-disabled)] tracking-wide border-b border-[var(--color-border)]">
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2 pr-4">Provider</th>
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4 text-right">Requests</th>
                    <th className="pb-2 pr-4 text-right">Input Tokens</th>
                    <th className="pb-2 pr-4 text-right">Output Tokens</th>
                    <th className="pb-2 pr-4 text-right">Cache Write</th>
                    <th className="pb-2 pr-4 text-right">Cache Read</th>
                    <th className="pb-2 pr-4 text-right">Eff Input</th>
                    <th className="pb-2 pr-4 text-right">Hit Rate</th>
                    <th className="pb-2 pr-4 text-right">Read Cost</th>
                    <th className="pb-2 pr-4 text-right">Write Cost</th>
                    <th className="pb-2 pr-4 text-right">Avoided</th>
                    <th className="pb-2 pr-4 text-right">Net</th>
                    <th className="pb-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {costDetail.map((d) => (
                    <tr
                      key={`${d.date}-${d.provider}-${d.model}-${d.input}-${d.output}-${d.cacheRead}-${d.cost}`}
                      className="border-b border-[var(--color-border)] last:border-0 hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="py-1.5 pr-4 text-[var(--color-text-muted)]">{d.date}</td>
                      <td className="py-1.5 pr-4 text-[var(--color-text-muted)]">{d.provider}</td>
                      <td className="py-1.5 pr-4 text-[var(--color-accent)]">{d.model}</td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(d.requestCount)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(d.input)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-secondary)]">
                        {formatNumber(d.output)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-muted)]">
                        {formatNumber(d.cacheWrite)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-muted)]">
                        {formatNumber(d.cacheRead)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-muted)]">
                        {formatNumber(d.effectiveInput)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-text-muted)]">
                        {pctFormatter(d.hitRate)}
                      </td>
                      <td className="py-1.5 pr-4 text-right">${formatCost(d.cacheReadCost)}</td>
                      <td className="py-1.5 pr-4 text-right">${formatCost(d.cacheWriteCost)}</td>
                      <td className="py-1.5 pr-4 text-right">
                        ${formatCost(d.grossAvoidedInputCost)}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {signedCostFormatter(d.netSavings)}
                      </td>
                      <td className="py-1.5 text-right">${formatCost(d.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </div>
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
        <StatCard
          label="Tracked Purposes"
          value={loading ? '...' : usage.length}
          delay={0}
        />
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
                  <tr key={row.purpose} className="border-b border-[var(--color-border)] last:border-0">
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
    channels.find((row) => `${row.source}::${row.channelName}` === selectedChannelKey) ?? channels[0]

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
                      className={`cursor-pointer border-b border-[var(--color-border)] last:border-0 ${
                        active ? 'bg-white/[0.04]' : ''
                      }`}
                      onClick={() => setSelectedChannelKey(key)}
                    >
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-secondary)]">
                        {row.channelName}
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
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => `$${formatCost(value)}`} />
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
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => `$${formatCost(value)}`} />
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
                <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => `$${formatCost(value)}`} />
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
        <StatCard
          label="Frequent Findings"
          value={loading ? '...' : findings.length}
          delay={80}
        />
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
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Metrics</h1>

      {/* Tab bar + time range selector */}
      <div className="flex items-center justify-between mb-4">
        {/* Tabs */}
        <div className="flex gap-1.5">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-1.5 rounded-md text-[13px] transition-colors ${
                activeTab === tab.key
                  ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
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
              className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
                range === r
                  ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {r === 'custom' ? 'Custom' : r}
            </button>
          ))}
        </div>
      </div>

      {/* Custom time range picker */}
      {range === 'custom' && (
        <div className="card p-3 mb-4 flex items-center gap-3 animate-fade-up">
          <span className="text-[12px] text-[var(--color-text-muted)]">From</span>
          <input
            type="date"
            className="input-field text-[12px]"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
          />
          <span className="text-[12px] text-[var(--color-text-muted)]">To</span>
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
  )
}
