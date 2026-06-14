import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SessionJudgeHistoryResponse,
  SessionJudgeResponse,
  StoredSessionJudgeEntry,
} from '../../../../session-judge-types'
import { apiFetch, apiPost } from '../../../lib/api'
import { formatCost, formatNumber, formatTimeAgo } from '../../../lib/format'
import type {
  DecisionTimelineItem,
  SessionDecisionEvent,
  SessionTaskClosureEvent,
  TaskClosureTimelineItem,
  TraceSpan,
} from '../timeline/timeline'
import { filterDisplayableDecisions, getTaskClosureTraceDetails } from '../timeline/timeline'
import {
  getMemoryRetrievalSearchCount,
  getMemoryRetrievalSelectedCount,
  readMemoryRetrievalDetail,
} from '../memory/memory-retrieval'
import {
  type ContextPanelMemoryResult,
  type ContextPanelModelHistoryEntry,
  ContextPanelSummaryTab,
  type ContextPanelToolCallInfo,
  type LlmRequestEntry,
} from './ContextPanelSummaryTab'
import type { ContextTokenSummary } from './context-tokens'
import { evaluateTraceSession } from './trace-eval'

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide">
        {label}
      </span>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

function ExpandableTextPanel({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="text-[11px] text-[var(--color-accent)] hover:underline"
      >
        {expanded ? 'Collapse' : 'Expand'} ({value.length.toLocaleString()} chars)
      </button>
      {expanded && (
        <pre className="text-[11px] font-mono text-[var(--color-text-muted)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[400px] overflow-y-auto mt-1">
          {value}
        </pre>
      )}
    </>
  )
}

function TracePreview({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)]">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[10px] text-[var(--color-text-muted)]">
        {value}
      </pre>
    </div>
  )
}

function StatusBadge({ status }: { status: TraceSpan['status'] }) {
  const cls =
    status === 'success'
      ? 'text-emerald-300 bg-emerald-400/10'
      : status === 'error'
        ? 'text-rose-300 bg-rose-400/10'
        : 'text-amber-300 bg-amber-400/10'

  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{status}</span>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide mb-1.5">
        {title.toUpperCase()}
      </h4>
      {children}
    </div>
  )
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function truncateInline(value: string, limit = 120): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 36 ? `${value.slice(0, 33)}...` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '-'
  return '...'
}

interface CompressionSpanCardProps {
  span: TraceSpan
  depth?: number
}

export function CompressionSpanCard({ span, depth = 0 }: CompressionSpanCardProps) {
  const [promptOpen, setPromptOpen] = useState(false)
  const [responseOpen, setResponseOpen] = useState(false)

  const compression = (span.data?.compression as Record<string, unknown> | undefined) ?? {}
  const model = typeof compression.model === 'string' ? compression.model : undefined
  const provider = typeof compression.provider === 'string' ? compression.provider : undefined
  const prompt = typeof compression.prompt === 'string' ? compression.prompt : undefined
  const response = typeof compression.response === 'string' ? compression.response : undefined
  const durationMs =
    (compression.durationMs as number | undefined) ?? (span.durationMs as number | undefined)
  const cost = typeof compression.cost === 'number' ? compression.cost : undefined
  const tokens = (compression.tokens as Record<string, unknown> | undefined) ?? {}

  const tokenBadges = (
    [
      ['in', tokens.input],
      ['out', tokens.output],
      ['cw', tokens.cacheWrite],
      ['cr', tokens.cacheRead],
      ['rs', tokens.reasoning],
    ] as const
  ).flatMap(([label, value]) =>
    typeof value === 'number'
      ? [
          <span
            key={label}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]"
          >
            {label} {formatNumber(value)}
          </span>,
        ]
      : [],
  )

  const statusIcon = span.status === 'success' ? '✅' : span.status === 'error' ? '❌' : '⏳'

  return (
    <div
      className="rounded-lg border border-[#F59E0B]/20 bg-[#F59E0B]/[0.04]"
      style={{ marginLeft: `${depth * 14}px` }}
      data-trace-card="compression"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12px] font-mono font-semibold text-[#FBBF24]">{span.name}</span>
        <span className="flex-1" />
        <span className="text-[12px]" title={span.status}>
          {statusIcon}
        </span>
        {durationMs !== undefined && (
          <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
            {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      <div className="px-3 pb-2 flex flex-wrap gap-1.5">
        {model && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            {model}
          </span>
        )}
        {provider && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            {provider}
          </span>
        )}
        {tokenBadges}
        {cost !== undefined && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            ${formatCost(cost)}
          </span>
        )}
      </div>

      {prompt && (
        <CompressionCollapsibleSection
          label="Prompt"
          open={promptOpen}
          onToggle={() => setPromptOpen(!promptOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {prompt}
          </pre>
        </CompressionCollapsibleSection>
      )}

      {response && (
        <CompressionCollapsibleSection
          label="Response"
          open={responseOpen}
          onToggle={() => setResponseOpen(!responseOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {response}
          </pre>
        </CompressionCollapsibleSection>
      )}
    </div>
  )
}

function CompressionCollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="flex items-center gap-1 text-[11px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <div className="mt-1 px-1">{children}</div>}
    </div>
  )
}

export function TraceSummaryCard({ span }: { span: TraceSpan }) {
  const {
    action,
    reason,
    failureStage,
    classifierResponseRaw,
    assistantMessageId,
    classifierRequest,
    error,
  } = getTaskClosureTraceDetails(span)

  return (
    <div className="rounded border border-white/8 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-cyan-300">{span.name}</code>
          <StatusBadge status={span.status} />
        </div>
        <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
          {span.durationMs !== undefined ? `${span.durationMs}ms` : formatTimeAgo(span.startTime)}
        </span>
      </div>
      <div className="space-y-1 text-[11px] text-[var(--color-text-secondary)]">
        {action && (
          <p>
            <span className="text-[var(--color-text-disabled)]">action:</span> {action}
          </p>
        )}
        {reason && (
          <p>
            <span className="text-[var(--color-text-disabled)]">reason:</span> {reason}
          </p>
        )}
        {failureStage && (
          <p>
            <span className="text-[var(--color-text-disabled)]">failure_stage:</span> {failureStage}
          </p>
        )}
        {assistantMessageId && (
          <p>
            <span className="text-[var(--color-text-disabled)]">assistant_message_id:</span>{' '}
            {assistantMessageId}
          </p>
        )}
        {error && (
          <p>
            <span className="text-[var(--color-text-disabled)]">error:</span> {error}
          </p>
        )}
      </div>
      {(classifierRequest || classifierResponseRaw || error) && (
        <details className="mt-2 rounded bg-black/15 p-2">
          <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
            Task Closure Details
          </summary>
          <div className="mt-2 space-y-2">
            {classifierRequest && (
              <TracePreview
                label="classifier_request"
                value={JSON.stringify(classifierRequest, null, 2)}
              />
            )}
            {classifierResponseRaw && (
              <TracePreview label="classifier_response_raw" value={classifierResponseRaw} />
            )}
          </div>
        </details>
      )}
    </div>
  )
}

function mapSessionTaskClosureEventToCard(event: SessionTaskClosureEvent) {
  return {
    createdAt: event.ts,
    event: event.event,
    action: event.event === 'task_closure_decision' ? event.action : undefined,
    reason: event.reason,
    failureStage: event.event === 'task_closure_failed' ? event.failureStage : undefined,
    classifierRequest: event.classifierRequest,
    classifierResponseRaw:
      event.event === 'task_closure_failed' ? event.classifierResponseRaw : undefined,
    assistantMessageId: event.assistantMessageId,
    assistantMessageCreatedAt: event.assistantMessageCreatedAt,
    error: event.event === 'task_closure_failed' ? event.error : undefined,
  }
}

function mapSessionDecisionEventToCard(event: SessionDecisionEvent) {
  return {
    id: event.id,
    createdAt: event.ts,
    decisionType: event.decisionType,
    outcome: event.outcome,
    sourceKind: event.sourceKind,
    context: event.context,
    detail: event.detail,
    rationale: event.rationale,
    durationMs: event.durationMs,
  }
}

type PersistedTaskClosureCardModel = ReturnType<typeof mapSessionTaskClosureEventToCard>
type PersistedDecisionCardModel = ReturnType<typeof mapSessionDecisionEventToCard>

function PersistedTaskClosureCard({
  card,
  onJumpToAssistantMessage,
}: {
  card: PersistedTaskClosureCardModel
  onJumpToAssistantMessage?: (messageId: string) => void
}) {
  return (
    <div className="rounded border border-white/8 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-cyan-300">{card.event}</code>
          <span className="rounded px-1.5 py-0.5 text-[10px] text-cyan-200 bg-cyan-400/10">
            session
          </span>
        </div>
        <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
          {formatTimeAgo(card.createdAt)}
        </span>
      </div>
      <div className="space-y-1 text-[11px] text-[var(--color-text-secondary)]">
        {card.action && (
          <p>
            <span className="text-[var(--color-text-disabled)]">action:</span> {card.action}
          </p>
        )}
        {card.reason && (
          <p>
            <span className="text-[var(--color-text-disabled)]">reason:</span> {card.reason}
          </p>
        )}
        {card.failureStage && (
          <p>
            <span className="text-[var(--color-text-disabled)]">failure_stage:</span>{' '}
            {card.failureStage}
          </p>
        )}
        {card.assistantMessageId && (
          <p>
            <span className="text-[var(--color-text-disabled)]">assistant_message_id:</span>{' '}
            {card.assistantMessageId}
          </p>
        )}
        {card.assistantMessageId && onJumpToAssistantMessage && (
          <button
            type="button"
            className="text-[10px] text-[var(--color-accent)] hover:underline"
            onClick={() => {
              const assistantMessageId = card.assistantMessageId
              if (assistantMessageId) onJumpToAssistantMessage(assistantMessageId)
            }}
          >
            Jump to assistant
          </button>
        )}
        {card.error && (
          <p>
            <span className="text-[var(--color-text-disabled)]">error:</span> {card.error}
          </p>
        )}
      </div>
      {(card.classifierRequest || card.classifierResponseRaw || card.error) && (
        <details className="mt-2 rounded bg-black/15 p-2">
          <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
            Task Closure Details
          </summary>
          <div className="mt-2 space-y-2">
            {card.classifierRequest && (
              <TracePreview
                label="classifier_request"
                value={JSON.stringify(card.classifierRequest, null, 2)}
              />
            )}
            {card.classifierResponseRaw && (
              <TracePreview label="classifier_response_raw" value={card.classifierResponseRaw} />
            )}
          </div>
        </details>
      )}
    </div>
  )
}

export function PersistedDecisionCard({
  card,
}: {
  card: PersistedDecisionCardModel
}) {
  const isMemoryRetrieval = card.decisionType === 'memory_retrieval'
  const memoryDetail = isMemoryRetrieval ? readMemoryRetrievalDetail(card.detail) : undefined
  const searchCount = memoryDetail ? getMemoryRetrievalSearchCount(memoryDetail) : 0
  const selectedCount = memoryDetail ? getMemoryRetrievalSelectedCount(memoryDetail) : 0

  return (
    <div
      className={`rounded border p-3 ${
        isMemoryRetrieval
          ? 'border-emerald-400/15 bg-emerald-400/[0.04]'
          : 'border-white/8 bg-white/[0.02]'
      }`}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <code
            className={`text-[11px] ${isMemoryRetrieval ? 'text-emerald-300' : 'text-cyan-300'}`}
          >
            {card.decisionType}
          </code>
          <DecisionOutcomeBadge decisionType={card.decisionType} outcome={card.outcome} />
          {memoryDetail?.layer === 'layer2' && (
            <span className="rounded px-1.5 py-0.5 text-[10px] text-amber-200 bg-amber-400/10">
              memory_hint
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
          {formatTimeAgo(card.createdAt)}
        </span>
      </div>
      <div className="space-y-1 text-[11px] text-[var(--color-text-secondary)]">
        <p>
          <span className="text-[var(--color-text-disabled)]">source_kind:</span> {card.sourceKind}
        </p>
        {isMemoryRetrieval && (
          <p>
            <span className="text-[var(--color-text-disabled)]">activity:</span> {searchCount}{' '}
            search{searchCount === 1 ? '' : 'es'} · {selectedCount} selected
          </p>
        )}
        {card.durationMs !== undefined && (
          <p>
            <span className="text-[var(--color-text-disabled)]">duration:</span>{' '}
            {formatDuration(card.durationMs)}
          </p>
        )}
        {card.rationale && (
          <p>
            <span className="text-[var(--color-text-disabled)]">rationale:</span>{' '}
            {truncateInline(card.rationale)}
          </p>
        )}
      </div>
      {(card.context || card.detail || card.rationale) && (
        <details className="mt-2 rounded bg-black/15 p-2">
          <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
            Decision Details
          </summary>
          <div className="mt-2 space-y-2">
            {card.context && (
              <TracePreview label="context" value={JSON.stringify(card.context, null, 2)} />
            )}
            {card.detail && (
              <TracePreview label="detail" value={JSON.stringify(card.detail, null, 2)} />
            )}
            {card.rationale && <TracePreview label="rationale" value={card.rationale} />}
          </div>
        </details>
      )}
    </div>
  )
}

function DecisionOutcomeBadge({
  decisionType,
  outcome,
}: {
  decisionType: DecisionTimelineItem['decisionType']
  outcome: string
}) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${getDecisionOutcomeBadgeClass(decisionType, outcome)}`}
    >
      {outcome}
    </span>
  )
}

function getDecisionOutcomeBadgeClass(
  decisionType: DecisionTimelineItem['decisionType'],
  outcome: string,
): string {
  if (decisionType === 'memory_retrieval') {
    if (outcome === 'injected') return 'bg-emerald-400/10 text-emerald-300'
    if (outcome === 'empty') return 'bg-slate-400/10 text-slate-300'
    if (outcome === 'skipped') return 'bg-white/5 text-[var(--color-text-muted)]'
  }

  return 'bg-cyan-400/10 text-cyan-200'
}

interface Props {
  sessionId?: string
  summary?: string
  systemPrompt?: string
  modelHistory: ContextPanelModelHistoryEntry[]
  toolCalls: ContextPanelToolCallInfo[]
  filesTouched: string[]
  totalTokens: number
  inputTokens?: number
  outputTokens?: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  effectiveInputTokens?: number
  cacheHitRate?: number
  cacheReadCost?: number
  cacheWriteCost?: number
  grossAvoidedInputCost?: number
  netSavings?: number
  contextTokenSummary?: ContextTokenSummary | null
  llmRequests?: LlmRequestEntry[]
  selectedDecision?: DecisionTimelineItem | null
  selectedTaskClosure?: TaskClosureTimelineItem | null
  traces?: TraceSpan[]
  decisions?: SessionDecisionEvent[]
  taskClosureEvents?: SessionTaskClosureEvent[]
  traceLoading?: boolean
  onJumpToAssistantMessage?: (messageId: string) => void
  onJumpToSubAgentInTimeline?: (subAgentId: string) => void
}

export function ContextPanel({
  sessionId,
  summary,
  systemPrompt,
  modelHistory,
  toolCalls,
  filesTouched,
  totalTokens,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  effectiveInputTokens,
  cacheHitRate,
  cacheReadCost,
  cacheWriteCost,
  grossAvoidedInputCost,
  netSavings,
  contextTokenSummary,
  llmRequests = [],
  selectedDecision = null,
  selectedTaskClosure = null,
  traces = [],
  decisions = [],
  taskClosureEvents = [],
  traceLoading = false,
  onJumpToAssistantMessage,
  onJumpToSubAgentInTimeline,
}: Props) {
  const panelClassName = 'card p-4 h-full min-h-0 overflow-y-auto animate-fade-up'
  const [tab, setTab] = useState<'summary' | 'trace'>('summary')
  const [relatedMemory, setRelatedMemory] = useState<ContextPanelMemoryResult[]>([])
  const {
    judgeHistory,
    selectedJudgeEntry,
    judgeResult,
    judgeLoading,
    judgeHistoryLoading,
    judgeHistoryError,
    runJudge,
    selectJudgeEntry,
  } = useSessionJudgeHistory(sessionId)

  useEffect(() => {
    if (!summary) return
    apiFetch<{ results: ContextPanelMemoryResult[] }>(
      `/api/memory/search?q=${encodeURIComponent(summary.slice(0, 100))}`,
    )
      .then((res) => setRelatedMemory(res.results ?? []))
      .catch(() => {})
  }, [summary])

  const traceEval = useMemo(
    () =>
      evaluateTraceSession({
        traces,
        taskClosureEvents,
        llmRequests,
      }),
    [llmRequests, taskClosureEvents, traces],
  )

  if (selectedDecision && selectedDecision.decisionType !== 'memory_retrieval') {
    return <DecisionDetailPanel decision={selectedDecision} />
  }

  if (selectedTaskClosure) {
    return (
      <TaskClosureDetailPanel
        taskClosure={selectedTaskClosure}
        onJumpToAssistantMessage={onJumpToAssistantMessage}
      />
    )
  }

  return (
    <div data-testid="session-context-panel" className={panelClassName}>
      <div className="flex gap-2 mb-4">
        {(['summary', 'trace'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-2 py-1 rounded text-[11px] transition-colors ${
              tab === t
                ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <ContextPanelSummaryTab
          sessionId={sessionId}
          summary={summary}
          systemPrompt={systemPrompt}
          modelHistory={modelHistory}
          toolCalls={toolCalls}
          filesTouched={filesTouched}
          totalTokens={totalTokens}
          inputTokens={inputTokens}
          outputTokens={outputTokens}
          cacheWriteTokens={cacheWriteTokens}
          cacheReadTokens={cacheReadTokens}
          effectiveInputTokens={effectiveInputTokens}
          cacheHitRate={cacheHitRate}
          cacheReadCost={cacheReadCost}
          cacheWriteCost={cacheWriteCost}
          grossAvoidedInputCost={grossAvoidedInputCost}
          netSavings={netSavings}
          contextTokenSummary={contextTokenSummary}
          llmRequests={llmRequests}
          relatedMemory={relatedMemory}
          traceEval={traceEval}
          traceLoading={traceLoading}
          judgeResult={judgeResult}
          judgeHistory={judgeHistory}
          selectedJudgeEntry={selectedJudgeEntry}
          judgeLoading={judgeLoading}
          judgeHistoryLoading={judgeHistoryLoading}
          judgeHistoryError={judgeHistoryError}
          onRunJudge={runJudge}
          onSelectJudgeEntry={selectJudgeEntry}
        />
      )}

      {tab === 'trace' && (
        <ContextPanelTraceTab
          traceLoading={traceLoading}
          decisions={decisions}
          taskClosureEvents={taskClosureEvents}
          traces={traces}
          onJumpToAssistantMessage={onJumpToAssistantMessage}
          onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
        />
      )}
    </div>
  )
}

function ContextPanelTraceTab({
  traceLoading,
  decisions,
  taskClosureEvents,
  traces,
  onJumpToAssistantMessage,
  onJumpToSubAgentInTimeline,
}: {
  traceLoading: boolean
  decisions: SessionDecisionEvent[]
  taskClosureEvents: SessionTaskClosureEvent[]
  traces: TraceSpan[]
  onJumpToAssistantMessage?: (messageId: string) => void
  onJumpToSubAgentInTimeline?: (subAgentId: string) => void
}) {
  const taskClosureCards = useMemo(
    () => taskClosureEvents.map(mapSessionTaskClosureEventToCard),
    [taskClosureEvents],
  )
  const decisionCards = useMemo(
    () => filterDisplayableDecisions(decisions).map(mapSessionDecisionEventToCard),
    [decisions],
  )

  return (
    <div className="space-y-4">
      <Section title="Decisions">
        {traceLoading ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">Loading trace…</p>
        ) : decisionCards.length === 0 ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">
            No decision events for this session.
          </p>
        ) : (
          <div className="space-y-2">
            {decisionCards.map((card, index) => (
              <PersistedDecisionCard key={`${card.id}-${index}`} card={card} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Task Closure">
        {traceLoading ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">Loading trace…</p>
        ) : taskClosureCards.length === 0 ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">
            No task closure events for this session.
          </p>
        ) : (
          <div className="space-y-2">
            {taskClosureCards.map((card, index) => (
              <PersistedTaskClosureCard
                key={`${card.createdAt}-${index}`}
                card={card}
                onJumpToAssistantMessage={onJumpToAssistantMessage}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Full Trace">
        {traceLoading ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">Loading trace…</p>
        ) : traces.length === 0 ? (
          <p className="text-[12px] text-[var(--color-text-disabled)]">
            No trace spans for this session.
          </p>
        ) : (
          <div className="space-y-2">
            {traces.map((span) => (
              <TraceSpanTree
                key={span.id}
                span={span}
                depth={0}
                onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function TraceSpanTree({
  span,
  depth,
  onJumpToSubAgentInTimeline,
}: {
  span: TraceSpan
  depth: number
  onJumpToSubAgentInTimeline?: (agentId: string) => void
}) {
  if (isCompressionSpan(span)) {
    return <CompressionSpanCard span={span} depth={depth} />
  }

  if (isSubAgentSpan(span)) {
    return (
      <SubAgentSpanCard span={span} depth={depth} onJumpToTimeline={onJumpToSubAgentInTimeline} />
    )
  }

  return (
    <TraceTreeWithSubAgents
      span={span}
      depth={depth}
      onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
    />
  )
}

function SubAgentSpanCard({
  span,
  depth = 0,
  onJumpToTimeline,
}: {
  span: TraceSpan
  depth?: number
  onJumpToTimeline?: (agentId: string) => void
}) {
  const [instructionOpen, setInstructionOpen] = useState(false)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [outputOpen, setOutputOpen] = useState(false)
  const [childrenOpen, setChildrenOpen] = useState(false)
  const view = buildSubAgentSpanViewModel(span)

  return (
    <div
      className="rounded-lg border border-[#4ECDC4]/20 bg-[#4ECDC4]/[0.03]"
      style={{ marginLeft: `${depth * 14}px` }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12px] font-mono font-semibold text-[#4ECDC4]">{view.label}</span>
        {view.role && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#4ECDC4]/10 text-[#4ECDC4]">
            {view.role}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[12px]" title={span.status}>
          {view.statusIcon}
        </span>
        {view.durationMs !== undefined && (
          <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
            {formatSubAgentSpanDuration(view.durationMs)}
          </span>
        )}
        {onJumpToTimeline && (
          <button
            type="button"
            onClick={() => onJumpToTimeline(view.agentId)}
            className="text-[10px] text-[#4ECDC4] hover:underline"
          >
            ↗ timeline
          </button>
        )}
      </div>

      {view.instruction && (
        <CollapsibleSection
          label="Instruction"
          open={instructionOpen}
          onToggle={() => setInstructionOpen(!instructionOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {view.instruction}
          </pre>
        </CollapsibleSection>
      )}

      {view.systemPrompt && (
        <CollapsibleSection
          label="System Prompt"
          open={systemPromptOpen}
          onToggle={() => setSystemPromptOpen(!systemPromptOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-muted)] whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-[400px] overflow-y-auto">
            {view.systemPrompt}
          </pre>
        </CollapsibleSection>
      )}

      {view.outputSummary && (
        <CollapsibleSection
          label="Output Summary"
          open={outputOpen}
          onToggle={() => setOutputOpen(!outputOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {view.outputSummary}
          </pre>
        </CollapsibleSection>
      )}

      {span.children.length > 0 && (
        <CollapsibleSection
          label={`Child Spans (${span.children.length})`}
          open={childrenOpen}
          onToggle={() => setChildrenOpen(!childrenOpen)}
        >
          <div className="space-y-1.5 pl-2 border-l border-[#4ECDC4]/15">
            {span.children.map((child) => (
              <ChildSpanRow key={child.id} span={child} depth={0} />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {view.success !== undefined && (
        <div className="px-3 pb-2 text-[10px] text-[var(--color-text-muted)]">
          Result: {view.success ? 'success' : 'failed'}
        </div>
      )}
    </div>
  )
}

interface SubAgentSpanViewModel {
  agentId: string
  label: string
  role?: string
  instruction?: string
  systemPrompt?: string
  success?: boolean
  durationMs?: number
  outputSummary?: string
  statusIcon: string
}

function buildSubAgentSpanViewModel(span: TraceSpan): SubAgentSpanViewModel {
  const data = span.data ?? {}
  const agentId =
    (span.metadata?.agentId as string | undefined) ??
    (data.agentId as string | undefined) ??
    span.id
  const label = span.name.startsWith('sub_agent:')
    ? span.name.slice('sub_agent:'.length)
    : span.name === 'sub_agent'
      ? ((data.label as string | undefined) ?? agentId)
      : span.name

  return {
    agentId,
    label,
    role: data.role as string | undefined,
    instruction: data.instruction as string | undefined,
    systemPrompt: data.systemPrompt as string | undefined,
    success: data.success as boolean | undefined,
    durationMs: (data.durationMs as number | undefined) ?? span.durationMs,
    statusIcon: span.status === 'success' ? '✅' : span.status === 'error' ? '❌' : '⏳',
  }
}

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="flex items-center gap-1 text-[11px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <div className="mt-1 px-1">{children}</div>}
    </div>
  )
}

function ChildSpanRow({ span, depth }: { span: TraceSpan; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const hasChildren = span.children.length > 0
  const statusCls = getChildSpanStatusClass(span.status)

  return (
    <div style={{ marginLeft: `${depth * 12}px` }}>
      <div className="flex items-center gap-2 rounded bg-white/[0.02] px-2 py-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        <code className="text-[10px] text-[var(--color-text-secondary)] truncate flex-1">
          {span.name}
        </code>
        <span className={`rounded px-1 py-0.5 text-[9px] ${statusCls}`}>{span.status}</span>
        {span.durationMs !== undefined && (
          <span className="text-[9px] font-mono text-[var(--color-text-disabled)]">
            {formatSubAgentSpanDuration(span.durationMs)}
          </span>
        )}
      </div>
      {expanded &&
        span.children.map((child) => (
          <ChildSpanRow key={child.id} span={child} depth={depth + 1} />
        ))}
    </div>
  )
}

function formatSubAgentSpanDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function getChildSpanStatusClass(status: TraceSpan['status']): string {
  return status === 'success'
    ? 'text-emerald-300 bg-emerald-400/10'
    : status === 'error'
      ? 'text-rose-300 bg-rose-400/10'
      : 'text-amber-300 bg-amber-400/10'
}

function isSubAgentSpan(span: TraceSpan): boolean {
  return (
    span.name === 'sub_agent' ||
    span.name.startsWith('sub_agent:') ||
    span.data?.kind === 'sub_agent' ||
    span.metadata?.kind === 'sub_agent'
  )
}

function isCompressionSpan(span: TraceSpan): boolean {
  return span.name === 'compression' && span.kind === 'llm_request'
}

function TraceTreeWithSubAgents({
  span,
  depth,
  onJumpToSubAgentInTimeline,
}: {
  span: TraceSpan
  depth: number
  onJumpToSubAgentInTimeline?: (agentId: string) => void
}) {
  return (
    <div className="space-y-2">
      <div
        className="rounded border border-white/8 bg-white/[0.02] p-3"
        style={{ marginLeft: `${depth * 14}px` }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <code className="text-[11px] text-[var(--color-text-secondary)] truncate">
              {span.name}
            </code>
            <StatusBadge status={span.status} />
          </div>
          <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
            {span.durationMs !== undefined ? `${span.durationMs}ms` : 'running'}
          </span>
        </div>
        {span.metadata && Object.keys(span.metadata).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(span.metadata)
              .slice(0, 6)
              .map(([key, value]) => (
                <span
                  key={key}
                  className="rounded bg-black/20 px-2 py-1 text-[10px] text-[var(--color-text-muted)]"
                  title={`${key}: ${String(value)}`}
                >
                  {key}: {formatMetadataValue(value)}
                </span>
              ))}
          </div>
        )}
      </div>

      {span.children.map((child) => (
        <TraceSpanTree
          key={child.id}
          span={child}
          depth={depth + 1}
          onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
        />
      ))}
    </div>
  )
}

interface SessionJudgeHistoryState {
  judgeHistory: StoredSessionJudgeEntry[]
  selectedJudgeEntry: StoredSessionJudgeEntry | null
  judgeResult: SessionJudgeResponse | null
  selectedJudgeSavedAt: string | null
  judgeLoading: boolean
  judgeHistoryLoading: boolean
  judgeHistoryError: string | null
  runJudge(): Promise<void>
  selectJudgeEntry(savedAt: string | null): void
}

function useSessionJudgeHistory(sessionId?: string): SessionJudgeHistoryState {
  const [judgeHistory, setJudgeHistory] = useState<StoredSessionJudgeEntry[]>([])
  const [selectedJudgeSavedAt, setSelectedJudgeSavedAt] = useState<string | null>(null)
  const [judgeLoading, setJudgeLoading] = useState(false)
  const [judgeHistoryLoading, setJudgeHistoryLoading] = useState(false)
  const [judgeHistoryError, setJudgeHistoryError] = useState<string | null>(null)

  const selectedJudgeEntry = useMemo(() => {
    if (judgeHistory.length === 0) return null
    if (!selectedJudgeSavedAt) return judgeHistory[0] ?? null
    return (
      judgeHistory.find((entry) => entry.savedAt === selectedJudgeSavedAt) ??
      judgeHistory[0] ??
      null
    )
  }, [judgeHistory, selectedJudgeSavedAt])

  const loadJudgeHistory = useCallback(
    async (preferredSavedAt?: string) => {
      if (!sessionId) {
        setJudgeHistory([])
        setSelectedJudgeSavedAt(null)
        setJudgeHistoryError(null)
        setJudgeHistoryLoading(false)
        return
      }

      setJudgeHistoryLoading(true)
      setJudgeHistoryError(null)
      try {
        const response = await apiFetch<SessionJudgeHistoryResponse>(
          `/api/sessions/${sessionId}/llm-judge`,
        )
        const history = response.history ?? []
        setJudgeHistory(history)
        setSelectedJudgeSavedAt((current) => {
          if (preferredSavedAt && history.some((entry) => entry.savedAt === preferredSavedAt)) {
            return preferredSavedAt
          }
          if (current && history.some((entry) => entry.savedAt === current)) {
            return current
          }
          return history[0]?.savedAt ?? null
        })
      } catch (error) {
        setJudgeHistory([])
        setSelectedJudgeSavedAt(null)
        setJudgeHistoryError(error instanceof Error ? error.message : String(error))
      } finally {
        setJudgeHistoryLoading(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    if (sessionId === undefined) {
      setJudgeHistory([])
      setSelectedJudgeSavedAt(null)
      setJudgeHistoryError(null)
      setJudgeLoading(false)
      setJudgeHistoryLoading(false)
      return
    }

    setJudgeHistory([])
    setSelectedJudgeSavedAt(null)
    setJudgeHistoryError(null)
    setJudgeLoading(false)
    void loadJudgeHistory()
  }, [loadJudgeHistory, sessionId])

  const runJudge = useCallback(async () => {
    if (!sessionId || judgeLoading) return
    setJudgeLoading(true)
    try {
      const result = await apiPost<SessionJudgeResponse>(`/api/sessions/${sessionId}/llm-judge`, {})
      await loadJudgeHistory(result.generatedAt)
    } catch {
    } finally {
      setJudgeLoading(false)
    }
  }, [judgeLoading, loadJudgeHistory, sessionId])

  return {
    judgeHistory,
    selectedJudgeEntry,
    judgeResult: selectedJudgeEntry?.run ?? null,
    selectedJudgeSavedAt,
    judgeLoading,
    judgeHistoryLoading,
    judgeHistoryError,
    runJudge,
    selectJudgeEntry: setSelectedJudgeSavedAt,
  }
}

function TaskClosureDetailPanel({
  taskClosure,
  onJumpToAssistantMessage,
}: {
  taskClosure: TaskClosureTimelineItem
  onJumpToAssistantMessage?: (messageId: string) => void
}) {
  const accentClass =
    taskClosure.event === 'task_closure_failed' || taskClosure.action === 'block'
      ? 'text-amber-400'
      : 'text-cyan-400'

  return (
    <div
      data-testid="session-context-panel"
      className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up"
    >
      <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-3">
        Task Closure Detail
      </h3>
      <div className="space-y-3">
        <DetailField label="EVENT">
          <p className={`text-[13px] font-mono ${accentClass}`}>{taskClosure.event}</p>
        </DetailField>

        {taskClosure.action && (
          <DetailField label="ACTION">
            <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
              {taskClosure.action}
            </p>
          </DetailField>
        )}

        <DetailField label="REASON">
          <p className="text-[12px] whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
            {taskClosure.reason}
          </p>
        </DetailField>

        {taskClosure.failureStage && (
          <DetailField label="FAILURE STAGE">
            <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
              {taskClosure.failureStage}
            </p>
          </DetailField>
        )}

        {taskClosure.error && (
          <DetailField label="ERROR">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[220px] overflow-y-auto">
              {taskClosure.error}
            </pre>
          </DetailField>
        )}

        {taskClosure.assistantMessageId && (
          <DetailField label="ASSISTANT MESSAGE">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
                {taskClosure.assistantMessageId}
              </p>
              {onJumpToAssistantMessage && (
                <button
                  type="button"
                  onClick={() => {
                    const assistantMessageId = taskClosure.assistantMessageId
                    if (assistantMessageId) onJumpToAssistantMessage(assistantMessageId)
                  }}
                  className="text-[11px] text-[var(--color-accent)] hover:underline"
                >
                  Jump to message
                </button>
              )}
            </div>
          </DetailField>
        )}

        {taskClosure.classifierRequest?.prompt && (
          <DetailField label="CLASSIFIER PROMPT">
            <ExpandableTextPanel value={taskClosure.classifierRequest.prompt} />
          </DetailField>
        )}

        {taskClosure.classifierResponseRaw && (
          <DetailField label="CLASSIFIER RESPONSE">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[400px] overflow-y-auto">
              {taskClosure.classifierResponseRaw}
            </pre>
          </DetailField>
        )}
      </div>
    </div>
  )
}

function DecisionDetailPanel({
  decision,
}: {
  decision: DecisionTimelineItem
}) {
  return (
    <div
      data-testid="session-context-panel"
      className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up"
    >
      <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-3">
        Decision Detail
      </h3>
      <div className="space-y-3">
        <DetailField label="DECISION TYPE">
          <p className="text-[13px] font-mono text-cyan-300">{decision.decisionType}</p>
        </DetailField>

        <DetailField label="OUTCOME">
          <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
            {decision.outcome}
          </p>
        </DetailField>

        <DetailField label="SOURCE KIND">
          <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
            {decision.sourceKind}
          </p>
        </DetailField>

        {decision.durationMs !== undefined && (
          <DetailField label="DURATION">
            <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
              {formatDuration(decision.durationMs)}
            </p>
          </DetailField>
        )}

        {decision.rationale && (
          <DetailField label="RATIONALE">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[320px] overflow-y-auto">
              {decision.rationale}
            </pre>
          </DetailField>
        )}

        {decision.context && (
          <DetailField label="CONTEXT">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[320px] overflow-y-auto">
              {JSON.stringify(decision.context, null, 2)}
            </pre>
          </DetailField>
        )}

        {decision.detail && (
          <DetailField label="DETAIL">
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[320px] overflow-y-auto">
              {JSON.stringify(decision.detail, null, 2)}
            </pre>
          </DetailField>
        )}
      </div>
    </div>
  )
}
