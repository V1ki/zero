import {
  Archive,
  ArrowRight,
  CaretDown,
  CaretRight,
  Check,
  MagnifyingGlass,
  PencilSimple,
  SealCheck,
  X,
} from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch, apiPatch, apiPost, apiPut } from '../lib/api'
import { memoryStatusColors, typeBgColors, typeColors } from '../lib/colors'
import { formatTimeAgo } from '../lib/format'

const EDGE_KIND_LABELS: Record<string, string> = {
  'same-as': '重复于',
  subsumes: '包含',
  'same-topic': '同主题',
  supersedes: '取代',
  contradicts: '冲突于',
  'derived-from': '派生自',
}

const EDGE_KIND_OPTIONS: { kind: string; label: string }[] = [
  { kind: 'same-topic', label: '同主题' },
  { kind: 'same-as', label: '重复于' },
  { kind: 'subsumes', label: '包含' },
  { kind: 'contradicts', label: '冲突于' },
  { kind: 'derived-from', label: '派生自' },
]

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
  topicKey?: string
  supersededBy?: string
  mergedInto?: string
  edges?: { toId: string; kind: string }[]
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

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded ${memoryStatusColors[status] ?? 'bg-white/[0.05] text-slate-400'}`}
    >
      {status}
    </span>
  )
}

function clusterKey(memory: MemoryItem): string {
  if (memory.topicKey) return `topic:${memory.topicKey}`
  if (memory.sessionId) return `sess:${memory.sessionId}|${memory.type}`
  return `id:${memory.id}`
}

function memoryStatusRank(status: string): number {
  if (status === 'verified') return 0
  if (status === 'archived') return 3
  return 1
}

function pickCover(group: MemoryItem[]): MemoryItem {
  return [...group].sort((a, b) => {
    const ra = memoryStatusRank(a.status)
    const rb = memoryStatusRank(b.status)
    if (ra !== rb) return ra - rb
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })[0]
}

function groupByCluster(items: MemoryItem[]): [string, MemoryItem[]][] {
  const map = new Map<string, MemoryItem[]>()
  for (const memory of items) {
    const key = clusterKey(memory)
    const existing = map.get(key)
    if (existing) existing.push(memory)
    else map.set(key, [memory])
  }
  return [...map.entries()]
}

function MemoryCard({
  mem,
  isSelected,
  onSelect,
}: {
  mem: MemoryItem
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left card p-3 transition-colors ${
        isSelected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]'
          : 'hover:bg-white/[0.02]'
      } ${mem.status === 'archived' ? 'opacity-50' : ''}`}
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
      <p className="text-[12px] text-[var(--color-text-primary)] truncate">{mem.title}</p>
    </button>
  )
}

function ClusterCard({
  group,
  selectedId,
  onSelect,
  expanded,
  onToggleExpand,
}: {
  group: MemoryItem[]
  selectedId: string | null
  onSelect: (mem: MemoryItem) => void
  expanded: boolean
  onToggleExpand: () => void
}) {
  const cover = pickCover(group)
  const sides = group.filter((memory) => memory.id !== cover.id)
  const archivedCount = sides.filter((memory) => memory.status === 'archived').length
  const coverSelected = selectedId === cover.id

  return (
    <div
      className={`card p-3 ${coverSelected ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]' : ''}`}
    >
      <button type="button" onClick={() => onSelect(cover)} className="w-full text-left">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[cover.type] ?? ''} ${typeColors[cover.type] ?? 'text-slate-400'}`}
          >
            {cover.type}
          </span>
          <ConfidenceDots value={cover.confidence} />
          <span className="text-[10px] text-[var(--color-text-disabled)]">
            {formatTimeAgo(cover.updatedAt)}
          </span>
        </div>
        <p className="text-[12px] text-[var(--color-text-primary)] truncate">{cover.title}</p>
      </button>
      <button
        type="button"
        onClick={onToggleExpand}
        className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}+{sides.length} 条侧面
        {archivedCount > 0 ? `（含 ${archivedCount} 归档）` : ''}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 pl-2 border-l border-[var(--color-border)]">
          {sides.map((memory) => (
            <button
              key={memory.id}
              type="button"
              onClick={() => onSelect(memory)}
              className={`w-full text-left text-[11px] py-1 px-1.5 rounded hover:bg-white/[0.03] truncate ${
                memory.status === 'archived' ? 'opacity-40' : ''
              } ${selectedId === memory.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}
            >
              {memory.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_ORDER = ['verified', 'draft', 'conflict', 'archived'] as const

function MemoryOverview({ memories }: { memories: MemoryItem[] }) {
  const typeStats: Record<string, { total: number; verified: number; archived: number }> = {}
  const statusCounts: Record<string, number> = {}
  for (const memory of memories) {
    if (!typeStats[memory.type]) {
      typeStats[memory.type] = { total: 0, verified: 0, archived: 0 }
    }
    const typeStat = typeStats[memory.type]
    typeStat.total++
    if (memory.status === 'verified') typeStat.verified++
    else if (memory.status === 'archived') typeStat.archived++
    statusCounts[memory.status] = (statusCounts[memory.status] ?? 0) + 1
  }
  const verifiedCount = statusCounts.verified ?? 0
  const archivedCount = statusCounts.archived ?? 0
  const statusKeys = [
    ...STATUS_ORDER.filter((status) => statusCounts[status]),
    ...Object.keys(statusCounts).filter(
      (status) => !STATUS_ORDER.includes(status as (typeof STATUS_ORDER)[number]),
    ),
  ]

  const mostRecent =
    memories.length > 0
      ? memories.reduce((a, b) => (new Date(b.updatedAt) > new Date(a.updatedAt) ? b : a))
      : null

  return (
    <div className="space-y-4">
      <h3 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">
        Memory Overview
      </h3>

      <div className="flex items-baseline gap-3">
        <div className="text-[28px] font-bold tracking-tight">{memories.length}</div>
        <span className="text-[13px] text-[var(--color-text-muted)]">total memories</span>
      </div>
      <div className="flex items-center gap-2 text-[12px] font-mono">
        <span className="text-emerald-400">{verifiedCount} verified</span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span className="text-[var(--color-text-disabled)]">{archivedCount} archived</span>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold">
          BY STATUS
        </p>
        {statusKeys.map((status) => (
          <div key={status} className="flex items-center justify-between py-1">
            <StatusPill status={status} />
            <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
              {statusCounts[status]}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold">
          BY TYPE
        </p>
        {Object.entries(typeStats).map(([type, stat]) => (
          <div key={type} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${typeBgColors[type] ?? ''} ${typeColors[type] ?? 'text-slate-400'}`}
              >
                {type}
              </span>
            </div>
            <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
              <span className="text-emerald-400">{stat.verified}</span>
              <span className="text-[var(--color-text-disabled)]"> / {stat.total}</span>
              {stat.archived > 0 ? (
                <span className="text-[11px] text-[var(--color-text-disabled)]">
                  {' '}
                  ({stat.archived} arch)
                </span>
              ) : null}
            </span>
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
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [view, setView] = useState<'browse' | 'clusters'>('browse')
  const [fold, setFold] = useState(false)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
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

  function handleTypeChange(type: string) {
    setSelectedType(type)
    setSearch('')
  }

  function toggleCluster(key: string) {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectMemory(mem: MemoryItem) {
    setSelected(mem)
    setEditing(false)
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
        { content: editContent },
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

  async function archiveMemory() {
    if (!selected) return
    const { id, type } = selected
    try {
      const { memory } = await apiPost<{ memory: MemoryItem }>(
        `/api/memory/${type}/${id}/archive`,
        {},
      )
      setSelected(memory)
      setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)))
    } catch {
      // ignore failure, keep current state
    }
    setShowArchiveConfirm(false)
  }

  async function verifyMemory() {
    if (!selected) return
    const { id, type } = selected
    try {
      const { memory } = await apiPost<{ memory: MemoryItem }>(
        `/api/memory/${type}/${id}/verify`,
        {},
      )
      setSelected(memory)
      setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)))
    } catch {
      // ignore failure, keep current state
    }
  }

  async function createEdge(toId: string, kind: string) {
    if (!selected) return
    const { id, type } = selected
    try {
      const { memory } = await apiPatch<{ memory: MemoryItem }>(
        `/api/memory/${type}/${id}/relations`,
        { add: [{ toId, kind }] },
      )
      setSelected(memory)
      setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)))
    } catch {
      // ignore failure
    }
  }

  async function supersedeBy(byId: string) {
    if (!selected) return
    const { id, type } = selected
    try {
      const { memory } = await apiPost<{ memory: MemoryItem }>(
        `/api/memory/${type}/${id}/supersede`,
        { bySupersededId: byId },
      )
      setSelected(memory)
      setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)))
    } catch {
      // ignore failure
    }
  }

  const filteredMemories = memories
    .filter((memory) => statusFilter === 'all' || memory.status === statusFilter)
    .sort((left, right) => {
      if (sortBy === 'confidence') return right.confidence - left.confidence
      if (sortBy === 'type') return left.type.localeCompare(right.type)
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    })
  const clusterGroups = fold ? groupByCluster(filteredMemories) : null

  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-bold tracking-tight">Memory</h1>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setView('browse')}
            className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
              view === 'browse'
                ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            浏览
          </button>
          <button
            type="button"
            onClick={() => setView('clusters')}
            className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
              view === 'clusters'
                ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            簇治理
          </button>
        </div>
      </div>

      {view === 'clusters' && <GovernanceView />}

      {view === 'browse' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr]">
          <MemoryBrowsePanel
            selectedType={selectedType}
            statusFilter={statusFilter}
            sortBy={sortBy}
            search={search}
            loading={loading}
            fold={fold}
            filteredMemories={filteredMemories}
            clusterGroups={clusterGroups}
            selectedId={selected?.id ?? null}
            expandedClusters={expandedClusters}
            onTypeChange={handleTypeChange}
            onStatusFilterChange={setStatusFilter}
            onSortChange={setSortBy}
            onSearchChange={handleSearch}
            onFoldChange={setFold}
            onSelectMemory={selectMemory}
            onToggleCluster={toggleCluster}
          />

          <MemoryDetailPanel
            selected={selected}
            memories={memories}
            editing={editing}
            editContent={editContent}
            editSaving={editSaving}
            onStartEdit={startEdit}
            onSaveEdit={saveEdit}
            onCancelEdit={cancelEdit}
            onEditContentChange={setEditContent}
            onVerifyMemory={verifyMemory}
            onArchiveRequest={() => setShowArchiveConfirm(true)}
            onSelectMemory={selectMemory}
            onCreateEdge={createEdge}
            onSupersede={supersedeBy}
          />
        </div>
      )}

      <ConfirmDialog
        open={showArchiveConfirm}
        title="归档此记忆？"
        description={
          selected
            ? `将把“${selected.title}”标记为已归档（检索不再命中）。不会删除，可在状态筛选切到 archived 找回。`
            : undefined
        }
        confirmText="归档"
        onConfirm={archiveMemory}
        onCancel={() => setShowArchiveConfirm(false)}
      />
    </div>
  )
}

function RelationRow({
  label,
  targetId,
  target,
  onJump,
}: {
  label: string
  targetId: string
  target?: MemoryItem
  onJump?: () => void
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-[var(--color-text-muted)] shrink-0">{label}</span>
      {target && onJump ? (
        <button
          type="button"
          onClick={onJump}
          className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline truncate text-left"
        >
          <span className="truncate">{target.title}</span>
          <ArrowRight size={12} className="shrink-0" />
        </button>
      ) : (
        <span className="text-[var(--color-text-disabled)] font-mono truncate">{targetId}</span>
      )}
    </div>
  )
}

interface Neighbor {
  memoryId: string
  type?: string
  title?: string
  score: number
}

function NeighborPicker({
  memory,
  onCreateEdge,
  onSupersede,
}: {
  memory: MemoryItem
  onCreateEdge: (toId: string, kind: string) => Promise<void>
  onSupersede: (byId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [neighbors, setNeighbors] = useState<Neighbor[]>([])
  const [note, setNote] = useState<string | null>(null)

  async function load() {
    setOpen(true)
    setLoading(true)
    setNote(null)
    try {
      const res = await apiFetch<{ neighbors: Neighbor[]; reason?: string }>(
        `/api/memory/${memory.type}/${memory.id}/neighbors`,
      )
      setNeighbors(res.neighbors)
      if (res.neighbors.length === 0) setNote(res.reason ?? '无近邻')
    } catch {
      setNote('近邻获取失败')
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={load}
        className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
      >
        <MagnifyingGlass size={12} />
        查看近邻 / 建立关系
      </button>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold">
          语义近邻
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          收起
        </button>
      </div>
      {loading ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">加载中…</p>
      ) : note ? (
        <p className="text-[11px] text-[var(--color-text-disabled)]">{note}</p>
      ) : (
        neighbors.map((neighbor) => (
          <NeighborRow
            key={neighbor.memoryId}
            neighbor={neighbor}
            existingKinds={(memory.edges ?? [])
              .filter((edge) => edge.toId === neighbor.memoryId)
              .map((edge) => edge.kind)}
            onCreateEdge={onCreateEdge}
            onSupersede={onSupersede}
          />
        ))
      )}
    </div>
  )
}

function NeighborRow({
  neighbor,
  existingKinds,
  onCreateEdge,
  onSupersede,
}: {
  neighbor: Neighbor
  existingKinds?: string[]
  onCreateEdge: (toId: string, kind: string) => Promise<void>
  onSupersede: (byId: string) => Promise<void>
}) {
  const [kind, setKind] = useState(existingKinds?.[0] ?? 'same-topic')
  const [busy, setBusy] = useState(false)
  return (
    <div className="card p-2 space-y-1">
      <div className="flex items-center gap-2">
        {neighbor.type && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[neighbor.type] ?? ''} ${typeColors[neighbor.type] ?? 'text-slate-400'}`}
          >
            {neighbor.type}
          </span>
        )}
        <span className="text-[11px] text-[var(--color-text-secondary)] truncate flex-1">
          {neighbor.title ?? neighbor.memoryId}
        </span>
        <span className="text-[10px] text-[var(--color-text-disabled)] font-mono shrink-0">
          {neighbor.score.toFixed(2)}
        </span>
      </div>
      {existingKinds && existingKinds.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] text-[var(--color-text-disabled)]">已关联</span>
          {existingKinds.map((existingKind) => (
            <span
              key={existingKind}
              className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-accent-glow)] text-[var(--color-accent)]"
            >
              {EDGE_KIND_LABELS[existingKind] ?? existingKind}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="input-field text-[10px] py-0.5 flex-1"
        >
          {EDGE_KIND_OPTIONS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onCreateEdge(neighbor.memoryId, kind)
            setBusy(false)
          }}
          className="text-[10px] px-2 py-0.5 rounded text-[var(--color-accent)] hover:bg-[var(--color-accent-glow)] disabled:opacity-40"
        >
          建边
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onSupersede(neighbor.memoryId)
            setBusy(false)
          }}
          className="text-[10px] px-2 py-0.5 rounded text-amber-400 hover:bg-amber-400/10 disabled:opacity-40"
        >
          被此取代
        </button>
      </div>
    </div>
  )
}

interface ClusterMember {
  id: string
  type: string
  title: string
  status: string
  confidence: number
  updatedAt: string
}

interface MemoryCluster {
  size: number
  suggestedWinnerId?: string
  members: ClusterMember[]
}

function GovernanceView() {
  const [loading, setLoading] = useState(true)
  const [clusters, setClusters] = useState<MemoryCluster[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ total: number; memoriesInClusters: number }>({
    total: 0,
    memoriesInClusters: 0,
  })
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false)

  const load = useCallback((force = false) => {
    setLoading(true)
    setReason(null)
    setSelectedIdx(null)
    apiFetch<{
      clusters: MemoryCluster[]
      total: number
      memoriesInClusters: number
      reason?: string
    }>(`/api/memory/clusters${force ? '?fresh=1' : ''}`)
      .then((res) => {
        setClusters(res.clusters)
        setSummary({ total: res.total, memoriesInClusters: res.memoriesInClusters })
        if (res.clusters.length === 0) setReason(res.reason ?? '没有发现近重复簇')
      })
      .catch(() => setReason('聚类获取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = selectedIdx != null ? (clusters[selectedIdx] ?? null) : null
  const winnerTitle = (cluster: MemoryCluster) =>
    cluster.members.find((member) => member.id === cluster.suggestedWinnerId)?.title ??
    cluster.members[0]?.title ??
    '—'

  function markArchivedLocal(ids: string[]) {
    const idSet = new Set(ids)
    setClusters((prev) =>
      prev.map((cluster) => ({
        ...cluster,
        members: cluster.members.map((member) =>
          idSet.has(member.id) ? { ...member, status: 'archived' } : member,
        ),
      })),
    )
  }

  async function archiveMember(member: ClusterMember, winnerId?: string) {
    setBusy(true)
    try {
      if (winnerId) {
        await apiPost(`/api/memory/${member.type}/${member.id}/supersede`, {
          bySupersededId: winnerId,
        })
      } else {
        await apiPost(`/api/memory/${member.type}/${member.id}/archive`, {})
      }
      markArchivedLocal([member.id])
    } catch {
      // ignore
    }
    setBusy(false)
  }

  async function archiveAllLosers() {
    if (!selected) return
    setBusy(true)
    const winnerId = selected.suggestedWinnerId
    const losers = selected.members.filter(
      (member) => member.id !== winnerId && member.status !== 'archived',
    )
    for (const member of losers) {
      try {
        if (winnerId) {
          await apiPost(`/api/memory/${member.type}/${member.id}/supersede`, {
            bySupersededId: winnerId,
          })
        } else {
          await apiPost(`/api/memory/${member.type}/${member.id}/archive`, {})
        }
      } catch {
        // ignore individual failures
      }
    }
    markArchivedLocal(losers.map((member) => member.id))
    setBusy(false)
    setConfirmArchiveAll(false)
  }

  const loserCount = selected
    ? selected.members.filter(
        (member) => member.id !== selected.suggestedWinnerId && member.status !== 'archived',
      ).length
    : 0

  return (
    <div className="space-y-4">
      <div className="card p-4 flex items-center gap-8">
        <div>
          <div className="text-[24px] font-bold tracking-tight">{summary.total}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">近重复簇</div>
        </div>
        <div>
          <div className="text-[24px] font-bold tracking-tight">{summary.memoriesInClusters}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">条记忆落在簇里</div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading || busy}
          className="ml-auto text-[12px] px-3 py-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-white/[0.05] disabled:opacity-40 transition-colors"
        >
          刷新聚类
        </button>
      </div>

      {loading ? (
        <p className="text-[13px] text-[var(--color-text-muted)] px-1">
          聚类计算中…（全库 O(n²) 暴力比对，可能要几秒）
        </p>
      ) : reason ? (
        <div className="card p-6 text-center">
          <p className="text-[13px] text-[var(--color-text-muted)]">{reason}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
          <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
            {clusters.map((cluster, index) => (
              <button
                key={`${cluster.suggestedWinnerId ?? 'c'}-${index}`}
                type="button"
                onClick={() => setSelectedIdx(index)}
                className={`w-full text-left card p-3 transition-colors ${
                  selectedIdx === index
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]'
                    : 'hover:bg-white/[0.02]'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[var(--color-text-muted)]">
                    {cluster.size} 条
                  </span>
                </div>
                <p className="text-[12px] text-[var(--color-text-primary)] truncate">
                  {winnerTitle(cluster)}
                </p>
              </button>
            ))}
          </div>

          <div className="card p-6">
            {selected ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                    簇：{selected.size} 条
                  </h2>
                  {loserCount > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmArchiveAll(true)}
                      className="text-[11px] px-2 py-1 rounded-md text-amber-400 hover:bg-amber-400/10 disabled:opacity-40 transition-colors"
                    >
                      归档全部非权威条（{loserCount}）
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-[var(--color-text-disabled)] mb-3">
                  默认共存；裁决均为可逆归档（标记被权威取代），不删除任何记忆。
                </p>
                <div className="space-y-1.5">
                  {selected.members.map((member) => {
                    const isWinner = member.id === selected.suggestedWinnerId
                    return (
                      <div key={member.id} className="card p-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          {isWinner && (
                            <span className="text-amber-400 text-[12px]" title="建议权威条">
                              ★
                            </span>
                          )}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[member.type] ?? ''} ${typeColors[member.type] ?? 'text-slate-400'}`}
                          >
                            {member.type}
                          </span>
                          <StatusPill status={member.status} />
                          <span className="text-[10px] text-[var(--color-text-disabled)] ml-auto">
                            conf {member.confidence.toFixed(2)}
                          </span>
                        </div>
                        <p className="text-[12px] text-[var(--color-text-primary)]">
                          {member.title}
                        </p>
                        {!isWinner && member.status !== 'archived' && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => archiveMember(member, selected.suggestedWinnerId)}
                              className="text-[10px] px-2 py-0.5 rounded text-amber-400 hover:bg-amber-400/10 disabled:opacity-40"
                            >
                              被权威取代
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => archiveMember(member)}
                              className="text-[10px] px-2 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-white/[0.05] disabled:opacity-40"
                            >
                              归档
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-[var(--color-text-muted)]">
                选择左侧一个簇，查看成员与裁决建议。
              </p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmArchiveAll}
        title="归档全部非权威条？"
        description={
          selected
            ? `将把该簇中除建议权威条外的 ${loserCount} 条标记为「被权威取代」并归档（可逆，不删除）。`
            : undefined
        }
        confirmText="归档"
        onConfirm={archiveAllLosers}
        onCancel={() => setConfirmArchiveAll(false)}
      />
    </div>
  )
}

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

function MemoryBrowsePanel({
  selectedType,
  statusFilter,
  sortBy,
  search,
  loading,
  fold,
  filteredMemories,
  clusterGroups,
  selectedId,
  expandedClusters,
  onTypeChange,
  onStatusFilterChange,
  onSortChange,
  onSearchChange,
  onFoldChange,
  onSelectMemory,
  onToggleCluster,
}: {
  selectedType: string
  statusFilter: string
  sortBy: SortKey
  search: string
  loading: boolean
  fold: boolean
  filteredMemories: MemoryItem[]
  clusterGroups: [string, MemoryItem[]][] | null
  selectedId: string | null
  expandedClusters: Set<string>
  onTypeChange: (type: string) => void
  onStatusFilterChange: (status: string) => void
  onSortChange: (sort: SortKey) => void
  onSearchChange: (value: string) => void
  onFoldChange: (fold: boolean) => void
  onSelectMemory: (memory: MemoryItem) => void
  onToggleCluster: (key: string) => void
}) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <MagnifyingGlass
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
        />
        <input
          type="text"
          placeholder="Search memories..."
          className="input-field w-full pl-9"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onTypeChange('all')}
          className={`rounded-md px-2.5 py-1 text-[11px] tracking-wide transition-colors ${
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
            onClick={() => onTypeChange(type)}
            className={`rounded-md px-2.5 py-1 text-[11px] tracking-wide transition-colors ${
              selectedType === type
                ? `${typeBgColors[type] ?? ''} ${typeColors[type] ?? ''}`
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <select
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value)}
          className="input-field flex-1 text-[12px]"
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status === 'all' ? 'All statuses' : status}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(event) => onSortChange(event.target.value as SortKey)}
          className="input-field flex-1 text-[12px]"
        >
          {SORT_OPTIONS.map((sortOption) => (
            <option key={sortOption.key} value={sortOption.key}>
              {sortOption.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={fold}
            onChange={(event) => onFoldChange(event.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          按主题折叠
        </label>
        {fold && (
          <p className="mt-1 text-[10px] text-[var(--color-text-disabled)]">
            临时按「会话 + 类型」分组（语义聚类未就绪，对跨会话重复无效）
          </p>
        )}
      </div>

      {loading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 5 }, (_, index) => `memory-loading-${index}`).map((key) => (
            <div key={key} className="card p-3">
              <div className="mb-2 flex items-center gap-2">
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
      ) : clusterGroups ? (
        <div className="max-h-[600px] space-y-1.5 overflow-y-auto">
          {clusterGroups.map(([key, group]) =>
            group.length === 1 ? (
              <MemoryCard
                key={key}
                mem={group[0]}
                isSelected={selectedId === group[0].id}
                onSelect={() => onSelectMemory(group[0])}
              />
            ) : (
              <ClusterCard
                key={key}
                group={group}
                selectedId={selectedId}
                onSelect={onSelectMemory}
                expanded={expandedClusters.has(key)}
                onToggleExpand={() => onToggleCluster(key)}
              />
            ),
          )}
        </div>
      ) : (
        <div className="max-h-[600px] space-y-1.5 overflow-y-auto">
          {filteredMemories.map((memory) => (
            <MemoryCard
              key={memory.id}
              mem={memory}
              isSelected={selectedId === memory.id}
              onSelect={() => onSelectMemory(memory)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MemoryDetailPanel({
  selected,
  memories,
  editing,
  editContent,
  editSaving,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditContentChange,
  onVerifyMemory,
  onArchiveRequest,
  onSelectMemory,
  onCreateEdge,
  onSupersede,
}: {
  selected: MemoryItem | null
  memories: MemoryItem[]
  editing: boolean
  editContent: string
  editSaving: boolean
  onStartEdit: () => void
  onSaveEdit: () => Promise<void>
  onCancelEdit: () => void
  onEditContentChange: (content: string) => void
  onVerifyMemory: () => Promise<void>
  onArchiveRequest: () => void
  onSelectMemory: (memory: MemoryItem) => void
  onCreateEdge: (toId: string, kind: string) => Promise<void>
  onSupersede: (byId: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const sessionDetailId = selected?.type === 'session' ? selected.sessionId : undefined

  return (
    <div className="card p-6">
      {selected ? (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-[11px] ${typeBgColors[selected.type] ?? ''} ${typeColors[selected.type] ?? ''}`}
              >
                {selected.type}
              </span>
              <StatusPill status={selected.status} />
              <ConfidenceDots value={selected.confidence} />
            </div>
            {!editing ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onStartEdit}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.05] hover:text-[var(--color-accent)]"
                >
                  <PencilSimple size={12} />
                  Edit
                </button>
                {selected.status !== 'verified' && (
                  <button
                    type="button"
                    onClick={onVerifyMemory}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-emerald-400/10 hover:text-emerald-400"
                  >
                    <SealCheck size={12} />
                    Verify
                  </button>
                )}
                {selected.status !== 'archived' && (
                  <button
                    type="button"
                    onClick={onArchiveRequest}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-amber-400/10 hover:text-amber-400"
                  >
                    <Archive size={12} />
                    Archive
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onSaveEdit}
                  disabled={editSaving}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-emerald-400 transition-colors hover:bg-emerald-400/10 disabled:opacity-40"
                >
                  <Check size={12} />
                  {editSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.05]"
                >
                  <X size={12} />
                  Cancel
                </button>
              </div>
            )}
          </div>

          <h2 className="mb-2 text-[16px] font-semibold text-[var(--color-text-primary)]">
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
            <div className="mb-3 flex flex-wrap gap-1">
              {selected.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {!editing && (selected.edges?.length || selected.supersededBy || selected.mergedInto) ? (
            <div className="mb-3 space-y-1.5 border-t border-[var(--color-border)] pt-3">
              <p className="text-[11px] font-semibold tracking-wide text-[var(--color-text-disabled)]">
                关联与演进
              </p>
              {selected.supersededBy && (
                <RelationRow
                  label="已被取代"
                  targetId={selected.supersededBy}
                  target={memories.find((memory) => memory.id === selected.supersededBy)}
                  onJump={() => {
                    const target = memories.find((memory) => memory.id === selected.supersededBy)
                    if (target) onSelectMemory(target)
                  }}
                />
              )}
              {selected.mergedInto && (
                <RelationRow
                  label="已并入"
                  targetId={selected.mergedInto}
                  target={memories.find((memory) => memory.id === selected.mergedInto)}
                  onJump={() => {
                    const target = memories.find((memory) => memory.id === selected.mergedInto)
                    if (target) onSelectMemory(target)
                  }}
                />
              )}
              {selected.edges?.map((edge) => {
                const target = memories.find((memory) => memory.id === edge.toId)
                return (
                  <RelationRow
                    key={`${edge.kind}:${edge.toId}`}
                    label={EDGE_KIND_LABELS[edge.kind] ?? edge.kind}
                    targetId={edge.toId}
                    target={target}
                    onJump={target ? () => onSelectMemory(target) : undefined}
                  />
                )
              })}
            </div>
          ) : null}

          {!editing && (
            <div className="mb-3">
              <NeighborPicker
                memory={selected}
                onCreateEdge={onCreateEdge}
                onSupersede={onSupersede}
              />
            </div>
          )}
          {editing ? (
            <textarea
              value={editContent}
              onChange={(event) => onEditContentChange(event.target.value)}
              className="min-h-[300px] w-full resize-none rounded-lg border border-[var(--color-border)] bg-transparent p-3 font-mono text-[13px] text-[var(--color-text-primary)] outline-none"
              spellCheck={false}
            />
          ) : (
            <div className="whitespace-pre-wrap font-mono text-[13px] text-[var(--color-text-secondary)]">
              {selected.content}
            </div>
          )}
        </div>
      ) : (
        <MemoryOverview memories={memories} />
      )}
    </div>
  )
}
