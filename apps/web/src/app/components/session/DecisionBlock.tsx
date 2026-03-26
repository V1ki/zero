import { ArrowsClockwise } from '@phosphor-icons/react'
import type { DecisionTimelineItem } from './timeline'

interface Props {
  id: string
  decisionType: DecisionTimelineItem['decisionType']
  outcome: string
  detail?: Record<string, unknown>
  selected?: boolean
  onSelect?: (id: string) => void
}

export function DecisionBlock({ id, decisionType, outcome, detail, selected, onSelect }: Props) {
  const previewText = getDecisionPreviewText(decisionType, outcome, detail)

  return (
    <button
      type="button"
      data-decision-id={id}
      aria-pressed={selected}
      onClick={() => onSelect?.(id)}
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-[var(--color-accent)]/30 bg-white/[0.04]'
          : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05]'
      }`}
    >
      <div className="flex items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-cyan-400" />
        <span className="text-[12px] font-mono font-semibold text-cyan-300">{decisionType}</span>
        <span className="flex-1" />
        <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-cyan-400/10 text-cyan-300">
          {outcome}
        </span>
      </div>
      <p className="mt-1 text-[11px] font-mono text-[var(--color-text-muted)] truncate">
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

    if (before !== undefined && after !== undefined) {
      return `messages ${before} -> ${after}`
    }
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
