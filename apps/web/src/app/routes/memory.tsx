import { ArrowRight, Check, MagnifyingGlass, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { Skeleton } from '../components/shared/Skeleton'
import { apiDelete, apiFetch, apiPut } from '../lib/api'
import { typeBgColors, typeColors } from '../lib/colors'
import { formatTimeAgo } from '../lib/format'

const memoryTypes = [
  'session',
  'incident',
  'runbook',
  'decision',
  'note',
  'inbox',
  'preference',
] as const
const STATUS_OPTIONS = ['all', 'draft', 'verified', 'archived', 'conflict'] as const
const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'type', label: 'Type' },
] as const

type SortKey = (typeof SORT_OPTIONS)[number]['key']

interface MemoryItem {
  id: string
  type: string
  sessionId?: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  status: string
  confidence: number
  tags: string[]
}

function ConfidenceDots({ value }: { value: number }) {
  const filled = Math.round(value * 5)
  const dotKeys = Array.from({ length: 5 }, (_, index) => `confidence-dot-${index}`)
  return (
    <div className="flex gap-0.5">
      {dotKeys.map((dotKey, index) => (
        <span
          key={dotKey}
          className={`w-1.5 h-1.5 rounded-full ${index < filled ? 'bg-cyan-400' : 'bg-white/10'}`}
        />
      ))}
    </div>
  )
}

function MemoryOverview({ memories }: { memories: MemoryItem[] }) {
  const typeCounts: Record<string, number> = {}
  for (const m of memories) {
    typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1
  }

  const mostRecent =
    memories.length > 0
      ? memories.reduce((a, b) => (new Date(b.updatedAt) > new Date(a.updatedAt) ? b : a))
      : null

  return (
    <div className="space-y-4">
      <h3 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">
        Memory Overview
      </h3>

      <div className="flex items-center gap-3">
        <div className="text-[28px] font-bold tracking-tight">{memories.length}</div>
        <span className="text-[13px] text-[var(--color-text-muted)]">total memories</span>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold">
          BY TYPE
        </p>
        {Object.entries(typeCounts).map(([type, count]) => (
          <div key={type} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${typeBgColors[type] ?? ''} ${typeColors[type] ?? 'text-slate-400'}`}
              >
                {type}
              </span>
            </div>
            <span className="text-[13px] font-mono text-[var(--color-text-primary)]">{count}</span>
          </div>
        ))}
      </div>

      {mostRecent && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
          <p className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold mb-2">
            MOST RECENT
          </p>
          <p className="text-[12px] text-[var(--color-text-primary)]">{mostRecent.title}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {formatTimeAgo(mostRecent.updatedAt)}
          </p>
        </div>
      )}
    </div>
  )
}

export function MemoryPage() {
  const navigate = useNavigate()
  const [selectedType, setSelectedType] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortKey>('newest')
  const [search, setSearch] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [selected, setSelected] = useState<MemoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const fetchMemories = useCallback((type: string) => {
    setLoading(true)
    const params = type !== 'all' ? `?type=${type}` : ''
    apiFetch<{ memories: MemoryItem[] }>(`/api/memory${params}`)
      .then((res) => setMemories(res.memories))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const searchMemories = useCallback(
    (q: string) => {
      if (!q.trim()) {
        fetchMemories(selectedType)
        return
      }
      setLoading(true)
      apiFetch<{ results: MemoryItem[] }>(`/api/memory/search?q=${encodeURIComponent(q)}`)
        .then((res) => setMemories(res.results))
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [fetchMemories, selectedType],
  )

  useEffect(() => {
    if (!search) fetchMemories(selectedType)
  }, [selectedType, search, fetchMemories])

  function handleSearch(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => searchMemories(value), 300)
  }

  function startEdit() {
    if (!selected) return
    setEditContent(selected.content)
    setEditing(true)
  }

  async function saveEdit() {
    if (!selected) return
    setEditSaving(true)
    try {
      const { memory } = await apiPut<{ memory: MemoryItem }>(
        `/api/memory/${selected.type}/${selected.id}`,
        {
          content: editContent,
        },
      )
      setSelected(memory)
      setMemories((prev) => prev.map((m) => (m.id === selected.id ? memory : m)))
      setEditing(false)
    } catch {
      // keep editing on failure
    } finally {
      setEditSaving(false)
    }
  }

  function cancelEdit() {
    setEditing(false)
    setEditContent('')
  }

  async function confirmDelete() {
    if (!selected) return

    const { id, type } = selected
    await apiDelete(`/api/memory/${type}/${id}`)
    setMemories((prev) => prev.filter((memory) => memory.id !== id))
    setSelected(null)
    setEditing(false)
    setEditContent('')
    setShowDeleteConfirm(false)
  }

  // Apply status filter and sorting
  const filteredMemories = memories
    .filter((m) => statusFilter === 'all' || m.status === statusFilter)
    .sort((a, b) => {
      if (sortBy === 'confidence') return b.confidence - a.confidence
      if (sortBy === 'type') return a.type.localeCompare(b.type)
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  const sessionDetailId = selected?.type === 'session' ? selected.sessionId : undefined

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Memory</h1>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
        {/* Left panel: filters + list */}
        <div className="space-y-3">
          {/* Search */}
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
            />
            <input
              type="text"
              placeholder="Search memories..."
              className="input-field pl-9 w-full"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>

          {/* Type filters */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                setSelectedType('all')
                setSearch('')
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] tracking-wide transition-colors ${
                selectedType === 'all'
                  ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              All
            </button>
            {memoryTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setSelectedType(type)
                  setSearch('')
                }}
                className={`px-2.5 py-1 rounded-md text-[11px] tracking-wide transition-colors ${
                  selectedType === type
                    ? `${typeBgColors[type] ?? ''} ${typeColors[type] ?? ''}`
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* Status filter + Sort */}
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input-field text-[12px] flex-1"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === 'all' ? 'All statuses' : s}
                </option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="input-field text-[12px] flex-1"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Memory list */}
          {loading ? (
            <div className="space-y-1.5">
              {Array.from({ length: 5 }, (_, index) => `memory-loading-${index}`).map((key) => (
                <div key={key} className="card p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Skeleton className="h-3 w-14 rounded" />
                    <Skeleton className="h-2.5 w-16" />
                  </div>
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-[13px] text-[var(--color-text-muted)]">No memories found</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
              {filteredMemories.map((mem) => (
                <button
                  key={mem.id}
                  type="button"
                  onClick={() => {
                    setSelected(mem)
                    setEditing(false)
                  }}
                  className={`w-full text-left card p-3 transition-colors ${
                    selected?.id === mem.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]'
                      : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[mem.type] ?? ''} ${typeColors[mem.type] ?? 'text-slate-400'}`}
                    >
                      {mem.type}
                    </span>
                    <ConfidenceDots value={mem.confidence} />
                    <span className="text-[10px] text-[var(--color-text-disabled)]">
                      {formatTimeAgo(mem.updatedAt)}
                    </span>
                  </div>
                  <p className="text-[12px] text-[var(--color-text-primary)] truncate">
                    {mem.title}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right panel: detail view */}
        <div className="card p-6">
          {selected ? (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded ${typeBgColors[selected.type] ?? ''} ${typeColors[selected.type] ?? ''}`}
                  >
                    {selected.type}
                  </span>
                  <span className="text-[11px] text-[var(--color-text-disabled)]">
                    {selected.status}
                  </span>
                  <ConfidenceDots value={selected.confidence} />
                </div>
                {!editing ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={startEdit}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-white/[0.05] transition-colors"
                    >
                      <PencilSimple size={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                    >
                      <Trash size={12} />
                      Delete
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={editSaving}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-emerald-400 hover:bg-emerald-400/10 transition-colors disabled:opacity-40"
                    >
                      <Check size={12} />
                      {editSaving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:bg-white/[0.05] transition-colors"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)] mb-2">
                {selected.title}
              </h2>
              {sessionDetailId && (
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: '/sessions/$id',
                      params: { id: sessionDetailId },
                    })
                  }
                  className="mb-3 inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"
                >
                  View Session
                  <ArrowRight size={12} />
                </button>
              )}
              {selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {selected.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--color-text-muted)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {editing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full min-h-[300px] bg-transparent text-[13px] font-mono text-[var(--color-text-primary)] resize-none outline-none border border-[var(--color-border)] rounded-lg p-3"
                  spellCheck={false}
                />
              ) : (
                <div className="text-[13px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap">
                  {selected.content}
                </div>
              )}
            </div>
          ) : (
            <MemoryOverview memories={filteredMemories} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete memory?"
        description={
          selected
            ? `This will permanently delete “${selected.title}”. This action cannot be undone.`
            : undefined
        }
        confirmText="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}
