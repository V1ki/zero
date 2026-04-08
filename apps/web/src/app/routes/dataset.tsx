import { Database, FunnelSimple } from '@phosphor-icons/react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TraitPill } from '../components/dataset/TraitPill'
import { PulseDot } from '../components/shared/PulseDot'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch } from '../lib/api'
import { formatCost, formatNumber, formatTimeAgo } from '../lib/format'
import {
  buildDatasetEpisodesQuery,
  compactDatasetSearch,
  formatTraitsSearch,
  parseTraitsSearch,
  type DatasetRouteSearch,
} from './dataset-helpers'

interface EpisodeSummary {
  id: string
  sessionId: string
  metadata: {
    source: string
    status: string
    currentModel: string
    summary?: string
    tags: string[]
    createdAt: string
    updatedAt: string
  }
  conversation: {
    messageCount: number
    userTurnCount: number
    assistantTurnCount: number
  }
  recordedContext: {
    toolsSource: 'snapshot' | 'none'
  }
  trace: {
    counts: {
      requestCount: number
      closureCount: number
      decisionCount: number
      snapshotCount: number
      toolCallCount: number
      memoryDecisionCount: number
      compressionCount: number
      toolErrorCount: number
    }
  }
  usage: {
    totalCost: number
    totalTokens: number
    requestCount: number
  }
  latestEvaluation?: {
    overallScore: number
    verdict: string
    confidence: string
    createdAt: string
  }
  traits: string[]
}

interface DatasetStatsResponse {
  totalEpisodes: number
  byTrait: Array<{ key: string; count: number }>
  bySource: Array<{ key: string; count: number }>
  byStatus: Array<{ key: string; count: number }>
  evaluated: number
  unevaluated: number
  avgCost: number
}

const STATUS_FILTERS = ['all', 'completed', 'failed', 'archived'] as const
const SOURCE_FILTERS = ['all', 'web', 'feishu', 'telegram', 'scheduler'] as const

function mapStatusToDot(status: string): 'active' | 'idle' | 'error' | 'warning' {
  if (status === 'active') return 'active'
  if (status === 'failed') return 'error'
  return 'idle'
}

export function DatasetPage() {
  const search = useSearch({ from: '/dataset' }) as DatasetRouteSearch
  const navigate = useNavigate()
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([])
  const [stats, setStats] = useState<DatasetStatsResponse | null>(null)
  const [availableTraits, setAvailableTraits] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [focusIndex, setFocusIndex] = useState(-1)
  const [sinceInput, setSinceInput] = useState(search.since ?? '')
  const [untilInput, setUntilInput] = useState(search.until ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedTraits = useMemo(() => parseTraitsSearch(search.traits), [search.traits])

  const fetchEpisodes = useCallback(async () => {
    setLoading(true)
    const query = buildDatasetEpisodesQuery({ ...search, limit: 50 })
    try {
      const response = await apiFetch<{ episodes: EpisodeSummary[] }>(
        `/api/dataset/episodes${query ? `?${query}` : ''}`,
      )
      setEpisodes(response.episodes ?? [])
    } catch {
      setEpisodes([])
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void Promise.all([
      apiFetch<DatasetStatsResponse>('/api/dataset/stats').then(setStats),
      apiFetch<{ traits: string[] }>('/api/dataset/traits').then((response) =>
        setAvailableTraits(response.traits ?? []),
      ),
    ]).catch(() => {})
  }, [])

  useEffect(() => {
    setSinceInput(search.since ?? '')
    setUntilInput(search.until ?? '')
  }, [search.since, search.until])

  useEffect(() => {
    void fetchEpisodes()
  }, [fetchEpisodes])

  const updateSearch = useCallback(
    (patch: Partial<DatasetRouteSearch>, replace = true) => {
      navigate({
        to: '/dataset',
        search: (prev) =>
          compactDatasetSearch({
            ...prev,
            ...patch,
            offset: patch.offset ?? (patch.limit !== undefined ? 0 : prev.offset),
          }),
        replace,
      })
    },
    [navigate],
  )

  const handleDateInput = useCallback(
    (field: 'since' | 'until', value: string) => {
      if (field === 'since') {
        setSinceInput(value)
      } else {
        setUntilInput(value)
      }

      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        updateSearch({
          [field]: value || undefined,
          offset: 0,
        })
      }, 300)
    },
    [updateSearch],
  )

  const openEpisode = useCallback(
    (sessionId: string) => {
      navigate({
        to: '/dataset/$id',
        params: { id: sessionId },
        search: compactDatasetSearch(search),
      })
    },
    [navigate, search],
  )

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'j') {
        setFocusIndex((prev) => Math.min(prev + 1, episodes.length - 1))
      } else if (e.key === 'k') {
        setFocusIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && focusIndex >= 0 && episodes[focusIndex]) {
        openEpisode(episodes[focusIndex].sessionId)
      } else if (e.key === 'Escape') {
        setFocusIndex(-1)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [episodes, focusIndex, openEpisode])

  const topTrait = stats?.byTrait[0]

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Database size={20} className="text-[var(--color-accent)]" />
        <h1 className="text-[20px] font-bold tracking-tight">Dataset</h1>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatsCard label="Total Episodes" value={stats ? formatNumber(stats.totalEpisodes) : '—'} />
        <StatsCard
          label="Evaluated"
          value={
            stats
              ? `${formatNumber(stats.evaluated)} / ${stats.totalEpisodes > 0 ? ((stats.evaluated / stats.totalEpisodes) * 100).toFixed(1) : '0.0'}%`
              : '—'
          }
        />
        <StatsCard label="Avg Cost" value={stats ? formatCost(stats.avgCost) : '—'} />
        <StatsCard
          label="Top Trait"
          value={
            topTrait
              ? `${topTrait.key} ${Math.round((topTrait.count / Math.max(stats?.totalEpisodes ?? 1, 1)) * 100)}%`
              : '—'
          }
        />
      </div>

      <div className="card p-4 mt-4 animate-fade-up">
        <div className="flex items-center gap-2 mb-3">
          <FunnelSimple size={16} className="text-[var(--color-text-muted)]" />
          <span className="text-[12px] font-semibold text-[var(--color-text-secondary)]">Filters</span>
        </div>

        <FilterRow label="Status">
          {STATUS_FILTERS.map((status) => (
            <FilterButton
              key={status}
              active={(search.status ?? 'all') === status}
              onClick={() => updateSearch({ status: status === 'all' ? undefined : status, offset: 0 })}
            >
              {status}
            </FilterButton>
          ))}
        </FilterRow>

        <FilterRow label="Source">
          {SOURCE_FILTERS.map((source) => (
            <FilterButton
              key={source}
              active={(search.source ?? 'all') === source}
              onClick={() => updateSearch({ source: source === 'all' ? undefined : source, offset: 0 })}
            >
              {source}
            </FilterButton>
          ))}
        </FilterRow>

        <FilterRow label="Traits">
          {availableTraits.map((trait) => {
            const active = selectedTraits.includes(trait)
            const nextTraits = active
              ? selectedTraits.filter((value) => value !== trait)
              : [...selectedTraits, trait]

            return (
              <TraitPill
                key={trait}
                trait={trait}
                interactive
                active={active}
                onClick={() => updateSearch({ traits: formatTraitsSearch(nextTraits), offset: 0 })}
              />
            )
          })}
        </FilterRow>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[auto_1fr_1fr] md:items-center">
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={search.hasEvaluation === 'true'}
              onChange={(event) =>
                updateSearch({
                  hasEvaluation: event.target.checked ? 'true' : undefined,
                  offset: 0,
                })
              }
            />
            Has Evaluation
          </label>

          <input
            aria-label="Since"
            type="text"
            placeholder="Since ISO timestamp"
            className="input-field"
            value={sinceInput}
            onChange={(event) => handleDateInput('since', event.target.value)}
          />

          <input
            aria-label="Until"
            type="text"
            placeholder="Until ISO timestamp"
            className="input-field"
            value={untilInput}
            onChange={(event) => handleDateInput('until', event.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 mt-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={`dataset-loading-${index}`} className="card p-4">
              <Skeleton className="h-4 w-56 mb-3" />
              <Skeleton className="h-3 w-72 mb-2" />
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
        </div>
      ) : episodes.length === 0 ? (
        <div className="card p-10 text-center mt-4 text-[13px] text-[var(--color-text-muted)]">
          No dataset episodes matched the current filters.
        </div>
      ) : (
        <div ref={listRef} className="space-y-2 mt-4 animate-fade-up">
          {episodes.map((episode, index) => (
            <button
              key={episode.sessionId}
              type="button"
              onClick={() => openEpisode(episode.sessionId)}
              className={`card w-full p-4 text-left hover:bg-white/[0.02] transition-colors ${
                index === focusIndex
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30'
                  : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <PulseDot status={mapStatusToDot(episode.metadata.status)} />
                <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                  {episode.sessionId}
                </span>
                {episode.metadata.summary && (
                  <span className="text-[13px] text-[var(--color-text-secondary)] truncate">
                    {episode.metadata.summary}
                  </span>
                )}
                <span className="flex-1" />
                {episode.latestEvaluation && (
                  <span className="px-2 py-0.5 rounded text-[10px] border border-[var(--color-border)] text-[var(--color-accent)]">
                    {episode.latestEvaluation.verdict.toUpperCase()}
                  </span>
                )}
              </div>

              <div className="ml-7 mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5 flex-wrap">
                <span className="capitalize">{episode.metadata.source}</span>
                <span>·</span>
                <span className="font-mono">{episode.metadata.currentModel}</span>
                <span>·</span>
                <span>{formatTimeAgo(episode.metadata.updatedAt)}</span>
              </div>

              <div className="ml-7 mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5 flex-wrap">
                <span>{episode.conversation.userTurnCount} user</span>
                <span>·</span>
                <span>{episode.trace.counts.toolCallCount} tool calls</span>
                <span>·</span>
                <span>{formatNumber(episode.usage.totalTokens)} tokens</span>
                <span>·</span>
                <span>{formatCost(episode.usage.totalCost)}</span>
              </div>

              <div className="ml-7 mt-2 flex flex-wrap gap-2">
                {episode.traits.map((trait) => (
                  <TraitPill key={`${episode.sessionId}-${trait}`} trait={trait} />
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StatsCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">{label}</p>
      <p className="text-[20px] font-semibold text-[var(--color-text-primary)] mt-2">{value}</p>
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
      <div className="text-[11px] text-[var(--color-text-disabled)] mb-2">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
        active
          ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
      }`}
    >
      {children}
    </button>
  )
}
