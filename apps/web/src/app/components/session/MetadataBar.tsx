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

  const displayTitle = summary || sessionId
  const showSessionId = Boolean(summary && summary !== sessionId)
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
      <div className="absolute inset-0 bg-[linear-gradient(110deg,rgba(10,16,24,0.96),rgba(9,11,16,0.94)),radial-gradient(circle_at_top_left,rgba(34,211,238,0.1),transparent_34%)]" />
      <div className="relative px-3 py-2.5 sm:px-4">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {placement && (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${getPlacementBadgeClass(placement)}`}
                >
                  {placement}
                </span>
              )}
              {typeof isCurrent === 'boolean' && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">
                  {isCurrent ? 'bound' : 'history'}
                </span>
              )}
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-secondary)]">
                {source}
              </span>
              {channelName || channelId ? (
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-secondary)]">
                  {channelName ?? channelId}
                </span>
              ) : null}
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2
                className="min-w-0 max-w-4xl truncate text-[18px] font-semibold leading-tight text-[var(--color-text-primary)] sm:text-[20px]"
                title={displayTitle}
              >
                {displayTitle}
              </h2>
              {showSessionId ? (
                <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                  {sessionId}
                </span>
              ) : null}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
              <span className="inline-flex items-center gap-1">
                <Clock size={12} className="shrink-0" />
                {formatTimeRange(createdAt, updatedAt)}
              </span>
              {currentModel && (
                <>
                  <span className="text-[var(--color-text-disabled)]">·</span>
                  <span className="font-mono text-[var(--color-text-secondary)]">
                    {currentModel}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              onClick={() => setDetailsExpanded((current) => !current)}
              aria-expanded={detailsExpanded}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-white/18 hover:text-[var(--color-text-primary)]"
            >
              {detailsExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
              Session Stats
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-400/25 bg-red-400/6 px-2.5 text-[11px] text-red-200 transition-colors hover:border-red-400/45 hover:bg-red-400/12"
            >
              <Trash size={13} />
              Delete
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/8 pt-2">
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
            detail={`${formatNumber(cacheReadTokens)} read · ${formatNumber(cacheWriteTokens)} write`}
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
          <span className="text-[10px] text-[var(--color-text-muted)]">
            effective input {formatNumber(effectiveInputTokens)}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            reasoning {formatNumber(reasoningTokens)}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            aux {formatCost(auxiliaryCost)}
          </span>
          {compactPurposeSummary ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {compactPurposeSummary}
            </span>
          ) : null}
        </div>

        {detailsExpanded && (
          <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="rounded-xl border border-white/8 bg-black/15 p-3">
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

            <div className="rounded-xl border border-white/8 bg-black/15 p-3">
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
    <div className="inline-flex min-w-fit items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
        {label}
      </span>
      <span className="text-[14px] font-semibold leading-none text-[var(--color-text-primary)]">
        {value}
      </span>
      <span className="max-w-[120px] truncate text-[10px] leading-4 text-[var(--color-text-muted)]">
        {detail}
      </span>
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
