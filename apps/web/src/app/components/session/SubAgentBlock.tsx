import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Clock,
  HourglassMedium,
  Robot,
  Spinner,
  XCircle,
} from '@phosphor-icons/react'
import * as React from 'react'
import { formatTime } from '../../lib/format'
import { ToolCallDetail, summarizeToolInput } from './ToolCallDetail'
import type { ToolResultContentItem } from './ToolCallDetail'
import type { TraceSpan } from './timeline'

export interface SubAgentChildToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  contentItems?: ToolResultContentItem[]
  isError?: boolean
  durationMs?: number
}

export interface SubAgentBlockProps {
  agentId: string
  label: string
  role?: string
  instruction: string
  status: 'running' | 'waiting' | 'completed' | 'errored' | 'closed'
  output?: string
  durationMs?: number
  createdAt?: string
  childToolCalls?: SubAgentChildToolCall[]
  traceSpan?: TraceSpan | null
  selected?: boolean
  highlighted?: boolean
  selectedChildToolId?: string | null
  onSelect?: (id: string) => void
  onSelectChildTool?: (toolId: string) => void
}

type SubAgentInternalTimelineEvent =
  | {
      id: string
      kind: 'tool'
      label: string
      preview?: string
      depth: number
      createdAt?: string
      durationMs?: number
      status: TraceSpan['status']
      chips: string[]
      span?: TraceSpan
      toolCall: SubAgentChildToolCall
    }
  | {
      id: string
      kind: 'turn' | 'llm-request' | 'reason' | 'generic'
      label: string
      preview?: string
      depth: number
      createdAt?: string
      durationMs?: number
      status: TraceSpan['status']
      chips: string[]
      span?: TraceSpan
      toolCall?: undefined
    }

const statusBorderColor: Record<SubAgentBlockProps['status'], string> = {
  running: 'border-l-sky-400',
  waiting: 'border-l-amber-400',
  completed: 'border-l-emerald-400',
  errored: 'border-l-rose-400',
  closed: 'border-l-slate-500',
}

const statusLabel: Record<SubAgentBlockProps['status'], string> = {
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  errored: 'Error',
  closed: 'Closed',
}

const statusTextColor: Record<SubAgentBlockProps['status'], string> = {
  running: 'text-sky-300',
  waiting: 'text-amber-200',
  completed: 'text-emerald-200',
  errored: 'text-rose-200',
  closed: 'text-slate-300',
}

export function SubAgentBlock({
  agentId,
  label,
  role,
  instruction,
  status,
  output,
  durationMs,
  createdAt,
  childToolCalls = [],
  traceSpan,
  selected,
  highlighted,
  onSelect,
  selectedChildToolId,
  onSelectChildTool,
}: SubAgentBlockProps) {
  const activity = React.useMemo(() => summarizeChildToolActivity(childToolCalls), [childToolCalls])
  const preview = getSubAgentPreview({ instruction, output, status, childToolCalls })
  const internalTimeline = React.useMemo(
    () => buildSubAgentInternalTimeline(traceSpan, childToolCalls),
    [traceSpan, childToolCalls],
  )
  const handleSelect = () => onSelect?.(agentId)

  return (
    <div
      data-sub-agent-id={agentId}
      className={`overflow-hidden rounded-[22px] border-l-2 border ${statusBorderColor[status]} ${
        selected
          ? 'border-white/12 bg-[linear-gradient(135deg,rgba(10,45,44,0.92),rgba(10,16,22,0.86))] ring-1 ring-teal-400/25'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(16,24,28,0.94),rgba(11,15,21,0.84))] hover:border-white/12 hover:bg-white/[0.04]'
      } ${highlighted ? 'ring-1 ring-cyan-400/35' : ''}`}
    >
      <button
        type="button"
        onClick={handleSelect}
        aria-expanded={selected}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <Robot size={14} weight="bold" className="text-teal-300" />
          <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-teal-300">
            sub-agent
          </span>
          {createdAt && (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
              {formatTime(createdAt)}
            </span>
          )}
          <span className="flex-1" />
          <StatusIcon status={status} />
          <span className={`text-[10px] font-mono ${statusTextColor[status]}`}>
            {statusLabel[status]}
          </span>
          <span className="text-[var(--color-text-disabled)]">
            {selected ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </div>

        <div className="px-4 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-[var(--color-text-primary)]">{label}</p>
            {role && (
              <span className="rounded-full border border-teal-400/20 bg-teal-400/10 px-2 py-0.5 text-[10px] font-mono text-teal-200">
                {role}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
            {childToolCalls.length} tool{childToolCalls.length === 1 ? '' : 's'}
          </span>
          {durationMs !== undefined && (
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
              <span className="inline-flex items-center gap-1">
                <Clock size={10} />
                {formatDuration(durationMs)}
              </span>
            </span>
          )}
          {activity.slice(0, 3).map((entry) => (
            <span
              key={entry.name}
              className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]"
            >
              {entry.name}
              {entry.count > 1 ? ` ×${entry.count}` : ''}
            </span>
          ))}
        </div>

        <div className="px-4 pb-3 pt-2">
          <p className="line-clamp-2 text-[12px] text-[var(--color-text-muted)]">{preview}</p>
        </div>
      </button>

      {selected && (
        <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
          <InlineSection label="Mission">
            <ExpandableInlineText value={instruction} />
          </InlineSection>

          <InlineSection label="Activity">
            {activity.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {activity.map((entry) => (
                  <span
                    key={entry.name}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]"
                  >
                    {entry.name}
                    {entry.count > 1 ? ` ×${entry.count}` : ''}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                No child tool calls were recorded for this agent.
              </p>
            )}
          </InlineSection>

          <InlineSection label={`Internal Timeline (${internalTimeline.length})`}>
            {internalTimeline.length > 0 ? (
              <div data-sub-agent-timeline className="space-y-1.5">
                {internalTimeline.map((event) => (
                  <SubAgentTimelineEventRow
                    key={event.id}
                    event={event}
                    selectedToolId={selectedChildToolId}
                    onSelectChildTool={onSelectChildTool}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                This agent did not persist a sub-trace timeline. Only the final status was captured.
              </p>
            )}
          </InlineSection>

          <InlineSection label={status === 'completed' ? 'Final Output' : 'Current Output'}>
            {output ? (
              <ExpandableInlineText
                value={output}
                blockClassName="bg-black/20 text-[var(--color-text-secondary)]"
              />
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {status === 'running'
                  ? 'The agent is still running and has not emitted a final output yet.'
                  : status === 'waiting'
                    ? 'The agent is paused and waiting for more input.'
                    : 'No output was captured for this agent.'}
              </p>
            )}
          </InlineSection>
        </div>
      )}
    </div>
  )
}

function SubAgentTimelineEventRow({
  event,
  selectedToolId,
  onSelectChildTool,
}: {
  event: SubAgentInternalTimelineEvent
  selectedToolId?: string | null
  onSelectChildTool?: (toolId: string) => void
}) {
  const hasInlineDetails =
    event.kind === 'tool' ||
    Boolean(event.preview) ||
    hasRecordContent(event.span?.metadata) ||
    hasRecordContent(event.span?.data)
  const [expanded, setExpanded] = React.useState(false)
  const isToolSelected = event.kind === 'tool' && selectedToolId === event.toolCall.id
  const tone = getTimelineEventTone(event)
  const timeLabel = event.createdAt ? formatTime(event.createdAt) : null
  const indentation = Math.min(event.depth, 5) * 14

  const content = (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={`mt-0.5 rounded-full px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] ${tone.badgeClass}`}
      >
        {getTimelineEventBadge(event)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">
            {event.label}
          </span>
          {timeLabel ? (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-disabled)]">
              {timeLabel}
            </span>
          ) : null}
          {event.durationMs !== undefined ? (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-disabled)]">
              {formatDuration(event.durationMs)}
            </span>
          ) : null}
          <TraceStatusBadge status={event.status} />
        </div>
        {event.preview ? (
          <p className="mt-1 line-clamp-2 text-[10.5px] leading-[1.15rem] text-[var(--color-text-secondary)]">
            {event.preview}
          </p>
        ) : null}
        {event.chips.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {event.chips.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-disabled)]"
              >
                {chip}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {hasInlineDetails ? (
        <span className="pt-0.5 text-[var(--color-text-disabled)]">
          {event.kind === 'tool' ? (
            isToolSelected ? (
              <CaretDown size={10} className={tone.caretClass} />
            ) : (
              <CaretRight size={10} />
            )
          ) : expanded ? (
            <CaretDown size={10} className={tone.caretClass} />
          ) : (
            <CaretRight size={10} />
          )}
        </span>
      ) : null}
    </div>
  )

  return (
    <div
      data-sub-agent-event-id={event.id}
      data-sub-agent-event-kind={event.kind}
      data-sub-agent-tool-id={event.kind === 'tool' ? event.toolCall.id : undefined}
      style={{ marginLeft: indentation ? `${indentation}px` : undefined }}
      className={`overflow-hidden rounded-2xl border ${tone.surfaceClass}`}
    >
      {event.kind === 'tool' ? (
        <button
          type="button"
          onClick={() => onSelectChildTool?.(event.toolCall.id)}
          aria-expanded={isToolSelected}
          className="w-full px-3 py-2 text-left"
        >
          {content}
        </button>
      ) : hasInlineDetails ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="w-full px-3 py-2 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="px-3 py-2">{content}</div>
      )}

      {event.kind === 'tool' && isToolSelected ? (
        <ToolCallDetail
          name={event.toolCall.name}
          input={event.toolCall.input}
          result={event.toolCall.result}
          summary={event.toolCall.summary}
          contentItems={event.toolCall.contentItems}
          isError={event.toolCall.isError}
          durationMs={event.toolCall.durationMs}
          nested
        />
      ) : null}

      {event.kind !== 'tool' && expanded ? <TraceEventDetail event={event} /> : null}
    </div>
  )
}

function TraceEventDetail({
  event,
}: {
  event: Extract<
    SubAgentInternalTimelineEvent,
    { kind: 'turn' | 'llm-request' | 'reason' | 'generic' }
  >
}) {
  return (
    <div className="space-y-2 border-t border-white/[0.06] px-3 py-2.5">
      {event.preview ? (
        <ExpandableInlineText
          value={event.preview}
          blockClassName="bg-black/20 text-[var(--color-text-secondary)]"
        />
      ) : null}

      {hasRecordContent(event.span?.metadata) ? (
        <TraceRecordSection label="Metadata" value={event.span?.metadata} />
      ) : null}

      {hasRecordContent(event.span?.data) ? (
        <TraceRecordSection label="Data" value={event.span?.data} />
      ) : null}
    </div>
  )
}

function TraceRecordSection({
  label,
  value,
}: {
  label: string
  value?: Record<string, unknown>
}) {
  if (!value || Object.keys(value).length === 0) return null

  return (
    <details className="overflow-hidden rounded-xl border border-white/[0.06] bg-black/10">
      <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
        {label}
      </summary>
      <pre className="max-h-[220px] overflow-y-auto border-t border-white/[0.06] px-3 py-2 text-[10px] leading-[1.15rem] text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
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

function ExpandableInlineText({
  value,
  blockClassName,
}: {
  value: string
  blockClassName?: string
}) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <>
      <p className="text-[11px] text-[var(--color-text-secondary)]">
        {expanded ? value : truncateText(value, 220)}
      </p>
      {value.length > 220 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
        >
          {expanded ? 'Collapse' : 'Expand'} ({value.length.toLocaleString()} chars)
        </button>
      )}
      {expanded && (
        <pre
          className={`mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl p-3 text-[10px] ${blockClassName ?? 'bg-black/10 text-[var(--color-text-muted)]'}`}
        >
          {value}
        </pre>
      )}
    </>
  )
}

function StatusIcon({ status }: { status: SubAgentBlockProps['status'] }) {
  if (status === 'running') {
    return <Spinner size={14} weight="bold" className="animate-spin text-sky-300" />
  }
  if (status === 'waiting') {
    return <HourglassMedium size={14} weight="fill" className="text-amber-300" />
  }
  if (status === 'completed') {
    return <CheckCircle size={14} weight="fill" className="text-emerald-300" />
  }
  if (status === 'errored') {
    return <XCircle size={14} weight="fill" className="text-rose-300" />
  }
  return null
}

function TraceStatusBadge({ status }: { status: TraceSpan['status'] }) {
  const className =
    status === 'success'
      ? 'bg-emerald-400/10 text-emerald-300'
      : status === 'error'
        ? 'bg-rose-400/10 text-rose-300'
        : 'bg-amber-400/10 text-amber-300'

  return <span className={`rounded px-1.5 py-0.5 text-[9px] ${className}`}>{status}</span>
}

function buildSubAgentInternalTimeline(
  traceSpan: TraceSpan | null | undefined,
  childToolCalls: SubAgentChildToolCall[],
): SubAgentInternalTimelineEvent[] {
  const toolById = new Map(childToolCalls.map((toolCall) => [toolCall.id, toolCall]))

  if (!traceSpan) {
    return childToolCalls.map((toolCall, index) => ({
      id: `tool-fallback-${toolCall.id}-${index}`,
      kind: 'tool',
      label: `tool:${toolCall.name}`,
      preview: toolCall.summary ?? summarizeToolInput(toolCall.name, toolCall.input),
      depth: 0,
      durationMs: toolCall.durationMs,
      status: toolCall.isError ? 'error' : 'success',
      chips: summarizeToolInput(toolCall.name, toolCall.input)
        ? [summarizeToolInput(toolCall.name, toolCall.input)]
        : [],
      toolCall,
    }))
  }

  const collected: Array<{ span: TraceSpan; depth: number; index: number }> = []
  let order = 0

  const walk = (span: TraceSpan, depth: number) => {
    const sortedChildren = [...span.children].sort(compareSpansByTime)
    for (const child of sortedChildren) {
      collected.push({ span: child, depth, index: order++ })
      walk(child, depth + 1)
    }
  }

  walk(traceSpan, 0)

  return collected
    .sort(
      (left, right) =>
        compareSpansByTime(left.span, right.span) ||
        left.depth - right.depth ||
        left.index - right.index,
    )
    .map(({ span, depth, index }) => toInternalTimelineEvent(span, depth, index, toolById))
}

function toInternalTimelineEvent(
  span: TraceSpan,
  depth: number,
  index: number,
  toolById: Map<string, SubAgentChildToolCall>,
): SubAgentInternalTimelineEvent {
  const kind = getInternalTimelineKind(span)
  const label = getInternalTimelineLabel(span, kind)
  const preview = getInternalTimelinePreview(span, kind)
  const chips = getInternalTimelineChips(span, kind)

  if (kind === 'tool') {
    const toolCall = resolveToolCall(span, toolById)
    return {
      id: `${span.id}-${index}`,
      kind,
      label,
      preview:
        toolCall.summary ??
        preview ??
        summarizeToolInput(toolCall.name, toolCall.input) ??
        undefined,
      depth,
      createdAt: span.startTime,
      durationMs: toolCall.durationMs ?? span.durationMs,
      status: span.status,
      chips,
      span,
      toolCall,
    }
  }

  return {
    id: `${span.id}-${index}`,
    kind,
    label,
    preview,
    depth,
    createdAt: span.startTime,
    durationMs: span.durationMs,
    status: span.status,
    chips,
    span,
  }
}

function resolveToolCall(
  span: TraceSpan,
  toolById: Map<string, SubAgentChildToolCall>,
): SubAgentChildToolCall {
  const metadata = span.metadata ?? {}
  const data = span.data ?? {}
  const toolUseId = stringValue(metadata.toolUseId) ?? span.id
  const existing = toolById.get(toolUseId)

  if (existing) {
    return {
      ...existing,
      durationMs: existing.durationMs ?? span.durationMs,
      summary:
        existing.summary ??
        stringValue(metadata.outputSummary) ??
        stringValue(data.outputSummary) ??
        existing.summary,
      result: existing.result ?? stringValue(metadata.result) ?? existing.result,
    }
  }

  return {
    id: toolUseId,
    name: span.name.replace(/^tool:/, '') || 'tool',
    input: recordValue(metadata.input) ?? {},
    result: stringValue(metadata.result),
    summary: stringValue(metadata.outputSummary) ?? stringValue(data.outputSummary),
    isError: span.status === 'error' ? true : undefined,
    durationMs: span.durationMs,
  }
}

function getInternalTimelineKind(span: TraceSpan): SubAgentInternalTimelineEvent['kind'] {
  if (span.name.startsWith('tool:')) return 'tool'
  if (span.name === 'llm_request') return 'llm-request'
  if (span.name.startsWith('turn:')) return 'turn'
  if (span.name.includes('reason')) return 'reason'
  return 'generic'
}

function getInternalTimelineLabel(span: TraceSpan, kind: SubAgentInternalTimelineEvent['kind']) {
  if (kind === 'tool') return span.name
  return span.name
}

function getInternalTimelinePreview(span: TraceSpan, kind: SubAgentInternalTimelineEvent['kind']) {
  const data = span.data ?? {}
  const metadata = span.metadata ?? {}

  if (kind === 'tool') {
    return pickMeaningfulText(
      stringValue(metadata.outputSummary),
      stringValue(data.outputSummary),
      stringValue(metadata.result),
    )
  }

  if (kind === 'llm-request') {
    return pickMeaningfulText(
      stringValue(data.outputSummary),
      stringValue(data.responseSummary),
      stringValue(data.response),
      stringValue(data.assistantMessage),
      stringValue(data.userPrompt),
      stringValue(metadata.model),
    )
  }

  if (kind === 'turn') {
    return pickMeaningfulText(
      stringValue(data.summary),
      stringValue(data.outputSummary),
      stringValue(data.goal),
      stringValue(data.task),
      stringValue(metadata.goal),
      stringValue(metadata.label),
    )
  }

  if (kind === 'reason') {
    return pickMeaningfulText(
      stringValue(data.note),
      stringValue(data.reason),
      stringValue(data.summary),
      stringValue(metadata.note),
      stringValue(metadata.reason),
    )
  }

  return pickMeaningfulText(
    stringValue(data.outputSummary),
    stringValue(data.summary),
    stringValue(data.output),
    stringValue(data.message),
    stringValue(metadata.summary),
    stringValue(metadata.note),
  )
}

function getInternalTimelineChips(span: TraceSpan, kind: SubAgentInternalTimelineEvent['kind']) {
  const data = span.data ?? {}
  const metadata = span.metadata ?? {}

  if (kind === 'tool') {
    const toolName = span.name.replace(/^tool:/, '')
    const inputSummary = summarizeToolInput(toolName, recordValue(metadata.input) ?? {})
    return inputSummary ? [inputSummary] : []
  }

  if (kind === 'llm-request') {
    const chips: string[] = []
    const model = stringValue(metadata.model) ?? stringValue(data.model)
    const stopReason = stringValue(data.stopReason) ?? stringValue(metadata.stopReason)
    const inputTokens = numberValue(data.inputTokens) ?? numberValue(data.promptTokens)
    const outputTokens = numberValue(data.outputTokens) ?? numberValue(data.completionTokens)
    const cost = numberValue(data.cost) ?? numberValue(metadata.cost)

    if (model) chips.push(model)
    if (stopReason) chips.push(stopReason)
    if (inputTokens !== undefined || outputTokens !== undefined) {
      chips.push(`tokens ${inputTokens ?? 0}/${outputTokens ?? 0}`)
    }
    if (cost !== undefined) chips.push(`$${cost.toFixed(3)}`)

    return chips
  }

  if (kind === 'turn') {
    const chips: string[] = []
    const turnIndex = numberValue(data.turnIndex) ?? numberValue(metadata.turnIndex)
    if (turnIndex !== undefined) chips.push(`turn ${turnIndex}`)
    if (span.children.length > 0) chips.push(`${span.children.length} child spans`)
    return chips
  }

  const genericChips = collectPrimitiveChips(metadata, ['phase', 'model', 'source'])
  if (genericChips.length > 0) return genericChips
  return collectPrimitiveChips(data, ['phase', 'source', 'kind'])
}

function getTimelineEventBadge(event: SubAgentInternalTimelineEvent) {
  if (event.kind === 'tool') return event.toolCall.name
  if (event.kind === 'llm-request') return 'llm'
  if (event.kind === 'turn') return 'turn'
  if (event.kind === 'reason') return 'reason'
  return 'span'
}

function getTimelineEventTone(event: SubAgentInternalTimelineEvent) {
  if (event.kind === 'tool') {
    const toolName = event.toolCall.name.toLowerCase()
    if (toolName === 'bash') {
      return {
        surfaceClass: 'border-cyan-400/14 bg-cyan-400/[0.05]',
        badgeClass: 'bg-cyan-400/15 text-cyan-200',
        caretClass: 'text-cyan-200',
      }
    }
    if (toolName === 'write') {
      return {
        surfaceClass: 'border-emerald-400/14 bg-emerald-400/[0.05]',
        badgeClass: 'bg-emerald-400/15 text-emerald-200',
        caretClass: 'text-emerald-200',
      }
    }
    if (toolName === 'edit') {
      return {
        surfaceClass: 'border-amber-400/14 bg-amber-400/[0.05]',
        badgeClass: 'bg-amber-400/15 text-amber-200',
        caretClass: 'text-amber-200',
      }
    }
    if (toolName === 'fetch') {
      return {
        surfaceClass: 'border-sky-400/14 bg-sky-400/[0.05]',
        badgeClass: 'bg-sky-400/15 text-sky-200',
        caretClass: 'text-sky-200',
      }
    }
    return {
      surfaceClass: 'border-white/[0.08] bg-white/[0.03]',
      badgeClass: 'bg-white/[0.08] text-[var(--color-text-secondary)]',
      caretClass: 'text-[var(--color-text-secondary)]',
    }
  }

  if (event.kind === 'llm-request') {
    return {
      surfaceClass: 'border-sky-400/14 bg-sky-400/[0.05]',
      badgeClass: 'bg-sky-400/15 text-sky-200',
      caretClass: 'text-sky-200',
    }
  }

  if (event.kind === 'turn') {
    return {
      surfaceClass: 'border-indigo-400/14 bg-indigo-400/[0.05]',
      badgeClass: 'bg-indigo-400/15 text-indigo-200',
      caretClass: 'text-indigo-200',
    }
  }

  if (event.kind === 'reason') {
    return {
      surfaceClass: 'border-amber-400/14 bg-amber-400/[0.05]',
      badgeClass: 'bg-amber-400/15 text-amber-200',
      caretClass: 'text-amber-200',
    }
  }

  return {
    surfaceClass: 'border-white/[0.08] bg-white/[0.03]',
    badgeClass: 'bg-white/[0.08] text-[var(--color-text-secondary)]',
    caretClass: 'text-[var(--color-text-secondary)]',
  }
}

function summarizeChildToolActivity(childToolCalls: SubAgentChildToolCall[]) {
  const counts = new Map<string, number>()

  for (const toolCall of childToolCalls) {
    counts.set(toolCall.name, (counts.get(toolCall.name) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function getSubAgentPreview({
  instruction,
  output,
  status,
  childToolCalls,
}: {
  instruction: string
  output?: string
  status: SubAgentBlockProps['status']
  childToolCalls: SubAgentChildToolCall[]
}) {
  if (output) return output.replace(/\s+/g, ' ').trim()
  if (childToolCalls.length > 0) {
    return `Used ${childToolCalls.length} tool call${childToolCalls.length === 1 ? '' : 's'} while ${status}.`
  }
  return instruction.replace(/\s+/g, ' ').trim()
}

function hasRecordContent(value?: Record<string, unknown>) {
  return Boolean(value && Object.keys(value).length > 0)
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength).trimEnd()}...`
}

function formatDuration(durationMs: number) {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function compareSpansByTime(left: TraceSpan, right: TraceSpan) {
  const leftTime = Date.parse(left.startTime)
  const rightTime = Date.parse(right.startTime)

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return left.name.localeCompare(right.name)
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickMeaningfulText(...values: Array<string | undefined>) {
  for (const value of values) {
    if (!value) continue
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized) return normalized
  }
  return undefined
}

function collectPrimitiveChips(record: Record<string, unknown>, preferredKeys: string[]) {
  const chips: string[] = []

  for (const key of preferredKeys) {
    const value = record[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      chips.push(`${key} ${String(value)}`)
    }
    if (chips.length >= 3) return chips
  }

  for (const [key, value] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      chips.push(`${key} ${String(value)}`)
    }
    if (chips.length >= 3) break
  }

  return chips
}
