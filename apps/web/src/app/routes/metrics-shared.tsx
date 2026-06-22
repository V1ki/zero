import type { ReactNode } from 'react'
import { formatCost } from '../lib/format'

export type MetricsTab = 'cost' | 'purpose' | 'attribution' | 'evaluations' | 'events' | 'health'
export type PresetTimeRange = '7d' | '30d' | '90d' | 'custom'
export type TimeRange =
  | PresetTimeRange
  | `${number}d`
  | `${number}h`
  | `${number}m`
  | `${string}..${string}`

export interface CostByDayModel {
  period: string
  model: string
  cost: number
}
export interface CostDetail {
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
export interface CacheHitRate {
  period: string
  hitRate: number
}
export interface ToolStat {
  tool: string
  count: number
  successRate: number
  avgDurationMs: number
}
export interface TaskSuccess {
  period: string
  successRate: number
  total: number
}
export interface AvgDuration {
  period: string
  avgMs: number
}
export interface ToolErrorByDay {
  period: string
  tool: string
  total: number
  errors: number
}
export interface HealthData {
  repairs: { total: number; successCount: number; successRate: number }
  repairTrend: { period: string; total: number; success: number }[]
}
export interface UsageSummary {
  purpose: string
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  eventCount: number
}
export interface CostByChannel {
  source: string
  channelName: string
  totalCost: number
  sessionCount: number
  requestCount: number
}
export interface CostBySource {
  source: string
  totalCost: number
  sessionCount: number
}
export interface SessionUsageByPurpose {
  purpose: string
  totalCost: number
  totalTokens: number
  reasoningTokens: number
  requestCount: number
}
export interface EvaluationTrend {
  period: string
  avgScore: number
  evalCount: number
  strongCount: number
  mixedCount: number
  weakCount: number
}
export interface EvaluationDimensionAverage {
  dimensionKey: string
  avgScore: number
  count: number
}
export interface TopFinding {
  title: string
  severity: string
  count: number
}
export interface LogEntry {
  ts: string
  event?: string
  [key: string]: unknown
}

export const MODEL_COLORS = [
  '#22d3ee',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb7185',
  '#94a3b8',
]
export const CHART_GRID = 'rgba(148, 163, 184, 0.14)'
export const CHART_TEXT = '#93a4b8'
export const TOOLTIP_STYLE = {
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

export const METRICS_TABS: { key: MetricsTab; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'evaluations', label: 'Evaluations' },
  { key: 'events', label: 'Events' },
  { key: 'health', label: 'Health' },
]

export const METRICS_RANGES: PresetTimeRange[] = ['7d', '30d', '90d', 'custom']

export function ChartCard({
  title,
  delay = 0,
  className = '',
  children,
}: { title: string; delay?: number; className?: string; children: ReactNode }) {
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

export function ChartEmpty({
  loading,
  message = 'No data',
}: {
  loading: boolean
  message?: string
}) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-[#93a4b8]">
      {loading ? 'Loading...' : message}
    </div>
  )
}

export function StatCard({
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

export function pctFormatter(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

export function pctTickFormatter(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

export function signedCostFormatter(v: number): string {
  const abs = formatCost(Math.abs(v))
  if (v > 0) return `+$${abs}`
  if (v < 0) return `-$${abs}`
  return `$${abs}`
}

export function formatCurrency(v: number): string {
  return `$${formatCost(v)}`
}

export function formatExactNumber(v: number): string {
  return Math.round(v).toLocaleString()
}

export function totalTokensForDetail(row: CostDetail): number {
  return row.input + row.output + row.cacheWrite + row.cacheRead + row.reasoningTokens
}

export function pivotBy<T extends object>(
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
