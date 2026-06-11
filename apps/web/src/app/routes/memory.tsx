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
  // 记忆重构方向字段（关联/发展），均可选；聚类未就绪前 topicKey 多为空。
  topicKey?: string
  supersededBy?: string
  mergedInto?: string
  edges?: { toId: string; kind: string }[]
}

// 带类型边（关联柱）的中文标签。
const EDGE_KIND_LABELS: Record<string, string> = {
  'same-as': '重复于',
  subsumes: '包含',
  'same-topic': '同主题',
  supersedes: '取代',
  contradicts: '冲突于',
  'derived-from': '派生自',
}

// 详情面板里的一行关联/演进连边：目标在当前列表里则可点击跳转，否则只显示 id。
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

// 建边时可选的边类型（取代走独立的 supersede 动作，不在此列）。
const EDGE_KIND_OPTIONS: { kind: string; label: string }[] = [
  { kind: 'same-topic', label: '同主题' },
  { kind: 'same-as', label: '重复于' },
  { kind: 'subsumes', label: '包含' },
  { kind: 'contradicts', label: '冲突于' },
  { kind: 'derived-from', label: '派生自' },
]

// P1(关联): 拉取语义近邻，人工挑一条建边 / 标记被其取代。系统不自动建边。
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
        neighbors.map((n) => (
          <NeighborRow
            key={n.memoryId}
            n={n}
            existingKinds={(memory.edges ?? [])
              .filter((e) => e.toId === n.memoryId)
              .map((e) => e.kind)}
            onCreateEdge={onCreateEdge}
            onSupersede={onSupersede}
          />
        ))
      )}
    </div>
  )
}

function NeighborRow({
  n,
  existingKinds,
  onCreateEdge,
  onSupersede,
}: {
  n: Neighbor
  existingKinds?: string[]
  onCreateEdge: (toId: string, kind: string) => Promise<void>
  onSupersede: (byId: string) => Promise<void>
}) {
  // 已建边的近邻：选择器默认其真实边类型（而非笼统的"同主题"），避免显示误导。
  const [kind, setKind] = useState(existingKinds?.[0] ?? 'same-topic')
  const [busy, setBusy] = useState(false)
  return (
    <div className="card p-2 space-y-1">
      <div className="flex items-center gap-2">
        {n.type && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[n.type] ?? ''} ${typeColors[n.type] ?? 'text-slate-400'}`}
          >
            {n.type}
          </span>
        )}
        <span className="text-[11px] text-[var(--color-text-secondary)] truncate flex-1">
          {n.title ?? n.memoryId}
        </span>
        <span className="text-[10px] text-[var(--color-text-disabled)] font-mono shrink-0">
          {n.score.toFixed(2)}
        </span>
      </div>
      {existingKinds && existingKinds.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] text-[var(--color-text-disabled)]">已关联</span>
          {existingKinds.map((k) => (
            <span
              key={k}
              className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-accent-glow)] text-[var(--color-accent)]"
            >
              {EDGE_KIND_LABELS[k] ?? k}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="input-field text-[10px] py-0.5 flex-1"
        >
          {EDGE_KIND_OPTIONS.map((o) => (
            <option key={o.kind} value={o.kind}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onCreateEdge(n.memoryId, kind)
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
            await onSupersede(n.memoryId)
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

// 折叠分组键：优先用 topicKey（语义聚类产物），未就绪时降级为「会话+类型」。
// 降级分组只能折叠"显然同源"的条目，对跨会话语义近重复无效（UI 已标注）。
function clusterKey(m: MemoryItem): string {
  if (m.topicKey) return `topic:${m.topicKey}`
  if (m.sessionId) return `sess:${m.sessionId}|${m.type}`
  return `id:${m.id}`
}

// 权威条排序：verified 最优、archived 最次、其余居中。
// 与设计 3.4 一致——verified 优先于 confidence；updatedAt 已被污染，仅作末位兜底。
function memoryStatusRank(status: string): number {
  if (status === 'verified') return 0
  if (status === 'archived') return 3
  return 1
}

// 簇内挑权威条：状态秩 → 置信度高 → 更新更晚（末位兜底）。
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
  for (const m of items) {
    const k = clusterKey(m)
    const arr = map.get(k)
    if (arr) arr.push(m)
    else map.set(k, [m])
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
  const sides = group.filter((m) => m.id !== cover.id)
  const archivedCount = sides.filter((m) => m.status === 'archived').length
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
          {sides.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(m)}
              className={`w-full text-left text-[11px] py-1 px-1.5 rounded hover:bg-white/[0.03] truncate ${
                m.status === 'archived' ? 'opacity-40' : ''
              } ${selectedId === m.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}
            >
              {m.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 状态展示顺序：verified（生效）在前，archived（已归档/不生效）在后。
const STATUS_ORDER = ['verified', 'draft', 'conflict', 'archived'] as const

function MemoryOverview({ memories }: { memories: MemoryItem[] }) {
  // 按类型统计的同时拆出 verified/archived，让"哪些在生效"一目了然。
  const typeStats: Record<string, { total: number; verified: number; archived: number }> = {}
  const statusCounts: Record<string, number> = {}
  for (const m of memories) {
    const t = (typeStats[m.type] ??= { total: 0, verified: 0, archived: 0 })
    t.total++
    if (m.status === 'verified') t.verified++
    else if (m.status === 'archived') t.archived++
    statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1
  }
  const verifiedCount = statusCounts.verified ?? 0
  const archivedCount = statusCounts.archived ?? 0
  // 已知顺序在前，未知 status 兜底排后
  const statusKeys = [
    ...STATUS_ORDER.filter((s) => statusCounts[s]),
    ...Object.keys(statusCounts).filter(
      (s) => !STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number]),
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
      {/* 生效/归档小结：verified = 当前生效的权威条，archived = 已归档不参与默认检索 */}
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
        {Object.entries(typeStats).map(([type, s]) => (
          <div key={type} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${typeBgColors[type] ?? ''} ${typeColors[type] ?? 'text-slate-400'}`}
              >
                {type}
              </span>
            </div>
            <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
              <span className="text-emerald-400">{s.verified}</span>
              <span className="text-[var(--color-text-disabled)]"> / {s.total}</span>
              {s.archived > 0 ? (
                <span className="text-[11px] text-[var(--color-text-disabled)]">
                  {' '}
                  ({s.archived} arch)
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

// P2(治理): 按需聚类工作台。默认偏共存；裁决均为可逆归档（archive/supersede），不删除。
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
  const winnerTitle = (cl: MemoryCluster) =>
    cl.members.find((m) => m.id === cl.suggestedWinnerId)?.title ?? cl.members[0]?.title ?? '—'

  // 本地把成员标记为已归档（避免每次动作都重跑昂贵的全库聚类）。
  function markArchivedLocal(ids: string[]) {
    const set = new Set(ids)
    setClusters((prev) =>
      prev.map((cl) => ({
        ...cl,
        members: cl.members.map((m) => (set.has(m.id) ? { ...m, status: 'archived' } : m)),
      })),
    )
  }

  async function archiveMember(m: ClusterMember, winnerId?: string) {
    setBusy(true)
    try {
      if (winnerId) {
        await apiPost(`/api/memory/${m.type}/${m.id}/supersede`, { bySupersededId: winnerId })
      } else {
        await apiPost(`/api/memory/${m.type}/${m.id}/archive`, {})
      }
      markArchivedLocal([m.id])
    } catch {
      // ignore
    }
    setBusy(false)
  }

  async function archiveAllLosers() {
    if (!selected) return
    setBusy(true)
    const winnerId = selected.suggestedWinnerId
    const losers = selected.members.filter((m) => m.id !== winnerId && m.status !== 'archived')
    for (const m of losers) {
      try {
        if (winnerId) {
          await apiPost(`/api/memory/${m.type}/${m.id}/supersede`, { bySupersededId: winnerId })
        } else {
          await apiPost(`/api/memory/${m.type}/${m.id}/archive`, {})
        }
      } catch {
        // ignore individual failures
      }
    }
    markArchivedLocal(losers.map((m) => m.id))
    setBusy(false)
    setConfirmArchiveAll(false)
  }

  const loserCount = selected
    ? selected.members.filter((m) => m.id !== selected.suggestedWinnerId && m.status !== 'archived')
        .length
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
            {clusters.map((cl, i) => (
              <button
                key={`${cl.suggestedWinnerId ?? 'c'}-${i}`}
                type="button"
                onClick={() => setSelectedIdx(i)}
                className={`w-full text-left card p-3 transition-colors ${
                  selectedIdx === i
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]'
                    : 'hover:bg-white/[0.02]'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[var(--color-text-muted)]">
                    {cl.size} 条
                  </span>
                </div>
                <p className="text-[12px] text-[var(--color-text-primary)] truncate">
                  {winnerTitle(cl)}
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
                  {selected.members.map((m) => {
                    const isWinner = m.id === selected.suggestedWinnerId
                    return (
                      <div key={m.id} className="card p-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          {isWinner && (
                            <span className="text-amber-400 text-[12px]" title="建议权威条">
                              ★
                            </span>
                          )}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${typeBgColors[m.type] ?? ''} ${typeColors[m.type] ?? 'text-slate-400'}`}
                          >
                            {m.type}
                          </span>
                          <StatusPill status={m.status} />
                          <span className="text-[10px] text-[var(--color-text-disabled)] ml-auto">
                            conf {m.confidence.toFixed(2)}
                          </span>
                        </div>
                        <p className="text-[12px] text-[var(--color-text-primary)]">{m.title}</p>
                        {!isWinner && m.status !== 'archived' && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => archiveMember(m, selected.suggestedWinnerId)}
                              className="text-[10px] px-2 py-0.5 rounded text-amber-400 hover:bg-amber-400/10 disabled:opacity-40"
                            >
                              被权威取代
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => archiveMember(m)}
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

  function toggleCluster(key: string) {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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

  // P0: 用可逆归档替代硬删除。改 status，不物理删除；状态筛选切到 archived 可找回。
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

  // P1(发展): 验证 = 提升到 verified（置信 0.9）。
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

  // P1(关联): 人工建一条带类型的边到目标记忆。
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

  // P1(发展): 标记当前记忆被某条近邻取代（supersededBy + 可逆归档）。
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

  // Apply status filter and sorting
  const filteredMemories = memories
    .filter((m) => statusFilter === 'all' || m.status === statusFilter)
    .sort((a, b) => {
      if (sortBy === 'confidence') return b.confidence - a.confidence
      if (sortBy === 'type') return a.type.localeCompare(b.type)
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  const clusterGroups = fold ? groupByCluster(filteredMemories) : null
  const sessionDetailId = selected?.type === 'session' ? selected.sessionId : undefined

  function selectMemory(mem: MemoryItem) {
    setSelected(mem)
    setEditing(false)
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[20px] font-bold tracking-tight">Memory</h1>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setView('browse')}
            className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
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
            className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
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

            {/* Topic fold toggle (P0: 读时折叠，默认关) */}
            <div>
              <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={fold}
                  onChange={(e) => setFold(e.target.checked)}
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
            ) : clusterGroups ? (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {clusterGroups.map(([key, group]) =>
                  group.length === 1 ? (
                    <MemoryCard
                      key={key}
                      mem={group[0]}
                      isSelected={selected?.id === group[0].id}
                      onSelect={() => selectMemory(group[0])}
                    />
                  ) : (
                    <ClusterCard
                      key={key}
                      group={group}
                      selectedId={selected?.id ?? null}
                      onSelect={selectMemory}
                      expanded={expandedClusters.has(key)}
                      onToggleExpand={() => toggleCluster(key)}
                    />
                  ),
                )}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {filteredMemories.map((mem) => (
                  <MemoryCard
                    key={mem.id}
                    mem={mem}
                    isSelected={selected?.id === mem.id}
                    onSelect={() => selectMemory(mem)}
                  />
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
                    <StatusPill status={selected.status} />
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
                      {selected.status !== 'verified' && (
                        <button
                          type="button"
                          onClick={verifyMemory}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:text-emerald-400 hover:bg-emerald-400/10 transition-colors"
                        >
                          <SealCheck size={12} />
                          Verify
                        </button>
                      )}
                      {selected.status !== 'archived' && (
                        <button
                          type="button"
                          onClick={() => setShowArchiveConfirm(true)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:text-amber-400 hover:bg-amber-400/10 transition-colors"
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
                {!editing &&
                (selected.edges?.length || selected.supersededBy || selected.mergedInto) ? (
                  <div className="mb-3 space-y-1.5 border-t border-[var(--color-border)] pt-3">
                    <p className="text-[11px] text-[var(--color-text-disabled)] tracking-wide font-semibold">
                      关联与演进
                    </p>
                    {selected.supersededBy && (
                      <RelationRow
                        label="已被取代"
                        targetId={selected.supersededBy}
                        target={memories.find((m) => m.id === selected.supersededBy)}
                        onJump={() => {
                          const t = memories.find((m) => m.id === selected.supersededBy)
                          if (t) selectMemory(t)
                        }}
                      />
                    )}
                    {selected.mergedInto && (
                      <RelationRow
                        label="已并入"
                        targetId={selected.mergedInto}
                        target={memories.find((m) => m.id === selected.mergedInto)}
                        onJump={() => {
                          const t = memories.find((m) => m.id === selected.mergedInto)
                          if (t) selectMemory(t)
                        }}
                      />
                    )}
                    {selected.edges?.map((e) => {
                      const t = memories.find((m) => m.id === e.toId)
                      return (
                        <RelationRow
                          key={`${e.kind}:${e.toId}`}
                          label={EDGE_KIND_LABELS[e.kind] ?? e.kind}
                          targetId={e.toId}
                          target={t}
                          onJump={t ? () => selectMemory(t) : undefined}
                        />
                      )
                    })}
                  </div>
                ) : null}
                {!editing && (
                  <div className="mb-3">
                    <NeighborPicker
                      memory={selected}
                      onCreateEdge={createEdge}
                      onSupersede={supersedeBy}
                    />
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
              // 传全量 memories（不受 statusFilter 影响）——Overview 的状态拆分要反映完整集合
              <MemoryOverview memories={memories} />
            )}
          </div>
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
