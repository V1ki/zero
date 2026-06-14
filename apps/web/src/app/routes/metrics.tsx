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
import { AttributionTab } from './metrics-attribution-tab'
import { CostTab } from './metrics-cost-tab'
import {
  type AvgDuration,
  CHART_GRID,
  CHART_TEXT,
  ChartCard,
  ChartEmpty,
  type EvaluationDimensionAverage,
  type EvaluationTrend,
  type HealthData,
  type LogEntry,
  METRICS_RANGES,
  METRICS_TABS,
  MODEL_COLORS,
  StatCard,
  TOOLTIP_STYLE,
  type MetricsTab,
  type TaskSuccess,
  type TimeRange,
  type ToolErrorByDay,
  type ToolStat,
  type TopFinding,
  type UsageSummary,
  pctFormatter,
  pctTickFormatter,
  pivotBy,
} from './metrics-shared'

export function MetricsPage() {
  const [activeTab, setActiveTab] = useState<MetricsTab>('cost')
  const [range, setRange] = useState<TimeRange>('30d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const effectiveRange = range === 'custom' ? 'custom' : range

  return (
    <div className="min-h-screen bg-[#0a0f14] text-[#e6edf3]">
      <div className="mx-auto max-w-[1440px] p-6">
        <h1 className="mb-4 text-[20px] font-bold tracking-tight text-[#f8fafc]">Metrics</h1>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {METRICS_TABS.map((tab) => (
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

          <div className="flex gap-1">
            {METRICS_RANGES.map((r) => (
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

  const { data: toolErrorData, keys: errorTools } = pivotBy(
    toolErrorByDay,
    'period',
    'tool',
    'errors',
  )
  const sortedToolStats = [...toolStats].sort((a, b) => b.count - a.count)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
  const availabilityData =
    repairTrend.length > 0 ? repairTrend.map((d) => ({ period: d.period, availability: 1 })) : []

  return (
    <div className="space-y-4">
      <ChartCard title="Self-Repair Stats" delay={0}>
        <div className="mb-4 grid grid-cols-3 gap-3">
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <ChartCard title="Fuse Events" delay={120}>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {loading ? (
              <div className="py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                Loading...
              </div>
            ) : fuseEvents.length === 0 ? (
              <div className="py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                No fuse events
              </div>
            ) : (
              <table className="w-full font-mono text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[10px] tracking-wide text-[var(--color-text-disabled)]">
                    <th className="pb-2 pr-4">Time</th>
                    <th className="pb-2">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {fuseEvents.map((e) => (
                    <tr
                      key={`${e.ts}-${String(e.event ?? '')}`}
                      className="border-b border-[var(--color-border)] transition-colors last:border-0 hover:bg-white/[0.03]"
                    >
                      <td className="whitespace-nowrap py-1.5 pr-4 text-[var(--color-text-muted)]">
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
