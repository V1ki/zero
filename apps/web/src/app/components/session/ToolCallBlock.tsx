import {
  CaretDown,
  CaretRight,
  CheckCircle,
  File,
  FilePlus,
  Globe,
  PencilSimple,
  Terminal,
  XCircle,
} from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'
import { toolColors } from '../../lib/colors'
import { ToolCallDetail, summarizeToolInput } from './ToolCallDetail'

const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: File,
  edit: PencilSimple,
  write: FilePlus,
  browser: Globe,
}

interface Props {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  isError?: boolean
  durationMs?: number
  createdAt?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

export function ToolCallBlock({
  id,
  name,
  input,
  result,
  summary,
  isError,
  durationMs,
  createdAt,
  selected,
  onSelect,
}: Props) {
  const Icon = toolIcons[name.toLowerCase()] ?? Terminal
  const colorClass = toolColors[name.toLowerCase()] ?? 'text-slate-400'
  const inputPreview = summarizeToolInput(name, input)
  const handleSelect = () => onSelect?.(id)

  return (
    <div
      data-tool-call-id={id}
      className={`overflow-hidden rounded-[20px] border ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-cyan-400/8 ring-1 ring-cyan-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(19,24,33,0.92),rgba(12,15,21,0.84))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <button
        type="button"
        onClick={handleSelect}
        aria-expanded={selected}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Icon size={14} weight="bold" className={colorClass} />
          <span
            className={`text-[11px] font-mono font-semibold uppercase tracking-[0.16em] ${colorClass}`}
          >
            {name}
          </span>
          {createdAt && (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
              {formatTime(createdAt)}
            </span>
          )}
          <span className="flex-1" />
          {isError !== undefined &&
            (isError ? (
              <XCircle size={14} weight="fill" className="text-red-400" />
            ) : (
              <CheckCircle size={14} weight="fill" className="text-emerald-400" />
            ))}
          {durationMs !== undefined && (
            <span className="text-[10px] text-[var(--color-text-disabled)] font-mono">
              {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          <span className="text-[var(--color-text-disabled)]">
            {selected ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </div>

        {inputPreview && (
          <div className="px-4 pb-3">
            <p className="text-[12px] font-mono text-[var(--color-text-muted)] truncate">
              {inputPreview}
            </p>
          </div>
        )}
      </button>

      {selected && (
        <ToolCallDetail
          name={name}
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          durationMs={durationMs}
        />
      )}
    </div>
  )
}
