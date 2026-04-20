import { ArrowsClockwise } from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'
import type { DecisionTimelineItem } from './timeline'

interface Props {
  id: string
  decisionType: DecisionTimelineItem['decisionType']
  outcome: string
  detail?: Record<string, unknown>
  createdAt?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

export function DecisionBlock({
  id,
  decisionType,
  outcome,
  detail,
  createdAt,
  selected,
  onSelect,
}: Props) {
  const previewText = getDecisionPreviewText(decisionType, outcome, detail)

  return (
    <button
      type="button"
      data-decision-id={id}
      aria-pressed={selected}
      onClick={() => onSelect?.(id)}
      className={`w-full rounded-[20px] border px-4 py-3 text-left ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-cyan-400/8 ring-1 ring-cyan-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(17,25,36,0.92),rgba(11,15,24,0.82))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-cyan-400" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-cyan-300">
          {decisionType}
        </span>
        {createdAt && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
            {formatTime(createdAt)}
          </span>
        )}
        <span className="flex-1" />
        <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-cyan-400/10 text-cyan-300">
          {outcome}
        </span>
      </div>
      <p className="mt-2 text-[12px] font-mono text-[var(--color-text-muted)] truncate">
        {previewText}
      </p>
    </button>
  )
}

function getDecisionPreviewText(
  decisionType: DecisionTimelineItem['decisionType'],
  outcome: string,
  detail?: Record<string, unknown>,
): string {
  if (decisionType === 'context_compression') {
    const before = typeof detail?.messagesBefore === 'number' ? detail.messagesBefore : undefined
    const after = typeof detail?.messagesAfter === 'number' ? detail.messagesAfter : undefined
    const model = typeof detail?.model === 'string' ? detail.model : undefined
    const cost = typeof detail?.cost === 'number' ? `$${detail.cost.toFixed(4)}` : undefined

    const parts: string[] = []
    if (before !== undefined && after !== undefined) {
      parts.push(`messages ${before} -> ${after}`)
    }
    if (model) parts.push(model)
    if (cost) parts.push(cost)

    if (parts.length > 0) return parts.join(' | ')
  }

  if (decisionType === 'memory_retrieval') {
    const queries = Array.isArray(detail?.queries)
      ? detail.queries.filter((query): query is string => typeof query === 'string')
      : []

    if (queries.length > 0) {
      return queries.join(' | ')
    }
  }

  if (decisionType === 'tool_selection') {
    const selectedTools = Array.isArray(detail?.selectedTools)
      ? detail.selectedTools.filter((tool): tool is string => typeof tool === 'string')
      : []

    if (selectedTools.length > 0) {
      return selectedTools.join(' | ')
    }
  }

  return outcome
}
