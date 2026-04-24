import {
  CaretDown,
  CaretRight,
  CheckCircle,
  File,
  FilePlus,
  Globe,
  PencilSimple,
  Spinner,
  Terminal,
  XCircle,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { apiPost } from '../../lib/api'
import { toolColors } from '../../lib/colors'
import { formatTime } from '../../lib/format'
import { useUIStore } from '../../stores/ui'
import { TokenUsagePill } from './TokenUsagePill'
import { ToolCallDetail, summarizeToolInput } from './ToolCallDetail'
import type { ToolResultContentItem } from './ToolCallDetail'
import type { TokenUsageSummary } from './context-tokens'

const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: File,
  read_image: File,
  edit: PencilSimple,
  write: FilePlus,
  browser: Globe,
}

interface Props {
  sessionId?: string
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  contentItems?: ToolResultContentItem[]
  isError?: boolean
  status?: 'running' | 'success' | 'error'
  durationMs?: number
  createdAt?: string
  tokenUsage?: TokenUsageSummary
  resultTokenUsage?: TokenUsageSummary
  selected?: boolean
  onSelect?: (id: string) => void
}

export function ToolCallBlock({
  sessionId,
  id,
  name,
  input,
  result,
  summary,
  contentItems,
  isError,
  status,
  durationMs,
  createdAt,
  tokenUsage,
  resultTokenUsage,
  selected,
  onSelect,
}: Props) {
  const { addToast } = useUIStore()
  const Icon = toolIcons[name.toLowerCase()] ?? Terminal
  const colorClass = toolColors[name.toLowerCase()] ?? 'text-slate-400'
  const inputPreview = summarizeToolInput(name, input)
  const [abortPending, setAbortPending] = useState(false)
  const handleSelect = () => onSelect?.(id)
  const isRunning = status === 'running'

  useEffect(() => {
    if (!isRunning) {
      setAbortPending(false)
    }
  }, [isRunning])

  async function handleAbort() {
    if (!sessionId || abortPending) return
    setAbortPending(true)

    try {
      const response = await apiPost<{
        ok: boolean
        status: 'accepted' | 'already_requested' | 'already_finished'
      }>(`/api/sessions/${sessionId}/tool-calls/${id}/abort`, {})

      if (response.status === 'accepted') {
        addToast('success', 'Abort requested')
        return
      }

      if (response.status === 'already_finished') {
        setAbortPending(false)
      }
    } catch {
      setAbortPending(false)
    }
  }

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
          {isRunning ? (
            <span className="rounded-full border border-cyan-400/15 bg-cyan-400/[0.08] px-2 py-0.5 text-[10px] font-mono text-cyan-100">
              <span className="inline-flex items-center gap-1">
                <Spinner size={10} className="animate-spin" />
                running
              </span>
            </span>
          ) : null}
          <span className="flex-1" />
          {isError !== undefined &&
            (isRunning ? null : isError ? (
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

        {(inputPreview || tokenUsage || resultTokenUsage) && (
          <div className="space-y-2 px-4 pb-3">
            {inputPreview && (
              <p className="text-[12px] font-mono text-[var(--color-text-muted)] truncate">
                {inputPreview}
              </p>
            )}
            {(tokenUsage || resultTokenUsage) && (
              <div className="flex flex-wrap gap-1.5">
                <TokenUsagePill usage={tokenUsage} label="Request" tone="accent" />
                <TokenUsagePill usage={resultTokenUsage} label="Result" />
              </div>
            )}
          </div>
        )}
      </button>

      {selected && (
        <ToolCallDetail
          name={name}
          input={input}
          result={result}
          summary={summary}
          contentItems={contentItems}
          isError={isError}
          status={status}
          durationMs={durationMs}
          abortPending={abortPending}
          onAbort={name.toLowerCase() === 'bash' && isRunning ? handleAbort : undefined}
        />
      )}
    </div>
  )
}
