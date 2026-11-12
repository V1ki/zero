import { ArrowsClockwise } from '@phosphor-icons/react'
import type { ContextCheckpoint } from '@zero-os/shared'
import { formatNumber, formatTime, formatTimeAgo } from '../../../lib/format'
import { MarkdownText } from '../trajectory/primitives'

const chipClass =
  'rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]'

/** Same tags the summary prompt asks for: fixed `##` sections, lists and inline code. */
const markdownClass =
  'text-[11px] leading-5 text-[var(--color-text-secondary)] [&_h1]:mt-3 [&_h1]:text-[12px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.12em] [&_h2]:text-sky-200 [&_h2:first-child]:mt-0 [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-black/25 [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/25 [&_pre]:p-2'

/**
 * The context checkpoint currently in effect: the rolling summary that
 * replaces a prefix of the canonical history plus the prune watermark
 * (docs/context-compaction.md). `timeline` renders the collapsible marker
 * placed after the last summarized message; `panel` the context-panel card.
 */
export function ContextCheckpointCard({
  checkpoint,
  variant,
}: {
  checkpoint: ContextCheckpoint
  variant: 'panel' | 'timeline'
}) {
  const facts = (
    <>
      <span className={chipClass}>gen {checkpoint.generation}</span>
      <span className={chipClass}>
        {checkpoint.summary === undefined
          ? 'no summary'
          : `replaces ${checkpoint.coveredMessageCount} messages`}
      </span>
      <span className={chipClass}>
        tokens {formatNumber(checkpoint.tokensBefore)} → {formatNumber(checkpoint.tokensAfter)}
      </span>
    </>
  )
  const details = (
    <div className="mt-2 space-y-1 text-[11px] font-mono text-[var(--color-text-disabled)]">
      <div className="truncate" title={checkpoint.prunedThroughMessageId}>
        pruned through {checkpoint.prunedThroughMessageId ?? '—'}
      </div>
      {checkpoint.summarizedThroughMessageId !== undefined && (
        <div className="truncate" title={checkpoint.summarizedThroughMessageId}>
          summarized through {checkpoint.summarizedThroughMessageId}
        </div>
      )}
      {checkpoint.model && (
        <div className="truncate" title={checkpoint.model.promptVersion}>
          model {checkpoint.model.model} · {checkpoint.model.provider}
        </div>
      )}
      <div title={checkpoint.createdAt}>
        created {formatTime(checkpoint.createdAt)} ({formatTimeAgo(checkpoint.createdAt)})
      </div>
    </div>
  )
  const summary =
    checkpoint.summary === undefined ? null : (
      <div className="mt-2 rounded-lg border border-white/10 bg-black/15 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
          Summary
        </div>
        <div
          data-testid="context-checkpoint-summary"
          className={`mt-2 max-h-80 overflow-auto ${markdownClass}`}
        >
          <MarkdownText text={checkpoint.summary} />
        </div>
      </div>
    )

  if (variant === 'timeline') {
    return (
      <details
        data-testid="timeline-context-checkpoint"
        className="rounded-[14px] border border-sky-300/20 bg-sky-300/[0.05] px-3 py-2"
      >
        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
          <ArrowsClockwise size={14} weight="bold" className="text-sky-300" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300">
            context_checkpoint
          </span>
          {facts}
          <span className={chipClass}>{formatTime(checkpoint.createdAt)}</span>
        </summary>
        {details}
        {summary}
      </details>
    )
  }

  return (
    <div
      data-testid="context-checkpoint-panel"
      className="rounded-lg border border-sky-300/20 bg-sky-300/[0.05] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-sky-300" />
        <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-2 py-0.5 text-[10px] font-semibold text-sky-200">
          in effect
        </span>
        {facts}
      </div>
      {details}
      {summary}
    </div>
  )
}
