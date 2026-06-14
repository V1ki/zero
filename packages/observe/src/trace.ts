import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSessionLogRelativeDir } from '@zero-os/shared'
import { generatePrefixedId, now } from '@zero-os/shared'
import { externalizeImageData } from './image-ref'
import type {
  RunLogEntry,
  RunLogLevel,
  StartSpanOptions,
  TraceEntry,
  TraceSpan,
  TraceStatus,
  UpdateSpanInput,
} from './trace-types'

export type {
  RunLogEntry,
  RunLogLevel,
  StartSpanOptions,
  TraceEntry,
  TraceKind,
  TraceSpan,
  TraceStatus,
  UpdateSpanInput,
} from './trace-types'

/**
 * Trace recorder for tracking call chains across sessions and tools.
 * When initialized with a logs directory, span lifecycle snapshots are
 * append-written to per-session trace.jsonl files.
 */
export class Tracer {
  private spans: Map<string, TraceSpan> = new Map()
  private rootSpans: Map<string, TraceSpan> = new Map()
  private logStore?: TraceLogStore

  constructor(basePath?: string) {
    this.logStore = basePath ? new TraceLogStore(basePath) : undefined
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

    this.logStore?.appendTraceEntry(this.toTraceEntry(span))

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
      span.data = mergeTraceRecords(
        span.data,
        this.preparePersistedValue(span.sessionId, update.data),
      )
    }
    if (update.metadata) {
      span.metadata = mergeTraceRecords(
        span.metadata,
        this.preparePersistedValue(span.sessionId, update.metadata),
      )
    }

    this.logStore?.appendTraceEntry(this.toTraceEntry(span))
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

    this.logStore?.appendTraceEntry(this.toTraceEntry(span))
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
    if (!this.logStore) return

    this.logStore.appendRunLogEntry({
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
    if (!this.logStore) {
      return Array.from(this.rootSpans.values()).filter((s) => s.sessionId === sessionId)
    }

    return this.exportSession(sessionId)
  }

  /**
   * Read all persisted trace entries for a session.
   */
  readSessionEntries(sessionId: string): TraceEntry[] {
    return this.logStore?.readSessionEntries(sessionId) ?? []
  }

  /**
   * Export the complete trace tree for a session as a serializable object.
   * When file persistence is enabled, this rebuilds the tree from trace.jsonl
   * and overlays any still-running in-memory spans.
   */
  exportSession(sessionId: string): TraceSpan[] {
    if (!this.logStore) {
      return this.getSessionTraces(sessionId)
    }

    const traces = new Map<string, TraceSpan>()

    for (const entry of this.readSessionEntries(sessionId)) {
      traces.set(entry.spanId, traceEntryToSpan(entry))
    }

    for (const span of this.spans.values()) {
      if (span.sessionId !== sessionId || span.endTime) continue
      const cloned = cloneTraceSpanWithoutChildren(span)
      traces.set(span.id, this.preparePersistedValue(span.sessionId, cloned))
    }

    return buildTraceTree(traces.values())
  }

  /**
   * Clear all spans (useful for testing or memory management).
   */
  clear(): void {
    this.spans.clear()
    this.rootSpans.clear()
  }

  private preparePersistedValue<T>(sessionId: string, value: T): T {
    return this.logStore?.preparePersistedValue(sessionId, value) ?? value
  }

  private toTraceEntry(span: TraceSpan): TraceEntry {
    return traceSpanToEntry(span)
  }
}

function mergeTraceRecords(
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
      next[key] = mergeTraceRecords(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      continue
    }

    next[key] = value
  }

  return next
}

class TraceLogStore {
  constructor(private readonly basePath: string) {}

  appendTraceEntry(entry: TraceEntry): void {
    const persistedEntry = this.preparePersistedValue(entry.sessionId, entry)
    const filePath = this.getTraceFilePath(persistedEntry.sessionId)
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

  appendRunLogEntry(entry: RunLogEntry): void {
    const persistedEntry = this.preparePersistedValue(entry.sessionId, entry)
    const filePath = join(
      this.basePath,
      getSessionLogRelativeDir(persistedEntry.sessionId),
      'run.log',
    )
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(persistedEntry)}\n`, 'utf-8')
  }

  readSessionEntries(sessionId: string): TraceEntry[] {
    const filePath = this.getTraceFilePath(sessionId)
    if (!existsSync(filePath)) return []
    return collapseTraceEntries(this.readJsonlFile<TraceEntry>(filePath))
  }

  preparePersistedValue<T>(sessionId: string, value: T): T {
    return externalizeImageData(value, { logsBasePath: this.basePath, sessionId })
  }

  private getTraceFilePath(sessionId: string): string {
    return join(this.basePath, getSessionLogRelativeDir(sessionId), 'trace.jsonl')
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
}

function buildTraceTree(spans: Iterable<TraceSpan>): TraceSpan[] {
  const traces = new Map<string, TraceSpan>()
  for (const span of spans) {
    span.children = []
    traces.set(span.id, span)
  }

  const roots: TraceSpan[] = []
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

  sortTraceTree(roots)
  return roots
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

function traceSpanToEntry(span: TraceSpan): TraceEntry {
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

function traceEntryToSpan(entry: TraceEntry): TraceSpan {
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

function cloneTraceSpanWithoutChildren(span: TraceSpan): TraceSpan {
  return {
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
}

function sortTraceTree(spans: TraceSpan[]): void {
  spans.sort((left, right) => left.startTime.localeCompare(right.startTime))
  for (const span of spans) {
    if (span.children.length > 0) {
      sortTraceTree(span.children)
    }
  }
}
