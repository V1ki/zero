import { Robot } from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'

interface Props {
  messageId?: string
  text: string
  model?: string
  createdAt?: string
  highlighted?: boolean
}

export function AgentMessageBlock({
  messageId,
  text,
  model,
  createdAt,
  highlighted = false,
}: Props) {
  return (
    <div
      data-assistant-message-id={messageId}
      className={`overflow-hidden rounded-[22px] border px-4 py-4 ${
        highlighted
          ? 'border-cyan-400/45 bg-cyan-400/8 ring-1 ring-cyan-400/35'
          : 'border-white/8 bg-[linear-gradient(135deg,rgba(18,24,34,0.92),rgba(12,14,20,0.86))]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/15 bg-cyan-400/10">
          <Robot size={16} weight="bold" className="text-[var(--color-accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/90">
              Assistant
            </span>
            {model && (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
                {model}
              </span>
            )}
            {createdAt && (
              <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
                {formatTime(createdAt)}
              </span>
            )}
          </div>
          <p className="text-[13px] leading-6 text-slate-100 whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    </div>
  )
}
