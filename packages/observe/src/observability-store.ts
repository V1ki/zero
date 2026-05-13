import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { getSessionLogRelativeDir, now } from '@zero-os/shared'
import type { CompletionResponse, StopReason, ToolEvidence, ToolResultBlock } from '@zero-os/shared'
import { type RunLogEntry, type TraceEntry, type TraceKind, collapseTraceEntries } from './trace'
import {
  projectSessionClosuresFromTraceEntries,
  projectSessionDecisionsFromTraceEntries,
  projectSessionRequestsFromTraceEntries,
  projectSessionSnapshotsFromTraceEntries,
} from './trace-projections'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  sessionId?: string
  event: string
  [key: string]: unknown
}

export interface RequestToolCallEntry {
  id: string
  name: string
  input: Record<string, unknown>
  evidence?: ToolEvidence
}

export interface RequestToolResultEntry extends ToolResultBlock {}

export interface RequestQueuedInjectionMessageEntry {
  timestamp: string
  content: string
  imageCount: number
  mediaTypes: string[]
}

export interface RequestQueuedInjectionEntry {
  count: number
  formattedText: string
  messages: RequestQueuedInjectionMessageEntry[]
}

export interface RequestMemoryInjectionEntry {
  layer: 'layer1' | 'layer2'
  source: 'retrieved_memories' | 'memory_hint'
  formattedText: string
}

export interface RequestLogEntry {
  id: string
  turnIndex: number
  parentId?: string
  sessionId: string
  agentName?: string
  spawnedByRequestId?: string
  snapshotId?: string
  model: string
  provider: string
  userPrompt: string
  response: string
  reasoningContent?: string
  stopReason: StopReason
  toolUseCount: number
  toolCalls: RequestToolCallEntry[]
  toolResults: RequestToolResultEntry[]
  queuedInjection?: RequestQueuedInjectionEntry
  memoryInjections?: RequestMemoryInjectionEntry[]
  toolNames?: string[]
  toolDefinitionsHash?: string
  systemHash?: string
  staticPrefixHash?: string
  messageCount?: number
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

export interface SnapshotEntry {
  id: string
  sessionId: string
  trigger: string
  model?: string
  parentSnapshot?: string
  systemPrompt?: string
  tools?: string[]
  identityMemory?: string
  compressedSummary?: string
  messagesBefore?: number
  messagesAfter?: number
  compressedRange?: string
  decisionContext?: {
    currentTokens: number
    conversationBudget: number
  }
  ts: string
}

export interface TaskClosureClassifierRequest {
  system: string
  prompt: string
  maxTokens: number
}

export type TaskClosureClassifierResponse = CompletionResponse

export interface EventLogEntry {
  ts: string
  level: LogLevel
  sessionId?: string
  event: string
  [key: string]: unknown
}

export interface TaskClosureDecisionLogEntry {
  ts: string
  sessionId: string
  event: 'task_closure_decision'
  action: 'finish' | 'continue' | 'block'
  reason: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  classifierRequest: TaskClosureClassifierRequest
  classifierResponse?: TaskClosureClassifierResponse
}

export interface TaskClosureFailedLogEntry {
  ts: string
  sessionId: string
  event: 'task_closure_failed'
  reason: 'invalid_classifier_output' | 'classifier_failed'
  failureStage: 'parse_classifier_response' | 'request_classifier'
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  classifierRequest: TaskClosureClassifierRequest
  classifierResponse?: TaskClosureClassifierResponse
  classifierResponseRaw?: string
  error?: string
}

export type ClosureLogEntry = TaskClosureDecisionLogEntry | TaskClosureFailedLogEntry

export type ClosureLogEntryInput =
  | Omit<TaskClosureDecisionLogEntry, 'ts'>
  | Omit<TaskClosureFailedLogEntry, 'ts'>

export type DecisionType =
  | 'context_compression'
  | 'memory_retrieval'
  | 'tool_selection'
  | 'task_closure'

export interface DecisionLogEntry {
  id: string
  sessionId: string
  agentName?: string
  ts: string
  durationMs?: number
  parentSpanId?: string
  sourceKind: TraceKind
  decisionType: DecisionType
  outcome: string
  context?: Record<string, unknown>
  detail?: Record<string, unknown>
  rationale?: string
}

export interface SessionRunLogSummary {
  sessionId: string
  entryCount: number
  sizeBytes: number
  firstTs?: string
  lastTs?: string
  lastEvent?: string
  lastLevel?: LogLevel
  levels: Partial<Record<LogLevel, number>>
  events: Record<string, number>
  rawRequestCount: number
  rawResponseCount: number
  toolCallCount: number
  errorCount: number
}

/**
 * Observability store for global events and trace-backed session projections.
 */
export class ObservabilityStore {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
    this.ensureDir(basePath)
    this.ensureDir(this.getSessionsRoot())
    this.ensureDir(this.getCurrentSessionsRoot())
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private getSessionsRoot(): string {
    return join(this.basePath, 'sessions')
  }

  private getCurrentSessionsRoot(): string {
    return join(this.getSessionsRoot(), '_current')
  }

  private appendLine(file: string, data: unknown): void {
    const filePath = join(this.basePath, file)
    const dir = dirname(filePath)
    this.ensureDir(dir)
    appendFileSync(filePath, `${JSON.stringify(data)}\n`, 'utf-8')
  }

  private listSessionDirectories(): string[] {
    const sessionsDir = this.getSessionsRoot()
    if (!existsSync(sessionsDir)) return []

    const sessionDirs: string[] = []
    for (const dirent of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (dirent.name === '_active' || dirent.name === '_current' || !dirent.isDirectory()) {
        continue
      }

      const entryPath = join(sessionsDir, dirent.name)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dirent.name)) {
        for (const sessionDirent of readdirSync(entryPath, { withFileTypes: true })) {
          if (!sessionDirent.isDirectory()) continue
          sessionDirs.push(join(entryPath, sessionDirent.name))
        }
        continue
      }

      sessionDirs.push(entryPath)
    }

    return sessionDirs
  }

  private removePathIfExists(path: string): void {
    try {
      const stat = lstatSync(path)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        rmSync(path, { recursive: true, force: true })
        return
      }
      unlinkSync(path)
    } catch {}
  }

  syncSessionCurrentState(sessionId: string, isCurrent: boolean): void {
    const currentLinkPath = join(this.getCurrentSessionsRoot(), sessionId)
    const legacyLinkPath = join(this.getSessionsRoot(), '_active', sessionId)
    if (!isCurrent) {
      this.removePathIfExists(currentLinkPath)
      this.removePathIfExists(legacyLinkPath)
      return
    }

    const sessionDir = join(this.basePath, getSessionLogRelativeDir(sessionId))
    this.ensureDir(sessionDir)
    this.ensureDir(this.getCurrentSessionsRoot())

    const target = relative(this.getCurrentSessionsRoot(), sessionDir)
    try {
      const currentTarget = readlinkSync(currentLinkPath)
      if (currentTarget === target) return
      this.removePathIfExists(currentLinkPath)
    } catch {}

    this.removePathIfExists(legacyLinkPath)

    symlinkSync(target, currentLinkPath, 'dir')
  }

  /**
   * Log a general event entry.
   */
  logEvent(entry: Omit<EventLogEntry, 'ts'>): void {
    this.appendLine('events.jsonl', { ...entry, ts: now() })
  }

  /**
   * General log entry.
   */
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    this.appendLine('events.jsonl', { ts: now(), level, event, ...data })
  }

  /**
   * Read all entries from a JSONL file.
   */
  readEntries<T = unknown>(file: string): T[] {
    return this.readJsonlFileSafely<T>(join(this.basePath, file))
  }

  /**
   * Read entries from a session-scoped JSONL file.
   */
  readSessionEntries<T = unknown>(sessionId: string, file: string): T[] {
    const filePath = join(this.basePath, getSessionLogRelativeDir(sessionId), file)
    return this.readJsonlFileSafely<T>(filePath)
  }

  readSessionRunLog(sessionId: string): RunLogEntry[] {
    return this.readSessionEntries<RunLogEntry>(sessionId, 'run.log')
  }

  listSessionRunLogs(): SessionRunLogSummary[] {
    const summaries: SessionRunLogSummary[] = []

    for (const sessionDir of this.listSessionDirectories()) {
      const runLogPath = join(sessionDir, 'run.log')
      if (!existsSync(runLogPath)) continue

      const entries = this.readJsonlFileSafely<RunLogEntry>(runLogPath)
      const levels: Partial<Record<LogLevel, number>> = {}
      const events: Record<string, number> = {}
      let rawRequestCount = 0
      let rawResponseCount = 0
      let toolCallCount = 0
      let errorCount = 0

      for (const entry of entries) {
        levels[entry.level] = (levels[entry.level] ?? 0) + 1
        events[entry.event] = (events[entry.event] ?? 0) + 1
        if (entry.event === 'llm_request.raw_request') rawRequestCount += 1
        if (entry.event === 'llm_request.raw_response') rawResponseCount += 1
        if (entry.event.startsWith('tool_call.')) toolCallCount += 1
        if (entry.level === 'error') errorCount += 1
      }

      const sortedEntries = [...entries].sort((left, right) => left.ts.localeCompare(right.ts))
      const first = sortedEntries[0]
      const last = sortedEntries.at(-1)
      const stat = statSync(runLogPath)

      summaries.push({
        sessionId: basename(sessionDir),
        entryCount: entries.length,
        sizeBytes: stat.size,
        firstTs: first?.ts,
        lastTs: last?.ts,
        lastEvent: last?.event,
        lastLevel: last?.level,
        levels,
        events,
        rawRequestCount,
        rawResponseCount,
        toolCallCount,
        errorCount,
      })
    }

    return summaries.sort((left, right) => (right.lastTs ?? '').localeCompare(left.lastTs ?? ''))
  }

  appendSessionJudge(sessionId: string, entry: unknown): void {
    this.appendLine(join(getSessionLogRelativeDir(sessionId), 'llm-judge.jsonl'), entry)
  }

  readSessionJudges<T = Record<string, unknown>>(sessionId: string): T[] {
    const filePath = join(this.basePath, getSessionLogRelativeDir(sessionId), 'llm-judge.jsonl')

    return this.readJsonlFileSafely<T>(filePath).sort((left, right) =>
      this.getSessionJudgeSortKey(right).localeCompare(this.getSessionJudgeSortKey(left)),
    )
  }

  /**
   * Read requests for a session from trace.jsonl.
   */
  readSessionRequests(sessionId: string): RequestLogEntry[] {
    return projectSessionRequestsFromTraceEntries(this.readSessionTraceEntries(sessionId)).map(
      (entry) => this.normalizeStoredRequestEntry(entry),
    )
  }

  /**
   * Read task closure events for a session from trace.jsonl.
   */
  readSessionClosures(sessionId: string): ClosureLogEntry[] {
    return projectSessionClosuresFromTraceEntries(this.readSessionTraceEntries(sessionId))
  }

  /**
   * Read projected decisions for a session from trace.jsonl.
   */
  readSessionDecisions(sessionId: string): DecisionLogEntry[] {
    return projectSessionDecisionsFromTraceEntries(this.readSessionTraceEntries(sessionId))
  }

  /**
   * Read snapshots for a session from trace.jsonl.
   */
  readSessionSnapshots(sessionId: string): SnapshotEntry[] {
    return projectSessionSnapshotsFromTraceEntries(this.readSessionTraceEntries(sessionId))
  }

  /**
   * Read the latest persisted trace snapshot for each span in a session.
   */
  readSessionTraceEntries(sessionId: string): TraceEntry[] {
    return collapseTraceEntries(this.readSessionEntries<TraceEntry>(sessionId, 'trace.jsonl'))
  }

  /**
   * Read all request entries across trace spans.
   */
  readAllRequests(): RequestLogEntry[] {
    const deduped = new Map<string, RequestLogEntry>()

    for (const entry of this.readAllTraceEntries()) {
      for (const projected of projectSessionRequestsFromTraceEntries([entry])) {
        deduped.set(projected.id, this.normalizeStoredRequestEntry(projected))
      }
    }

    return Array.from(deduped.values()).sort((left, right) => left.ts.localeCompare(right.ts))
  }

  /**
   * Read all persisted trace entries across sessions.
   */
  readAllTraceEntries(): TraceEntry[] {
    const entries: TraceEntry[] = []

    for (const sessionDir of this.listSessionDirectories()) {
      entries.push(
        ...collapseTraceEntries(
          this.readJsonlFileSafely<TraceEntry>(join(sessionDir, 'trace.jsonl')),
        ),
      )
    }

    return entries.sort((left, right) => left.startTime.localeCompare(right.startTime))
  }

  /**
   * Read all snapshots across trace spans.
   */
  readAllSnapshots(): SnapshotEntry[] {
    const deduped = new Map<string, SnapshotEntry>()

    for (const entry of this.readAllTraceEntries()) {
      for (const projected of projectSessionSnapshotsFromTraceEntries([entry])) {
        deduped.set(projected.id, projected)
      }
    }

    return Array.from(deduped.values()).sort((left, right) => left.ts.localeCompare(right.ts))
  }

  /**
   * @deprecated Use readJsonlFileSafely instead.
   */
  private readJsonlFile<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, 'utf-8')
    if (content.trim().length === 0) return []
    return content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T)
  }

  private readJsonlFileSafely<T>(filePath: string): T[] {
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

  private getSessionJudgeSortKey(entry: unknown): string {
    if (!entry || typeof entry !== 'object') return ''

    const savedAt = (entry as { savedAt?: unknown }).savedAt
    return typeof savedAt === 'string' ? savedAt : ''
  }

  private normalizeStoredRequestEntry(entry: RequestLogEntry): RequestLogEntry {
    return {
      ...entry,
      toolCalls: this.normalizeToolCalls(entry.toolCalls),
      toolResults: this.normalizeToolResults(entry.toolResults),
      queuedInjection: this.normalizeQueuedInjection(entry.queuedInjection),
      memoryInjections: this.normalizeMemoryInjections(entry.memoryInjections),
    }
  }

  private normalizeToolCalls(toolCalls: unknown): RequestToolCallEntry[] {
    if (!Array.isArray(toolCalls)) return []

    return toolCalls.filter((toolCall): toolCall is RequestToolCallEntry =>
      Boolean(
        toolCall &&
          typeof toolCall === 'object' &&
          typeof (toolCall as RequestToolCallEntry).id === 'string' &&
          typeof (toolCall as RequestToolCallEntry).name === 'string' &&
          (toolCall as RequestToolCallEntry).input &&
          typeof (toolCall as RequestToolCallEntry).input === 'object' &&
          !Array.isArray((toolCall as RequestToolCallEntry).input),
      ),
    )
  }

  private normalizeToolResults(toolResults: unknown): RequestToolResultEntry[] {
    if (!Array.isArray(toolResults)) return []

    return toolResults.filter((toolResult): toolResult is RequestToolResultEntry =>
      Boolean(
        toolResult &&
          typeof toolResult === 'object' &&
          (toolResult as RequestToolResultEntry).type === 'tool_result' &&
          typeof (toolResult as RequestToolResultEntry).toolUseId === 'string' &&
          typeof (toolResult as RequestToolResultEntry).content === 'string' &&
          ((toolResult as RequestToolResultEntry).isError === undefined ||
            typeof (toolResult as RequestToolResultEntry).isError === 'boolean') &&
          ((toolResult as RequestToolResultEntry).outputSummary === undefined ||
            typeof (toolResult as RequestToolResultEntry).outputSummary === 'string'),
      ),
    )
  }

  private normalizeQueuedInjection(
    queuedInjection: unknown,
  ): RequestQueuedInjectionEntry | undefined {
    if (!queuedInjection || typeof queuedInjection !== 'object' || Array.isArray(queuedInjection)) {
      return undefined
    }

    const count = (queuedInjection as RequestQueuedInjectionEntry).count
    const formattedText = (queuedInjection as RequestQueuedInjectionEntry).formattedText
    const messages = (queuedInjection as RequestQueuedInjectionEntry).messages

    if (
      typeof count !== 'number' ||
      !Number.isFinite(count) ||
      typeof formattedText !== 'string' ||
      !Array.isArray(messages)
    ) {
      return undefined
    }

    return {
      count,
      formattedText,
      messages: messages.filter((message): message is RequestQueuedInjectionMessageEntry =>
        Boolean(
          message &&
            typeof message === 'object' &&
            typeof (message as RequestQueuedInjectionMessageEntry).timestamp === 'string' &&
            typeof (message as RequestQueuedInjectionMessageEntry).content === 'string' &&
            typeof (message as RequestQueuedInjectionMessageEntry).imageCount === 'number' &&
            Number.isFinite((message as RequestQueuedInjectionMessageEntry).imageCount) &&
            Array.isArray((message as RequestQueuedInjectionMessageEntry).mediaTypes) &&
            (message as RequestQueuedInjectionMessageEntry).mediaTypes.every(
              (mediaType) => typeof mediaType === 'string',
            ),
        ),
      ),
    }
  }

  private normalizeMemoryInjections(
    memoryInjections: unknown,
  ): RequestMemoryInjectionEntry[] | undefined {
    if (!Array.isArray(memoryInjections)) return undefined

    const normalized = memoryInjections.filter(
      (memoryInjection): memoryInjection is RequestMemoryInjectionEntry =>
        Boolean(
          memoryInjection &&
            typeof memoryInjection === 'object' &&
            ((memoryInjection as RequestMemoryInjectionEntry).layer === 'layer1' ||
              (memoryInjection as RequestMemoryInjectionEntry).layer === 'layer2') &&
            ((memoryInjection as RequestMemoryInjectionEntry).source === 'retrieved_memories' ||
              (memoryInjection as RequestMemoryInjectionEntry).source === 'memory_hint') &&
            typeof (memoryInjection as RequestMemoryInjectionEntry).formattedText === 'string',
        ),
    )

    return normalized.length > 0 ? normalized : undefined
  }
}
