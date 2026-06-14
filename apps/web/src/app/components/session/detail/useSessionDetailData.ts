import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '../../../useWebSocket'
import { apiFetch, isAbortError } from '../../../lib/api'
import type { MemoryInjectionEntry } from '../memory/memory-retrieval'
import type {
  SessionDecisionEvent,
  SessionTaskClosureEvent,
  TimelineCompactionBlock,
  TraceSpan,
} from '../timeline/timeline'

export interface ContentBlock {
  type: string
  [key: string]: unknown
}

export interface Message {
  id: string
  role: string
  messageType: string
  content: ContentBlock[]
  model?: string
  createdAt: string
}

export interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

export interface ToolResultEntry {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
  outputSummary?: string
  evidence?: {
    kind: 'tool_use_input' | 'tool_result_output'
    toolUseId: string
    toolName: string
    path: string
    chars?: number
    bytes?: number
    sha256?: string
    summary?: string
    strategy?: string
  }
}

export interface ToolCallEntry {
  id: string
  name: string
  input: Record<string, unknown>
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

export interface SessionRequestEntry {
  id: string
  turnIndex?: number
  parentId?: string
  model: string
  provider: string
  userPrompt: string
  response: string
  stopReason: string
  toolUseCount: number
  toolCalls?: ToolCallEntry[]
  toolResults?: ToolResultEntry[]
  queuedInjection?: QueuedInjectionEntry
  memoryInjections?: MemoryInjectionEntry[]
  tokens: {
    input: number
    output: number
    cacheWrite?: number
    cacheRead?: number
    reasoning?: number
  }
  cost: number
  durationMs?: number
  ts: string
}

export interface SessionDetail {
  id: string
  source: string
  isCurrent: boolean
  placement: 'current' | 'background'
  currentModel: string
  channelName?: string
  channelId?: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  timelineCompactionBlocks?: TimelineCompactionBlock[]
  tags: string[]
  summary?: string
  systemPrompt?: string
  modelHistory: ModelHistoryEntry[]
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  effectiveInputTokens: number
  cacheHitRate: number
  cacheReadCost: number
  cacheWriteCost: number
  grossAvoidedInputCost: number
  netSavings: number
  totalCost: number
  auxiliaryCost: number
  purposeBreakdown: Array<{
    purpose: string
    totalCost: number
    totalTokens: number
    reasoningTokens: number
    requestCount: number
  }>
  requestCount: number
}

interface TimelineSnapshot {
  sessionId: string | null
  messageCount: number
  traceCount: number
  taskClosureCount: number
  decisionCount: number
}

const emptyTimelineSnapshot: TimelineSnapshot = {
  sessionId: null,
  messageCount: 0,
  traceCount: 0,
  taskClosureCount: 0,
  decisionCount: 0,
}

export function useSessionDetailData(
  sessionId: string | null | undefined,
  timelineRef: RefObject<HTMLDivElement | null>,
) {
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [traces, setTraces] = useState<TraceSpan[]>([])
  const [taskClosureEvents, setTaskClosureEvents] = useState<SessionTaskClosureEvent[]>([])
  const [decisions, setDecisions] = useState<SessionDecisionEvent[]>([])
  const [llmRequests, setLlmRequests] = useState<SessionRequestEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [traceLoading, setTraceLoading] = useState(true)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wasAtBottomRef = useRef(true)
  const lastTimelineSnapshotRef = useRef<TimelineSnapshot>(emptyTimelineSnapshot)

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
            lastTimelineSnapshotRef.current = emptyTimelineSnapshot
          }
        })
        .finally(() => {
          if (requestId !== requestIdRef.current) return
          setTraceLoading(false)
          if (showLoading) setLoading(false)
        })
    },
    [sessionId, timelineRef],
  )

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
  }, [session?.id, timelineRef])

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
    topics: ['session:update', 'tool:call', 'tool:result'],
    onEvent,
  })

  return {
    session,
    traces,
    taskClosureEvents,
    decisions,
    llmRequests,
    loading,
    traceLoading,
  }
}
