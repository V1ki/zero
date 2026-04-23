import { MagnifyingGlass } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PulseDot } from '../components/shared/PulseDot'
import { Skeleton } from '../components/shared/Skeleton'
import { useWebSocket } from '../hooks/useWebSocket'
import { apiFetch } from '../lib/api'
import { formatCost, formatModelHistory, formatNumber, formatTimeAgo } from '../lib/format'
import { useUIStore } from '../stores/ui'

interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

interface SessionInfo {
  id: string
  source: string
  channelName?: string
  isCurrent: boolean
  placement: 'current' | 'background'
  currentModel: string
  createdAt: string
  updatedAt: string
  messageCount: number
  tags: string[]
  summary?: string
  channelId?: string
  modelHistory: ModelHistoryEntry[]
  toolCallCount: number
  userMessageCount: number
  assistantMessageCount: number
  totalTokens: number
  totalCost: number
}

function mapPlacementToDot(placement: SessionInfo['placement']): 'active' | 'idle' | 'error' | 'warning' {
  return placement === 'current' ? 'active' : 'idle'
}

function canOpenChannelDetail(session: SessionInfo) {
  return Boolean(session.channelId && session.placement === 'current')
}

const SOURCE_FILTERS = ['all', 'web', 'feishu', 'telegram', 'scheduler'] as const

export function SessionsPage() {
  const [filter, setFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [focusIndex, setFocusIndex] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wsDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastKeyRef = useRef<string>('')
  const filterRef = useRef(filter)
  const searchRef = useRef(search)
  filterRef.current = filter
  searchRef.current = search
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { setSelectedSessionId } = useUIStore()

  const fetchSessions = useCallback((f: string, q: string, showLoading = true) => {
    if (showLoading) setLoading(true)
    const params = new URLSearchParams()
    if (f !== 'all') params.set('filter', f)
    if (q) params.set('q', q)
    const qs = params.toString()
    apiFetch<{ sessions: SessionInfo[] }>(`/api/sessions${qs ? `?${qs}` : ''}`)
      .then((res) => setSessions(res.sessions))
      .catch(() => {})
      .finally(() => {
        if (showLoading) setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchSessions(filter, searchRef.current)
  }, [filter, fetchSessions])

  function handleSearch(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchSessions(filter, value), 300)
  }

  const openSession = useCallback(
    (id: string) => {
      setSelectedSessionId(id)
      navigate({ to: '/sessions/$id', params: { id } })
    },
    [navigate, setSelectedSessionId],
  )

  function openChannelDetail(session: SessionInfo) {
    if (!session.channelId) return
    navigate({
      to: '/sessions/channel/$channel/detail',
      params: { channel: session.channelId },
      search: { source: session.source, channelName: session.channelName },
    })
  }

  const filteredSessions =
    sourceFilter === 'all' ? sessions : sessions.filter((s) => s.source === sourceFilter)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'j') {
        setFocusIndex((prev) => Math.min(prev + 1, filteredSessions.length - 1))
      } else if (e.key === 'k') {
        setFocusIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < filteredSessions.length) {
        openSession(filteredSessions[focusIndex].id)
      } else if (e.key === 'Escape') {
        setFocusIndex(-1)
      } else if (e.key === 'g' && lastKeyRef.current === 'g') {
        setFocusIndex(0)
        listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      } else if (e.key === 'G') {
        setFocusIndex(filteredSessions.length - 1)
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
      }

      lastKeyRef.current = e.key
    },
    [filteredSessions, focusIndex, openSession],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const onSessionEvent = useCallback(() => {
    clearTimeout(wsDebounceRef.current)
    wsDebounceRef.current = setTimeout(() => {
      fetchSessions(filterRef.current, searchRef.current, false)
    }, 500)
  }, [fetchSessions])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['session:create', 'session:update'],
    onEvent: onSessionEvent,
  })

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Sessions</h1>

      <div className="card p-4 mb-4 animate-fade-up">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex gap-2">
            {['all', 'current', 'background'].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
                  filter === f
                    ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
            />
            <input
              type="text"
              placeholder="Search sessions..."
              className="input-field pl-9 w-[200px]"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-1.5 mt-3 pt-3 border-t border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-disabled)] mr-1 self-center">
            Source:
          </span>
          {SOURCE_FILTERS.map((sf) => (
            <button
              key={sf}
              type="button"
              onClick={() => setSourceFilter(sf)}
              className={`px-2.5 py-0.5 rounded text-[11px] transition-colors ${
                sourceFilter === sf
                  ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {sf}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => ({
            key: `session-loading-${index}`,
            delay: `${index * 40}ms`,
          })).map(({ key, delay }) => (
            <div key={key} className="card p-4" style={{ animationDelay: delay }}>
              <div className="flex items-center gap-3">
                <Skeleton className="w-2 h-2 rounded-full" />
                <Skeleton className="h-3.5 w-48" />
                <span className="flex-1" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="ml-7 mt-2 flex gap-2">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 w-32" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="card p-12 text-center animate-fade-up" style={{ animationDelay: '60ms' }}>
          <p className="text-[14px] text-[var(--color-text-muted)] mb-2">No sessions yet</p>
          <p className="text-[12px] text-[var(--color-text-disabled)]">
            Sessions will appear here when you start interacting with ZeRo OS
          </p>
        </div>
      ) : (
        <div ref={listRef} className="space-y-2 animate-fade-up" style={{ animationDelay: '60ms' }}>
          {filteredSessions.map((s, idx) => {
            const showChannelButton = canOpenChannelDetail(s)

            return (
              <div
                key={s.id}
                onClick={() => openSession(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openSession(s.id)
                  }
                }}
                className={`card p-4 cursor-pointer hover:bg-white/[0.02] transition-colors ${
                  idx === focusIndex
                    ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30'
                    : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <PulseDot status={mapPlacementToDot(s.placement)} />
                  <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                    {s.id}
                  </span>
                  {s.summary && (
                    <span className="text-[13px] text-[var(--color-text-secondary)] truncate">
                      {s.summary}
                    </span>
                  )}
                  <span className="flex-1" />
                  {showChannelButton && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        openChannelDetail(s)
                      }}
                      className="px-2 py-0.5 rounded text-[10px] border border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-accent-glow)] transition-colors"
                    >
                      Channel
                    </button>
                  )}
                  <span
                    className={`text-[11px] ${
                      s.placement === 'current' ? 'text-emerald-300' : 'text-slate-400'
                    }`}
                  >
                    {s.placement}
                  </span>
                </div>

                <div className="ml-7 mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5 flex-wrap">
                  <span className="capitalize">{s.source}</span>
                  <span>·</span>
                  {s.channelName && s.channelName !== s.source && (
                    <>
                      <span className="font-mono text-[var(--color-text-muted)]">
                        {s.channelName}
                      </span>
                      <span>·</span>
                    </>
                  )}
                  {s.channelId && (
                    <>
                      <span className="font-mono text-[var(--color-text-disabled)]">
                        {s.channelId}
                      </span>
                      <span>·</span>
                    </>
                  )}
                  <span className="font-mono">
                    {s.modelHistory && s.modelHistory.length > 0
                      ? formatModelHistory(s.modelHistory)
                      : s.currentModel}
                  </span>
                  <span>·</span>
                  <span>{formatTimeAgo(s.createdAt)}</span>
                  {s.isCurrent && <span>- current</span>}
                </div>

                <div className="ml-7 mt-0.5 text-[11px] text-[var(--color-text-disabled)]">
                  {s.userMessageCount} user · {s.assistantMessageCount} assistant ·{' '}
                  {s.toolCallCount} tool calls
                  {' · '}
                  {formatNumber(s.totalTokens)} tokens
                  {' · '}${formatCost(s.totalCost)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
