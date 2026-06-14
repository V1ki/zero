export type TraceStatus = 'running' | 'success' | 'error'

export type TraceKind =
  | 'turn'
  | 'llm_request'
  | 'tool_call'
  | 'context_compaction'
  | 'sub_agent'
  | 'snapshot'
  | 'closure_decision'
  | 'closure_failed'

export interface TraceSpan {
  id: string
  parentId?: string
  sessionId: string
  kind: TraceKind
  name: string
  agentName?: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: TraceStatus
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  children: TraceSpan[]
}

export interface TraceEntry {
  spanId: string
  parentSpanId?: string
  sessionId: string
  kind: TraceKind
  name: string
  agentName?: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: TraceStatus
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type RunLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RunLogEntry {
  ts: string
  level: RunLogLevel
  event: string
  sessionId: string
  spanId?: string
  parentSpanId?: string
  name?: string
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface StartSpanOptions {
  kind?: TraceKind
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface UpdateSpanInput {
  kind?: TraceKind
  name?: string
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}
