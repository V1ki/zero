import { ArrowsClockwise, Warning } from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'

interface Props {
  id: string
  event: 'task_closure_decision' | 'task_closure_failed'
  action?: 'finish' | 'continue' | 'block'
  reason: string
  error?: string
  createdAt?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

export function TaskClosureBlock({
  id,
  event,
  action,
  reason,
  error,
  createdAt,
  selected,
  onSelect,
}: Props) {
  const isWarning = event === 'task_closure_failed' || action === 'block'
  const Icon = isWarning ? Warning : ArrowsClockwise
  const accentClass = isWarning ? 'text-amber-400' : 'text-cyan-400'
  const badgeClass = isWarning ? 'bg-amber-400/10 text-amber-300' : 'bg-cyan-400/10 text-cyan-300'
  const previewLabel = event === 'task_closure_failed' ? 'failed' : (action ?? 'decision')
  const previewText = `${previewLabel}: ${reason}`
  const detailText = error ? `${previewText} · ${error}` : previewText

  return (
    <button
      type="button"
      data-task-closure-id={id}
      aria-pressed={selected}
      onClick={() => onSelect?.(id)}
      className={`w-full rounded-[20px] border px-4 py-3 text-left ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-cyan-400/8 ring-1 ring-cyan-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(22,20,16,0.92),rgba(11,15,24,0.84))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} weight="bold" className={accentClass} />
        <span className={`text-[11px] font-mono font-semibold uppercase tracking-[0.16em] ${accentClass}`}>
          {event}
        </span>
        {createdAt && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
            {formatTime(createdAt)}
          </span>
        )}
        <span className="flex-1" />
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${badgeClass}`}>
          {previewLabel}
        </span>
      </div>
      <p className="mt-2 text-[12px] font-mono text-[var(--color-text-muted)] truncate">
        {detailText}
      </p>
    </button>
  )
}
