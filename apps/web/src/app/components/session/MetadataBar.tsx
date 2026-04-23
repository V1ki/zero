import { CaretDown, CaretRight, Clock, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { apiDelete } from '../../lib/api'
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
  isCurrent?: boolean
  placement?: 'current' | 'background'
  currentModel?: string
  channelName?: string
  channelId?: string
  createdAt: string
  updatedAt: string
  modelHistory: ModelHistoryEntry[]
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens?: number
  effectiveInputTokens: number
  cacheHitRate: number
  totalCost: number
  auxiliaryCost?: number
  purposeBreakdown?: Array<{
    purpose: string
    totalCost: number
    totalTokens: number
    reasoningTokens: number
    requestCount: number
  }>
  toolCallCount?: number
  decisionCount?: number
  taskClosureCount?: number
  timelineCount?: number
  systemEventCount?: number
  subAgentCount?: number
  onDeleted?: () => void
}

export function MetadataBar({
  sessionId,
  summary,
  source,
  isCurrent,
  placement,
  currentModel,
  channelName,
  channelId,
  createdAt,
  updatedAt,
  modelHistory,
  requestCount,
  totalTokens,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  reasoningTokens = 0,
  effectiveInputTokens,
  cacheHitRate,
  totalCost,
  auxiliaryCost = 0,
  purposeBreakdown = [],
  toolCallCount = 0,
  decisionCount = 0,
  taskClosureCount = 0,
  timelineCount = 0,
  systemEventCount = 0,
  subAgentCount = 0,
  onDeleted,
}: Props) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const { addToast } = useUIStore()

  const activePurposes = purposeBreakdown.filter((row) => row.totalCost > 0 || row.requestCount > 0)
  const compactPurposeSummary = activePurposes
    .slice(0, 2)
    .map((row) => `${row.purpose}: ${formatCost(row.totalCost)}`)
    .join(' · ')

  async function handleDelete() {
    await apiDelete(`/api/sessions/${sessionId}`)
    addToast('success', 'Session 已删除')
    setShowDeleteConfirm(false)
    onDeleted?.()
  }

  return (
    <div data-testid="session-hero" className="card relative overflow-hidden p-0">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_36%),linear-gradient(180deg,rgba(13,18,26,0.97),rgba(9,11,16,0.94))]" />
      <div className="relative p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {placement && (
                <span
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${getPlacementBadgeClass(placement)}`}
                >
                  {placement}
                </span>
              )}
              {typeof isCurrent === 'boolean' && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
                  {isCurrent ? 'bound' : 'history'}
                </span>
              )}
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-mono text-[var(--color-text-secondary)]">
                {source}
              </span>
              {channelName || channelId ? (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-mono text-[var(--color-text-secondary)]">
                  {channelName ?? channelId}
                </span>
              ) : null}
            </div>

            <h2 className="mt-3 max-w-4xl text-[18px] font-semibold leading-tight text-[var(--color-text-primary)] sm:text-[22px]">
              {summary || sessionId}
            </h2>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
              <span className="font-mono text-[var(--color-text-secondary)]">{sessionId}</span>
              <span className="text-[var(--color-text-disabled)]">·</span>
              <span className="inline-flex items-center gap-1">
                <Clock size={12} className="shrink-0" />
                {formatTimeRange(createdAt, updatedAt)}
              </span>
              {currentModel && (
                <>
                  <span className="text-[var(--color-text-disabled)]">·</span>
                  <span className="font-mono text-[var(--color-text-secondary)]">{currentModel}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-xl border border-red-400/25 bg-red-400/6 px-3 py-2 text-[11px] text-red-200 transition-colors hover:border-red-400/45 hover:bg-red-400/12"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Trash size={14} />
                  Delete
                </span>
              </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <MetricPill
            label="Requests"
            value={String(requestCount)}
            detail={`${toolCallCount} tools`}
          />
          <MetricPill
            label="Tokens"
            value={formatNumber(totalTokens)}
            detail={`${formatNumber(inputTokens)} in · ${formatNumber(outputTokens)} out`}
          />
          <MetricPill
            label="Cache"
            value={`${(cacheHitRate * 100).toFixed(0)}%`}
            detail={`${formatNumber(cacheReadTokens)} read`}
          />
          <MetricPill
            label="Spend"
            value={`$${formatCost(totalCost)}`}
            detail={`aux ${formatCost(auxiliaryCost)}`}
          />
          <MetricPill
            label="Timeline"
            value={formatNumber(timelineCount)}
            detail={`${taskClosureCount} closure · ${subAgentCount} sub-agent`}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-white/8 pt-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
            <span>effective input {formatNumber(effectiveInputTokens)}</span>
            <span>reasoning {formatNumber(reasoningTokens)}</span>
            <span>aux {formatCost(auxiliaryCost)}</span>
            {compactPurposeSummary ? <span>{compactPurposeSummary}</span> : null}
          </div>

          <button
            type="button"
            onClick={() => setDetailsExpanded((current) => !current)}
            aria-expanded={detailsExpanded}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            {detailsExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
            More Session Stats
          </button>
        </div>

        {detailsExpanded && (
          <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="rounded-[20px] border border-white/8 bg-black/15 p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
                Model Route
              </p>
              <p className="mt-2 text-[12px] font-mono leading-6 text-[var(--color-text-secondary)]">
                {formatModelHistory(modelHistory)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-muted)]">
                <span>effective input {formatNumber(effectiveInputTokens)}</span>
                <span className="text-[var(--color-text-disabled)]">·</span>
                <span>reasoning {formatNumber(reasoningTokens)}</span>
                <span className="text-[var(--color-text-disabled)]">·</span>
                <span>decisions {decisionCount}</span>
                <span className="text-[var(--color-text-disabled)]">·</span>
                <span>system {systemEventCount}</span>
              </div>
            </div>

            <div className="rounded-[20px] border border-white/8 bg-black/15 p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
                Purpose Breakdown
              </p>
              {activePurposes.length === 0 ? (
                <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
                  No purpose-specific usage has been persisted yet.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {activePurposes.slice(0, 4).map((row) => (
                    <div
                      key={row.purpose}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
                          {row.purpose}
                        </p>
                        <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                          {formatNumber(row.totalTokens)} tokens · {row.requestCount} calls
                        </p>
                      </div>
                      <p className="shrink-0 text-[12px] font-mono text-[var(--color-text-secondary)]">
                        ${formatCost(row.totalCost)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="删除此 Session？"
        description="删除后 Session 及其关联的记忆数据将被永久移除，无法恢复。"
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}

function MetricPill({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="min-w-[132px] rounded-[18px] border border-white/8 bg-black/15 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
        {label}
      </p>
      <p className="mt-1.5 text-[17px] font-semibold text-[var(--color-text-primary)]">{value}</p>
      <p className="mt-0.5 text-[10px] leading-5 text-[var(--color-text-muted)]">{detail}</p>
    </div>
  )
}

function getPlacementBadgeClass(placement: 'current' | 'background'): string {
  switch (placement) {
    case 'current':
      return 'border-emerald-400/40 bg-emerald-400/12 text-emerald-200'
    case 'background':
      return 'border-slate-400/30 bg-slate-400/10 text-slate-300'
    default:
      return 'border-white/10 bg-white/5 text-[var(--color-text-secondary)]'
  }
}
