import { ArrowDown, CaretRight, MagnifyingGlass, Pause, Play } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Skeleton } from '../components/shared/Skeleton'
import { useWebSocket } from '../useWebSocket'
import { apiFetch } from '../lib/api'
import { formatTimeAgo } from '../lib/format'

// --- Main Page ---

export function LogsPage() {
  const {
    loading,
    levels,
    logType,
    timeRange,
    customStart,
    customEnd,
    filterText,
    expandedRowKey,
    isLive,
    traceData,
    userScrolledUp,
    filteredEntries,
    filterRef,
    scrollRef,
    setTimeRange,
    setCustomStart,
    setCustomEnd,
    setFilterText,
    setExpandedRowKey,
    setIsLive,
    toggleLevel,
    selectLogType,
    jumpToLatest,
  } = useLogsPageState()
  const navigate = useNavigate()

  const config = getColumnConfig(logType)

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Logs</h1>

      {/* Filter bar */}
      <div className="card p-4 mb-4 animate-fade-up">
        {/* Row 1: Log type tabs */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex gap-1.5">
            {LOG_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => selectLogType(t)}
                className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
                  logType === t
                    ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {logType !== 'session' && (
            <button
              type="button"
              onClick={() => setIsLive(!isLive)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] transition-colors ${
                isLive
                  ? 'bg-cyan-400/10 text-cyan-400'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {isLive ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
              Live
              {isLive && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            </button>
          )}
        </div>

        {/* Row 2: Level checkboxes + Time range + Search */}
        <div className="flex items-center gap-3">
          {/* Level toggles */}
          {logType !== 'trace' && logType !== 'session' && (
            <div className="flex gap-1.5">
              {(['info', 'warn', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => toggleLevel(lvl)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors ${
                    levels.has(lvl)
                      ? 'bg-white/[0.06] text-[var(--color-text-secondary)]'
                      : 'text-[var(--color-text-disabled)]'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${levels.has(lvl) ? levelDotColors[lvl] : 'bg-slate-600'}`}
                  />
                  {lvl}
                </button>
              ))}
            </div>
          )}

          {/* Time range */}
          {logType !== 'session' && (
            <select
              className="input-field w-[140px] text-[12px]"
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
            >
              {TIME_RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}

          {/* Search */}
          <div className="relative flex-1">
            <MagnifyingGlass
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
            />
            <input
              ref={filterRef}
              type="text"
              placeholder={
                logType === 'session' ? 'Filter sessions with run.log...' : 'Filter logs... (⌘F)'
              }
              className="input-field pl-9 w-full text-[12px]"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Custom time range inputs */}
      {timeRange === 'custom' && logType !== 'session' && (
        <div className="card p-3 mb-4 flex items-center gap-3 animate-fade-up">
          <span className="text-[12px] text-[var(--color-text-muted)]">From</span>
          <input
            type="datetime-local"
            className="input-field text-[12px]"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
          />
          <span className="text-[12px] text-[var(--color-text-muted)]">To</span>
          <input
            type="datetime-local"
            className="input-field text-[12px]"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
          />
        </div>
      )}

      {/* Log table */}
      <div className="card animate-fade-up relative" style={{ animationDelay: '60ms' }}>
        {/* Jump to latest FAB */}
        {userScrolledUp && !loading && filteredEntries.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-accent)] text-[var(--color-deep-bg)] text-[12px] font-medium shadow-lg hover:bg-[var(--color-accent-hover)] transition-colors animate-fade-up"
          >
            <ArrowDown size={14} weight="bold" />
            Jump to latest
          </button>
        )}
        {/* Header */}
        <div className="p-3 border-b border-[var(--color-border)]">
          <div
            className={`grid ${config.cols} gap-3 text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide`}
          >
            {config.headers.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <div className="p-3 space-y-0.5">
            {Array.from({ length: 8 }, (_, index) => `log-loading-${index}`).map((key) => (
              <div key={key} className="flex items-center gap-3 h-8">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 w-10" />
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 flex-1" />
              </div>
            ))}
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="p-8 text-center text-[12px] text-[var(--color-text-muted)]">
            No log entries
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 340px)' }}
          >
            {filteredEntries.map((entry) => {
              const rowKey = getLogEntryKey(entry)
              const rowBgClass = levelRowBg[entry.level ?? ''] ?? ''
              return (
                <div key={rowKey}>
                  <div
                    onClick={() => {
                      if (logType === 'session' && entry.sessionId) {
                        navigate({ to: '/logs/session/$id', params: { id: entry.sessionId } })
                        return
                      }
                      setExpandedRowKey(expandedRowKey === rowKey ? null : rowKey)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (logType === 'session' && entry.sessionId) {
                          navigate({ to: '/logs/session/$id', params: { id: entry.sessionId } })
                          return
                        }
                        setExpandedRowKey(expandedRowKey === rowKey ? null : rowKey)
                      }
                    }}
                    className={`px-3 border-b border-[var(--color-border)] last:border-0 hover:bg-white/[0.03] cursor-pointer transition-colors ${rowBgClass}`}
                    style={{ height: '32px', display: 'flex', alignItems: 'center' }}
                  >
                    <div className={`grid ${config.cols} gap-3 text-[12px] font-mono w-full`}>
                      {config.render(entry)}
                    </div>
                  </div>

                  {/* Expanded detail drawer */}
                  {expandedRowKey === rowKey &&
                    (logType === 'trace' ? (
                      <div className="px-4 py-3 bg-black/20 border-b border-[var(--color-border)]">
                        {traceData ? (
                          <WaterfallChart spans={traceData} />
                        ) : (
                          <p className="text-[11px] text-[var(--color-text-muted)]">
                            Loading trace...
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="px-4 py-3 bg-black/20 border-b border-[var(--color-border)]">
                        <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
                          {JSON.stringify(entry, null, 2)}
                        </pre>
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface LogEntry {
  ts: string
  level?: string
  sessionId?: string
  session_id?: string
  tool?: string
  event?: string
  model?: string
  tokens?: { input: number; output: number }
  cost?: number
  trigger?: string
  tools?: string[]
  messagesBefore?: number
  name?: string
  status?: string
  durationMs?: number
  childCount?: number
  input?: string
  outputSummary?: string
  entryCount?: number
  sizeBytes?: number
  firstTs?: string
  lastTs?: string
  lastEvent?: string
  lastLevel?: string
  rawRequestCount?: number
  rawResponseCount?: number
  toolCallCount?: number
  errorCount?: number
  [key: string]: unknown
}

interface TraceSpan {
  name: string
  startTime: string
  durationMs: number
  status: string
  children: TraceSpan[]
}

interface WaterfallSpan {
  name: string
  startOffset: number
  durationMs: number
  status: string
  depth: number
  startTime: string
}

interface ColumnConfig {
  cols: string
  headers: string[]
  render: (entry: LogEntry) => ReactNode[]
}

const LOG_TYPES = ['events', 'requests', 'snapshots', 'trace', 'session'] as const
type LogType = (typeof LOG_TYPES)[number]

const TIME_RANGES = [
  { label: '最近 1 小时', value: '1h' },
  { label: '最近 24 小时', value: '24h' },
  { label: '最近 7 天', value: '7d' },
  { label: '自定义', value: 'custom' },
] as const

const levelColors: Record<string, string> = {
  info: 'text-cyan-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  debug: 'text-slate-400',
}

const levelDotColors: Record<string, string> = {
  info: 'bg-cyan-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
}

const levelRowBg: Record<string, string> = {
  error: 'bg-red-400/[0.05]',
  warn: 'bg-amber-400/[0.05]',
}

const spanBarColors: Record<string, string> = {
  bash: 'bg-cyan-400',
  edit: 'bg-cyan-600',
  read: 'bg-cyan-500',
  write: 'bg-cyan-300',
  browser: 'bg-cyan-700',
}

function useLogsPageState() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [levels, setLevels] = useState<Set<string>>(new Set(['info', 'warn', 'error']))
  const [logType, setLogType] = useState<LogType>('events')
  const [timeRange, setTimeRange] = useState('1h')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [filterText, setFilterText] = useState('')
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [traceData, setTraceData] = useState<TraceSpan[] | null>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined)

  const fetchLogs = useCallback(
    (lvls: Set<string>, typ: LogType, range: string, cStart: string, cEnd: string) => {
      setLoading(true)
      if (typ === 'session') {
        apiFetch<{ sessions: LogEntry[] }>('/api/logs/sessions?limit=500')
          .then((res) => setEntries(res.sessions))
          .catch(() => {})
          .finally(() => setLoading(false))
        return
      }

      const params = new URLSearchParams({ type: typ, limit: '200' })

      if (range === 'custom') {
        if (cStart) params.set('since', new Date(cStart).toISOString())
        if (cEnd) params.set('until', new Date(cEnd).toISOString())
      } else {
        const ms = range === '1h' ? 3_600_000 : range === '24h' ? 86_400_000 : 604_800_000
        params.set('since', new Date(Date.now() - ms).toISOString())
      }

      apiFetch<{ entries: LogEntry[] }>(`/api/logs?${params}`)
        .then((res) => {
          let filtered = res.entries
          if (lvls.size < 3 && typ !== 'trace') {
            filtered = filtered.filter((entry) => !entry.level || lvls.has(entry.level))
          }
          setEntries(filtered)
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    fetchLogs(levels, logType, timeRange, customStart, customEnd)
  }, [levels, logType, timeRange, customStart, customEnd, fetchLogs])

  const onWsEvent = useCallback(
    (_topic: string, data: unknown) => {
      if (!isLive) return
      const entry = data as LogEntry
      if (!entry) return
      const logEntry: LogEntry = {
        ...entry,
        ts: entry.ts ?? new Date().toISOString(),
      }
      setEntries((prev) => [...prev, logEntry].slice(-200))

      if (!userScrolledUp && scrollRef.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
        })
      }
    },
    [isLive, userScrolledUp],
  )

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: isLive ? ['log:*', 'tool:*', 'session:*'] : [],
    onEvent: onWsEvent,
  })

  useEffect(() => {
    if (isLive) {
      pollRef.current = setInterval(() => {
        fetchLogs(levels, logType, timeRange, customStart, customEnd)
      }, 5000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [isLive, levels, logType, timeRange, customStart, customEnd, fetchLogs])

  useEffect(() => {
    const visibleEntries = filterText
      ? entries.filter((entry) =>
          JSON.stringify(entry).toLowerCase().includes(filterText.toLowerCase()),
        )
      : entries
    if (loading || visibleEntries.length === 0) return
    const el = scrollRef.current
    if (!el) return
    function handleScroll() {
      if (!el) return
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      setUserScrolledUp(!isAtBottom)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [entries, filterText, loading])

  useEffect(() => {
    if (logType !== 'trace' || expandedRowKey === null) {
      setTraceData(null)
      return
    }

    const entry = entries.find((candidate) => getLogEntryKey(candidate) === expandedRowKey)
    if (!entry) {
      setTraceData(null)
      return
    }

    const sessionId = entry.sessionId ?? entry.session_id
    if (!sessionId) {
      setTraceData(null)
      return
    }

    setTraceData(null)
    apiFetch<{ traces: TraceSpan[] }>(`/api/sessions/${sessionId}/traces`)
      .then((res) => setTraceData(res.traces))
      .catch(() => setTraceData([]))
  }, [expandedRowKey, logType, entries])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        filterRef.current?.focus()
      }
      if (e.key === 'Escape') {
        setExpandedRowKey(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  function toggleLevel(lvl: string) {
    setLevels((prev) => {
      const next = new Set(prev)
      if (next.has(lvl)) {
        if (next.size > 1) next.delete(lvl)
      } else {
        next.add(lvl)
      }
      return next
    })
  }

  function selectLogType(type: LogType) {
    setLogType(type)
    setExpandedRowKey(null)
    if (type === 'session') setIsLive(false)
  }

  function jumpToLatest() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
    setUserScrolledUp(false)
  }

  const filteredEntries = filterText
    ? entries.filter((entry) =>
        JSON.stringify(entry).toLowerCase().includes(filterText.toLowerCase()),
      )
    : entries

  return {
    loading,
    levels,
    logType,
    timeRange,
    customStart,
    customEnd,
    filterText,
    expandedRowKey,
    isLive,
    traceData,
    userScrolledUp,
    filteredEntries,
    filterRef,
    scrollRef,
    setTimeRange,
    setCustomStart,
    setCustomEnd,
    setFilterText,
    setExpandedRowKey,
    setIsLive,
    toggleLevel,
    selectLogType,
    jumpToLatest,
  }
}

function getColumnConfig(type: LogType): ColumnConfig {
  switch (type) {
    case 'events':
      return {
        cols: 'grid-cols-[90px_60px_90px_70px_1fr_1fr]',
        headers: ['Time', 'Level', 'Session', 'Source', 'Event', 'Summary'],
        render: (entry) => [
          <span key="ts" className="text-[var(--color-text-disabled)] truncate">
            {entry.ts ? formatTimeAgo(entry.ts) : '-'}
          </span>,
          <LevelBadge key="lvl" level={entry.level} />,
          <span key="sid" className="text-[var(--color-text-muted)] truncate">
            {getSid(entry)}
          </span>,
          <span key="tool" className="text-[var(--color-accent)]">
            {entry.tool ?? entry.event ?? '-'}
          </span>,
          <span key="input" className="text-[var(--color-text-secondary)] truncate">
            {entry.event ?? entry.input ?? '-'}
          </span>,
          <span key="output" className="text-[var(--color-text-muted)] truncate">
            {entry.outputSummary ?? '-'}
          </span>,
        ],
      }
    case 'requests':
      return {
        cols: 'grid-cols-[90px_60px_90px_120px_80px_80px]',
        headers: ['Time', 'Level', 'Session', 'Model', 'Tokens', 'Cost'],
        render: (entry) => [
          <span key="ts" className="text-[var(--color-text-disabled)] truncate">
            {entry.ts ? formatTimeAgo(entry.ts) : '-'}
          </span>,
          <LevelBadge key="lvl" level={entry.level} />,
          <span key="sid" className="text-[var(--color-text-muted)] truncate">
            {getSid(entry)}
          </span>,
          <span key="model" className="text-[var(--color-accent)] font-mono truncate">
            {entry.model ?? '-'}
          </span>,
          <span key="tokens" className="text-[var(--color-text-secondary)]">
            {entry.tokens ? `${entry.tokens.input}/${entry.tokens.output}` : '-'}
          </span>,
          <span key="cost" className="text-[var(--color-text-muted)]">
            {entry.cost !== undefined ? `$${entry.cost.toFixed(4)}` : '-'}
          </span>,
        ],
      }
    case 'snapshots':
      return {
        cols: 'grid-cols-[90px_60px_90px_100px_1fr_80px]',
        headers: ['Time', 'Level', 'Session', 'Trigger', 'Tools', 'MsgBefore'],
        render: (entry) => [
          <span key="ts" className="text-[var(--color-text-disabled)] truncate">
            {entry.ts ? formatTimeAgo(entry.ts) : '-'}
          </span>,
          <LevelBadge key="lvl" level={entry.level} />,
          <span key="sid" className="text-[var(--color-text-muted)] truncate">
            {getSid(entry)}
          </span>,
          <span key="trigger" className="text-[var(--color-accent)]">
            {entry.trigger ?? '-'}
          </span>,
          <span key="tools" className="text-[var(--color-text-secondary)] truncate">
            {Array.isArray(entry.tools) ? entry.tools.join(', ') : '-'}
          </span>,
          <span key="msgBefore" className="text-[var(--color-text-muted)]">
            {entry.messagesBefore ?? '-'}
          </span>,
        ],
      }
    case 'trace':
      return {
        cols: 'grid-cols-[90px_100px_1fr_90px]',
        headers: ['Time', 'Session', 'Summary', 'Duration'],
        render: (entry) => [
          <span key="ts" className="text-[var(--color-text-disabled)] truncate">
            {entry.ts ? formatTimeAgo(entry.ts) : '-'}
          </span>,
          <span key="sid" className="text-[var(--color-text-muted)] truncate">
            {getSid(entry)}
          </span>,
          <span key="name" className="text-[var(--color-text-secondary)] truncate">
            {entry.name ?? '-'} {entry.childCount ? `(${entry.childCount} spans)` : ''}
          </span>,
          <span key="dur" className="text-[var(--color-text-muted)] font-mono">
            {entry.durationMs !== undefined ? `${entry.durationMs}ms` : '-'}
          </span>,
        ],
      }
    case 'session':
      return {
        cols: 'grid-cols-[260px_80px_80px_90px_90px_1fr_22px]',
        headers: ['Session', 'Entries', 'Errors', 'LLM', 'Tools', 'Last Event', ''],
        render: (entry) => [
          <div key="sid" className="min-w-0">
            <span className="block truncate font-mono text-[var(--color-text-primary)]">
              {entry.sessionId ?? '-'}
            </span>
            <span className="block truncate text-[10px] text-[var(--color-text-disabled)]">
              {entry.lastTs
                ? `${formatTimeAgo(entry.lastTs)} · ${formatBytes(entry.sizeBytes)}`
                : '-'}
            </span>
          </div>,
          <span key="entries" className="text-[var(--color-text-secondary)]">
            {entry.entryCount ?? 0}
          </span>,
          <span
            key="errors"
            className={entry.errorCount ? 'text-red-400' : 'text-[var(--color-text-muted)]'}
          >
            {entry.errorCount ?? 0}
          </span>,
          <span key="llm" className="text-[var(--color-text-secondary)]">
            {entry.rawRequestCount ?? 0}/{entry.rawResponseCount ?? 0}
          </span>,
          <span key="tools" className="text-[var(--color-text-muted)]">
            {entry.toolCallCount ?? 0}
          </span>,
          <span key="last" className="truncate text-[var(--color-text-muted)]">
            {entry.lastEvent ?? '-'}
          </span>,
          <CaretRight
            key="go"
            size={13}
            className="text-[var(--color-text-disabled)]"
            weight="bold"
          />,
        ],
      }
  }
}

function WaterfallChart({ spans }: { spans: TraceSpan[] }) {
  if (spans.length === 0) {
    return <p className="text-[11px] text-[var(--color-text-muted)]">No trace spans</p>
  }

  const allTimes = collectAllTimes(spans)
  const minTime = Math.min(...allTimes)
  const maxTime = Math.max(...allTimes)
  const totalDuration = maxTime - minTime || 1

  const flatSpans = flattenSpans(spans, 0, minTime)

  const markers = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    pct: pct * 100,
    label: formatMs(pct * totalDuration),
  }))

  return (
    <div className="space-y-0.5">
      <div className="relative h-5 mb-2 border-b border-[var(--color-border)]">
        {markers.map((marker) => (
          <span
            key={marker.pct}
            className="absolute bottom-0 text-[9px] text-[var(--color-text-disabled)] font-mono -translate-x-1/2"
            style={{ left: `${marker.pct}%` }}
          >
            {marker.label}
          </span>
        ))}
      </div>

      {flatSpans.map((span, index) => {
        const leftPct = (span.startOffset / totalDuration) * 100
        const widthPct = Math.max((span.durationMs / totalDuration) * 100, 2)
        const barColor = spanBarColors[span.name.toLowerCase()] ?? 'bg-slate-500'
        const spanKey = `${span.startTime}-${span.name}-${span.depth}-${index}`

        return (
          <div
            key={spanKey}
            className="flex items-center h-6"
            style={{ paddingLeft: `${span.depth * 16}px` }}
          >
            <div className="relative flex-1 h-4">
              <div
                className={`absolute top-0 h-full rounded-sm ${barColor} opacity-80`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
              <span
                className="absolute top-0 h-full flex items-center text-[10px] font-mono text-[var(--color-text-primary)] whitespace-nowrap pointer-events-none"
                style={{ left: `${leftPct + widthPct + 0.5}%` }}
              >
                {span.name}{' '}
                <span className="ml-1 text-[var(--color-text-disabled)]">
                  {formatMs(span.durationMs)}
                </span>
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LevelBadge({ level }: { level?: string }) {
  if (!level) return <span className="text-slate-400">-</span>
  return <span className={levelColors[level] ?? 'text-slate-400'}>{level}</span>
}

function flattenSpans(spans: TraceSpan[], depth: number, sessionStart: number): WaterfallSpan[] {
  const result: WaterfallSpan[] = []
  for (const span of spans) {
    const startOffset = new Date(span.startTime).getTime() - sessionStart
    result.push({
      name: span.name,
      startOffset,
      durationMs: span.durationMs,
      status: span.status,
      depth,
      startTime: span.startTime,
    })
    if (span.children && span.children.length > 0) {
      result.push(...flattenSpans(span.children, depth + 1, sessionStart))
    }
  }
  return result
}

function collectAllTimes(spans: TraceSpan[]): number[] {
  const times: number[] = []
  for (const span of spans) {
    const start = new Date(span.startTime).getTime()
    times.push(start, start + span.durationMs)
    if (span.children && span.children.length > 0) {
      times.push(...collectAllTimes(span.children))
    }
  }
  return times
}

function getSid(entry: LogEntry): string {
  const sid = entry.sessionId ?? entry.session_id ?? ''
  return typeof sid === 'string' ? sid.slice(0, 8) : '-'
}

function getLogEntryKey(entry: LogEntry): string {
  return [
    entry.ts,
    entry.sessionId ?? entry.session_id ?? '',
    entry.name ?? '',
    entry.tool ?? '',
    entry.event ?? '',
  ].join(':')
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}
