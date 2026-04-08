import { Archive, Clock, CurrencyDollar, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { apiDelete, apiPost } from '../../lib/api'
import { formatCost, formatModelHistory, formatNumber, formatTimeRange } from '../../lib/format'
import { useUIStore } from '../../stores/ui'
import { ConfirmDialog } from '../shared/ConfirmDialog'

interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

interface Props {
  sessionId: string
  summary?: string
  source: string
  createdAt: string
  updatedAt: string
  modelHistory: ModelHistoryEntry[]
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  effectiveInputTokens: number
  cacheHitRate: number
  totalCost: number
  auxiliaryCost: number
  purposeBreakdown: Array<{
    purpose: string
    totalCost: number
    totalTokens: number
    reasoningTokens: number
    requestCount: number
  }>
  onArchived?: () => void
  onDeleted?: () => void
}

export function MetadataBar({
  sessionId,
  summary,
  source,
  createdAt,
  updatedAt,
  modelHistory,
  requestCount,
  totalTokens,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  reasoningTokens,
  effectiveInputTokens,
  cacheHitRate,
  totalCost,
  auxiliaryCost,
  purposeBreakdown,
  onArchived,
  onDeleted,
}: Props) {
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const { addToast } = useUIStore()
  const canArchive = typeof onArchived === 'function'
  const canDelete = typeof onDeleted === 'function'
  const purposeBreakdownTitle = purposeBreakdown
    .filter((row) => row.totalCost > 0 || row.requestCount > 0)
    .map(
      (row) =>
        `${row.purpose}: ${formatCost(row.totalCost)} · ${formatNumber(row.totalTokens)} tokens · ${row.requestCount} calls`,
    )
    .join('\n')

  async function handleArchive() {
    await apiPost(`/api/sessions/${sessionId}/archive`, {})
    addToast('success', 'Session 已归档')
    setShowArchiveConfirm(false)
    onArchived?.()
  }

  async function handleDelete() {
    await apiDelete(`/api/sessions/${sessionId}`)
    addToast('success', 'Session 已删除')
    setShowDeleteConfirm(false)
    onDeleted?.()
  }

  return (
    <div className="card p-4 animate-fade-up">
      {/* Title row */}
      <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
            {summary || sessionId}
          </h2>
          <p className="text-[12px] text-[var(--color-text-muted)] mt-0.5">
            <span className="capitalize">{source}</span>
            {' · '}
            <Clock size={12} className="inline -mt-0.5" /> {formatTimeRange(createdAt, updatedAt)}
          </p>
        </div>
        {(canArchive || canDelete) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {canDelete && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="px-3 py-1.5 rounded-md text-[11px] text-red-400/70 border border-red-400/20 hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/5 transition-colors flex items-center gap-1.5"
              >
                <Trash size={14} />
                Delete
              </button>
            )}
            {canArchive && (
              <button
                type="button"
                onClick={() => setShowArchiveConfirm(true)}
                className="px-3 py-1.5 rounded-md text-[11px] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:text-red-400 hover:border-red-400/30 transition-colors flex items-center gap-1.5"
              >
                <Archive size={14} />
                Archive
              </button>
            )}
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-[var(--color-text-muted)] flex-wrap">
        <span className="font-mono">{formatModelHistory(modelHistory)}</span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span>{requestCount} calls</span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span>
          {formatNumber(totalTokens)} tokens
          <span className="text-[var(--color-text-disabled)]">
            {' '}
            ({formatNumber(inputTokens)} in / {formatNumber(outputTokens)} out)
          </span>
        </span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span>
          cache {formatNumber(cacheReadTokens)} read / {formatNumber(cacheWriteTokens)} write
        </span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span>reasoning {formatNumber(reasoningTokens)}</span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span>
          eff {formatNumber(effectiveInputTokens)} · {(cacheHitRate * 100).toFixed(0)}% hit
        </span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span className="flex items-center gap-0.5">
          <CurrencyDollar size={12} />
          {formatCost(totalCost)}
        </span>
        <span className="text-[var(--color-text-disabled)]">·</span>
        <span
          title={purposeBreakdownTitle || undefined}
          className={purposeBreakdownTitle ? 'cursor-help' : undefined}
        >
          aux {formatCost(auxiliaryCost)}
        </span>
      </div>

      {canArchive && (
        <ConfirmDialog
          open={showArchiveConfirm}
          title="归档此 Session？"
          description="归档后 Session 将从活跃列表中移除，历史数据仍可查看。"
          confirmText="归档"
          danger
          onConfirm={handleArchive}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}

      {canDelete && (
        <ConfirmDialog
          open={showDeleteConfirm}
          title="删除此 Session？"
          description="删除后 Session 及其关联的记忆数据将被永久移除，无法恢复。"
          confirmText="删除"
          danger
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
