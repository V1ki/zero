import { Brain } from '@phosphor-icons/react'
import { formatTime } from '../../../lib/format'
import type { DecisionTimelineItem } from './timeline'

export function getDecisionPreviewText(
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

/** One chip per decision type, with a count when it repeats. */
export function decisionThinkingChips(decisions: readonly DecisionTimelineItem[]): string[] {
  const counts = new Map<string, number>()
  for (const decision of decisions) {
    counts.set(decision.decisionType, (counts.get(decision.decisionType) ?? 0) + 1)
  }
  return [...counts.entries()].map(([type, count]) => (count > 1 ? `${type} ×${count}` : type))
}

interface DecisionThinkingListProps {
  decisions: DecisionTimelineItem[]
  selectedDecisionId?: string | null
  onSelectDecision?: (id: string | null) => void
}

/**
 * Compact decision rows rendered inside an assistant or sub-agent thinking
 * section; selecting a row opens the shared decision detail panel.
 */
export function DecisionThinkingList({
  decisions,
  selectedDecisionId = null,
  onSelectDecision,
}: DecisionThinkingListProps) {
  return (
    <div className="space-y-1">
      {decisions.map((decision) => {
        const selected = selectedDecisionId === decision.id
        const previewText = getDecisionPreviewText(
          decision.decisionType,
          decision.outcome,
          decision.detail,
        )
        return (
          <button
            key={decision.id}
            type="button"
            data-decision-id={decision.id}
            aria-pressed={selected}
            onClick={() => onSelectDecision?.(selected ? null : decision.id)}
            className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              selected
                ? 'border-cyan-400/35 bg-cyan-400/8'
                : 'border-transparent hover:border-white/10 hover:bg-white/[0.04]'
            }`}
          >
            <Brain size={12} className="shrink-0 text-violet-300/80" />
            <span className="shrink-0 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-violet-300/90">
              {decision.decisionType}
            </span>
            <span className="shrink-0 rounded bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-mono text-cyan-300">
              {decision.outcome}
            </span>
            {previewText !== decision.outcome ? (
              <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-[var(--color-text-muted)]">
                {previewText}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <span className="shrink-0 text-[10px] font-mono text-[var(--color-text-disabled)]">
              {formatTime(decision.createdAt)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
