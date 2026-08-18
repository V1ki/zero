import type { ScheduleConfig, SecretFilter } from './config'
import type { Memory, MemorySearchOptions, MemoryType, ScoredMemoryMatch } from './memory'
import type { ToolResultContentItem } from './message'

/**
 * Minimal interface for structured logging from tools.
 */
export interface ObservabilityHandle {
  logEvent(entry: {
    level: string
    sessionId: string
    event: string
    tool: string
    input: string
    outputSummary: string
    durationMs: number
  }): void
  recordOperation(entry: {
    sessionId: string
    tool: string
    event: string
    success: boolean
    durationMs: number
    createdAt: string
  }): void
}

export interface ToolTraceSpan {
  id: string
  parentId?: string
  sessionId: string
  kind:
    | 'turn'
    | 'llm_request'
    | 'tool_call'
    | 'context_compaction'
    | 'sub_agent'
    | 'snapshot'
    | 'closure_decision'
    | 'closure_failed'
  name: string
  agentName?: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: 'running' | 'success' | 'error'
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  children: ToolTraceSpan[]
}

export interface ToolTracer {
  startSpan(
    sessionId: string,
    name: string,
    parentId?: string,
    options?: {
      kind?:
        | 'turn'
        | 'llm_request'
        | 'tool_call'
        | 'context_compaction'
        | 'sub_agent'
        | 'snapshot'
        | 'closure_decision'
        | 'closure_failed'
      agentName?: string
      data?: Record<string, unknown>
      metadata?: Record<string, unknown>
    },
  ): ToolTraceSpan
  updateSpan(
    spanId: string,
    update: {
      kind?:
        | 'turn'
        | 'llm_request'
        | 'tool_call'
        | 'context_compaction'
        | 'sub_agent'
        | 'snapshot'
        | 'closure_decision'
        | 'closure_failed'
      name?: string
      agentName?: string
      data?: Record<string, unknown>
      metadata?: Record<string, unknown>
    },
  ): void
  endSpan(spanId: string, status?: 'success' | 'error', metadata?: Record<string, unknown>): void
  getSpan(spanId: string): ToolTraceSpan | undefined
}

export interface AgentControlHandle {
  spawn(
    agent: unknown,
    context: unknown,
    instruction: string,
    options?: {
      mode?: 'standard' | 'interactive'
      label?: string
      role?: string
      model?: string
      depth?: number
      traceSpanId?: string
      tracer?: ToolTracer
      logger?: ToolLogger
      secretFilter?: SecretFilter
      sessionId?: string
    },
  ): { agentId: string; label: string } | { error: string }
  waitAny(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }>
  waitAll(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }>
  waitReady(
    ids: string[],
    timeoutMs?: number,
    waitAll?: boolean,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }>
  getStatus(agentId: string): { state: string; [key: string]: unknown } | undefined
  getOutput(agentId: string): string | undefined
  getSnapshot(): Array<{
    id: string
    label: string
    role?: string
    mode?: string
    state: string
    instruction: string
    output?: string
    error?: string
    startedAt: number
    endedAt?: number
  }>
  restoreSnapshot(
    entries: Array<{
      id: string
      label: string
      role?: string
      mode?: string
      state: string
      instruction: string
      output?: string
      error?: string
      startedAt: number
      endedAt?: number
    }>,
  ): void
  sendInput(
    agentId: string,
    message: string,
    options?: { interrupt?: boolean },
  ): { success: boolean; error?: string }
  getTraceSpanId(agentId: string): string | undefined
  getAgentInfo(
    agentId: string,
  ): { label: string; role?: string; status: { state: string } } | undefined
  close(agentId: string): { state: string; [key: string]: unknown } | undefined
  listAgents(): Array<{
    id: string
    label: string
    role?: string
    status: { state: string }
    depth: number
    elapsedMs: number
  }>
  readonly activeAgentCount: number
}

export type RunningToolState = 'running' | 'abort_requested' | 'finished'

export type RunningToolAbortRequestStatus =
  | 'accepted'
  | 'already_requested'
  | 'already_finished'
  | 'not_abortable'

export type RunningToolTerminationCause = 'completed' | 'abort' | 'timeout' | 'spawn_error'

export interface RunningToolTerminalMetadata {
  finishedAt: string
  cause: RunningToolTerminationCause
  success: boolean
  outputSummary?: string
}

export interface RunningToolHandle {
  readonly toolUseId: string
  readonly toolName: string
  readonly abortable: boolean
  getState(): RunningToolState
  getAbortReason(): string | undefined
  getTerminalMetadata(): RunningToolTerminalMetadata | undefined
  requestAbort(reason?: string): RunningToolAbortRequestStatus
  setAbortHandler(handler: (reason?: string) => void): void
  markFinished(metadata: RunningToolTerminalMetadata): boolean
}

export interface RunningToolRegistry {
  register(entry: {
    toolUseId: string
    toolName: string
    abortable: boolean
  }): RunningToolHandle
  get(toolUseId: string): RunningToolHandle | undefined
}

export interface BackgroundToolExecutionInput {
  toolName: string
  toolUseId: string
  inputSummary: string
  execute(): Promise<ToolResult>
}

export interface BackgroundToolTaskSink {
  readonly thresholdMs: number
  run(input: BackgroundToolExecutionInput): Promise<ToolResult>
  waitForCompletion?(taskId: string): Promise<ToolResult>
}

export interface ToolContext {
  sessionId: string
  currentModel?: string
  currentRequestId?: string
  currentTraceSpanId?: string
  currentToolUseId?: string
  spawnedByRequestId?: string
  workDir: string
  projectRoot?: string
  logger: ToolLogger
  tracer?: ToolTracer
  secretFilter?: SecretFilter
  observability?: ObservabilityHandle
  secretResolver?: (ref: string) => string | undefined
  memoryRetriever?: {
    retrieve(query: string, options?: MemorySearchOptions): Promise<Memory[]>
    retrieveScored?(query: string, options?: MemorySearchOptions): Promise<ScoredMemoryMatch[]>
  }
  memoryStore?: {
    create(
      type: MemoryType,
      title: string,
      content: string,
      options?: Record<string, unknown>,
    ): Promise<Memory>
    update(
      type: MemoryType,
      id: string,
      updates: Record<string, unknown>,
      context?: { sessionId?: string; precondition?: (current: Memory) => boolean },
    ): Promise<Memory | undefined>
    delete(type: MemoryType, id: string): Promise<boolean>
    list(type: MemoryType): Memory[]
    get(type: MemoryType, id: string): Memory | undefined
    getRelativePath?(type: MemoryType, id: string): string | undefined
    readByPath?(
      path: string,
      options?: { from?: number; lines?: number },
    ): { path: string; text: string } | undefined
    findSimilar?(
      input: { title: string; content: string; tags: string[] },
      opts?: { topK?: number; candidateIds?: string[]; minScore?: number },
    ): Promise<{ id: string; type: MemoryType; score: number } | undefined>
  }
  channelBinding?: {
    source: string
    channelName: string
    channelId: string
    participantId?: string
    deliveryChannelId?: string
  }
  schedulerHandle?: {
    addAndStart(config: ScheduleConfig): void
    remove(name: string): boolean
    getStatus(): Array<{ name: string; nextRun: Date; running: boolean; lastRun?: Date }>
  }
  scheduleStore?: {
    save(config: ScheduleConfig): void
    delete(name: string): boolean
  }
  agentControl?: AgentControlHandle
  runningToolRegistry?: RunningToolRegistry
  backgroundToolTasks?: BackgroundToolTaskSink
  /**
   * When true, backgrounded bash tool executions are awaited in-place by the
   * tool executor (the model turn does not end until the task completes).
   * Used by sub-agents so their turn loop does not terminate with pending
   * background tasks (which caused premature "completed" states).
   */
  backgroundTaskWait?: boolean
  /** P3a: 会话内活文档折叠句柄。memory create 命中同主题时改走 update（合并正文），治会话内快照爆发。 */
  liveDocHandle?: {
    route(input: {
      type: MemoryType
      title: string
      content: string
      tags: string[]
    }): Promise<
      | { memoryId: string; existingContent: string; existingTags: string[]; maxChars: number }
      | undefined
    >
    register(input: { type: MemoryType; title: string; tags: string[] }, memoryId: string): void
  }
}

export interface ToolLogger {
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

export interface ToolResult {
  success: boolean
  output: string
  outputSummary: string
  contentItems?: ToolResultContentItem[]
  artifacts?: string[]
  /**
   * When a bash tool execution is moved to the background, the result carries
   * the background task id so executors in wait mode can await its completion.
   */
  backgroundTaskId?: string
}

export interface ToolRegistryEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  trusted: boolean
}
