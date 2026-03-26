import { ArrowLeft } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWebSocket } from '../../hooks/useWebSocket'
import { apiFetch, isAbortError } from '../../lib/api'
import { useUIStore } from '../../stores/ui'
import { Skeleton, SkeletonText } from '../shared/Skeleton'
import { ContextPanel } from './ContextPanel'
import { MetadataBar } from './MetadataBar'
import { TimelineView } from './TimelineView'
import {
  type DecisionTimelineItem,
  type SessionDecisionEvent,
  type SessionTaskClosureEvent,
  type TaskClosureTimelineItem,
  type TraceSpan,
  buildTimeline,
  extractFilesTouched,
} from './timeline'

interface ContentBlock {
  type: string
  [key: string]: unknown
}

interface Message {
  id: string
  role: string
  messageType: string
  content: ContentBlock[]
  model?: string
  createdAt: string
}

interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
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

interface SessionRequestEntry {
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

interface SessionDetail {
  id: string
  source: string
  status: string
  currentModel: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  tags: string[]
  summary?: string
  systemPrompt?: string
  modelHistory: ModelHistoryEntry[]
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  effectiveInputTokens: number
  cacheHitRate: number
  cacheReadCost: number
  cacheWriteCost: number
  grossAvoidedInputCost: number
  netSavings: number
  totalCost: number
  requestCount: number
}

interface SessionDetailScreenProps {
  sessionId?: string | null
  topContent?: ReactNode
  emptyState?: ReactNode
}

export function SessionDetailScreen({
  sessionId,
  topContent,
  emptyState,
}: SessionDetailScreenProps) {
  const { setSelectedSessionId } = useUIStore()
  const navigate = useNavigate()

  const [session, setSession] = useState<SessionDetail | null>(null)
  const [traces, setTraces] = useState<TraceSpan[]>([])
  const [taskClosureEvents, setTaskClosureEvents] = useState<SessionTaskClosureEvent[]>([])
  const [decisions, setDecisions] = useState<SessionDecisionEvent[]>([])
  const [llmRequests, setLlmRequests] = useState<SessionRequestEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [traceLoading, setTraceLoading] = useState(true)
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)
  const [selectedTaskClosureId, setSelectedTaskClosureId] = useState<string | null>(null)
  const [selectedSubAgentId, setSelectedSubAgentId] = useState<string | null>(null)
  const [highlightedAssistantMessageId, setHighlightedAssistantMessageId] = useState<string | null>(
    null,
  )
  const [highlightedSubAgentId, setHighlightedSubAgentId] = useState<string | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const lastKeyRef = useRef<string>('')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wasAtBottomRef = useRef(true)
  const previousSessionIdRef = useRef<string | null | undefined>(undefined)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const lastTimelineSnapshotRef = useRef({
    sessionId: null as string | null,
    messageCount: 0,
    traceCount: 0,
    taskClosureCount: 0,
    decisionCount: 0,
  })

  const fetchSession = useCallback(
    (showLoading = false) => {
      if (!sessionId) return Promise.resolve()
      const requestId = ++requestIdRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      if (showLoading) {
        setLoading(true)
      }
      setTraceLoading(true)
      return Promise.all([
        apiFetch<SessionDetail>(`/api/sessions/${sessionId}`, { signal: controller.signal }),
        apiFetch<{ traces: TraceSpan[] }>(`/api/sessions/${sessionId}/traces`, {
          signal: controller.signal,
        }),
        apiFetch<{ events: SessionTaskClosureEvent[] }>(
          `/api/sessions/${sessionId}/task-closure-events`,
          { signal: controller.signal },
        ),
        apiFetch<{ requests: SessionRequestEntry[] }>(`/api/sessions/${sessionId}/requests`, {
          signal: controller.signal,
        }),
        apiFetch<{ decisions: SessionDecisionEvent[] }>(`/api/sessions/${sessionId}/decisions`, {
          signal: controller.signal,
        }),
      ])
        .then(([data, traceResponse, taskClosureResponse, requestResponse, decisionResponse]) => {
          if (requestId !== requestIdRef.current) return

          const nextTraces = traceResponse.traces ?? []
          const nextTaskClosureEvents = taskClosureResponse.events ?? []
          const nextDecisions = decisionResponse.decisions ?? []
          const previousSnapshot = lastTimelineSnapshotRef.current
          const isSameSession = previousSnapshot.sessionId === data.id
          const timelineExpanded =
            data.messages.length > previousSnapshot.messageCount ||
            nextTraces.length > previousSnapshot.traceCount ||
            nextTaskClosureEvents.length > previousSnapshot.taskClosureCount ||
            nextDecisions.length > previousSnapshot.decisionCount

          setSession(data)
          setTraces(nextTraces)
          setTaskClosureEvents(nextTaskClosureEvents)
          setDecisions(nextDecisions)
          setLlmRequests(requestResponse.requests ?? [])

          lastTimelineSnapshotRef.current = {
            sessionId: data.id,
            messageCount: data.messages.length,
            traceCount: nextTraces.length,
            taskClosureCount: nextTaskClosureEvents.length,
            decisionCount: nextDecisions.length,
          }

          if (wasAtBottomRef.current && (!isSameSession || timelineExpanded)) {
            requestAnimationFrame(() => {
              const el = timelineRef.current
              if (el) el.scrollTo({ top: el.scrollHeight })
            })
          }
        })
        .catch((error) => {
          if (requestId !== requestIdRef.current || isAbortError(error)) return

          if (showLoading) {
            setSession(null)
            setTraces([])
            setTaskClosureEvents([])
            setDecisions([])
            setLlmRequests([])
            lastTimelineSnapshotRef.current = {
              sessionId: null,
              messageCount: 0,
              traceCount: 0,
              taskClosureCount: 0,
              decisionCount: 0,
            }
          }
        })
        .finally(() => {
          if (requestId !== requestIdRef.current) return
          setTraceLoading(false)
          if (showLoading) setLoading(false)
        })
    },
    [sessionId],
  )

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return
    previousSessionIdRef.current = sessionId
    setSelectedToolId(null)
    setSelectedDecisionId(null)
    setSelectedTaskClosureId(null)
    setSelectedSubAgentId(null)
    setHighlightedAssistantMessageId(null)
    setHighlightedSubAgentId(null)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) {
      abortRef.current?.abort()
      setDecisions([])
      setLoading(false)
      setTraceLoading(false)
      return
    }

    void fetchSession(true)
  }, [sessionId, fetchSession])

  useEffect(() => {
    if (!session?.id) return
    const el = timelineRef.current
    if (!el) return
    function onScroll() {
      if (!el) return
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [session?.id])

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    },
    [],
  )

  const onEvent = useCallback(
    (_: string, data: unknown) => {
      const ev = data as { sessionId?: string }
      if (ev?.sessionId !== sessionId) return
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(fetchSession, 300)
    },
    [sessionId, fetchSession],
  )

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['session:update', 'session:end', 'tool:call', 'tool:result'],
    onEvent,
  })

  function goBack() {
    setSelectedSessionId(null)
    navigate({ to: '/sessions' })
  }

  const timelineItems = useMemo(
    () => (session ? buildTimeline(session.messages, traces, taskClosureEvents, decisions) : []),
    [session, traces, taskClosureEvents, decisions],
  )

  const toolCalls = useMemo(() => {
    const calls: Array<{
      id: string
      name: string
      input: Record<string, unknown>
      result?: string
      isError?: boolean
      durationMs?: number
    }> = []

    for (const item of timelineItems) {
      if (item.type === 'tool-call') {
        calls.push({
          id: item.id,
          name: item.name,
          input: item.input,
          result: item.result,
          isError: item.isError,
          durationMs: item.durationMs,
        })
      } else if (item.type === 'sub-agent' && item.childToolCalls) {
        // Include child tool calls so they can be selected in the right panel
        for (const tc of item.childToolCalls) {
          calls.push({
            id: tc.id,
            name: `${item.label}/${tc.name}`,
            input: tc.input,
            result: tc.result,
            isError: tc.isError,
            durationMs: tc.durationMs,
          })
        }
      }
    }

    return calls
  }, [timelineItems])

  const filesTouched = useMemo(() => extractFilesTouched(timelineItems), [timelineItems])

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

  const handleSelectTool = useCallback((toolId: string | null) => {
    setSelectedToolId(toolId)
    setSelectedDecisionId(null)
    setSelectedTaskClosureId(null)
  }, [])

  const handleSelectDecision = useCallback((decisionId: string | null) => {
    setSelectedDecisionId(decisionId)
    setSelectedToolId(null)
    setSelectedTaskClosureId(null)
  }, [])

  const handleSelectTaskClosure = useCallback((taskClosureId: string | null) => {
    setSelectedTaskClosureId(taskClosureId)
    setSelectedDecisionId(null)
    setSelectedToolId(null)
  }, [])

  const handleSelectSubAgent = useCallback((subAgentId: string | null) => {
    setSelectedSubAgentId(subAgentId)
  }, [])

  const jumpToAssistantMessage = useCallback((messageId: string) => {
    setHighlightedAssistantMessageId(messageId)

    requestAnimationFrame(() => {
      const container = timelineRef.current
      const target = container?.querySelector(
        `[data-assistant-message-id="${messageId}"]`,
      ) as HTMLElement | null
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  const handleJumpToSubAgentInTimeline = useCallback((subAgentId: string) => {
    setHighlightedSubAgentId(subAgentId)

    requestAnimationFrame(() => {
      const container = timelineRef.current
      const target = container?.querySelector(
        `[data-sub-agent-id="${subAgentId}"]`,
      ) as HTMLElement | null
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  useEffect(() => {
    if (!highlightedAssistantMessageId) return
    const timer = setTimeout(() => setHighlightedAssistantMessageId(null), 3000)
    return () => clearTimeout(timer)
  }, [highlightedAssistantMessageId])

  useEffect(() => {
    if (!highlightedSubAgentId) return
    const timer = setTimeout(() => setHighlightedSubAgentId(null), 3000)
    return () => clearTimeout(timer)
  }, [highlightedSubAgentId])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const el = timelineRef.current
    if (!el) return

    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const scrollAmount = 60

    if (e.key === 'j') {
      el.scrollBy({ top: scrollAmount, behavior: 'smooth' })
    } else if (e.key === 'k') {
      el.scrollBy({ top: -scrollAmount, behavior: 'smooth' })
    } else if (e.key === 'Escape') {
      setSelectedToolId(null)
      setSelectedDecisionId(null)
      setSelectedTaskClosureId(null)
    } else if (e.key === 'g' && lastKeyRef.current === 'g') {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (e.key === 'G') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }

    lastKeyRef.current = e.key
  }, [])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const pageHeader = (
    <>
      <button
        type="button"
        onClick={goBack}
        className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors mb-4"
      >
        <ArrowLeft size={16} /> Sessions
      </button>
      {topContent ? <div className="mb-4">{topContent}</div> : null}
    </>
  )

  if (!sessionId) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        {pageHeader}
        {emptyState ?? (
          <div className="p-6 text-center text-[var(--color-text-muted)]">
            No session selected.{' '}
            <button type="button" onClick={goBack} className="text-[var(--color-accent)] underline">
              Back to sessions
            </button>
          </div>
        )}
      </div>
    )
  }

  if (loading && !session) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        {pageHeader}
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
      </div>
    )
  }

  if (!session) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        {pageHeader}
        <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
          Session not found.
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {pageHeader}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-[11px] font-mono text-[var(--color-text-disabled)]">
          {session.id}
        </span>
      </div>

      <MetadataBar
        sessionId={session.id}
        summary={session.summary}
        source={session.source}
        createdAt={session.createdAt}
        updatedAt={session.updatedAt}
        modelHistory={session.modelHistory}
        requestCount={session.requestCount}
        totalTokens={session.totalTokens}
        inputTokens={session.inputTokens}
        outputTokens={session.outputTokens}
        cacheWriteTokens={session.cacheWriteTokens}
        cacheReadTokens={session.cacheReadTokens}
        effectiveInputTokens={session.effectiveInputTokens}
        cacheHitRate={session.cacheHitRate}
        totalCost={session.totalCost}
        onArchived={goBack}
        onDeleted={goBack}
      />

      <div className="mt-4 grid min-h-0 grid-cols-1 items-stretch gap-4 lg:grid-cols-[65fr_35fr] lg:h-[calc(100vh-280px)]">
        <div
          ref={timelineRef}
          className="min-h-[320px] overflow-visible pr-0 lg:min-h-0 lg:overflow-y-auto lg:pr-2"
        >
          {session.messages.length === 0 ? (
            <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
              No messages in this session.
            </div>
          ) : (
            <TimelineView
              messages={session.messages}
              traces={traces}
              taskClosureEvents={taskClosureEvents}
              decisions={decisions}
              selectedToolId={selectedToolId}
              selectedDecisionId={selectedDecisionId}
              selectedTaskClosureId={selectedTaskClosureId}
              selectedSubAgentId={selectedSubAgentId}
              highlightedAssistantMessageId={highlightedAssistantMessageId}
              highlightedSubAgentId={highlightedSubAgentId}
              onSelectTool={handleSelectTool}
              onSelectDecision={handleSelectDecision}
              onSelectTaskClosure={handleSelectTaskClosure}
              onSelectSubAgent={handleSelectSubAgent}
            />
          )}
        </div>

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
          llmRequests={llmRequests}
          selectedToolId={selectedToolId}
          selectedDecision={selectedDecision}
          selectedTaskClosure={selectedTaskClosure}
          selectedSubAgentId={selectedSubAgentId}
          traces={traces}
          decisions={decisions}
          taskClosureEvents={taskClosureEvents}
          traceLoading={traceLoading}
          onJumpToAssistantMessage={jumpToAssistantMessage}
          onJumpToSubAgentInTimeline={handleJumpToSubAgentInTimeline}
        />
      </div>
    </div>
  )
}
