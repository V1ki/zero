import type { Message, SecretFilter, ToolLogger, ToolTracer } from '@zero-os/shared'
import { generatePrefixedId, toErrorMessage } from '@zero-os/shared'
import type { AgentContext } from './agent'
import type { QueuedMessage } from './queue'

export type AgentState = 'running' | 'completed' | 'failed' | 'closed'

export interface AgentSnapshot {
  id: string
  label: string
  role?: string
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
  waiters: Set<() => void>
  traceSpanId?: string
  tracer?: ToolTracer
  logger?: ToolLogger
  secretFilter?: SecretFilter
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
      if (entry.state === 'running') count++
    }
    return count
  }

  spawn(
    agent: ControlledAgent,
    context: AgentContext,
    instruction: string,
    options?: {
      label?: string
      role?: string
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
      depth: Math.max(1, options?.depth ?? 1),
      state: 'running',
      startedAt: Date.now(),
      instruction,
      originalInstruction: instruction,
      agent,
      context,
      messageQueue: [],
      interruptFlag: false,
      waiters: new Set(),
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
      depth: entry.depth,
      traceSpanId: entry.traceSpanId,
    })
    void this.runEntry(entry)

    return { agentId, label }
  }

  async waitAny(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }> {
    return this.wait(ids, timeoutMs, false)
  }

  async waitAll(
    ids: string[],
    timeoutMs?: number,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }> {
    return this.wait(ids, timeoutMs, true)
  }

  getStatus(agentId: string): { state: string; [key: string]: unknown } | undefined {
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
    return Array.from(this.entries.values()).map((entry) => ({
      id: entry.id,
      label: entry.label,
      role: entry.role,
      state: entry.state,
      instruction: entry.originalInstruction,
      output: entry.output,
      error: entry.error,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    }))
  }

  restoreSnapshot(entries: AgentSnapshot[]): void {
    for (const snapshot of entries) {
      if (snapshot.state === 'running') {
        this.entries.set(snapshot.id, {
          id: snapshot.id,
          label: snapshot.label,
          role: snapshot.role,
          depth: 1,
          state: 'failed',
          startedAt: snapshot.startedAt,
          endedAt: Date.now(),
          instruction: '',
          originalInstruction: snapshot.instruction,
          output: undefined,
          error: 'Process restarted while agent was running',
          messageQueue: [],
          interruptFlag: false,
          waiters: new Set(),
        })
        continue
      }

      this.entries.set(snapshot.id, {
        id: snapshot.id,
        label: snapshot.label,
        role: snapshot.role,
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
        waiters: new Set(),
      })
    }
  }

  sendInput(
    agentId: string,
    message: string,
    options?: { interrupt?: boolean },
  ): { success: boolean; error?: string } {
    const entry = this.entries.get(agentId)
    if (!entry) {
      this.logger?.warn('subagent_input_rejected', {
        agentId,
        reason: 'not_found',
      })
      return { success: false, error: `Sub-agent "${agentId}" was not found.` }
    }
    if (this.isTerminal(entry)) {
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
    if (options?.interrupt) {
      entry.interruptFlag = true
    }

    entry.logger?.info('subagent_input_sent', {
      agentId,
      sessionId: entry.sessionId,
      label: entry.label,
      interrupt: options?.interrupt ?? false,
      queueLength: entry.messageQueue.length,
      traceSpanId: entry.traceSpanId,
    })

    return { success: true }
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

  close(agentId: string): { state: string; [key: string]: unknown } | undefined {
    const entry = this.entries.get(agentId)
    if (!entry) {
      this.logger?.warn('subagent_close_missing', {
        agentId,
      })
      return undefined
    }

    const previousState = entry.state
    if (entry.state !== 'closed') {
      entry.state = 'closed'
      entry.endedAt ??= Date.now()
      if (previousState === 'running') {
        this.endSpanForClosedEntry(entry)
      }
      entry.agent = undefined
      entry.context = undefined
      entry.instruction = ''
      entry.messageQueue = []
      entry.interruptFlag = false
      this.resolveWaiters(entry)
      entry.logger?.info('subagent_closed', {
        agentId,
        sessionId: entry.sessionId,
        label: entry.label,
        role: entry.role,
        previousState,
        durationMs: this.getElapsedMs(entry),
        traceSpanId: entry.traceSpanId,
      })
    }

    return this.buildStatus(entry)
  }

  listAgents(): Array<{
    id: string
    label: string
    role?: string
    status: { state: string }
    depth: number
    elapsedMs: number
  }> {
    return Array.from(this.entries.values()).map((entry) => ({
      id: entry.id,
      label: entry.label,
      role: entry.role,
      status: { state: entry.state },
      depth: entry.depth,
      elapsedMs: this.getElapsedMs(entry),
    }))
  }

  private async wait(
    ids: string[],
    timeoutMs: number | undefined,
    waitAll: boolean,
  ): Promise<{
    statuses: Record<string, { state: string; [key: string]: unknown }>
    timedOut: boolean
  }> {
    const requestedIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
    if (requestedIds.length === 0) {
      return { statuses: {}, timedOut: false }
    }

    const knownEntries = requestedIds
      .map((id) => this.entries.get(id))
      .filter((entry): entry is AgentEntry => !!entry)

    const alreadySatisfied = waitAll
      ? knownEntries.every((entry) => this.isTerminal(entry))
      : knownEntries.some((entry) => this.isTerminal(entry))

    if (alreadySatisfied || knownEntries.length === 0) {
      const result = {
        statuses: this.buildStatuses(requestedIds),
        timedOut: false,
      }
      this.logWaitResult(requestedIds, knownEntries, result.statuses, false, waitAll, timeoutMs)
      return result
    }

    const waitPromise = waitAll
      ? Promise.all(knownEntries.map((entry) => this.waitForTerminal(entry))).then(() => 'done')
      : Promise.race(knownEntries.map((entry) => this.waitForTerminal(entry))).then(() => 'done')

    let timedOut = false
    if (typeof timeoutMs === 'number' && timeoutMs >= 0) {
      const outcome = await Promise.race([
        waitPromise,
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), timeoutMs)
        }),
      ])
      timedOut = outcome === 'timeout'
    } else {
      await waitPromise
    }

    const result = {
      statuses: this.buildStatuses(requestedIds),
      timedOut,
    }
    this.logWaitResult(requestedIds, knownEntries, result.statuses, timedOut, waitAll, timeoutMs)
    return result
  }

  private waitForTerminal(entry: AgentEntry): Promise<void> {
    if (this.isTerminal(entry)) return Promise.resolve()

    return new Promise((resolve) => {
      entry.waiters.add(resolve)
    })
  }

  private async runEntry(entry: AgentEntry): Promise<void> {
    try {
      const messages = await entry.agent?.run(
        entry.context as AgentContext,
        entry.instruction,
        undefined,
        undefined,
        undefined,
        () => entry.interruptFlag,
        () => {
          const messages = [...entry.messageQueue]
          entry.messageQueue = []
          entry.interruptFlag = false
          return messages
        },
      )
      if (entry.state !== 'closed') {
        entry.output = this.filterSensitive(entry, this.extractOutput(messages ?? []))
        entry.state = 'completed'
        entry.endedAt = Date.now()
        this.completeSpan(entry)
        entry.logger?.info('subagent_completed', {
          agentId: entry.id,
          sessionId: entry.sessionId,
          label: entry.label,
          role: entry.role,
          durationMs: this.getElapsedMs(entry),
          traceSpanId: entry.traceSpanId,
          outputSummary: entry.output.slice(0, 200),
        })
      }
    } catch (error) {
      if (entry.state !== 'closed') {
        entry.error = this.filterSensitive(entry, toErrorMessage(error))
        entry.state = 'failed'
        entry.endedAt = Date.now()
        this.failSpan(entry)
        entry.logger?.error('subagent_failed', {
          agentId: entry.id,
          sessionId: entry.sessionId,
          label: entry.label,
          role: entry.role,
          durationMs: this.getElapsedMs(entry),
          traceSpanId: entry.traceSpanId,
          error: entry.error,
        })
      }
    } finally {
      entry.agent = undefined
      entry.context = undefined
      entry.instruction = ''
      entry.messageQueue = []
      entry.interruptFlag = false
      if (entry.state !== 'closed') {
        entry.endedAt ??= Date.now()
      }
      this.resolveWaiters(entry)
    }
  }

  private resolveWaiters(entry: AgentEntry): void {
    for (const resolve of entry.waiters) resolve()
    entry.waiters.clear()
  }

  private buildStatuses(ids: string[]): Record<string, { state: string; [key: string]: unknown }> {
    const statuses: Record<string, { state: string; [key: string]: unknown }> = {}
    for (const id of ids) {
      const entry = this.entries.get(id)
      statuses[id] = entry ? this.buildStatus(entry) : { state: 'not_found' }
    }
    return statuses
  }

  private buildStatus(entry: AgentEntry): { state: string; [key: string]: unknown } {
    const status: { state: string; [key: string]: unknown } = {
      state: entry.state,
      label: entry.label,
      depth: entry.depth,
      elapsedMs: this.getElapsedMs(entry),
    }
    if (entry.role) status.role = entry.role
    if (entry.output !== undefined) status.output = entry.output
    if (entry.error) status.error = entry.error
    return status
  }

  private getElapsedMs(entry: AgentEntry): number {
    return Math.max(0, (entry.endedAt ?? Date.now()) - entry.startedAt)
  }

  private isTerminal(entry: AgentEntry): boolean {
    return entry.state === 'completed' || entry.state === 'failed' || entry.state === 'closed'
  }

  private filterSensitive(entry: AgentEntry, value: string): string {
    return entry.secretFilter ? entry.secretFilter.filter(value) : value
  }

  private completeSpan(entry: AgentEntry): void {
    if (!entry.tracer || !entry.traceSpanId) return

    entry.tracer.updateSpan(entry.traceSpanId, {
      data: {
        success: true,
        durationMs: this.getElapsedMs(entry),
        output: entry.output?.slice(0, 8000) ?? '',
        outputSummary: entry.output?.slice(0, 200) ?? '',
      },
    })
    entry.tracer.endSpan(entry.traceSpanId, 'success')
  }

  private failSpan(entry: AgentEntry): void {
    if (!entry.tracer || !entry.traceSpanId) return

    entry.tracer.updateSpan(entry.traceSpanId, {
      data: {
        success: false,
        durationMs: this.getElapsedMs(entry),
        error: entry.error,
      },
    })
    entry.tracer.endSpan(entry.traceSpanId, 'error', {
      error: entry.error,
    })
  }

  private endSpanForClosedEntry(entry: AgentEntry): void {
    if (!entry.tracer || !entry.traceSpanId) return

    entry.tracer.updateSpan(entry.traceSpanId, {
      data: {
        success: false,
        closedByParent: true,
        durationMs: this.getElapsedMs(entry),
      },
    })
    entry.tracer.endSpan(entry.traceSpanId, 'error', {
      error: 'Closed by parent',
    })
  }

  private logWaitResult(
    requestedIds: string[],
    entries: AgentEntry[],
    statuses: Record<string, { state: string; [key: string]: unknown }>,
    timedOut: boolean,
    waitAll: boolean,
    timeoutMs?: number,
  ): void {
    const loggers = new Set<ToolLogger>()
    if (this.logger) {
      loggers.add(this.logger)
    }
    for (const entry of entries) {
      if (entry.logger) {
        loggers.add(entry.logger)
      }
    }

    const stateByAgent = Object.fromEntries(
      requestedIds.map((id) => [id, statuses[id]?.state ?? 'not_found']),
    )
    const traceSpanIds = Object.fromEntries(
      requestedIds.map((id) => [id, this.entries.get(id)?.traceSpanId]),
    )

    for (const logger of loggers) {
      logger.info('subagent_wait_complete', {
        agentIds: requestedIds,
        waitAll,
        timeoutMs,
        timedOut,
        stateByAgent,
        traceSpanIds,
      })
    }
  }

  private extractOutput(messages: Message[]): string {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!lastAssistant) return ''

    return lastAssistant.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
}
