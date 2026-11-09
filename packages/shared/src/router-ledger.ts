export interface RouterMatter {
  id: string
  principal: string
  title: string
  goal: string
  criteria: string[]
  state: 'open' | 'working' | 'waiting' | 'paused' | 'completed' | 'cancelled'
  version: number
  context: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface RouterSignal {
  id: number
  key: string
  principal: string
  kind: 'event' | 'worker_result' | 'timer' | 'ui_action'
  scope: string
  payload: Record<string, unknown>
  state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  createdAt: string
  error: string | null
}

export interface RouterTraceRun {
  id: string
  ordinal: number
  sessionId: string
  label: string
  matterId: string | null
  relatedMatters?: { id: string; title: string }[]
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  endedAt: string | null
  replayOf: string | null
}

export interface RouterTraceEntry {
  ordinal: number
  runId: string
  kind:
    | 'input'
    | 'model_request'
    | 'model_response'
    | 'worker_request'
    | 'worker_event'
    | 'replay_tool'
    | 'tool_start'
    | 'tool_result'
    | 'result'
    | 'error'
  createdAt: string
  data: unknown
}

/** Stores transport-visible input/output, never hidden model reasoning. */
export interface RouterTraceSink {
  begin(sessionId: string, label: string, input: unknown): string
  append(runId: string, kind: RouterTraceEntry['kind'], data: unknown): void
  end(runId: string, status: 'completed' | 'failed'): void
}

export interface RouterFollowupTimer {
  publicationId?: string | null
  id: string
  principal: string
  matterId: string
  scope: string
  dueAt: string
  reason: string
  cancelReason?: string | null
  cancelTurnId?: number | null
  state: 'scheduled' | 'fired' | 'cancelled'
  createdAt: string
}
