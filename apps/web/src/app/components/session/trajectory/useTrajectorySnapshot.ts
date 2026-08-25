/**
 * Bridge between the session detail data flow and the trajectory view: derives
 * the trajectory snapshot whenever the session, request log, trace spans, or
 * gate events refresh (initial load and every websocket refetch). The current
 * tool registry is fetched once per mount and used to fill in tool
 * descriptions/parameters that session snapshots did not record historically.
 */

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../../lib/api'
import type { SessionDetail, SessionRequestEntry } from '../detail/useSessionDetailData'
import type { SessionTaskClosureEvent, TraceSpan } from '../timeline/timeline'
import {
  type MemoryNudgeEventLike,
  type SubAgentEventLike,
  buildTrajectorySnapshot,
} from './adapt-trajectory'
import type { ToolSchema, TrajectorySnapshot } from './types'

export interface TrajectorySnapshotState {
  snapshot: TrajectorySnapshot | null
}

export function useTrajectorySnapshot(
  session: SessionDetail | null,
  llmRequests: readonly SessionRequestEntry[],
  traces: readonly TraceSpan[],
  taskClosureEvents: readonly SessionTaskClosureEvent[] = [],
  subAgentEvents: readonly SubAgentEventLike[] = [],
  memoryNudgeEvents: readonly MemoryNudgeEventLike[] = [],
): TrajectorySnapshotState {
  const [toolSchemas, setToolSchemas] = useState<readonly ToolSchema[]>([])
  useEffect(() => {
    let cancelled = false
    apiFetch<{ tools: ToolSchema[] }>('/api/tools')
      .then((response) => {
        if (!cancelled) setToolSchemas(response.tools ?? [])
      })
      .catch((error) => {
        // Enrichment is display-only; an unavailable registry leaves the
        // name-only catalog in place.
        console.warn('trajectory: tool registry unavailable', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const snapshot = useMemo(() => {
    if (session === null) return null
    return buildTrajectorySnapshot(session, llmRequests, traces, {
      ...(session.timelineCompactionBlocks === undefined
        ? {}
        : { compactionBlocks: session.timelineCompactionBlocks }),
      taskClosureEvents,
      ...(toolSchemas.length === 0 ? {} : { toolSchemas }),
      subAgentEvents,
      memoryNudgeEvents,
    })
  }, [
    session,
    llmRequests,
    traces,
    taskClosureEvents,
    toolSchemas,
    subAgentEvents,
    memoryNudgeEvents,
  ])
  return { snapshot }
}
