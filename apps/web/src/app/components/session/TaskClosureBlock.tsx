import { ArrowsClockwise, Warning } from '@phosphor-icons/react'

interface Props {
  id: string
  event: 'task_closure_decision' | 'task_closure_failed'
  action?: 'finish' | 'continue' | 'block'
  reason: string
  error?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

export function TaskClosureBlock({ id, event, action, reason, error, selected, onSelect }: Props) {
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
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-[var(--color-accent)]/30 bg-white/[0.04]'
          : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05]'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} weight="bold" className={accentClass} />
        <span className={`text-[12px] font-mono font-semibold ${accentClass}`}>{event}</span>
        <span className="flex-1" />
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${badgeClass}`}>
          {previewLabel}
        </span>
      </div>
      <p className="mt-1 text-[11px] font-mono text-[var(--color-text-muted)] truncate">
        {detailText}
      </p>
    </button>
  )
}
