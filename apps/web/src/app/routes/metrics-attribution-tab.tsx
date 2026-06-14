import { useCallback, useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
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
  ChartCard,
  ChartEmpty,
  type CostByChannel,
  type CostBySource,
  type SessionUsageByPurpose,
  TOOLTIP_STYLE,
  type TimeRange,
} from './metrics-shared'

export function AttributionTab({ range }: { range: TimeRange }) {
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
