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
import { useState } from 'react'
import { toolColors } from '../../lib/colors'

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
  isError?: boolean
  durationMs?: number
  selected?: boolean
  onSelect?: (id: string) => void
}

export function ToolCallBlock({
  id,
  name,
  input,
  result,
  isError,
  durationMs,
  selected,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false)

  const Icon = toolIcons[name.toLowerCase()] ?? Terminal
  const colorClass = toolColors[name.toLowerCase()] ?? 'text-slate-400'

  const inputPreview = getInputPreview(name, input)
  const hasResult = result !== undefined
  const handleSelect = () => onSelect?.(id)

  return (
    <div
      data-tool-call-id={id}
      className={`rounded-lg border transition-colors cursor-pointer ${
        selected
          ? 'border-[var(--color-accent)]/30 bg-white/[0.04]'
          : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05]'
      }`}
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleSelect()
        }
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon size={14} weight="bold" className={colorClass} />
        <span className={`text-[12px] font-mono font-semibold ${colorClass}`}>{name}</span>
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
        {hasResult && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
            className="text-[var(--color-text-disabled)] hover:text-[var(--color-text-muted)]"
          >
            {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </button>
        )}
      </div>

      {/* Input preview */}
      {inputPreview && (
        <div className="px-3 pb-2">
          <p className="text-[11px] font-mono text-[var(--color-text-muted)] truncate">
            {inputPreview}
          </p>
        </div>
      )}

      {/* Expandable output */}
      {expanded && result && (
        <>
          <div className="border-t border-white/[0.06] mx-3" />
          <div className="px-3 py-2 max-h-[300px] overflow-y-auto">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
              {result}
            </pre>
          </div>
        </>
      )}
    </div>
  )
}

function getInputPreview(tool: string, input: Record<string, unknown>): string {
  const name = tool.toLowerCase()
  if (name === 'bash' && input.command) return String(input.command)
  if ((name === 'read' || name === 'edit' || name === 'write') && input.file_path)
    return String(input.file_path)
  if (name === 'browser' && input.url) return String(input.url)
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  return `${keys[0]}: ${String(input[keys[0]]).slice(0, 80)}`
}
