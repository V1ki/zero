import { ArrowLeft, Database, MagnifyingGlass, Warning } from '@phosphor-icons/react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch } from '../lib/api'
import { formatTimeAgo } from '../lib/format'

type RunLogLevel = 'debug' | 'info' | 'warn' | 'error'
type TimeOrder = 'asc' | 'desc'

interface RunLogEntry {
  ts: string
  level: RunLogLevel
  event: string
  sessionId: string
  spanId?: string
  parentSpanId?: string
  name?: string
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface RunLogResponse {
  sessionId: string
  entries: RunLogEntry[]
  total: number
  matched: number
  limit: number
  order?: TimeOrder
}

const levelClasses: Record<RunLogLevel, string> = {
  debug: 'text-slate-400 bg-slate-400/8',
  info: 'text-cyan-300 bg-cyan-400/8',
  warn: 'text-amber-300 bg-amber-400/10',
  error: 'text-red-300 bg-red-400/10',
}

const limitOptions = [200, 500, 1000, 2000, 5000]

export function SessionRunLogPage() {
  const { id } = useParams({ from: '/logs/session/$id' })
  const navigate = useNavigate()
  const runLog = useSessionRunLogState(id)

  return (
    <div className="px-5 py-4 max-w-[1680px] mx-auto">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate({ to: '/logs' })}
            className="mb-3 inline-flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-accent)]"
          >
            <ArrowLeft size={14} weight="bold" />
            Logs
          </button>
          <div className="flex items-center gap-3">
            <Database size={20} className="text-[var(--color-accent)]" />
            <div className="min-w-0">
              <h1 className="truncate text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
                {id}
              </h1>
              <p className="mt-1 text-[11px] text-[var(--color-text-disabled)]">
                run.log · {runLog.firstTs ? new Date(runLog.firstTs).toLocaleString() : '-'} to{' '}
                {runLog.lastTs ? new Date(runLog.lastTs).toLocaleString() : '-'}
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={runLog.fetchRunLog}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-accent)]"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        <Metric label="Loaded" value={runLog.entries.length.toLocaleString()} />
        <Metric label="Visible" value={runLog.filtered.length.toLocaleString()} />
        <Metric
          label="Errors"
          value={(runLog.levelCounts.error ?? 0).toLocaleString()}
          tone="error"
        />
        <Metric
          label="Raw LLM"
          value={`${countEvent(runLog.entries, 'llm_request.raw_request')}/${countEvent(
            runLog.entries,
            'llm_request.raw_response',
          )}`}
        />
        <Metric
          label="Tool Logs"
          value={countPrefix(runLog.entries, 'tool_call.').toLocaleString()}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 border-y border-[var(--color-border)] py-3">
        <div className="relative min-w-[260px] flex-1">
          <MagnifyingGlass
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
          />
          <input
            value={runLog.query}
            onChange={(e) => runLog.setQuery(e.target.value)}
            className="input-field w-full pl-9 text-[12px]"
            placeholder="Search raw JSON, event, model, tool, path..."
          />
        </div>
        <select
          value={runLog.level}
          onChange={(e) => runLog.setLevel(e.target.value as RunLogLevel | 'all')}
          className="input-field w-[120px] text-[12px]"
        >
          <option value="all">all levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <select
          value={runLog.event}
          onChange={(e) => runLog.setEvent(e.target.value)}
          className="input-field w-[220px] text-[12px]"
        >
          <option value="all">all events</option>
          {runLog.topEvents.map(([eventName]) => (
            <option key={eventName} value={eventName}>
              {eventName}
            </option>
          ))}
        </select>
        <select
          value={runLog.timeOrder}
          onChange={(e) => {
            runLog.setTimeOrder(e.target.value as TimeOrder)
            runLog.setSelectedKey(null)
          }}
          className="input-field w-[130px] text-[12px]"
        >
          <option value="asc">oldest first</option>
          <option value="desc">newest first</option>
        </select>
        <select
          value={runLog.limit}
          onChange={(e) => runLog.setLimit(Number(e.target.value))}
          className="input-field w-[110px] text-[12px]"
        >
          {limitOptions.map((option) => (
            <option key={option} value={option}>
              {option} rows
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <main className="min-w-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[#0d1319]/80">
          <div className="grid grid-cols-[140px_60px_240px_minmax(260px,1fr)_70px] gap-3 border-b border-[var(--color-border)] px-3 py-2 text-[10px] font-semibold tracking-wide text-[var(--color-text-disabled)]">
            <span>Time</span>
            <span>Level</span>
            <span>Event</span>
            <span>Raw Preview</span>
            <span>Duration</span>
          </div>

          {runLog.loading ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 12 }, (_, index) => `run-log-${index}`).map((key) => (
                <Skeleton key={key} className="h-7 w-full" />
              ))}
            </div>
          ) : runLog.filtered.length === 0 ? (
            <div className="flex min-h-[360px] items-center justify-center text-[12px] text-[var(--color-text-muted)]">
              No matching run.log entries
            </div>
          ) : (
            <div className="max-h-[calc(100vh-330px)] overflow-auto">
              {runLog.filtered.map((entry) => {
                const key = getEntryKey(entry)
                const selected = runLog.selectedEntry && getEntryKey(runLog.selectedEntry) === key
                const rawPreview = formatRawPreview(entry)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => runLog.setSelectedKey(key)}
                    className={`grid w-full grid-cols-[140px_60px_240px_minmax(260px,1fr)_70px] gap-3 border-b border-[var(--color-border)] px-3 py-1.5 text-left font-mono text-[11px] transition-colors last:border-0 ${
                      selected
                        ? 'bg-cyan-400/[0.075] shadow-[inset_2px_0_0_var(--color-accent)]'
                        : entry.level === 'error'
                          ? 'bg-red-400/[0.045] hover:bg-red-400/[0.07]'
                          : 'hover:bg-white/[0.035]'
                    }`}
                  >
                    <span className="truncate text-[var(--color-text-disabled)]">
                      {new Date(entry.ts).toLocaleTimeString()}
                      <span className="ml-2 text-[10px]">{formatTimeAgo(entry.ts)}</span>
                    </span>
                    <LevelBadge level={entry.level} />
                    <span className="truncate text-[var(--color-accent)]">{entry.event}</span>
                    <span
                      className="truncate text-[var(--color-text-secondary)]"
                      title={rawPreview}
                    >
                      {rawPreview}
                    </span>
                    <span className="text-right text-[var(--color-text-muted)]">
                      {formatDuration(readNumber(entry.data, 'durationMs'))}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </main>

        <aside className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[#0d1319]/80">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <span className="text-[11px] font-semibold tracking-wide text-[var(--color-text-disabled)]">
              INSPECTOR
            </span>
            {runLog.selectedEntry?.level === 'error' && (
              <span className="inline-flex items-center gap-1 text-[11px] text-red-300">
                <Warning size={13} weight="fill" />
                error
              </span>
            )}
          </div>
          {runLog.selectedEntry ? (
            <div className="max-h-[calc(100vh-330px)] overflow-auto p-3">
              <div className="mb-3 space-y-1 text-[11px]">
                <InspectorRow label="event" value={runLog.selectedEntry.event} />
                <InspectorRow
                  label="time"
                  value={new Date(runLog.selectedEntry.ts).toLocaleString()}
                />
                <InspectorRow label="span" value={runLog.selectedEntry.spanId ?? '-'} />
                <InspectorRow
                  label="agent"
                  value={runLog.selectedEntry.agentName ?? runLog.selectedEntry.name ?? '-'}
                />
              </div>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-black/25 p-3 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                {JSON.stringify(runLog.selectedEntry, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="p-5 text-[12px] text-[var(--color-text-muted)]">
              Select a row to inspect the full JSON payload.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'error'
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[#0d1319]/75 px-3 py-2">
      <p className="text-[10px] font-semibold tracking-wide text-[var(--color-text-disabled)]">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-[18px] ${tone === 'error' ? 'text-red-300' : 'text-[var(--color-text-primary)]'}`}
      >
        {value}
      </p>
    </div>
  )
}

function LevelBadge({ level }: { level: RunLogLevel }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] ${levelClasses[level]}`}
    >
      {level}
    </span>
  )
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-2">
      <span className="text-[var(--color-text-disabled)]">{label}</span>
      <span className="truncate font-mono text-[var(--color-text-secondary)]">{value}</span>
    </div>
  )
}

function useSessionRunLogState(id: string) {
  const [entries, setEntries] = useState<RunLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<RunLogLevel | 'all'>('all')
  const [event, setEvent] = useState('all')
  const [timeOrder, setTimeOrder] = useState<TimeOrder>('asc')
  const [limit, setLimit] = useState(200)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const fetchRunLog = useCallback(() => {
    setLoading(true)
    apiFetch<RunLogResponse>(`/api/logs/sessions/${id}/run?limit=${limit}&order=${timeOrder}`)
      .then((res) => {
        setEntries(res.entries)
        setSelectedKey(
          (current) =>
            current ?? getEntryKey(timeOrder === 'desc' ? res.entries[0] : res.entries.at(-1)),
        )
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [id, limit, timeOrder])

  useEffect(() => {
    fetchRunLog()
  }, [fetchRunLog])

  const levelCounts = useMemo(() => {
    const counts: Partial<Record<RunLogLevel, number>> = {}
    for (const entry of entries) {
      counts[entry.level] = (counts[entry.level] ?? 0) + 1
    }
    return counts
  }, [entries])

  const topEvents = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1)
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)
  }, [entries])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false
      if (event !== 'all' && entry.event !== event) return false
      if (!needle) return true
      return JSON.stringify(entry).toLowerCase().includes(needle)
    })
  }, [entries, event, level, query])

  const selectedEntry =
    filtered.find((entry) => getEntryKey(entry) === selectedKey) ?? filtered.at(-1) ?? null

  return {
    entries,
    loading,
    query,
    setQuery,
    level,
    setLevel,
    event,
    setEvent,
    timeOrder,
    setTimeOrder,
    limit,
    setLimit,
    selectedKey,
    setSelectedKey,
    fetchRunLog,
    levelCounts,
    topEvents,
    filtered,
    selectedEntry,
    firstTs: entries[0]?.ts,
    lastTs: entries.at(-1)?.ts,
  }
}

function getEntryKey(entry: RunLogEntry | undefined): string | null {
  if (!entry) return null
  return [entry.ts, entry.event, entry.spanId ?? '', entry.name ?? ''].join(':')
}

function countEvent(entries: RunLogEntry[], event: string): number {
  return entries.filter((entry) => entry.event === event).length
}

function countPrefix(entries: RunLogEntry[], prefix: string): number {
  return entries.filter((entry) => entry.event.startsWith(prefix)).length
}

function readNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key]
  return typeof value === 'number' ? value : undefined
}

function formatRawPreview(entry: RunLogEntry): string {
  const payload =
    entry.data !== undefined || entry.metadata !== undefined
      ? {
          ...(entry.data !== undefined ? { data: entry.data } : {}),
          ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        }
      : entry

  return compactJson(payload, 1600)
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function compactJson(value: unknown, maxLength: number): string {
  if (value === undefined) return '-'
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized
  } catch {
    return String(value)
  }
}
