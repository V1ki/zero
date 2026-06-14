import { type ReactNode, useMemo, useState } from 'react'
import type { SessionJudgeResponse, StoredSessionJudgeEntry } from '../../../../session-judge-types'
import { toolColors } from '../../../lib/colors'
import { formatCost, formatModelHistory, formatNumber, formatTimeAgo } from '../../../lib/format'
import { ContextLoadPanel } from './ContextLoadPanel'
import type { MemoryInjectionEntry } from '../memory/memory-retrieval'
import type { ContextTokenSummary } from './context-tokens'
import type { EvalConfidence, EvalTone, EvalVerdict, TraceEvalReport } from './trace-eval'

export interface ContextPanelModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

export interface ContextPanelToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  durationMs?: number
}

export interface ContextPanelMemoryResult {
  id: string
  type: string
  title?: string
  snippet: string
}

export interface ToolResultEntry {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
  outputSummary?: string
}

export interface QueuedInjectionMessageEntry {
  timestamp: string
  content: string
  imageCount: number
  mediaTypes: string[]
}

export interface QueuedInjectionEntry {
  count: number
  formattedText: string
  messages: QueuedInjectionMessageEntry[]
}

export interface LlmRequestEntry {
  id: string
  turnIndex?: number
  parentId?: string
  model: string
  provider: string
  userPrompt: string
  response: string
  stopReason: string
  toolUseCount: number
  toolResults?: ToolResultEntry[]
  queuedInjection?: QueuedInjectionEntry
  memoryInjections?: MemoryInjectionEntry[]
  tokens: {
    input: number
    output: number
    cacheWrite?: number
    cacheRead?: number
  }
  cost: number
  durationMs?: number
  ts: string
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

export function ContextPanelSummaryTab({
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
  llmRequests,
  relatedMemory,
  traceEval,
  traceLoading,
  judgeResult,
  judgeHistory,
  selectedJudgeEntry,
  judgeLoading,
  judgeHistoryLoading,
  judgeHistoryError,
  onRunJudge,
  onSelectJudgeEntry,
}: {
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
  llmRequests: LlmRequestEntry[]
  relatedMemory: ContextPanelMemoryResult[]
  traceEval: TraceEvalReport
  traceLoading: boolean
  judgeResult: SessionJudgeResponse | null
  judgeHistory: StoredSessionJudgeEntry[]
  selectedJudgeEntry: StoredSessionJudgeEntry | null
  judgeLoading: boolean
  judgeHistoryLoading: boolean
  judgeHistoryError: string | null
  onRunJudge?: () => void
  onSelectJudgeEntry?: (savedAt: string) => void
}) {
  const toolDist = useMemo(() => {
    const distribution = new Map<string, number>()
    for (const toolCall of toolCalls) {
      distribution.set(toolCall.name, (distribution.get(toolCall.name) ?? 0) + 1)
    }
    return distribution
  }, [toolCalls])
  const totalCalls = toolCalls.length

  return (
    <div className="space-y-4">
      {contextTokenSummary ? (
        <ContextLoadPanel summary={contextTokenSummary} layout="sidebar" />
      ) : null}

      <Section title="Trace Eval">
        <TraceEvalCard
          report={traceEval}
          loading={traceLoading}
          judgeResult={judgeResult}
          judgeHistory={judgeHistory}
          selectedJudgeEntry={selectedJudgeEntry}
          judgeLoading={judgeLoading}
          judgeHistoryLoading={judgeHistoryLoading}
          judgeHistoryError={judgeHistoryError}
          onRunJudge={sessionId ? onRunJudge : undefined}
          onSelectJudgeEntry={onSelectJudgeEntry}
        />
      </Section>

      {summary && (
        <Section title="Summary">
          <p className="text-[12px] text-[var(--color-text-secondary)]">{summary}</p>
        </Section>
      )}

      {systemPrompt && (
        <Section title="System Prompt">
          <ExpandableTextPanel value={systemPrompt} />
        </Section>
      )}

      <Section title="Model History">
        <p className="text-[12px] font-mono text-[var(--color-text-muted)]">
          {formatModelHistory(modelHistory)}
        </p>
      </Section>

      <ModelUsageSection
        totalTokens={totalTokens}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
      />

      <CacheSection
        cacheReadTokens={cacheReadTokens}
        cacheWriteTokens={cacheWriteTokens}
        effectiveInputTokens={effectiveInputTokens}
        cacheHitRate={cacheHitRate}
        cacheReadCost={cacheReadCost}
        cacheWriteCost={cacheWriteCost}
        grossAvoidedInputCost={grossAvoidedInputCost}
        netSavings={netSavings}
      />

      {totalCalls > 0 && (
        <ToolCallDistributionSection toolDist={toolDist} totalCalls={totalCalls} />
      )}

      <LlmRequestsSection requests={llmRequests} />

      {filesTouched.length > 0 && <FilesTouchedSection filesTouched={filesTouched} />}

      {relatedMemory.length > 0 && <RelatedMemorySection relatedMemory={relatedMemory} />}
    </div>
  )
}

function LlmRequestsSection({ requests }: { requests: LlmRequestEntry[] }) {
  if (requests.length === 0) return null

  return (
    <Section title="LLM Requests">
      <div className="space-y-2">
        {requests
          .slice(-5)
          .reverse()
          .map((request) => (
            <details key={request.id} className="rounded bg-white/[0.02] p-2">
              <summary className="cursor-pointer select-none text-[11px] text-[var(--color-text-secondary)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[var(--color-accent)]">
                    {request.model}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-disabled)]">
                    {formatTimeAgo(request.ts)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
                  <span>${request.cost.toFixed(4)}</span>
                  <span>
                    {request.tokens.input}/{request.tokens.output} tok
                  </span>
                  <span>{request.toolUseCount} tool</span>
                  <span>
                    {request.durationMs !== undefined
                      ? `${request.durationMs}ms`
                      : request.stopReason}
                  </span>
                </div>
              </summary>
              <div className="mt-2 space-y-2">
                <TracePreview label="prompt" value={request.userPrompt} />
                {request.queuedInjection && (
                  <QueuedInjectionPreview queuedInjection={request.queuedInjection} />
                )}
                {request.memoryInjections && request.memoryInjections.length > 0 && (
                  <MemoryInjectionPreview memoryInjections={request.memoryInjections} />
                )}
                <TracePreview label="response" value={request.response} />
              </div>
            </details>
          ))}
      </div>
    </Section>
  )
}

function QueuedInjectionPreview({
  queuedInjection,
}: {
  queuedInjection: QueuedInjectionEntry
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)]">
        queued_injection
      </div>
      <div className="space-y-2 rounded bg-black/20 p-2">
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          Queued injection: {queuedInjection.count} message(s)
        </div>
        {queuedInjection.messages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            {queuedInjection.messages.map((message, index) => (
              <span
                key={`${message.timestamp}-${index}`}
                className="rounded bg-white/5 px-1.5 py-0.5"
                title={
                  message.mediaTypes.length > 0
                    ? `media: ${message.mediaTypes.join(', ')}`
                    : undefined
                }
              >
                {formatQueuedTimestamp(message.timestamp)}
                {message.imageCount > 0
                  ? ` | ${message.imageCount} image${message.imageCount === 1 ? '' : 's'}`
                  : ''}
              </span>
            ))}
          </div>
        )}
        <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[10px] text-[var(--color-text-muted)]">
          {queuedInjection.formattedText}
        </pre>
      </div>
    </div>
  )
}

function MemoryInjectionPreview({
  memoryInjections,
}: {
  memoryInjections: MemoryInjectionEntry[]
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)]">
        memory_injections
      </div>
      <div className="space-y-2 rounded bg-black/20 p-2">
        {memoryInjections.map((memoryInjection, index) => (
          <div
            key={`${memoryInjection.layer}-${memoryInjection.source}-${index}`}
            className="space-y-1"
          >
            <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
              <span className="rounded bg-white/5 px-1.5 py-0.5">{memoryInjection.layer}</span>
              <span>{memoryInjection.source}</span>
            </div>
            <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[10px] text-[var(--color-text-muted)]">
              {memoryInjection.formattedText}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatQueuedTimestamp(timestamp: string): string {
  return timestamp.length >= 16 ? timestamp.slice(11, 16) : timestamp
}

function ModelUsageSection({
  totalTokens,
  inputTokens,
  outputTokens,
}: {
  totalTokens: number
  inputTokens?: number
  outputTokens?: number
}) {
  return (
    <Section title="Model Usage">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-muted)]">Total</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            {formatNumber(totalTokens)}
          </span>
        </div>
        {inputTokens !== undefined && (
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Input</span>
            <span className="font-mono text-[var(--color-text-secondary)]">
              {formatNumber(inputTokens)}
            </span>
          </div>
        )}
        {outputTokens !== undefined && (
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Output</span>
            <span className="font-mono text-[var(--color-text-secondary)]">
              {formatNumber(outputTokens)}
            </span>
          </div>
        )}
        {inputTokens !== undefined && outputTokens !== undefined && totalTokens > 0 && (
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden flex mt-1">
            <div
              className="h-full bg-[var(--color-accent)] rounded-l-full"
              style={{ width: `${(inputTokens / totalTokens) * 100}%` }}
            />
            <div
              className="h-full bg-[var(--color-accent-dim)]"
              style={{ width: `${(outputTokens / totalTokens) * 100}%` }}
            />
          </div>
        )}
      </div>
    </Section>
  )
}

function CacheSection({
  cacheReadTokens,
  cacheWriteTokens,
  effectiveInputTokens,
  cacheHitRate,
  cacheReadCost,
  cacheWriteCost,
  grossAvoidedInputCost,
  netSavings,
}: {
  cacheReadTokens?: number
  cacheWriteTokens?: number
  effectiveInputTokens?: number
  cacheHitRate?: number
  cacheReadCost?: number
  cacheWriteCost?: number
  grossAvoidedInputCost?: number
  netSavings?: number
}) {
  const formattedNetSavings =
    netSavings === undefined
      ? undefined
      : `${netSavings >= 0 ? '+' : '-'}$${formatCost(Math.abs(netSavings))}`

  return (
    <Section title="Cache">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-muted)]">Cache Read</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            {formatNumber(cacheReadTokens ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-muted)]">Cache Write</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            {formatNumber(cacheWriteTokens ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-muted)]">Effective Input</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            {formatNumber(effectiveInputTokens ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-muted)]">Hit Rate</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            {((cacheHitRate ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
        <div className="border-t border-[var(--color-border)] pt-2 mt-2 space-y-1">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Read Cost</span>
            <span className="font-mono text-[var(--color-text-secondary)]">
              ${formatCost(cacheReadCost ?? 0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Write Cost</span>
            <span className="font-mono text-[var(--color-text-secondary)]">
              ${formatCost(cacheWriteCost ?? 0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Avoided Input Cost</span>
            <span className="font-mono text-[var(--color-text-secondary)]">
              ${formatCost(grossAvoidedInputCost ?? 0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--color-text-muted)]">Net Savings</span>
            <span className="font-mono text-[var(--color-accent)]">
              {formattedNetSavings ?? '$0.0000'}
            </span>
          </div>
        </div>
      </div>
    </Section>
  )
}

function ToolCallDistributionSection({
  toolDist,
  totalCalls,
}: {
  toolDist: Map<string, number>
  totalCalls: number
}) {
  return (
    <Section title="Tool Calls">
      <div className="space-y-1.5">
        {Array.from(toolDist.entries()).map(([name, count]) => (
          <div key={name} className="flex items-center gap-2">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-0.5">
                <span
                  className={`text-[11px] font-mono ${toolColors[name.toLowerCase()] ?? 'text-slate-400'}`}
                >
                  {name}
                </span>
                <span className="text-[10px] text-[var(--color-text-disabled)]">{count}</span>
              </div>
              <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--color-accent)] rounded-full"
                  style={{ width: `${(count / totalCalls) * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function FilesTouchedSection({ filesTouched }: { filesTouched: string[] }) {
  return (
    <Section title="Files Touched">
      <div className="space-y-0.5">
        {filesTouched.map((file) => (
          <p key={file} className="text-[11px] font-mono text-[var(--color-text-muted)] truncate">
            {file}
          </p>
        ))}
      </div>
    </Section>
  )
}

function RelatedMemorySection({
  relatedMemory,
}: {
  relatedMemory: ContextPanelMemoryResult[]
}) {
  return (
    <Section title="Related Memory">
      <div className="space-y-1.5">
        {relatedMemory.slice(0, 5).map((memory) => (
          <div key={memory.id} className="rounded bg-white/[0.02] p-2">
            <span className="text-[10px] text-[var(--color-accent)] capitalize">{memory.type}</span>
            {memory.title && (
              <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                {memory.title}
              </p>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)] truncate">{memory.snippet}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

function TraceEvalCard({
  report,
  loading,
  judgeResult,
  judgeHistory,
  selectedJudgeEntry,
  judgeLoading,
  judgeHistoryLoading,
  judgeHistoryError,
  onRunJudge,
  onSelectJudgeEntry,
}: {
  report: TraceEvalReport
  loading: boolean
  judgeResult: SessionJudgeResponse | null
  judgeHistory: StoredSessionJudgeEntry[]
  selectedJudgeEntry: StoredSessionJudgeEntry | null
  judgeLoading: boolean
  judgeHistoryLoading: boolean
  judgeHistoryError: string | null
  onRunJudge?: () => void
  onSelectJudgeEntry?: (savedAt: string) => void
}) {
  if (
    loading &&
    report.metrics.projectedRequestCount === 0 &&
    report.metrics.llmRequestSpanCount === 0 &&
    report.metrics.closureCount === 0
  ) {
    return <p className="text-[12px] text-[var(--color-text-disabled)]">Loading trace…</p>
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-white/8 bg-white/[0.02] p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-end gap-1.5">
              <span className="text-[28px] font-semibold leading-none text-[var(--color-text-primary)]">
                {report.score}
              </span>
              <span className="pb-0.5 text-[11px] text-[var(--color-text-disabled)]">/100</span>
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{report.summary}</p>
          </div>

          <div className="flex flex-col items-end gap-1">
            <span
              className={`rounded px-2 py-1 text-[10px] ${getEvalVerdictClass(report.verdict)}`}
            >
              {formatEvalVerdict(report.verdict)}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${getEvalConfidenceClass(report.confidence)}`}
            >
              {report.confidence}
            </span>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {report.breakdown.map((item) => (
            <div key={item.key} className="rounded bg-black/15 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--color-text-disabled)]">{item.label}</span>
                <span className="text-[10px] font-mono text-[var(--color-text-secondary)]">
                  {item.score}/{item.maxScore}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                {item.note}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">
          <span className="rounded bg-black/15 px-2 py-1">
            {report.metrics.turnCount} turn{report.metrics.turnCount === 1 ? '' : 's'}
          </span>
          <span className="rounded bg-black/15 px-2 py-1">
            {report.metrics.projectedRequestCount} request
            {report.metrics.projectedRequestCount === 1 ? '' : 's'}
          </span>
          <span className="rounded bg-black/15 px-2 py-1">
            {report.metrics.toolCallCount} tool call{report.metrics.toolCallCount === 1 ? '' : 's'}
          </span>
          <span className="rounded bg-black/15 px-2 py-1">
            {report.metrics.closureCount} closure{report.metrics.closureCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        {report.highlights.map((highlight, index) => (
          <div
            key={`${highlight.tone}-${index}`}
            className={`rounded border px-2.5 py-2 text-[11px] leading-relaxed ${getEvalHighlightClass(highlight.tone)}`}
          >
            {highlight.text}
          </div>
        ))}
      </div>

      <div className="rounded border border-white/8 bg-black/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold text-[var(--color-text-primary)]">
              LLM Judge
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              Evaluates context use, memory usage, duplicate tools, cost discipline, grounding,
              human intervention judgment, and recovery honesty.
            </p>
          </div>

          {onRunJudge && (
            <button
              type="button"
              onClick={onRunJudge}
              disabled={judgeLoading}
              className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
            >
              {judgeLoading ? 'Running…' : judgeResult ? 'Run Again' : 'Run Judge'}
            </button>
          )}
        </div>

        {judgeHistoryLoading && judgeHistory.length === 0 && (
          <p className="mt-3 text-[11px] text-[var(--color-text-disabled)]">
            Loading saved judge runs…
          </p>
        )}

        {judgeHistoryError && (
          <p className="mt-3 text-[11px] text-amber-300">{judgeHistoryError}</p>
        )}

        <JudgeHistoryList
          judgeHistory={judgeHistory}
          selectedJudgeEntry={selectedJudgeEntry}
          onSelectJudgeEntry={onSelectJudgeEntry}
        />

        {judgeResult ? (
          <JudgeResultCard response={judgeResult} entry={selectedJudgeEntry} />
        ) : (
          !judgeHistoryLoading && (
            <p className="mt-3 text-[11px] text-[var(--color-text-disabled)]">
              Run on demand to avoid unnecessary model cost.
            </p>
          )
        )}
      </div>
    </div>
  )
}

function JudgeHistoryList({
  judgeHistory,
  selectedJudgeEntry,
  onSelectJudgeEntry,
}: {
  judgeHistory: StoredSessionJudgeEntry[]
  selectedJudgeEntry: StoredSessionJudgeEntry | null
  onSelectJudgeEntry?: (savedAt: string) => void
}) {
  if (judgeHistory.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-disabled)]">
        History
      </div>
      <div className="space-y-1.5">
        {judgeHistory.map((entry, index) => {
          const isSelected = selectedJudgeEntry?.savedAt === entry.savedAt

          return (
            <button
              key={`${entry.savedAt}-${index}`}
              type="button"
              onClick={() => onSelectJudgeEntry?.(entry.savedAt)}
              className={`w-full rounded border px-2.5 py-2 text-left transition-colors ${
                isSelected
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)]/20'
                  : 'border-white/8 bg-black/15 hover:border-[var(--color-accent)]/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                  {entry.run.result.overallScore}/100 ·{' '}
                  {formatJudgeVerdict(entry.run.result.verdict)}
                </span>
                <span
                  className="text-[10px] text-[var(--color-text-disabled)]"
                  title={entry.savedAt}
                >
                  {index === 0 ? 'latest' : formatTimeAgo(entry.savedAt)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">
                <span>{entry.run.model}</span>
                <span>{entry.run.result.confidence}</span>
                <span>{entry.run.generatedAt}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function JudgeResultCard({
  response,
  entry,
}: {
  response: SessionJudgeResponse
  entry: StoredSessionJudgeEntry | null
}) {
  const { result } = response

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-end gap-1.5">
            <span className="text-[24px] font-semibold leading-none text-[var(--color-text-primary)]">
              {result.overallScore}
            </span>
            <span className="pb-0.5 text-[10px] text-[var(--color-text-disabled)]">/100</span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{result.summary}</p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <span className={`rounded px-2 py-1 text-[10px] ${getJudgeVerdictClass(result.verdict)}`}>
            {formatJudgeVerdict(result.verdict)}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${getEvalConfidenceClass(result.confidence)}`}
          >
            {result.confidence}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="rounded bg-black/15 px-2 py-1">model {response.model}</span>
        <span className="rounded bg-black/15 px-2 py-1">
          dup tools {result.signals.duplicateToolCallCount}
        </span>
        <span className="rounded bg-black/15 px-2 py-1">
          memory {result.signals.memorySearchCount}/{result.signals.memoryReadCount}/
          {result.signals.memoryWriteCount}
        </span>
        <span className="rounded bg-black/15 px-2 py-1">
          ${result.signals.totalCost.toFixed(3)} total
        </span>
        {entry && (
          <span className="rounded bg-black/15 px-2 py-1" title={entry.savedAt}>
            saved {formatTimeAgo(entry.savedAt)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2">
        {result.dimensions.map((dimension) => (
          <div key={dimension.key} className="rounded bg-black/15 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[var(--color-text-disabled)]">
                {dimension.label}
              </span>
              <span className="text-[10px] font-mono text-[var(--color-text-secondary)]">
                {dimension.score}/{dimension.maxScore}
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              {dimension.rationale}
            </p>
          </div>
        ))}
      </div>

      {result.findings.length > 0 && (
        <div className="space-y-1.5">
          {result.findings.map((finding, index) => (
            <div
              key={`${finding.title}-${index}`}
              className={`rounded border px-2.5 py-2 text-[11px] leading-relaxed ${getJudgeFindingClass(finding.severity)}`}
            >
              <div className="font-medium">{finding.title}</div>
              <div className="mt-0.5 text-[10px] opacity-90">{finding.evidence}</div>
            </div>
          ))}
        </div>
      )}

      {entry && <JudgeArtifactsPanel entry={entry} />}
    </div>
  )
}

function JudgeArtifactsPanel({ entry }: { entry: StoredSessionJudgeEntry }) {
  return (
    <div className="space-y-2">
      <details className="rounded bg-black/15 p-2">
        <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
          Judge Prompt
        </summary>
        <div className="mt-2 space-y-2">
          <TracePreview
            label="system_prompt"
            value={entry.artifacts.primary.request.systemPrompt}
          />
          <TracePreview label="user_prompt" value={entry.artifacts.primary.request.userPrompt} />
          <TracePreview
            label="request_meta"
            value={JSON.stringify(entry.artifacts.primary.request, null, 2)}
          />
        </div>
      </details>

      <details className="rounded bg-black/15 p-2">
        <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
          Judge Response
        </summary>
        <div className="mt-2 space-y-2">
          <TracePreview
            label="primary_response_raw"
            value={entry.artifacts.primary.response.rawText}
          />
          <TracePreview
            label="primary_completion"
            value={JSON.stringify(entry.artifacts.primary.response.completion, null, 2)}
          />
        </div>
      </details>

      {entry.artifacts.repair && (
        <details className="rounded bg-black/15 p-2">
          <summary className="cursor-pointer text-[10px] text-[var(--color-accent)] select-none">
            Repair Exchange
          </summary>
          <div className="mt-2 space-y-2">
            <TracePreview
              label="repair_system_prompt"
              value={entry.artifacts.repair.request.systemPrompt}
            />
            <TracePreview
              label="repair_user_prompt"
              value={entry.artifacts.repair.request.userPrompt}
            />
            <TracePreview
              label="repair_request_meta"
              value={JSON.stringify(entry.artifacts.repair.request, null, 2)}
            />
            <TracePreview
              label="repair_response_raw"
              value={entry.artifacts.repair.response.rawText}
            />
            <TracePreview
              label="repair_completion"
              value={JSON.stringify(entry.artifacts.repair.response.completion, null, 2)}
            />
          </div>
        </details>
      )}
    </div>
  )
}

function formatEvalVerdict(verdict: EvalVerdict): string {
  if (verdict === 'resolved') return 'Resolved'
  if (verdict === 'blocked') return 'Blocked'
  return 'Needs Review'
}

function getEvalVerdictClass(verdict: EvalVerdict): string {
  if (verdict === 'resolved') return 'bg-emerald-400/10 text-emerald-300'
  if (verdict === 'blocked') return 'bg-amber-400/10 text-amber-300'
  return 'bg-rose-400/10 text-rose-300'
}

function getEvalConfidenceClass(confidence: EvalConfidence): string {
  if (confidence === 'high') return 'bg-cyan-400/10 text-cyan-300'
  if (confidence === 'medium') return 'bg-indigo-400/10 text-indigo-300'
  return 'bg-slate-400/10 text-slate-300'
}

function getEvalHighlightClass(tone: EvalTone): string {
  if (tone === 'good') return 'border-emerald-400/20 bg-emerald-400/5 text-emerald-100'
  if (tone === 'warn') return 'border-amber-400/20 bg-amber-400/5 text-amber-100'
  return 'border-rose-400/20 bg-rose-400/5 text-rose-100'
}

function formatJudgeVerdict(verdict: SessionJudgeResponse['result']['verdict']): string {
  if (verdict === 'strong') return 'Strong'
  if (verdict === 'weak') return 'Weak'
  return 'Mixed'
}

function getJudgeVerdictClass(verdict: SessionJudgeResponse['result']['verdict']): string {
  if (verdict === 'strong') return 'bg-emerald-400/10 text-emerald-300'
  if (verdict === 'weak') return 'bg-rose-400/10 text-rose-300'
  return 'bg-amber-400/10 text-amber-300'
}

function getJudgeFindingClass(
  severity: SessionJudgeResponse['result']['findings'][number]['severity'],
): string {
  if (severity === 'info') return 'border-cyan-400/20 bg-cyan-400/5 text-cyan-100'
  if (severity === 'bad') return 'border-rose-400/20 bg-rose-400/5 text-rose-100'
  return 'border-amber-400/20 bg-amber-400/5 text-amber-100'
}
