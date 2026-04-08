import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  SessionJudgeHistoryResponse,
  SessionJudgeResponse,
  StoredSessionJudgeEntry,
} from '../../../eval/types'
import { apiFetch, apiPost } from '../../lib/api'
import { toolColors } from '../../lib/colors'
import { formatCost, formatModelHistory, formatNumber, formatTimeAgo } from '../../lib/format'
import { CompressionSpanCard } from './CompressionSpanCard'
import { SubAgentSpanCard } from './SubAgentSpanCard'
import {
  type DecisionTimelineItem,
  type SessionDecisionEvent,
  type SessionTaskClosureEvent,
  type TaskClosureTimelineItem,
  type TraceSpan,
  filterDisplayableDecisions,
  getTaskClosureTraceDetails,
} from './timeline'
import { evaluateTraceSession } from './trace-eval'

interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  durationMs?: number
}

interface MemoryResult {
  id: string
  type: string
  title?: string
  snippet: string
}

interface ToolResultEntry {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
  outputSummary?: string
}

interface QueuedInjectionMessageEntry {
  timestamp: string
  content: string
  imageCount: number
  mediaTypes: string[]
}

interface QueuedInjectionEntry {
  count: number
  formattedText: string
  messages: QueuedInjectionMessageEntry[]
}

interface MemoryInjectionEntry {
  layer: 'layer1' | 'layer2'
  source: 'retrieved_memories' | 'memory_hint'
  formattedText: string
}

interface MemoryRetrievalSearchSummary {
  query: string
  resultCount: number
  topResultTitle?: string
}

interface MemoryRetrievalSelectedMemory {
  id: string
  type: string
  title: string
  score?: number
}

interface MemoryRetrievalTokens {
  input: number
  output: number
}

interface MemoryRetrievalDetail {
  need?: boolean
  layer?: string
  turnIndex?: number
  queries: string[]
  searches: MemoryRetrievalSearchSummary[]
  searchResultCount?: number
  selectedMemoryIds: string[]
  selectedMemories: MemoryRetrievalSelectedMemory[]
  usedFallbackSelection: boolean
  tokens?: MemoryRetrievalTokens
  cost?: number
}

interface LlmRequestEntry {
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

interface Props {
  sessionId?: string
  summary?: string
  systemPrompt?: string
  modelHistory: ModelHistoryEntry[]
  toolCalls: ToolCallInfo[]
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
  llmRequests?: LlmRequestEntry[]
  selectedToolId: string | null
  selectedDecision?: DecisionTimelineItem | null
  selectedTaskClosure?: TaskClosureTimelineItem | null
  selectedSubAgentId?: string | null
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
  llmRequests = [],
  selectedToolId,
  selectedDecision = null,
  selectedTaskClosure = null,
  traces = [],
  decisions = [],
  taskClosureEvents = [],
  traceLoading = false,
  onJumpToAssistantMessage,
  onJumpToSubAgentInTimeline,
}: Props) {
  const [tab, setTab] = useState<'summary' | 'trace'>('summary')
  const [relatedMemory, setRelatedMemory] = useState<MemoryResult[]>([])
  const [judgeHistory, setJudgeHistory] = useState<StoredSessionJudgeEntry[]>([])
  const [selectedJudgeSavedAt, setSelectedJudgeSavedAt] = useState<string | null>(null)
  const [judgeLoading, setJudgeLoading] = useState(false)
  const [judgeHistoryLoading, setJudgeHistoryLoading] = useState(false)
  const [judgeHistoryError, setJudgeHistoryError] = useState<string | null>(null)

  useEffect(() => {
    if (!summary) return
    apiFetch<{ results: MemoryResult[] }>(
      `/api/memory/search?q=${encodeURIComponent(summary.slice(0, 100))}`,
    )
      .then((res) => setRelatedMemory(res.results ?? []))
      .catch(() => {})
  }, [summary])

  const selectedTool = selectedToolId ? toolCalls.find((t) => t.id === selectedToolId) : null

  const toolDist = new Map<string, number>()
  for (const tc of toolCalls) {
    toolDist.set(tc.name, (toolDist.get(tc.name) ?? 0) + 1)
  }
  const totalCalls = toolCalls.length

  const taskClosureCards = useMemo(
    () => taskClosureEvents.map(mapSessionTaskClosureEventToCard),
    [taskClosureEvents],
  )
  const decisionCards = useMemo(
    () => filterDisplayableDecisions(decisions).map(mapSessionDecisionEventToCard),
    [decisions],
  )
  const traceEval = useMemo(
    () =>
      evaluateTraceSession({
        traces,
        taskClosureEvents,
        llmRequests,
      }),
    [llmRequests, taskClosureEvents, traces],
  )

  const selectedJudgeEntry = useMemo(() => {
    if (judgeHistory.length === 0) return null
    if (!selectedJudgeSavedAt) return judgeHistory[0] ?? null
    return (
      judgeHistory.find((entry) => entry.savedAt === selectedJudgeSavedAt) ??
      judgeHistory[0] ??
      null
    )
  }, [judgeHistory, selectedJudgeSavedAt])
  const judgeResult: SessionJudgeResponse | null = selectedJudgeEntry?.run ?? null

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

  const formattedNetSavings =
    netSavings === undefined
      ? undefined
      : `${netSavings >= 0 ? '+' : '-'}$${formatCost(Math.abs(netSavings))}`

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

  if (selectedTool) {
    return (
      <div className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-3">
          Tool Detail
        </h3>
        <div className="space-y-3">
          <div>
            <span className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide">
              TOOL
            </span>
            <p
              className={`text-[13px] font-mono mt-0.5 ${toolColors[selectedTool.name.toLowerCase()] ?? 'text-slate-400'}`}
            >
              {selectedTool.name}
            </p>
          </div>
          {selectedTool.durationMs !== undefined && (
            <div>
              <span className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide">
                DURATION
              </span>
              <p className="text-[12px] font-mono mt-0.5 text-[var(--color-text-secondary)]">
                {formatDuration(selectedTool.durationMs)}
              </p>
            </div>
          )}
          <div>
            <span className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide">
              INPUT
            </span>
            <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] mt-1 whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[320px] overflow-y-auto">
              {JSON.stringify(selectedTool.input, null, 2)}
            </pre>
          </div>
          {selectedTool.result !== undefined && (
            <div>
              <span className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide">
                OUTPUT
              </span>
              <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] mt-1 whitespace-pre-wrap break-all bg-black/20 rounded p-2 max-h-[400px] overflow-y-auto">
                {selectedTool.result}
              </pre>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (selectedDecision) {
    if (selectedDecision.decisionType === 'memory_retrieval') {
      return <MemoryRetrievalDetailPanel decision={selectedDecision} llmRequests={llmRequests} />
    }

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
    <div className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up">
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
        <div className="space-y-4">
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
              onRunJudge={sessionId ? runJudge : undefined}
              onSelectJudgeEntry={setSelectedJudgeSavedAt}
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

          {totalCalls > 0 && (
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
                        <span className="text-[10px] text-[var(--color-text-disabled)]">
                          {count}
                        </span>
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
          )}

          {llmRequests.length > 0 && (
            <Section title="LLM Requests">
              <div className="space-y-2">
                {llmRequests
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
          )}

          {filesTouched.length > 0 && (
            <Section title="Files Touched">
              <div className="space-y-0.5">
                {filesTouched.map((f) => (
                  <p
                    key={f}
                    className="text-[11px] font-mono text-[var(--color-text-muted)] truncate"
                  >
                    {f}
                  </p>
                ))}
              </div>
            </Section>
          )}

          {relatedMemory.length > 0 && (
            <Section title="Related Memory">
              <div className="space-y-1.5">
                {relatedMemory.slice(0, 5).map((m) => (
                  <div key={m.id} className="rounded bg-white/[0.02] p-2">
                    <span className="text-[10px] text-[var(--color-accent)] capitalize">
                      {m.type}
                    </span>
                    {m.title && (
                      <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                        {m.title}
                      </p>
                    )}
                    <p className="text-[11px] text-[var(--color-text-muted)] truncate">
                      {m.snippet}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {tab === 'trace' && (
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
                {traces.map((span) =>
                  isCompressionSpan(span) ? (
                    <CompressionSpanCard key={span.id} span={span} depth={0} />
                  ) : isSubAgentSpan(span) ? (
                    <SubAgentSpanCard
                      key={span.id}
                      span={span}
                      depth={0}
                      onJumpToTimeline={onJumpToSubAgentInTimeline}
                    />
                  ) : (
                    <TraceTreeWithSubAgents
                      key={span.id}
                      span={span}
                      depth={0}
                      onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
                    />
                  ),
                )}
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  )
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
    <div className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up">
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

export function MemoryRetrievalDetailPanel({
  decision,
  llmRequests = [],
}: {
  decision: DecisionTimelineItem
  llmRequests?: LlmRequestEntry[]
}) {
  const detail = readMemoryRetrievalDetail(decision.detail)
  const [viewingMemory, setViewingMemory] = useState<MemoryRetrievalSelectedMemory | null>(null)
  const [memoryContent, setMemoryContent] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const injectionPreview = useMemo(
    () => pickMemoryInjectionPreview(decision, detail, llmRequests),
    [decision, detail, llmRequests],
  )

  useEffect(() => {
    if (!viewingMemory) return

    const controller = new AbortController()
    setMemoryLoading(true)
    setMemoryContent(null)
    setMemoryError(null)

    void fetch(`/api/memory/${viewingMemory.type}/${viewingMemory.id}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 404) throw new Error('deleted')
        if (!res.ok) throw new Error('fetch_failed')
        return res.json() as Promise<{ memory?: { content?: string } }>
      })
      .then((data) => setMemoryContent(data.memory?.content ?? ''))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setMemoryError(
          error instanceof Error && error.message === 'deleted'
            ? '该记忆已被删除或归档。'
            : '加载失败。',
        )
      })
      .finally(() => setMemoryLoading(false))

    return () => controller.abort()
  }, [viewingMemory])

  useEffect(() => {
    if (!viewingMemory) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setViewingMemory(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [viewingMemory])

  return (
    <>
      <div className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-3">
          Memory Retrieval Detail
        </h3>
        <div className="space-y-3">
          <DetailField label="OUTCOME">
            <DecisionOutcomeBadge decisionType="memory_retrieval" outcome={decision.outcome} />
          </DetailField>

          {detail.layer && (
            <DetailField label="LAYER">
              <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
                {detail.layer}
              </p>
            </DetailField>
          )}

          {detail.queries.length > 0 && (
            <DetailField label="QUERIES">
              <div className="flex flex-wrap gap-1.5">
                {detail.queries.map((query) => (
                  <code
                    key={query}
                    className="rounded bg-black/20 px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
                  >
                    {query}
                  </code>
                ))}
              </div>
            </DetailField>
          )}

          {detail.searches.length > 0 && (
            <DetailField label="SEARCHES">
              <div className="space-y-2">
                {detail.searches.map((search, index) => (
                  <div key={`${search.query}-${index}`} className="rounded bg-black/15 p-2">
                    <p className="text-[11px] font-mono text-[var(--color-text-secondary)]">
                      {search.query}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      {search.resultCount} result{search.resultCount === 1 ? '' : 's'}
                      {search.topResultTitle ? ` · top: ${search.topResultTitle}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </DetailField>
          )}

          {detail.selectedMemories.length > 0 && (
            <DetailField label="SELECTED MEMORIES">
              <div className="space-y-2">
                {detail.selectedMemories.map((memory) => (
                  <button
                    key={memory.id}
                    type="button"
                    onClick={() => setViewingMemory(memory)}
                    className="w-full rounded bg-black/15 p-2 text-left transition-colors hover:bg-black/25"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[11px] text-[var(--color-accent)]">{memory.id}</code>
                      <span className="text-[11px] text-[var(--color-text-secondary)]">
                        {memory.title}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      {memory.type}
                      {memory.score !== undefined ? ` · score ${memory.score.toFixed(2)}` : ''}
                    </p>
                  </button>
                ))}
              </div>
            </DetailField>
          )}

          {injectionPreview.length > 0 && (
            <DetailField label="INJECTION PREVIEW">
              <div className="space-y-3">
                {injectionPreview.map((memoryInjection, index) => (
                  <div
                    key={`${memoryInjection.layer}-${memoryInjection.source}-${index}`}
                    className="space-y-1"
                  >
                    <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                      <span className="rounded bg-white/5 px-1.5 py-0.5">
                        {memoryInjection.layer}
                      </span>
                      <span>{memoryInjection.source}</span>
                    </div>
                    <ExpandableTextPanel value={memoryInjection.formattedText} />
                  </div>
                ))}
              </div>
            </DetailField>
          )}

          {detail.usedFallbackSelection && (
            <DetailField label="FALLBACK">
              <p className="text-[12px] text-amber-300">
                Agent 输出无法可靠解析，使用了 fallback selection。
              </p>
            </DetailField>
          )}

          <DetailField label="COST">
            <p className="text-[12px] font-mono text-[var(--color-text-secondary)]">
              {decision.durationMs !== undefined ? formatDuration(decision.durationMs) : 'n/a'}
              {' · '}
              {detail.tokens
                ? `${detail.tokens.input}+${detail.tokens.output} tokens`
                : '0+0 tokens'}
              {' · '}
              {detail.cost !== undefined ? `$${formatCost(detail.cost)}` : '$0.0000'}
            </p>
          </DetailField>

          {decision.rationale && (
            <DetailField label="AGENT REASONING">
              <div className="space-y-2">
                <p className="text-[12px] whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
                  {truncateInline(decision.rationale, 180)}
                </p>
                <ExpandableTextPanel value={decision.rationale} />
              </div>
            </DetailField>
          )}
        </div>
      </div>

      {viewingMemory && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center overlay-enter"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setViewingMemory(null)
          }}
        >
          <div
            className="card mx-4 w-full max-w-[760px] dialog-enter"
            style={{
              background: 'var(--color-float)',
              boxShadow:
                '0 8px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
            }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4">
              <div className="space-y-2">
                <h4 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                  {viewingMemory.title}
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                  <span className="rounded bg-white/5 px-2 py-1 font-mono">
                    {viewingMemory.type}
                  </span>
                  <code className="text-[var(--color-text-muted)]">{viewingMemory.id}</code>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewingMemory(null)}
                className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-white/[0.04]"
              >
                Close
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-4">
              {memoryLoading && (
                <p className="text-[13px] text-[var(--color-text-muted)]">Loading...</p>
              )}
              {memoryError && <p className="text-[13px] text-red-300">{memoryError}</p>}
              {!memoryLoading && !memoryError && memoryContent !== null && (
                <div className="prose prose-invert max-w-none text-[13px] text-[var(--color-text-secondary)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{memoryContent}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function pickMemoryInjectionPreview(
  decision: DecisionTimelineItem,
  detail: MemoryRetrievalDetail,
  llmRequests: LlmRequestEntry[],
): MemoryInjectionEntry[] {
  if (decision.outcome !== 'injected' || !detail.layer) return []

  const candidates = llmRequests.filter((request) =>
    request.memoryInjections?.some((memoryInjection) => memoryInjection.layer === detail.layer),
  )

  const turnMatched =
    detail.turnIndex === undefined
      ? []
      : candidates.filter((request) => request.turnIndex === detail.turnIndex)
  const ranked = (turnMatched.length > 0
    ? turnMatched
    : candidates.filter((request) => request.ts >= decision.createdAt)
  ).sort((left, right) => left.ts.localeCompare(right.ts))
  const matchedRequest = ranked[0]

  return (
    matchedRequest?.memoryInjections?.filter(
      (memoryInjection) => memoryInjection.layer === detail.layer,
    ) ?? []
  )
}

function DecisionDetailPanel({
  decision,
}: {
  decision: DecisionTimelineItem
}) {
  return (
    <div className="card p-4 h-full min-h-0 overflow-y-auto animate-fade-up">
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

function PersistedTaskClosureCard({
  card,
  onJumpToAssistantMessage,
}: {
  card: ReturnType<typeof mapSessionTaskClosureEventToCard>
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
  card: ReturnType<typeof mapSessionDecisionEventToCard>
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
  report: ReturnType<typeof evaluateTraceSession>
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

        {judgeHistory.length > 0 && (
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
        )}

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
          memory {result.signals.memorySearchCount}/{result.signals.memoryGetCount}/
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

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function truncateInline(value: string, limit = 120): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value
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

function readMemoryRetrievalDetail(detail?: Record<string, unknown>): MemoryRetrievalDetail {
  const record = detail ?? {}

  return {
    need: typeof record.need === 'boolean' ? record.need : undefined,
    layer: typeof record.layer === 'string' ? record.layer : undefined,
    turnIndex:
      typeof record.turnIndex === 'number' && Number.isFinite(record.turnIndex)
        ? record.turnIndex
        : undefined,
    queries: toStringArray(record.queries),
    searches: toMemoryRetrievalSearchSummaries(record.searches),
    searchResultCount:
      typeof record.searchResultCount === 'number' && Number.isFinite(record.searchResultCount)
        ? record.searchResultCount
        : undefined,
    selectedMemoryIds: toStringArray(record.selectedMemoryIds),
    selectedMemories: toMemoryRetrievalSelectedMemories(record.selectedMemories),
    usedFallbackSelection: record.usedFallbackSelection === true,
    tokens: toMemoryRetrievalTokens(record.tokens),
    cost: typeof record.cost === 'number' && Number.isFinite(record.cost) ? record.cost : undefined,
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function toMemoryRetrievalSearchSummaries(value: unknown): MemoryRetrievalSearchSummary[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const summary = item as Record<string, unknown>
    if (
      typeof summary.query !== 'string' ||
      typeof summary.resultCount !== 'number' ||
      !Number.isFinite(summary.resultCount)
    ) {
      return []
    }

    return [
      {
        query: summary.query,
        resultCount: summary.resultCount,
        topResultTitle:
          typeof summary.topResultTitle === 'string' ? summary.topResultTitle : undefined,
      },
    ]
  })
}

function toMemoryRetrievalSelectedMemories(value: unknown): MemoryRetrievalSelectedMemory[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const memory = item as Record<string, unknown>
    if (
      typeof memory.id !== 'string' ||
      typeof memory.type !== 'string' ||
      typeof memory.title !== 'string'
    ) {
      return []
    }

    return [
      {
        id: memory.id,
        type: memory.type,
        title: memory.title,
        score:
          typeof memory.score === 'number' && Number.isFinite(memory.score)
            ? memory.score
            : undefined,
      },
    ]
  })
}

function toMemoryRetrievalTokens(value: unknown): MemoryRetrievalTokens | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tokens = value as Record<string, unknown>
  const input =
    typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : undefined
  const output =
    typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : undefined

  if (input === undefined && output === undefined) return undefined

  return {
    input: input ?? 0,
    output: output ?? 0,
  }
}

function getMemoryRetrievalSearchCount(detail: MemoryRetrievalDetail): number {
  return detail.searches.length > 0 ? detail.searches.length : detail.queries.length
}

function getMemoryRetrievalSelectedCount(detail: MemoryRetrievalDetail): number {
  return detail.selectedMemories.length > 0
    ? detail.selectedMemories.length
    : detail.selectedMemoryIds.length
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

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 36 ? `${value.slice(0, 33)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '-'
  return '…'
}

function formatEvalVerdict(verdict: ReturnType<typeof evaluateTraceSession>['verdict']): string {
  if (verdict === 'resolved') return 'Resolved'
  if (verdict === 'blocked') return 'Blocked'
  return 'Needs Review'
}

function getEvalVerdictClass(verdict: ReturnType<typeof evaluateTraceSession>['verdict']): string {
  if (verdict === 'resolved') return 'bg-emerald-400/10 text-emerald-300'
  if (verdict === 'blocked') return 'bg-amber-400/10 text-amber-300'
  return 'bg-rose-400/10 text-rose-300'
}

function getEvalConfidenceClass(
  confidence: ReturnType<typeof evaluateTraceSession>['confidence'],
): string {
  if (confidence === 'high') return 'bg-cyan-400/10 text-cyan-300'
  if (confidence === 'medium') return 'bg-indigo-400/10 text-indigo-300'
  return 'bg-slate-400/10 text-slate-300'
}

function getEvalHighlightClass(
  tone: ReturnType<typeof evaluateTraceSession>['highlights'][number]['tone'],
): string {
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

      {span.children.map((child) =>
        isCompressionSpan(child) ? (
          <CompressionSpanCard key={child.id} span={child} depth={depth + 1} />
        ) : isSubAgentSpan(child) ? (
          <SubAgentSpanCard
            key={child.id}
            span={child}
            depth={depth + 1}
            onJumpToTimeline={onJumpToSubAgentInTimeline}
          />
        ) : (
          <TraceTreeWithSubAgents
            key={child.id}
            span={child}
            depth={depth + 1}
            onJumpToSubAgentInTimeline={onJumpToSubAgentInTimeline}
          />
        ),
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold text-[var(--color-text-disabled)] tracking-wide mb-1.5">
        {title.toUpperCase()}
      </h4>
      {children}
    </div>
  )
}
