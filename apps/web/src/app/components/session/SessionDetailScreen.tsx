import { ArrowLeft } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, type RefObject, useMemo, useState } from 'react'
import { useUIStore } from '../../stores/ui'
import { Skeleton, SkeletonText } from '../shared/Skeleton'
import { ContextPanel } from './context-panel/ContextPanel'
import { buildContextTokenSummary } from './context-panel/context-tokens'
import { MetadataBar } from './detail/MetadataBar'
import { type SessionRequestEntry, useSessionDetailData } from './detail/useSessionDetailData'
import { useSessionDetailSelection } from './detail/useSessionDetailSelection'
import { TimelineView } from './timeline/TimelineView'
import {
  type DecisionTimelineItem,
  type TaskClosureTimelineItem,
  type TimelineItem,
  type TraceSpan,
  buildTimeline,
  collectSubAgentTimelineItems,
  extractFilesTouched,
} from './timeline/timeline'
import { TrajectoryView } from './trajectory/TrajectoryView'
import { useTrajectorySnapshot } from './trajectory/useTrajectorySnapshot'

interface SessionDetailScreenProps {
  sessionId?: string | null
  topContent?: ReactNode
  emptyState?: ReactNode
}

export interface SessionDetailInsights {
  timelineCount: number
  userCount: number
  assistantCount: number
  toolCallCount: number
  decisionCount: number
  taskClosureCount: number
  systemEventCount: number
  subAgentCount: number
  runningTraceCount: number
  errorTraceCount: number
  successfulTraceCount: number
  dominantTool?: {
    name: string
    count: number
  }
  slowestTool?: {
    name: string
    durationMs: number
  }
  lastDecision?: {
    decisionType: string
    outcome: string
    createdAt: string
  }
  lastTaskClosure?: {
    event: string
    action?: string
    createdAt: string
  }
  averageRequestDurationMs?: number
}

interface SessionDetailToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  isError?: boolean
  durationMs?: number
}

export function SessionDetailScreen({
  sessionId,
  topContent,
  emptyState,
}: SessionDetailScreenProps) {
  const { setSelectedSessionId } = useUIStore()
  const navigate = useNavigate()
  const {
    timelineRef,
    selectedToolId,
    selectedDecisionId,
    selectedTaskClosureId,
    selectedMemoryNudgeId,
    selectedSubAgentId,
    highlightedAssistantMessageId,
    highlightedSubAgentId,
    handleSelectTool,
    handleSelectDecision,
    handleSelectTaskClosure,
    handleSelectMemoryNudge,
    handleSelectSubAgent,
    jumpToAssistantMessage,
    handleJumpToSubAgentInTimeline,
  } = useSessionDetailSelection(sessionId)
  const [stageView, setStageView] = useState<'trajectory' | 'timeline'>('trajectory')

  const { session, traces, taskClosureEvents, decisions, llmRequests, loading, traceLoading } =
    useSessionDetailData(sessionId, timelineRef)

  function goBack() {
    setSelectedSessionId(null)
    navigate({ to: '/sessions' })
  }

  const timelineItems = useMemo(
    () =>
      session
        ? buildTimeline(
            session.messages,
            traces,
            taskClosureEvents,
            decisions,
            llmRequests,
            session.timelineCompactionBlocks ?? [],
          )
        : [],
    [session, traces, taskClosureEvents, decisions, llmRequests],
  )

  const toolCalls = useMemo(() => collectSessionDetailToolCalls(timelineItems), [timelineItems])

  const filesTouched = useMemo(() => extractFilesTouched(timelineItems), [timelineItems])

  // Sub-agent events come from a compaction-independent collector so the
  // trajectory keeps the delegation story even when the spawning messages were
  // summarized away by an active timeline compaction block.
  const subAgentEvents = useMemo(
    () =>
      collectSubAgentTimelineItems(session?.messages ?? [], traces).map((item) => ({
        ts: item.createdAt,
        agentId: item.agentId,
        label: item.label,
        ...(item.model === undefined ? {} : { model: item.model }),
        status: item.status,
        instruction: item.instruction,
        ...(item.role === undefined ? {} : { role: item.role }),
        ...(item.output === undefined ? {} : { output: item.output }),
        ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        ...(item.childToolCalls.length === 0 ? {} : { childToolCalls: item.childToolCalls }),
      })),
    [session, traces],
  )

  const memoryNudgeEvents = useMemo(
    () =>
      timelineItems.flatMap((item) =>
        item.type === 'memory-nudge'
          ? [
              {
                ts: item.createdAt,
                prompt: item.prompt,
                source: item.source,
                ...(item.iteration === undefined ? {} : { iteration: item.iteration }),
                ...(item.memoryWritten === undefined ? {} : { memoryWritten: item.memoryWritten }),
                ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
                status: item.status,
                ...(item.relatedToolCalls.length === 0
                  ? {}
                  : { relatedToolCalls: item.relatedToolCalls }),
              },
            ]
          : [],
      ),
    [timelineItems],
  )

  const { snapshot: trajectorySnapshot } = useTrajectorySnapshot(
    session,
    llmRequests,
    traces,
    taskClosureEvents,
    subAgentEvents,
    memoryNudgeEvents,
  )

  const selectedTaskClosure = useMemo(() => {
    if (!selectedTaskClosureId) return null
    return (
      timelineItems.find(
        (item): item is TaskClosureTimelineItem =>
          item.type === 'task-closure' && item.id === selectedTaskClosureId,
      ) ?? null
    )
  }, [selectedTaskClosureId, timelineItems])

  const selectedDecision = useMemo(() => {
    if (!selectedDecisionId) return null
    return (
      timelineItems.find(
        (item): item is DecisionTimelineItem =>
          item.type === 'decision' && item.id === selectedDecisionId,
      ) ?? null
    )
  }, [selectedDecisionId, timelineItems])

  const sessionInsights = useMemo(
    () => buildSessionDetailInsights(timelineItems, traces, llmRequests),
    [timelineItems, traces, llmRequests],
  )

  const contextTokenSummary = useMemo(
    () =>
      session
        ? buildContextTokenSummary({
            messages: session.messages,
            systemPrompt: session.systemPrompt,
            llmRequests,
            totalTokens: session.totalTokens,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            cacheWriteTokens: session.cacheWriteTokens,
            cacheReadTokens: session.cacheReadTokens,
            reasoningTokens: session.reasoningTokens,
            effectiveInputTokens: session.effectiveInputTokens,
            totalCost: session.totalCost,
            requestCount: session.requestCount,
          })
        : null,
    [session, llmRequests],
  )

  if (!sessionId) {
    return (
      <SessionDetailUnselectedState
        topContent={topContent}
        emptyState={emptyState}
        onBack={goBack}
      />
    )
  }

  if (loading && !session) {
    return <SessionDetailLoadingState topContent={topContent} onBack={goBack} />
  }

  if (!session) {
    return <SessionDetailMissingState topContent={topContent} onBack={goBack} />
  }

  return (
    <div className="relative mx-auto flex h-screen max-w-[1720px] flex-col overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px] bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_35%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.1),transparent_28%)]" />
      <div data-testid="session-detail-header" className="shrink-0">
        <SessionDetailPageHeader topContent={topContent} onBack={goBack} />

        <MetadataBar
          sessionId={session.id}
          summary={session.summary}
          source={session.source}
          isCurrent={session.isCurrent}
          placement={session.placement}
          currentModel={session.currentModel}
          channelName={session.channelName}
          channelId={session.channelId}
          createdAt={session.createdAt}
          updatedAt={session.updatedAt}
          modelHistory={session.modelHistory}
          requestCount={session.requestCount}
          totalTokens={session.totalTokens}
          inputTokens={session.inputTokens}
          outputTokens={session.outputTokens}
          cacheWriteTokens={session.cacheWriteTokens}
          cacheReadTokens={session.cacheReadTokens}
          reasoningTokens={session.reasoningTokens}
          effectiveInputTokens={session.effectiveInputTokens}
          cacheHitRate={session.cacheHitRate}
          totalCost={session.totalCost}
          auxiliaryCost={session.auxiliaryCost}
          purposeBreakdown={session.purposeBreakdown}
          toolCallCount={sessionInsights.toolCallCount}
          decisionCount={sessionInsights.decisionCount}
          taskClosureCount={sessionInsights.taskClosureCount}
          timelineCount={sessionInsights.timelineCount}
          systemEventCount={sessionInsights.systemEventCount}
          subAgentCount={sessionInsights.subAgentCount}
          onDeleted={goBack}
        />
      </div>

      <div
        data-testid="session-detail-layout"
        className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_340px] xl:items-stretch xl:overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_360px]"
      >
        <SessionDetailTimelineStage
          messageCount={session.messages.length}
          stageView={stageView}
          onStageViewChange={setStageView}
          sessionId={session.id}
          timelineItems={timelineItems}
          llmRequests={llmRequests}
          trajectorySnapshot={trajectorySnapshot}
          loading={loading}
          insights={sessionInsights}
          filesTouchedCount={filesTouched.length}
          timelineRef={timelineRef}
          selectedToolId={selectedToolId}
          selectedDecisionId={selectedDecisionId}
          selectedTaskClosureId={selectedTaskClosureId}
          selectedMemoryNudgeId={selectedMemoryNudgeId}
          selectedSubAgentId={selectedSubAgentId}
          highlightedAssistantMessageId={highlightedAssistantMessageId}
          highlightedSubAgentId={highlightedSubAgentId}
          onSelectTool={handleSelectTool}
          onSelectDecision={handleSelectDecision}
          onSelectTaskClosure={handleSelectTaskClosure}
          onSelectMemoryNudge={handleSelectMemoryNudge}
          onSelectSubAgent={handleSelectSubAgent}
        />

        <div className="min-h-[520px] xl:min-h-0">
          <ContextPanel
            sessionId={session.id}
            summary={session.summary}
            systemPrompt={session.systemPrompt}
            modelHistory={session.modelHistory}
            toolCalls={toolCalls}
            filesTouched={filesTouched}
            totalTokens={session.totalTokens}
            inputTokens={session.inputTokens}
            outputTokens={session.outputTokens}
            cacheWriteTokens={session.cacheWriteTokens}
            cacheReadTokens={session.cacheReadTokens}
            effectiveInputTokens={session.effectiveInputTokens}
            cacheHitRate={session.cacheHitRate}
            cacheReadCost={session.cacheReadCost}
            cacheWriteCost={session.cacheWriteCost}
            grossAvoidedInputCost={session.grossAvoidedInputCost}
            netSavings={session.netSavings}
            contextTokenSummary={contextTokenSummary}
            llmRequests={llmRequests}
            selectedDecision={selectedDecision}
            selectedTaskClosure={selectedTaskClosure}
            traces={traces}
            decisions={decisions}
            taskClosureEvents={taskClosureEvents}
            traceLoading={traceLoading}
            onJumpToAssistantMessage={jumpToAssistantMessage}
            onJumpToSubAgentInTimeline={handleJumpToSubAgentInTimeline}
          />
        </div>
      </div>
    </div>
  )
}

interface SessionDetailStateProps {
  topContent?: ReactNode
  onBack: () => void
}

function SessionDetailPageHeader({ topContent, onBack }: SessionDetailStateProps) {
  return (
    <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-white/18 hover:text-[var(--color-accent)]"
      >
        <ArrowLeft size={14} /> Sessions
      </button>
      {topContent ? <div className="min-w-0 flex-1">{topContent}</div> : null}
    </div>
  )
}

function collectSessionDetailToolCalls(items: TimelineItem[]): SessionDetailToolCall[] {
  const calls: SessionDetailToolCall[] = []

  for (const item of items) {
    if (item.type === 'tool-call') {
      calls.push({
        id: item.id,
        name: item.name,
        input: item.input,
        result: item.result,
        summary: item.summary,
        isError: item.isError,
        durationMs: item.durationMs,
      })
    } else if (item.type === 'memory-nudge') {
      for (const toolCall of item.relatedToolCalls) {
        calls.push(toSessionDetailToolCall(toolCall))
      }
    } else if (item.type === 'sub-agent' && item.childToolCalls) {
      for (const toolCall of item.childToolCalls) {
        calls.push(toSessionDetailToolCall(toolCall))
      }
    }
  }

  return calls
}

function toSessionDetailToolCall(toolCall: {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  isError?: boolean
  durationMs?: number
}): SessionDetailToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    result: toolCall.result,
    summary: toolCall.summary,
    isError: toolCall.isError,
    durationMs: toolCall.durationMs,
  }
}

interface SessionDetailInsightRequestLike {
  durationMs?: number
}

export function buildSessionDetailInsights(
  items: TimelineItem[],
  traces: TraceSpan[],
  llmRequests: SessionDetailInsightRequestLike[] = [],
): SessionDetailInsights {
  const toolDistribution = new Map<string, number>()

  let userCount = 0
  let assistantCount = 0
  let toolCallCount = 0
  let decisionCount = 0
  let taskClosureCount = 0
  let systemEventCount = 0
  let subAgentCount = 0
  let slowestTool: SessionDetailInsights['slowestTool']
  let lastDecision: SessionDetailInsights['lastDecision']
  let lastTaskClosure: SessionDetailInsights['lastTaskClosure']

  for (const item of items) {
    switch (item.type) {
      case 'user-message':
        userCount += 1
        break
      case 'agent-text':
        assistantCount += 1
        break
      case 'tool-call':
        toolCallCount += 1
        toolDistribution.set(item.name, (toolDistribution.get(item.name) ?? 0) + 1)
        if (
          item.durationMs !== undefined &&
          (!slowestTool || item.durationMs > slowestTool.durationMs)
        ) {
          slowestTool = { name: item.name, durationMs: item.durationMs }
        }
        break
      case 'decision':
        decisionCount += 1
        lastDecision = {
          decisionType: item.decisionType,
          outcome: item.outcome,
          createdAt: item.createdAt,
        }
        break
      case 'task-closure':
        taskClosureCount += 1
        lastTaskClosure = {
          event: item.event,
          action: item.action,
          createdAt: item.createdAt,
        }
        break
      case 'memory-nudge':
        for (const toolCall of item.relatedToolCalls) {
          toolCallCount += 1
          toolDistribution.set(toolCall.name, (toolDistribution.get(toolCall.name) ?? 0) + 1)
          if (
            toolCall.durationMs !== undefined &&
            (!slowestTool || toolCall.durationMs > slowestTool.durationMs)
          ) {
            slowestTool = { name: toolCall.name, durationMs: toolCall.durationMs }
          }
        }
        break
      case 'system-event':
        systemEventCount += 1
        break
      case 'sub-agent':
        subAgentCount += 1
        break
    }
  }

  let dominantTool: SessionDetailInsights['dominantTool']
  for (const [name, count] of toolDistribution.entries()) {
    if (!dominantTool || count > dominantTool.count) {
      dominantTool = { name, count }
    }
  }

  let runningTraceCount = 0
  let errorTraceCount = 0
  let successfulTraceCount = 0

  for (const span of traces) {
    const counts = countTraceStatuses(span)
    runningTraceCount += counts.runningTraceCount
    errorTraceCount += counts.errorTraceCount
    successfulTraceCount += counts.successfulTraceCount
  }

  const requestDurations = llmRequests
    .map((request) => request.durationMs)
    .filter((durationMs): durationMs is number => typeof durationMs === 'number')

  return {
    timelineCount: items.length,
    userCount,
    assistantCount,
    toolCallCount,
    decisionCount,
    taskClosureCount,
    systemEventCount,
    subAgentCount,
    runningTraceCount,
    errorTraceCount,
    successfulTraceCount,
    dominantTool,
    slowestTool,
    lastDecision,
    lastTaskClosure,
    averageRequestDurationMs:
      requestDurations.length > 0
        ? Math.round(
            requestDurations.reduce((sum, durationMs) => sum + durationMs, 0) /
              requestDurations.length,
          )
        : undefined,
  }
}

function countTraceStatuses(
  span: TraceSpan,
): Pick<SessionDetailInsights, 'runningTraceCount' | 'errorTraceCount' | 'successfulTraceCount'> {
  let runningTraceCount = span.status === 'running' ? 1 : 0
  let errorTraceCount = span.status === 'error' ? 1 : 0
  let successfulTraceCount = span.status === 'success' ? 1 : 0

  for (const child of span.children) {
    const childCounts = countTraceStatuses(child)
    runningTraceCount += childCounts.runningTraceCount
    errorTraceCount += childCounts.errorTraceCount
    successfulTraceCount += childCounts.successfulTraceCount
  }

  return {
    runningTraceCount,
    errorTraceCount,
    successfulTraceCount,
  }
}

function SessionDetailUnselectedState({
  topContent,
  emptyState,
  onBack,
}: SessionDetailStateProps & { emptyState?: ReactNode }) {
  return (
    <SessionDetailOuter topContent={topContent} onBack={onBack}>
      {emptyState ?? (
        <div className="p-6 text-center text-[var(--color-text-muted)]">
          No session selected.{' '}
          <button type="button" onClick={onBack} className="text-[var(--color-accent)] underline">
            Back to sessions
          </button>
        </div>
      )}
    </SessionDetailOuter>
  )
}

function SessionDetailLoadingState({ topContent, onBack }: SessionDetailStateProps) {
  return (
    <SessionDetailOuter topContent={topContent} onBack={onBack}>
      <Skeleton className="h-3 w-48 mb-3" />
      <div className="card p-4 mb-4">
        <div className="flex gap-4">
          {Array.from({ length: 6 }, (_, index) => `session-metadata-${index}`).map((key) => (
            <div key={key} className="flex-1">
              <Skeleton className="h-2.5 w-16 mb-2" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[65fr_35fr]">
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, index) => `session-message-${index}`).map((key) => (
            <div key={key} className="card p-4">
              <Skeleton className="h-3 w-20 mb-2" />
              <SkeletonText lines={2} />
            </div>
          ))}
        </div>
        <div className="card p-4">
          <Skeleton className="h-4 w-32 mb-3" />
          <SkeletonText lines={5} />
        </div>
      </div>
    </SessionDetailOuter>
  )
}

function SessionDetailMissingState({ topContent, onBack }: SessionDetailStateProps) {
  return (
    <SessionDetailOuter topContent={topContent} onBack={onBack}>
      <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
        Session not found.
      </div>
    </SessionDetailOuter>
  )
}

function SessionDetailOuter({
  topContent,
  onBack,
  children,
}: SessionDetailStateProps & { children: ReactNode }) {
  return (
    <div className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <SessionDetailPageHeader topContent={topContent} onBack={onBack} />
      {children}
    </div>
  )
}

interface SessionDetailTimelineStageProps {
  messageCount: number
  stageView: 'trajectory' | 'timeline'
  onStageViewChange: (view: 'trajectory' | 'timeline') => void
  sessionId?: string
  timelineItems: TimelineItem[]
  llmRequests: SessionRequestEntry[]
  trajectorySnapshot: import('./trajectory/types').TrajectorySnapshot | null
  loading: boolean
  insights: SessionDetailInsights
  filesTouchedCount: number
  timelineRef: RefObject<HTMLDivElement | null>
  selectedToolId: string | null
  selectedDecisionId: string | null
  selectedTaskClosureId: string | null
  selectedMemoryNudgeId: string | null
  selectedSubAgentId: string | null
  highlightedAssistantMessageId: string | null
  highlightedSubAgentId: string | null
  onSelectTool: (id: string | null) => void
  onSelectDecision: (id: string | null) => void
  onSelectTaskClosure: (id: string | null) => void
  onSelectMemoryNudge: (id: string | null) => void
  onSelectSubAgent: (id: string | null) => void
}

function SessionDetailTimelineStage({
  messageCount,
  stageView,
  onStageViewChange,
  sessionId,
  timelineItems,
  llmRequests,
  trajectorySnapshot,
  loading,
  insights,
  filesTouchedCount,
  timelineRef,
  selectedToolId,
  selectedDecisionId,
  selectedTaskClosureId,
  selectedMemoryNudgeId,
  selectedSubAgentId,
  highlightedAssistantMessageId,
  highlightedSubAgentId,
  onSelectTool,
  onSelectDecision,
  onSelectTaskClosure,
  onSelectMemoryNudge,
  onSelectSubAgent,
}: SessionDetailTimelineStageProps) {
  return (
    <section
      data-testid="session-timeline-stage"
      className="card flex min-h-[520px] flex-col overflow-hidden p-0 xl:min-h-0"
    >
      <div className="shrink-0 border-b border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] px-4 py-3 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-disabled)]">
                Execution
              </p>
              <h3 className="mt-1 text-[18px] font-semibold text-[var(--color-text-primary)]">
                Session Story
              </h3>
            </div>
            <div className="flex rounded-full border border-white/10 bg-white/[0.03] p-0.5">
              {(['trajectory', 'timeline'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={stageView === view}
                  className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                    stageView === view
                      ? 'bg-cyan-400/15 text-cyan-100'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                  }`}
                  onClick={() => {
                    onStageViewChange(view)
                  }}
                >
                  {view === 'trajectory' ? 'Trajectory' : 'Timeline'}
                </button>
              ))}
            </div>
          </div>
          <TimelineInsightChips insights={insights} filesTouchedCount={filesTouchedCount} />
        </div>
      </div>

      <div
        ref={timelineRef}
        className={`min-h-0 flex-1 overflow-y-auto ${
          stageView === 'timeline'
            ? 'bg-[linear-gradient(180deg,rgba(10,14,20,0.72),rgba(9,11,16,0.98))] px-4 py-4 sm:px-5 [scrollbar-gutter:stable]'
            : ''
        }`}
      >
        {messageCount === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--color-text-muted)]">
            No messages in this session.
          </div>
        ) : stageView === 'trajectory' ? (
          <TrajectoryView snapshot={trajectorySnapshot} loading={loading} />
        ) : (
          <TimelineView
            sessionId={sessionId}
            items={timelineItems}
            llmRequests={llmRequests}
            selectedToolId={selectedToolId}
            selectedDecisionId={selectedDecisionId}
            selectedTaskClosureId={selectedTaskClosureId}
            selectedMemoryNudgeId={selectedMemoryNudgeId}
            selectedSubAgentId={selectedSubAgentId}
            highlightedAssistantMessageId={highlightedAssistantMessageId}
            highlightedSubAgentId={highlightedSubAgentId}
            onSelectTool={onSelectTool}
            onSelectDecision={onSelectDecision}
            onSelectTaskClosure={onSelectTaskClosure}
            onSelectMemoryNudge={onSelectMemoryNudge}
            onSelectSubAgent={onSelectSubAgent}
          />
        )}
      </div>
    </section>
  )
}

function TimelineInsightChips({
  insights,
  filesTouchedCount,
}: {
  insights: SessionDetailInsights
  filesTouchedCount: number
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <TimelineChip>{insights.assistantCount} assistant</TimelineChip>
      <TimelineChip>{insights.toolCallCount} tools</TimelineChip>
      <TimelineChip>{insights.decisionCount} decisions</TimelineChip>
      <TimelineChip>
        trace {insights.runningTraceCount} run / {insights.errorTraceCount} err
      </TimelineChip>
      <TimelineChip>files {filesTouchedCount}</TimelineChip>
      {insights.dominantTool ? (
        <span className="rounded-full border border-cyan-400/20 bg-cyan-400/7 px-2.5 py-1 text-[10px] font-mono text-cyan-100">
          top {insights.dominantTool.name}
        </span>
      ) : null}
    </div>
  )
}

function TimelineChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-mono text-[var(--color-text-secondary)]">
      {children}
    </span>
  )
}
