import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generatePrefixedId, getSessionLogRelativeDir, now } from '@zero-os/shared'
import { externalizeImageData } from './image-ref'

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

interface StartSpanOptions {
  kind?: TraceKind
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface UpdateSpanInput {
  kind?: TraceKind
  name?: string
  agentName?: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

function mergeRecords(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) }

  for (const [key, value] of Object.entries(update)) {
    const existing = next[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      next[key] = mergeRecords(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      continue
    }

    next[key] = value
  }

  return next
}

export function collapseTraceEntries(entries: TraceEntry[]): TraceEntry[] {
  const latestEntries = new Map<string, TraceEntry>()

  for (const entry of entries) {
    latestEntries.set(`${entry.sessionId}:${entry.spanId}`, entry)
  }

  return Array.from(latestEntries.values()).sort((left, right) =>
    left.startTime.localeCompare(right.startTime),
  )
}

/**
 * Trace recorder for tracking call chains across sessions and tools.
 * When initialized with a logs directory, span lifecycle snapshots are
 * append-written to per-session trace.jsonl files.
 */
export class Tracer {
  private spans: Map<string, TraceSpan> = new Map()
  private rootSpans: Map<string, TraceSpan> = new Map()
  private basePath?: string

  constructor(basePath?: string) {
    this.basePath = basePath
  }

  /**
   * Start a new trace span.
   */
  startSpan(
    sessionId: string,
    name: string,
    parentId?: string,
    options: StartSpanOptions = {},
  ): TraceSpan {
    const span: TraceSpan = {
      id: generatePrefixedId('span'),
      parentId,
      sessionId,
      kind: options.kind ?? 'turn',
      name,
      agentName: options.agentName,
      startTime: now(),
      status: 'running',
      data: options.data ? this.preparePersistedValue(sessionId, { ...options.data }) : undefined,
      metadata: options.metadata
        ? this.preparePersistedValue(sessionId, { ...options.metadata })
        : undefined,
      children: [],
    }

    this.spans.set(span.id, span)

    if (parentId) {
      const parent = this.spans.get(parentId)
      if (parent) {
        parent.children.push(span)
      }
    } else {
      this.rootSpans.set(span.id, span)
    }

    if (this.basePath) {
      this.appendTraceEntry(this.toTraceEntry(span))
    }

    return span
  }

  /**
   * Update mutable span fields before the span is ended.
   */
  updateSpan(spanId: string, update: UpdateSpanInput): void {
    const span = this.spans.get(spanId)
    if (!span || span.endTime) return

    if (update.kind) span.kind = update.kind
    if (update.name) span.name = update.name
    if (update.agentName) span.agentName = update.agentName
    if (update.data) {
      span.data = mergeRecords(span.data, this.preparePersistedValue(span.sessionId, update.data))
    }
    if (update.metadata) {
      span.metadata = mergeRecords(
        span.metadata,
        this.preparePersistedValue(span.sessionId, update.metadata),
      )
    }

    if (this.basePath) {
      this.appendTraceEntry(this.toTraceEntry(span))
    }
  }

  /**
   * End a trace span.
   */
  endSpan(
    spanId: string,
    status: Exclude<TraceStatus, 'running'> = 'success',
    metadata?: Record<string, unknown>,
  ): void {
    const span = this.spans.get(spanId)
    if (!span || span.endTime) return

    span.endTime = now()
    span.durationMs = new Date(span.endTime).getTime() - new Date(span.startTime).getTime()
    span.status = status
    if (metadata) {
      span.metadata = {
        ...span.metadata,
        ...this.preparePersistedValue(span.sessionId, metadata),
      }
    }

    if (this.basePath) {
      this.appendTraceEntry(this.toTraceEntry(span))
    }
  }

  /**
   * Append an arbitrary session-scoped runtime log entry to run.log.
   */
  logSession(
    sessionId: string,
    level: RunLogLevel,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.basePath) return

    this.appendRunLogEntry({
      ts: now(),
      level,
      event,
      sessionId,
      data,
    })
  }

  /**
   * Get a span by ID.
   */
  getSpan(spanId: string): TraceSpan | undefined {
    return this.spans.get(spanId)
  }

  /**
   * Get all root spans for a session.
   */
  getSessionTraces(sessionId: string): TraceSpan[] {
    if (!this.basePath) {
      return Array.from(this.rootSpans.values()).filter((s) => s.sessionId === sessionId)
    }

    return this.exportSession(sessionId)
  }

  /**
   * Read all persisted trace entries for a session.
   */
  readSessionEntries(sessionId: string): TraceEntry[] {
    if (!this.basePath) return []

    const filePath = this.getTraceFilePath(sessionId)
    if (existsSync(filePath)) {
      return collapseTraceEntries(this.readJsonlFile<TraceEntry>(filePath))
    }

    return []
  }

  /**
   * Export the complete trace tree for a session as a serializable object.
   * When file persistence is enabled, this rebuilds the tree from trace.jsonl
   * and overlays any still-running in-memory spans.
   */
  exportSession(sessionId: string): TraceSpan[] {
    if (!this.basePath) {
      return this.getSessionTraces(sessionId)
    }

    const traces = new Map<string, TraceSpan>()

    for (const entry of this.readSessionEntries(sessionId)) {
      traces.set(entry.spanId, this.entryToSpan(entry))
    }

    for (const span of this.spans.values()) {
      if (span.sessionId !== sessionId || span.endTime) continue
      traces.set(span.id, this.cloneSpanWithoutChildren(span))
    }

    const roots: TraceSpan[] = []
    for (const span of traces.values()) {
      span.children = []
    }

    for (const span of traces.values()) {
      if (span.parentId) {
        const parent = traces.get(span.parentId)
        if (parent) {
          parent.children.push(span)
          continue
        }
      }
      roots.push(span)
    }

    this.sortTraceTree(roots)
    return roots
  }

  /**
   * Clear all spans (useful for testing or memory management).
   */
  clear(): void {
    this.spans.clear()
    this.rootSpans.clear()
  }

  private getTraceFilePath(sessionId: string): string {
    return join(this.basePath as string, getSessionLogRelativeDir(sessionId), 'trace.jsonl')
  }

  private appendTraceEntry(entry: TraceEntry): void {
    if (!this.basePath) return

    const persistedEntry = this.preparePersistedValue(entry.sessionId, entry)
    const filePath = join(
      this.basePath,
      getSessionLogRelativeDir(persistedEntry.sessionId),
      'trace.jsonl',
    )
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(persistedEntry)}\n`, 'utf-8')
    this.appendRunLogEntry({
      ts: now(),
      level: persistedEntry.status === 'error' ? 'error' : 'debug',
      event: `trace.${persistedEntry.kind}.${persistedEntry.status}`,
      sessionId: persistedEntry.sessionId,
      spanId: persistedEntry.spanId,
      parentSpanId: persistedEntry.parentSpanId,
      name: persistedEntry.name,
      agentName: persistedEntry.agentName,
      data: {
        kind: persistedEntry.kind,
        startTime: persistedEntry.startTime,
        endTime: persistedEntry.endTime,
        durationMs: persistedEntry.durationMs,
        status: persistedEntry.status,
        ...(persistedEntry.data ? { spanData: persistedEntry.data } : {}),
      },
      metadata: persistedEntry.metadata,
    })
  }

  private appendRunLogEntry(entry: RunLogEntry): void {
    if (!this.basePath) return

    const persistedEntry = this.preparePersistedValue(entry.sessionId, entry)
    const filePath = join(
      this.basePath,
      getSessionLogRelativeDir(persistedEntry.sessionId),
      'run.log',
    )
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(persistedEntry)}\n`, 'utf-8')
  }

  private preparePersistedValue<T>(sessionId: string, value: T): T {
    return externalizeImageData(value, { logsBasePath: this.basePath, sessionId })
  }

  private readJsonlFile<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, 'utf-8')
    if (content.trim().length === 0) return []

    const entries: T[] = []

    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue

      try {
        entries.push(JSON.parse(line) as T)
      } catch {}
    }

    return entries
  }

  private toTraceEntry(span: TraceSpan): TraceEntry {
    return {
      spanId: span.id,
      parentSpanId: span.parentId,
      sessionId: span.sessionId,
      kind: span.kind,
      name: span.name,
      agentName: span.agentName,
      startTime: span.startTime,
      endTime: span.endTime,
      durationMs: span.durationMs,
      status: span.status,
      data: span.data,
      metadata: span.metadata,
    }
  }

  private entryToSpan(entry: TraceEntry): TraceSpan {
    return {
      id: entry.spanId,
      parentId: entry.parentSpanId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      name: entry.name,
      agentName: entry.agentName,
      startTime: entry.startTime,
      endTime: entry.endTime,
      durationMs: entry.durationMs,
      status: entry.status,
      data: entry.data,
      metadata: entry.metadata,
      children: [],
    }
  }

  private cloneSpanWithoutChildren(span: TraceSpan): TraceSpan {
    const cloned = {
      id: span.id,
      parentId: span.parentId,
      sessionId: span.sessionId,
      kind: span.kind,
      name: span.name,
      agentName: span.agentName,
      startTime: span.startTime,
      endTime: span.endTime,
      durationMs: span.durationMs,
      status: span.status,
      data: span.data ? { ...span.data } : undefined,
      metadata: span.metadata ? { ...span.metadata } : undefined,
      children: [],
    }
    return this.basePath ? this.preparePersistedValue(span.sessionId, cloned) : cloned
  }

  private sortTraceTree(spans: TraceSpan[]): void {
    spans.sort((left, right) => left.startTime.localeCompare(right.startTime))
    for (const span of spans) {
      if (span.children.length > 0) {
        this.sortTraceTree(span.children)
      }
    }
  }
}
