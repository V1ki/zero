import * as React from 'react'
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  Clock,
  Database,
  MagnifyingGlass,
  WarningCircle,
} from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'
import { ToolCallDetail, summarizeToolInput } from './ToolCallDetail'
import type { SubAgentChildToolCall, TraceSpan } from './timeline'

interface MemoryNudgeBlockProps {
  id: string
  prompt: string
  createdAt?: string
  source: 'control' | 'trace'
  iteration?: number
  memoryWritten?: boolean
  durationMs?: number
  status: TraceSpan['status']
  relatedToolCalls?: SubAgentChildToolCall[]
  selected?: boolean
  selectedChildToolId?: string | null
  onSelect?: (id: string) => void
  onSelectChildTool?: (toolId: string) => void
}

export function MemoryNudgeBlock({
  id,
  prompt,
  createdAt,
  source,
  iteration,
  memoryWritten,
  durationMs,
  status,
  relatedToolCalls = [],
  selected,
  selectedChildToolId,
  onSelect,
  onSelectChildTool,
}: MemoryNudgeBlockProps) {
  const primaryWrite = React.useMemo(
    () => findPrimaryMemoryWrite(relatedToolCalls),
    [relatedToolCalls],
  )
  const preview = getPreviewText(prompt, primaryWrite, memoryWritten)
  const handleSelect = () => onSelect?.(id)

  return (
    <div
      data-memory-nudge-id={id}
      className={`overflow-hidden rounded-[20px] border ${
        selected
          ? 'border-cyan-400/30 bg-[linear-gradient(135deg,rgba(8,52,60,0.92),rgba(8,18,28,0.88))] ring-1 ring-cyan-400/20'
          : 'border-cyan-400/14 bg-[linear-gradient(135deg,rgba(7,36,43,0.9),rgba(10,16,22,0.82))] hover:border-cyan-300/20 hover:bg-[linear-gradient(135deg,rgba(8,40,48,0.94),rgba(10,16,22,0.86))]'
      }`}
    >
      <button
        type="button"
        onClick={handleSelect}
        aria-expanded={selected}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <ArrowsClockwise size={14} weight="bold" className="text-cyan-300" />
          <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-cyan-300">
            memory_nudge
          </span>
          {createdAt ? (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
              {formatTime(createdAt)}
            </span>
          ) : null}
          <span className="flex-1" />
          <MemoryNudgeStatusBadge status={status} />
          <span className="text-[var(--color-text-disabled)]">
            {selected ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {iteration !== undefined ? <InlineChip>{`iteration ${iteration}`}</InlineChip> : null}
          <InlineChip>{`${relatedToolCalls.length} memory step${relatedToolCalls.length === 1 ? '' : 's'}`}</InlineChip>
          {durationMs !== undefined ? (
            <InlineChip>
              <span className="inline-flex items-center gap-1">
                <Clock size={10} />
                {formatDuration(durationMs)}
              </span>
            </InlineChip>
          ) : null}
          <InlineChip>{source}</InlineChip>
          {memoryWritten === true ? (
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-mono text-emerald-200">
              wrote memory
            </span>
          ) : memoryWritten === false ? (
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
              no memory write
            </span>
          ) : null}
        </div>

        <div className="px-4 pb-3">
          <p className="line-clamp-2 text-[12px] text-[var(--color-text-muted)]">{preview}</p>
        </div>
      </button>

      {selected ? (
        <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
          {primaryWrite ? (
            <div className="rounded-2xl border border-emerald-400/15 bg-[linear-gradient(180deg,rgba(6,78,59,0.18),rgba(10,14,20,0.7))] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-emerald-400/12 px-2 py-0.5 text-[10px] font-mono text-emerald-200">
                  {String(primaryWrite.input.action ?? 'create')}
                </span>
                {typeof primaryWrite.input.type === 'string' ? (
                  <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
                    {primaryWrite.input.type}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-[12px] font-medium text-[var(--color-text-primary)]">
                {typeof primaryWrite.input.title === 'string'
                  ? primaryWrite.input.title
                  : (primaryWrite.summary ?? 'Recorded a memory write during this checkpoint.')}
              </p>
              {primaryWrite.summary ? (
                <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                  {primaryWrite.summary}
                </p>
              ) : null}
            </div>
          ) : null}

          <InlineSection label="Prompt">
            <ExpandableInlineText value={prompt} />
          </InlineSection>

          <InlineSection label={`Memory Activity (${relatedToolCalls.length})`}>
            {relatedToolCalls.length > 0 ? (
              <div className="space-y-1.5">
                {relatedToolCalls.map((toolCall) => (
                  <MemoryToolRow
                    key={toolCall.id}
                    toolCall={toolCall}
                    selected={selectedChildToolId === toolCall.id}
                    onSelect={onSelectChildTool}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                This checkpoint did not persist any expandable memory tool steps.
              </p>
            )}
          </InlineSection>
        </div>
      ) : null}
    </div>
  )
}

function MemoryToolRow({
  toolCall,
  selected,
  onSelect,
}: {
  toolCall: SubAgentChildToolCall
  selected: boolean
  onSelect?: (toolId: string) => void
}) {
  const tone = getMemoryToolTone(toolCall.name)
  const preview = toolCall.summary ?? summarizeToolInput(toolCall.name, toolCall.input)
  const Icon = getMemoryToolIcon(toolCall.name)

  return (
    <div
      data-memory-nudge-tool-id={toolCall.id}
      className={`overflow-hidden rounded-2xl border ${tone.surfaceClass}`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(toolCall.id)}
        aria-expanded={selected}
        className="w-full px-3 py-2 text-left"
      >
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] ${tone.badgeClass}`}
          >
            <Icon size={10} weight="bold" />
            {toolCall.name}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">
                {getMemoryToolLabel(toolCall)}
              </span>
              {toolCall.durationMs !== undefined ? (
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-disabled)]">
                  {formatDuration(toolCall.durationMs)}
                </span>
              ) : null}
              {toolCall.isError === true ? (
                <span className="rounded px-1.5 py-0.5 text-[9px] bg-rose-400/12 text-rose-200">
                  error
                </span>
              ) : (
                <span className="rounded px-1.5 py-0.5 text-[9px] bg-emerald-400/12 text-emerald-200">
                  ok
                </span>
              )}
            </div>
            {preview ? (
              <p className="mt-1 line-clamp-2 text-[10.5px] leading-[1.15rem] text-[var(--color-text-secondary)]">
                {preview}
              </p>
            ) : null}
          </div>
          <span className="pt-0.5 text-[var(--color-text-disabled)]">
            {selected ? (
              <CaretDown size={10} className={tone.caretClass} />
            ) : (
              <CaretRight size={10} />
            )}
          </span>
        </div>
      </button>

      {selected ? (
        <ToolCallDetail
          name={toolCall.name}
          input={toolCall.input}
          result={toolCall.result}
          summary={toolCall.summary}
          contentItems={toolCall.contentItems}
          isError={toolCall.isError}
          durationMs={toolCall.durationMs}
          nested
        />
      ) : null}
    </div>
  )
}

function MemoryNudgeStatusBadge({ status }: { status: TraceSpan['status'] }) {
  if (status === 'error') {
    return <WarningCircle size={14} weight="fill" className="text-rose-300" />
  }
  return <CheckCircle size={14} weight="fill" className="text-emerald-300" />
}

function InlineSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
        {label}
      </div>
      {children}
    </div>
  )
}

function InlineChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
      {children}
    </span>
  )
}

function ExpandableInlineText({ value }: { value: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const preview = expanded ? value : truncateText(value, 220)

  return (
    <>
      <p className="text-[11px] text-[var(--color-text-secondary)]">{preview}</p>
      {value.length > 220 ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
        >
          {expanded ? 'Collapse' : 'Expand'} ({value.length.toLocaleString()} chars)
        </button>
      ) : null}
      {expanded ? (
        <pre className="mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-black/20 p-3 text-[10px] text-[var(--color-text-muted)]">
          {value}
        </pre>
      ) : null}
    </>
  )
}

function getPreviewText(
  prompt: string,
  primaryWrite: SubAgentChildToolCall | undefined,
  memoryWritten: boolean | undefined,
) {
  if (typeof primaryWrite?.input.title === 'string') {
    return `Recorded ${String(primaryWrite.input.type ?? 'memory')}: ${primaryWrite.input.title}`
  }
  if (primaryWrite?.summary) return primaryWrite.summary
  if (memoryWritten) return 'A memory write was recorded during this checkpoint.'
  return firstSentence(prompt)
}

function findPrimaryMemoryWrite(toolCalls: SubAgentChildToolCall[]) {
  return toolCalls.find((toolCall) => {
    if (toolCall.name !== 'memory') return false
    const action = typeof toolCall.input.action === 'string' ? toolCall.input.action : ''
    return action === 'create' || action === 'update'
  })
}

function getMemoryToolLabel(toolCall: SubAgentChildToolCall) {
  if (toolCall.name === 'memory_search') {
    return typeof toolCall.input.query === 'string' ? toolCall.input.query : 'Memory search'
  }
  if (toolCall.name === 'memory_read') {
    return typeof toolCall.input.path === 'string'
      ? toolCall.input.path
      : typeof toolCall.input.id === 'string'
        ? toolCall.input.id
        : 'Memory read'
  }
  if (toolCall.name === 'memory') {
    if (typeof toolCall.input.title === 'string') return toolCall.input.title
    if (typeof toolCall.input.action === 'string') return `memory.${toolCall.input.action}`
  }
  return toolCall.name
}

function getMemoryToolTone(toolName: string) {
  if (toolName === 'memory') {
    return {
      surfaceClass: 'border-emerald-400/14 bg-emerald-400/[0.05]',
      badgeClass: 'bg-emerald-400/15 text-emerald-200',
      caretClass: 'text-emerald-200',
    }
  }
  if (toolName === 'memory_search') {
    return {
      surfaceClass: 'border-cyan-400/14 bg-cyan-400/[0.05]',
      badgeClass: 'bg-cyan-400/15 text-cyan-200',
      caretClass: 'text-cyan-200',
    }
  }
  if (toolName === 'memory_read') {
    return {
      surfaceClass: 'border-indigo-400/14 bg-indigo-400/[0.05]',
      badgeClass: 'bg-indigo-400/15 text-indigo-200',
      caretClass: 'text-indigo-200',
    }
  }
  return {
    surfaceClass: 'border-white/[0.08] bg-white/[0.03]',
    badgeClass: 'bg-white/[0.08] text-[var(--color-text-secondary)]',
    caretClass: 'text-[var(--color-text-secondary)]',
  }
}

function firstSentence(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const match = normalized.match(/^(.+?[?？。!！])/u)?.[1]?.trim()
  return match || normalized
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength).trimEnd()}...`
}

function formatDuration(durationMs: number) {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function getMemoryToolIcon(toolName: string) {
  if (toolName === 'memory_search') return MagnifyingGlass
  return Database
}
