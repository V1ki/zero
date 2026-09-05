/**
 * Live background-tool progress: a small client-side store fed by the
 * `background_tool:*` websocket topics. Deliberately kept outside the session
 * detail refetch pipeline — progress events arrive on their own cadence and
 * must not trigger whole-session refetches or trajectory snapshot rebuilds.
 */

import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '../../../useWebSocket'

/** Latest known progress for one backgrounded tool execution, keyed by toolUseId. */
export interface BackgroundToolProgressEntry {
  taskId: string
  toolName: string
  elapsedMs: number
  totalOutputChars: number
  lastOutputTail: string
  /** Client clock of the last applied event; drives the staleness guard. */
  lastSeenAt: number
}

export interface BackgroundProgressStore {
  get(callId: string): BackgroundToolProgressEntry | undefined
  /** Apply one bus event; returns true when store state changed. */
  apply(sessionId: string, topic: string, data: unknown): boolean
  /** Drop all entries (session switch). */
  clear(): void
  subscribe(listener: () => void): () => void
}

interface BackgroundToolBusEvent {
  sessionId?: unknown
  toolUseId?: unknown
  taskId?: unknown
  tool?: unknown
  elapsedMs?: unknown
  totalOutputChars?: unknown
  lastOutputTail?: unknown
}

export function createBackgroundProgressStore(): BackgroundProgressStore {
  const entries = new Map<string, BackgroundToolProgressEntry>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    get: (callId) => entries.get(callId),
    apply(sessionId, topic, data) {
      if (typeof data !== 'object' || data === null) return false
      const event = data as BackgroundToolBusEvent
      if (event.sessionId !== sessionId || typeof event.toolUseId !== 'string') return false

      if (topic === 'background_tool:completed') {
        if (!entries.delete(event.toolUseId)) return false
        notify()
        return true
      }
      if (topic !== 'background_tool:started' && topic !== 'background_tool:progress') {
        return false
      }
      if (typeof event.taskId !== 'string') return false
      const previous = entries.get(event.toolUseId)
      entries.set(event.toolUseId, {
        taskId: event.taskId,
        toolName: typeof event.tool === 'string' ? event.tool : (previous?.toolName ?? ''),
        elapsedMs:
          typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs)
            ? event.elapsedMs
            : (previous?.elapsedMs ?? 0),
        totalOutputChars:
          typeof event.totalOutputChars === 'number' && Number.isFinite(event.totalOutputChars)
            ? event.totalOutputChars
            : (previous?.totalOutputChars ?? 0),
        lastOutputTail:
          typeof event.lastOutputTail === 'string'
            ? event.lastOutputTail
            : (previous?.lastOutputTail ?? ''),
        lastSeenAt: Date.now(),
      })
      notify()
      return true
    },
    clear() {
      if (entries.size === 0) return
      entries.clear()
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const backgroundProgressStore = createBackgroundProgressStore()

const BACKGROUND_TOOL_TOPICS = [
  'background_tool:started',
  'background_tool:progress',
  'background_tool:completed',
] as const

/**
 * Trust an entry only while events keep arriving. The steady heartbeat is
 * 15s; three missed heartbeats cover a websocket reconnect gap.
 */
export const BACKGROUND_PROGRESS_STALE_MS = 45_000

export function backgroundProgressIsStale(
  entry: BackgroundToolProgressEntry,
  nowMs: number,
): boolean {
  return nowMs - entry.lastSeenAt > BACKGROUND_PROGRESS_STALE_MS
}

/** Elapsed at render time: server-reported elapsed plus client drift since. */
export function backgroundProgressElapsedMs(
  entry: BackgroundToolProgressEntry,
  nowMs: number,
): number {
  return entry.elapsedMs + Math.max(0, nowMs - entry.lastSeenAt)
}

/**
 * Subscribe to live background-tool progress for one session.
 * @returns a stable lookup by tool call id, or undefined without a session.
 */
export function useBackgroundToolProgress(
  sessionId: string | null | undefined,
): ((callId: string) => BackgroundToolProgressEntry | undefined) | undefined {
  const [, setRevision] = useState(0)
  const activeSessionId = sessionId ?? null

  useEffect(() => {
    backgroundProgressStore.clear()
    if (activeSessionId === null) return undefined
    return backgroundProgressStore.subscribe(() => setRevision((revision) => revision + 1))
  }, [activeSessionId])

  const onEvent = useCallback(
    (topic: string, data: unknown) => {
      if (activeSessionId === null) return
      backgroundProgressStore.apply(activeSessionId, topic, data)
    },
    [activeSessionId],
  )

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: [...BACKGROUND_TOOL_TOPICS],
    onEvent,
  })

  return useCallback((callId: string) => {
    const entry = backgroundProgressStore.get(callId)
    if (entry === undefined) return undefined
    return backgroundProgressIsStale(entry, Date.now()) ? undefined : entry
  }, [])
}
