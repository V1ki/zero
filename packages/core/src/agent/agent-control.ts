import type { Message, SecretFilter, ToolLogger, ToolTracer } from '@zero-os/shared'
import { generatePrefixedId, toErrorMessage } from '@zero-os/shared'
import type { AgentContext } from './agent'
import type { QueuedMessage } from './queue'

export type AgentState = 'running' | 'waiting' | 'completed' | 'failed' | 'closed'

export interface AgentSnapshot {
  id: string
  label: string
  role?: string
  model?: string
  mode?: 'standard' | 'interactive'
  state: AgentState
  instruction: string
  output?: string
  error?: string
  startedAt: number
  endedAt?: number
}

interface ControlledAgent {
  run(
    context: AgentContext,
    userMessage: string,
    userImages?: Array<{ mediaType: string; data: string }>,
    onNewMessage?: (msg: Message) => void,
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void,
    shouldInterrupt?: () => boolean,
    getQueuedMessages?: () => QueuedMessage[],
    requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
  ): Promise<Message[]>
}

interface AgentEntry {
  id: string
  sessionId?: string
  label: string
  role?: string
  model?: string
  mode: 'standard' | 'interactive'
  depth: number
  state: AgentState
  startedAt: number
  endedAt?: number
  instruction: string
  originalInstruction: string
  agent?: ControlledAgent
  context?: AgentContext
  output?: string
  error?: string
  messageQueue: QueuedMessage[]
  interruptFlag: boolean
  inputSignal?: {
    resolve: (messages: QueuedMessage[]) => void
    reject: (reason: Error) => void
  }
  waiters: Set<() => void>
  readyWaiters: Set<() => void>
  traceSpanId?: string
  tracer?: ToolTracer
  logger?: ToolLogger
  secretFilter?: SecretFilter
}

type AgentStatus = { state: string; [key: string]: unknown }

interface AgentListItem {
  id: string
  label: string
  role?: string
  status: { state: string }
  depth: number
  elapsedMs: number
}

export class AgentControl {
  private entries: Map<string, AgentEntry> = new Map()
  private tracer?: ToolTracer
  private logger?: ToolLogger

  constructor(instrumentation?: { tracer?: ToolTracer; logger?: ToolLogger }) {
    this.tracer = instrumentation?.tracer
    this.logger = instrumentation?.logger
  }

  setInstrumentation(tracer?: ToolTracer, logger?: ToolLogger): void {
    this.tracer = tracer
    this.logger = logger
  }

  get activeAgentCount(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.state === 'running' || entry.state === 'waiting') count++
    }
    return count
  }

  spawn(
    agent: ControlledAgent,
    context: AgentContext,
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
  ): { agentId: string; label: string } | { error: string } {
    if (!agent || typeof agent.run !== 'function') {
      return { error: 'Invalid agent instance.' }
    }
    if (!context || typeof context !== 'object') {
      return { error: 'Invalid agent context.' }
    }
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      return { error: 'Instruction is required.' }
    }

    const agentId = generatePrefixedId('agent')
    const label = options?.label?.trim() || `agent-${this.entries.size + 1}`
    const entry: AgentEntry = {
      id: agentId,
      sessionId: options?.sessionId,
      label,
      role: options?.role?.trim() || undefined,
      model: options?.model?.trim() || undefined,
      mode: options?.mode ?? 'standard',
      depth: Math.max(1, options?.depth ?? 1),
      state: 'running',
      startedAt: Date.now(),
      instruction,
      originalInstruction: instruction,
      agent,
      context,
      messageQueue: [],
      interruptFlag: false,
      inputSignal: undefined,
      waiters: new Set(),
      readyWaiters: new Set(),
      traceSpanId: options?.traceSpanId,
      tracer: options?.tracer ?? this.tracer,
      logger: options?.logger ?? this.logger,
      secretFilter: options?.secretFilter,
    }

    this.entries.set(agentId, entry)
    entry.logger?.info('subagent_spawned', {
      agentId,
      sessionId: entry.sessionId,
      label: entry.label,
      role: entry.role,
      mode: entry.mode,
      depth: entry.depth,
      traceSpanId: entry.traceSpanId,
    })
    void runAgentEntry(entry, {
      resolveWaiters: (resolvedEntry) => this.resolveWaiters(resolvedEntry),
      resolveReadyWaiters: (resolvedEntry) => this.resolveReadyWaiters(resolvedEntry),
    })

    return { agentId, label }
  }

  async waitAny(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, AgentStatus>
    timedOut: boolean
  }> {
    return waitForAgents(ids, {
      entries: this.entries,
      logger: this.logger,
      timeoutMs,
      waitAll: false,
    })
  }

  async waitAll(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, AgentStatus>
    timedOut: boolean
  }> {
    return waitForAgents(ids, {
      entries: this.entries,
      logger: this.logger,
      timeoutMs,
      waitAll: true,
    })
  }

  async waitReady(
    ids: string[],
    timeoutMs?: number,
    waitAll = false,
  ): Promise<{
    statuses: Record<string, AgentStatus>
    timedOut: boolean
  }> {
    return waitForAgents(ids, {
      entries: this.entries,
      logger: this.logger,
      timeoutMs,
      waitAll,
      isSatisfied: (entry) => entry.state === 'waiting' || this.isTerminal(entry),
      waitForEntry: waitForReadyOrTerminalAgent,
    })
  }

  getStatus(agentId: string): AgentStatus | undefined {
    const entry = this.entries.get(agentId)
    return entry ? this.buildStatus(entry) : undefined
  }

  getOutput(agentId: string): string | undefined {
    return this.entries.get(agentId)?.output
  }

  getTraceSpanId(agentId: string): string | undefined {
    return this.entries.get(agentId)?.traceSpanId
  }

  getSnapshot(): AgentSnapshot[] {
    return Array.from(this.entries.values()).map(buildAgentSnapshot)
  }

  restoreSnapshot(entries: AgentSnapshot[]): void {
    for (const snapshot of entries) {
      this.entries.set(snapshot.id, restoreAgentSnapshot(snapshot))
    }
  }

  sendInput(
    agentId: string,
    message: string,
    options?: { interrupt?: boolean },
  ): { success: boolean; error?: string } {
    return sendAgentInput({
      entries: this.entries,
      logger: this.logger,
      agentId,
      message,
      interrupt: options?.interrupt,
    })
  }

  getAgentInfo(
    agentId: string,
  ): { label: string; role?: string; status: { state: string } } | undefined {
    const entry = this.entries.get(agentId)
    if (!entry) return undefined
    return {
      label: entry.label,
      role: entry.role,
      status: { state: entry.state },
    }
  }

  close(agentId: string): AgentStatus | undefined {
    return closeAgentEntry({
      entries: this.entries,
      logger: this.logger,
      agentId,
      resolveWaiters: (entry) => this.resolveWaiters(entry),
    })
  }

  listAgents(): AgentListItem[] {
    return Array.from(this.entries.values()).map((entry) => buildAgentListItem(entry))
  }

  private resolveWaiters(entry: AgentEntry): void {
    for (const resolve of entry.waiters) resolve()
    entry.waiters.clear()
    this.resolveReadyWaiters(entry)
  }

  private resolveReadyWaiters(entry: AgentEntry): void {
    for (const resolve of entry.readyWaiters) resolve()
    entry.readyWaiters.clear()
  }

  private buildStatus(entry: AgentEntry): AgentStatus {
    return buildAgentStatus(entry)
  }

  private isTerminal(entry: AgentEntry): boolean {
    return isTerminalAgentEntry(entry)
  }
}

interface AgentEntryRunnerOptions {
  resolveWaiters(entry: AgentEntry): void
  resolveReadyWaiters(entry: AgentEntry): void
}

async function runAgentEntry(entry: AgentEntry, options: AgentEntryRunnerOptions): Promise<void> {
  try {
    if (entry.mode === 'interactive') {
      await runInteractiveEntry(entry, options)
    } else {
      await runStandardEntry(entry)
    }
  } catch (error) {
    if (entry.state !== 'closed') {
      entry.error = filterSensitive(entry, toErrorMessage(error))
      entry.state = 'failed'
      entry.endedAt = Date.now()
      failAgentTraceSpan(entry)
      entry.logger?.error('subagent_failed', {
        agentId: entry.id,
        sessionId: entry.sessionId,
        label: entry.label,
        role: entry.role,
        durationMs: getAgentElapsedMs(entry),
        traceSpanId: entry.traceSpanId,
        error: entry.error,
      })
    }
  } finally {
    entry.agent = undefined
    entry.context = undefined
    entry.instruction = ''
    if (entry.inputSignal) {
      entry.inputSignal.reject(new Error('Agent entry finalized'))
      entry.inputSignal = undefined
    }
    entry.messageQueue = []
    entry.interruptFlag = false
    if (entry.state !== 'closed') {
      entry.endedAt ??= Date.now()
    }
    options.resolveWaiters(entry)
  }
}

function filterSensitive(entry: AgentEntry, value: string): string {
  return entry.secretFilter ? entry.secretFilter.filter(value) : value
}

function extractOutput(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!lastAssistant) return ''

  return lastAssistant.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function runStandardEntry(entry: AgentEntry): Promise<void> {
  const messages = await entry.agent?.run(
    entry.context as AgentContext,
    entry.instruction,
    undefined,
    undefined,
    undefined,
    () => entry.interruptFlag,
    () => drainQueuedInput(entry),
  )
  if (!isClosed(entry)) {
    entry.output = filterSensitive(entry, extractOutput(messages ?? []))
    entry.state = 'completed'
    entry.endedAt = Date.now()
    completeAgentTraceSpan(entry)
    entry.logger?.info('subagent_completed', {
      agentId: entry.id,
      sessionId: entry.sessionId,
      label: entry.label,
      role: entry.role,
      durationMs: getAgentElapsedMs(entry),
      traceSpanId: entry.traceSpanId,
      outputSummary: entry.output.slice(0, 200),
    })
  }
}

async function runInteractiveEntry(
  entry: AgentEntry,
  options: AgentEntryRunnerOptions,
): Promise<void> {
  const context = entry.context as AgentContext
  let currentInstruction = entry.instruction
  let turnCount = 0

  while (true) {
    entry.state = 'running'
    turnCount++

    const messages = await entry.agent?.run(
      context,
      currentInstruction,
      undefined,
      undefined,
      undefined,
      () => entry.interruptFlag,
      () => drainQueuedInput(entry),
    )

    if (isClosed(entry)) return

    entry.output = filterSensitive(entry, extractOutput(messages ?? []))
    if (messages && messages.length > 0) {
      context.conversationHistory.push(...messages)
    }

    entry.logger?.info('subagent_interactive_turn_complete', {
      agentId: entry.id,
      sessionId: entry.sessionId,
      label: entry.label,
      role: entry.role,
      turnCount,
      traceSpanId: entry.traceSpanId,
    })

    if (entry.messageQueue.length > 0) {
      currentInstruction = formatQueuedAsInstruction(drainQueuedInput(entry))
      continue
    }

    try {
      const inputMessages = await waitForInput(entry, options)
      currentInstruction = formatQueuedAsInstruction(inputMessages)
    } catch {
      return
    }
  }
}

function waitForInput(
  entry: AgentEntry,
  options: AgentEntryRunnerOptions,
): Promise<QueuedMessage[]> {
  return new Promise<QueuedMessage[]>((resolve, reject) => {
    entry.inputSignal = { resolve, reject }

    if (entry.messageQueue.length > 0) {
      const queuedMessages = drainQueuedInput(entry)
      entry.inputSignal = undefined
      resolve(queuedMessages)
      return
    }

    entry.state = 'waiting'
    options.resolveReadyWaiters(entry)
  })
}

function drainQueuedInput(entry: AgentEntry): QueuedMessage[] {
  const queuedMessages = [...entry.messageQueue]
  entry.messageQueue = []
  entry.interruptFlag = false
  return queuedMessages
}

function formatQueuedAsInstruction(messages: QueuedMessage[]): string {
  if (messages.length === 1) {
    return messages[0]?.content ?? ''
  }

  return messages.map((message) => `[${message.timestamp}] ${message.content}`).join('\n')
}

function isClosed(entry: AgentEntry): boolean {
  return entry.state === 'closed'
}

interface SendAgentInputOptions {
  entries: Map<string, AgentEntry>
  logger?: ToolLogger
  agentId: string
  message: string
  interrupt?: boolean
}

function sendAgentInput({
  entries,
  logger,
  agentId,
  message,
  interrupt = false,
}: SendAgentInputOptions): { success: boolean; error?: string } {
  const entry = entries.get(agentId)
  if (!entry) {
    logger?.warn('subagent_input_rejected', {
      agentId,
      reason: 'not_found',
    })
    return { success: false, error: `Sub-agent "${agentId}" was not found.` }
  }

  if (isTerminalAgentEntry(entry)) {
    entry.logger?.warn('subagent_input_rejected', {
      agentId,
      label: entry.label,
      state: entry.state,
      traceSpanId: entry.traceSpanId,
      reason: 'terminal_state',
    })
    return {
      success: false,
      error: `Sub-agent "${agentId}" is already in terminal state "${entry.state}".`,
    }
  }

  const trimmedMessage = message.trim()
  if (!trimmedMessage) {
    entry.logger?.warn('subagent_input_rejected', {
      agentId,
      label: entry.label,
      traceSpanId: entry.traceSpanId,
      reason: 'empty_message',
    })
    return { success: false, error: 'Message is required.' }
  }

  entry.messageQueue.push({
    content: trimmedMessage,
    timestamp: new Date().toISOString(),
  })
  if (interrupt) {
    entry.interruptFlag = true
  }

  if (entry.inputSignal) {
    const queuedMessages = [...entry.messageQueue]
    entry.messageQueue = []
    entry.interruptFlag = false
    entry.inputSignal.resolve(queuedMessages)
    entry.inputSignal = undefined
    entry.state = 'running'
  }

  entry.logger?.info('subagent_input_sent', {
    agentId,
    sessionId: entry.sessionId,
    label: entry.label,
    interrupt,
    queueLength: entry.messageQueue.length,
    traceSpanId: entry.traceSpanId,
  })

  return { success: true }
}

interface CloseAgentEntryOptions {
  entries: Map<string, AgentEntry>
  logger?: ToolLogger
  agentId: string
  resolveWaiters(entry: AgentEntry): void
}

function closeAgentEntry({
  entries,
  logger,
  agentId,
  resolveWaiters,
}: CloseAgentEntryOptions): AgentStatus | undefined {
  const entry = entries.get(agentId)
  if (!entry) {
    logger?.warn('subagent_close_missing', {
      agentId,
    })
    return undefined
  }

  const previousState = entry.state
  if (entry.state !== 'closed') {
    if (entry.inputSignal) {
      entry.inputSignal.reject(new Error('Agent closed'))
      entry.inputSignal = undefined
    }
    entry.state = 'closed'
    entry.endedAt ??= Date.now()
    if (previousState === 'running' || previousState === 'waiting') {
      closeAgentTraceSpan(entry)
    }
    entry.agent = undefined
    entry.context = undefined
    entry.instruction = ''
    entry.messageQueue = []
    entry.interruptFlag = false
    resolveWaiters(entry)
    entry.logger?.info('subagent_closed', {
      agentId,
      sessionId: entry.sessionId,
      label: entry.label,
      role: entry.role,
      previousState,
      durationMs: getAgentElapsedMs(entry),
      traceSpanId: entry.traceSpanId,
    })
  }

  return buildAgentStatus(entry)
}

function getAgentElapsedMs(entry: AgentEntry, at = Date.now()): number {
  return Math.max(0, (entry.endedAt ?? at) - entry.startedAt)
}

function isTerminalAgentEntry(entry: AgentEntry): boolean {
  return entry.state === 'completed' || entry.state === 'failed' || entry.state === 'closed'
}

function buildAgentStatus(entry: AgentEntry, at = Date.now()): AgentStatus {
  const status: AgentStatus = {
    state: entry.state,
    label: entry.label,
    depth: entry.depth,
    elapsedMs: getAgentElapsedMs(entry, at),
  }
  if (entry.role) status.role = entry.role
  if (entry.model) status.model = entry.model
  if (entry.mode === 'interactive') status.mode = entry.mode
  if (entry.output !== undefined) status.output = entry.output
  if (entry.error) status.error = entry.error
  return status
}

function buildAgentListItem(entry: AgentEntry, at = Date.now()): AgentListItem {
  return {
    id: entry.id,
    label: entry.label,
    role: entry.role,
    status: { state: entry.state },
    depth: entry.depth,
    elapsedMs: getAgentElapsedMs(entry, at),
  }
}

function buildAgentSnapshot(entry: AgentEntry): AgentSnapshot {
  return {
    id: entry.id,
    label: entry.label,
    role: entry.role,
    ...(entry.model ? { model: entry.model } : {}),
    mode: entry.mode === 'interactive' ? entry.mode : undefined,
    state: entry.state,
    instruction: entry.originalInstruction,
    output: entry.output,
    error: entry.error,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
  }
}

function restoreAgentSnapshot(snapshot: AgentSnapshot, restoredAt = Date.now()): AgentEntry {
  if (snapshot.state === 'running') {
    return {
      id: snapshot.id,
      label: snapshot.label,
      role: snapshot.role,
      model: snapshot.model,
      mode: snapshot.mode ?? 'standard',
      depth: 1,
      state: 'failed',
      startedAt: snapshot.startedAt,
      endedAt: restoredAt,
      instruction: '',
      originalInstruction: snapshot.instruction,
      output: undefined,
      error: 'Process restarted while agent was running',
      messageQueue: [],
      interruptFlag: false,
      inputSignal: undefined,
      waiters: new Set(),
      readyWaiters: new Set(),
    }
  }

  if (snapshot.state === 'waiting') {
    return {
      id: snapshot.id,
      label: snapshot.label,
      role: snapshot.role,
      model: snapshot.model,
      mode: snapshot.mode ?? 'interactive',
      depth: 1,
      state: 'failed',
      startedAt: snapshot.startedAt,
      endedAt: restoredAt,
      instruction: '',
      originalInstruction: snapshot.instruction,
      output: snapshot.output,
      error: 'Process restarted while agent was waiting',
      messageQueue: [],
      interruptFlag: false,
      inputSignal: undefined,
      waiters: new Set(),
      readyWaiters: new Set(),
    }
  }

  return {
    id: snapshot.id,
    label: snapshot.label,
    role: snapshot.role,
    model: snapshot.model,
    mode: snapshot.mode ?? 'standard',
    depth: 1,
    state: snapshot.state,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    instruction: '',
    originalInstruction: snapshot.instruction,
    output: snapshot.output,
    error: snapshot.error,
    messageQueue: [],
    interruptFlag: false,
    inputSignal: undefined,
    waiters: new Set(),
    readyWaiters: new Set(),
  }
}

interface AgentWaitOptions {
  entries: Map<string, AgentEntry>
  logger?: ToolLogger
  waitAll: boolean
  timeoutMs?: number
  isSatisfied?: (entry: AgentEntry) => boolean
  waitForEntry?: (entry: AgentEntry) => Promise<void>
}

async function waitForAgents(
  ids: string[],
  options: AgentWaitOptions,
): Promise<{
  statuses: Record<string, AgentStatus>
  timedOut: boolean
}> {
  const requestedIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (requestedIds.length === 0) {
    return { statuses: {}, timedOut: false }
  }

  const knownEntries = requestedIds
    .map((id) => options.entries.get(id))
    .filter((entry): entry is AgentEntry => !!entry)

  const isSatisfied = options.isSatisfied ?? isTerminalAgentEntry
  const waitForEntry = options.waitForEntry ?? waitForTerminalAgent

  const alreadySatisfied = options.waitAll
    ? knownEntries.every((entry) => isSatisfied(entry))
    : knownEntries.some((entry) => isSatisfied(entry))

  if (alreadySatisfied || knownEntries.length === 0) {
    const result = {
      statuses: buildAgentStatuses(requestedIds, options.entries),
      timedOut: false,
    }
    logAgentWaitResult({ ...options, requestedIds, knownEntries, ...result })
    return result
  }

  const waitPromise = options.waitAll
    ? Promise.all(knownEntries.map((entry) => waitForEntry(entry))).then(() => 'done')
    : Promise.race(knownEntries.map((entry) => waitForEntry(entry))).then(() => 'done')

  let timedOut = false
  if (typeof options.timeoutMs === 'number' && options.timeoutMs >= 0) {
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      waitPromise,
      new Promise<'timeout'>((resolve) => {
        waitTimer = setTimeout(() => resolve('timeout'), options.timeoutMs)
      }),
    ])
    // 等待先完成时清掉超时定时器，避免悬挂 timer 持有事件循环引用。
    if (outcome !== 'timeout' && waitTimer) clearTimeout(waitTimer)
    timedOut = outcome === 'timeout'
  } else {
    await waitPromise
  }

  const result = {
    statuses: buildAgentStatuses(requestedIds, options.entries),
    timedOut,
  }
  logAgentWaitResult({ ...options, requestedIds, knownEntries, ...result })
  return result
}

function waitForTerminalAgent(entry: AgentEntry): Promise<void> {
  if (isTerminalAgentEntry(entry)) return Promise.resolve()

  return new Promise((resolve) => {
    entry.waiters.add(resolve)
  })
}

function waitForReadyOrTerminalAgent(entry: AgentEntry): Promise<void> {
  if (entry.state === 'waiting' || isTerminalAgentEntry(entry)) return Promise.resolve()

  return new Promise((resolve) => {
    entry.readyWaiters.add(resolve)
  })
}

function buildAgentStatuses(
  ids: string[],
  entries: Map<string, AgentEntry>,
): Record<string, AgentStatus> {
  const statuses: Record<string, AgentStatus> = {}
  for (const id of ids) {
    const entry = entries.get(id)
    statuses[id] = entry ? buildAgentStatus(entry) : { state: 'not_found' }
  }
  return statuses
}

function logAgentWaitResult(options: {
  requestedIds: string[]
  knownEntries: AgentEntry[]
  entries: Map<string, AgentEntry>
  logger?: ToolLogger
  statuses: Record<string, AgentStatus>
  timedOut: boolean
  waitAll: boolean
  timeoutMs?: number
}): void {
  const loggers = new Set<ToolLogger>()
  if (options.logger) {
    loggers.add(options.logger)
  }
  for (const entry of options.knownEntries) {
    if (entry.logger) {
      loggers.add(entry.logger)
    }
  }

  const stateByAgent = Object.fromEntries(
    options.requestedIds.map((id) => [id, options.statuses[id]?.state ?? 'not_found']),
  )
  const traceSpanIds = Object.fromEntries(
    options.requestedIds.map((id) => [id, options.entries.get(id)?.traceSpanId]),
  )

  for (const logger of loggers) {
    logger.info('subagent_wait_complete', {
      agentIds: options.requestedIds,
      waitAll: options.waitAll,
      timeoutMs: options.timeoutMs,
      timedOut: options.timedOut,
      stateByAgent,
      traceSpanIds,
    })
  }
}

function completeAgentTraceSpan(entry: AgentEntry): void {
  if (!entry.tracer || !entry.traceSpanId) return

  entry.tracer.updateSpan(entry.traceSpanId, {
    data: {
      success: true,
      durationMs: getAgentElapsedMs(entry),
      output: entry.output?.slice(0, 8000) ?? '',
      outputSummary: entry.output?.slice(0, 200) ?? '',
    },
  })
  entry.tracer.endSpan(entry.traceSpanId, 'success')
}

function failAgentTraceSpan(entry: AgentEntry): void {
  if (!entry.tracer || !entry.traceSpanId) return

  entry.tracer.updateSpan(entry.traceSpanId, {
    data: {
      success: false,
      durationMs: getAgentElapsedMs(entry),
      error: entry.error,
    },
  })
  entry.tracer.endSpan(entry.traceSpanId, 'error', {
    error: entry.error,
  })
}

function closeAgentTraceSpan(entry: AgentEntry): void {
  if (!entry.tracer || !entry.traceSpanId) return

  entry.tracer.updateSpan(entry.traceSpanId, {
    data: {
      success: false,
      closedByParent: true,
      durationMs: getAgentElapsedMs(entry),
    },
  })
  entry.tracer.endSpan(entry.traceSpanId, 'error', {
    error: 'Closed by parent',
  })
}
