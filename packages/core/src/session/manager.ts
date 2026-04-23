import {
  type MemoryRepository,
  SESSION_MEMORY_PROMPT,
  shouldEvaluateSessionMemory,
} from '@zero-os/memory'
import type { ModelRouter } from '@zero-os/model'
import type { MetricsDB, SessionDB, SessionRow } from '@zero-os/observe'
import {
  generateSessionId,
  type ChannelSessionBinding,
  type Message,
  type Session as SessionData,
  type SessionPlacement,
  type SessionSource,
} from '@zero-os/shared'
import type { AgentSnapshot } from '../agent/agent-control'
import type { AgentConfig } from '../agent/agent'
import type { ToolRegistry } from '../tool/registry'
import { Session, type SessionDeps } from './session'

interface SessionCreateOptions {
  channelId?: string
  channelName?: string
  initialModel?: string
  modelScope?: {
    channelId: string
    channelName?: string
  }
}

export interface InterruptedSessionRef {
  sessionId: string
  source: SessionSource
  channelId?: string
  channelName?: string
  subAgents?: AgentSnapshot[]
}

/**
 * Manages current channel bindings plus the in-memory session cache.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map()
  private currentBindings: Map<string, ChannelSessionBinding> = new Map()
  private channelModelPreferences: Map<string, string> = new Map()
  private pendingBackgroundEvaluations = new Set<string>()
  private modelRouter: ModelRouter
  private toolRegistry: ToolRegistry
  private deps: SessionDeps
  private sessionDb?: SessionDB

  constructor(
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    deps: SessionDeps = {},
    sessionDb?: SessionDB,
  ) {
    this.modelRouter = modelRouter
    this.toolRegistry = toolRegistry
    this.deps = deps
    this.sessionDb = sessionDb
    this.loadChannelModelPreferences()
  }

  create(source: SessionSource, options: SessionCreateOptions = {}): Session {
    const modelScope = options.modelScope ?? this.getDefaultModelScope(source)
    const initialModel =
      options.initialModel ??
      this.getPreferredModel(source, modelScope?.channelId, modelScope?.channelName)
    const sessionId = this.allocateSessionId(source)
    const sessionDeps = this.createSessionDeps(source, modelScope)
    const session = new Session(
      source,
      this.modelRouter,
      this.toolRegistry,
      sessionDeps,
      initialModel,
      sessionId,
    )

    if (options.channelId) {
      session.ensureChannelContext(options.channelId, options.channelName)
    } else if (options.channelName) {
      session.data.channelName = options.channelName
    }

    this.sessions.set(session.data.id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  listCurrent(): Session[] {
    const currentIds = new Set(this.listCurrentBindings().map((binding) => binding.sessionId))
    return Array.from(currentIds)
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is Session => Boolean(session))
  }

  listAll(): Session[] {
    return Array.from(this.sessions.values())
  }

  listCurrentBindings(): ChannelSessionBinding[] {
    return Array.from(this.currentBindings.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  getCurrentBinding(
    source: SessionSource,
    channelId: string,
    channelName?: string,
  ): ChannelSessionBinding | undefined {
    return this.currentBindings.get(this.getChannelSessionKey(source, channelId, channelName))
  }

  isCurrentSessionId(sessionId: string): boolean {
    return Array.from(this.currentBindings.values()).some((binding) => binding.sessionId === sessionId)
  }

  isCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    channelName: string | undefined,
    sessionId: string,
  ): boolean {
    return this.getCurrentBinding(source, channelId, channelName)?.sessionId === sessionId
  }

  getCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
  ): Session | undefined {
    const binding = this.getCurrentBinding(source, channelId, channelName)
    if (!binding) return undefined
    return this.restoreSessionById(binding.sessionId) ?? undefined
  }

  getPreferredModel(source: SessionSource, channelId?: string, channelName?: string): string {
    const scope = this.getModelScope(source, channelId, channelName)
    if (scope) {
      const key = this.getChannelSessionKey(source, scope.channelId, scope.channelName)
      const preferred = this.channelModelPreferences.get(key)
      if (preferred) return preferred
    }

    return this.modelRouter.getDefaultModelLabel()
  }

  setPreferredModel(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
  ): string {
    const normalized = this.modelRouter.normalizeModelReference(model) ?? model
    const key = this.getChannelSessionKey(source, channelId, channelName)
    this.channelModelPreferences.set(key, normalized)
    this.sessionDb?.saveChannelModel(source, channelId, normalized, channelName)
    return normalized
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.deps.taskClosureModel = taskClosureModel
    for (const session of this.sessions.values()) {
      session.setTaskClosureModel(taskClosureModel)
    }
  }

  private createSessionDeps(
    source: SessionSource,
    modelScope?: { channelId: string; channelName?: string },
  ): SessionDeps {
    if (!modelScope) return this.deps

    return {
      ...this.deps,
      persistModelPreference: (model: string) => {
        this.setPreferredModel(source, modelScope.channelId, model, modelScope.channelName)
      },
    }
  }

  private getDefaultModelScope(
    source: SessionSource,
  ): { channelId: string; channelName?: string } | undefined {
    if (source === 'web') {
      return { channelId: 'default', channelName: 'web' }
    }
    return undefined
  }

  private getModelScope(
    source: SessionSource,
    channelId?: string,
    channelName?: string,
  ): { channelId: string; channelName?: string } | undefined {
    if (channelId) {
      return { channelId, channelName }
    }
    return this.getDefaultModelScope(source)
  }

  private loadChannelModelPreferences(): void {
    if (!this.sessionDb) return

    for (const row of this.sessionDb.loadChannelModels()) {
      const normalized = this.modelRouter.normalizeModelReference(row.model) ?? row.model
      const key = this.getChannelSessionKey(row.source, row.channelId, row.channelName)
      this.channelModelPreferences.set(key, normalized)
    }
  }

  private normalizeRow(row: SessionRow): SessionRow {
    return {
      ...row,
      currentModel: this.modelRouter.normalizeModelReference(row.currentModel) ?? row.currentModel,
      modelHistory: row.modelHistory.map((entry) => ({
        ...entry,
        model: this.modelRouter.normalizeModelReference(entry.model) ?? entry.model,
      })),
      reasoningEffort: row.reasoningEffort,
    }
  }

  private getChannelSessionKey(
    source: SessionSource,
    channelId: string,
    channelName?: string,
  ): string {
    return `${source}:${channelName ?? source}:${channelId}`
  }

  private allocateSessionId(source: SessionSource): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = generateSessionId(source)
      if (!this.sessions.has(id) && !this.sessionDb?.getSession(id)) {
        return id
      }
    }

    throw new Error(
      `Unable to allocate unique session ID for source "${source}" after 16 attempts.`,
    )
  }

  private restoreSession(row: SessionRow): Session {
    const existing = this.sessions.get(row.id)
    if (existing) return existing

    const normalizedRow = this.normalizeRow(row)
    const data: SessionData = {
      id: normalizedRow.id,
      createdAt: normalizedRow.createdAt,
      updatedAt: normalizedRow.updatedAt,
      source: normalizedRow.source,
      currentModel: normalizedRow.currentModel,
      reasoningEffort: normalizedRow.reasoningEffort,
      modelHistory: normalizedRow.modelHistory,
      summary: normalizedRow.summary,
      tags: normalizedRow.tags,
      channelName: normalizedRow.channelName,
      channelId: normalizedRow.channelId,
    }

    const messages = this.sessionDb?.loadSessionMessages(row.id) ?? []
    const modelScope = this.getModelScope(data.source, data.channelId, data.channelName)
    const session = Session.restore(
      data,
      messages,
      this.modelRouter,
      this.toolRegistry,
      this.createSessionDeps(data.source, modelScope),
      normalizedRow.systemPrompt,
    )

    if (normalizedRow.agentConfigJson) {
      try {
        const agentConfig = normalizeAgentConfig(normalizedRow.agentConfigJson)
        if (agentConfig) {
          session.initAgent(agentConfig)
        }
      } catch (error) {
        console.warn(`[SessionManager] Failed to restore agent for session ${row.id}:`, error)
      }
    }

    this.sessions.set(session.data.id, session)
    return session
  }

  private restoreSessionById(sessionId: string): Session | null {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const row = this.sessionDb?.getSession(sessionId)
    if (!row) return null
    return this.restoreSession(row)
  }

  private emitBindingEvent(
    event: 'binding_set' | 'binding_replaced' | 'binding_cleared' | 'session_backgrounded',
    binding: {
      sessionId: string
      source: SessionSource
      channelId: string
      channelName?: string
      previousSessionId?: string
      replacedBySessionId?: string
    },
  ): void {
    this.deps.bus?.emit('session:update', {
      sessionId: binding.sessionId,
      event,
      source: binding.source,
      channelId: binding.channelId,
      channelName: binding.channelName,
      previousSessionId: binding.previousSessionId ?? null,
      replacedBySessionId: binding.replacedBySessionId ?? null,
    })
  }

  private clearCurrentBinding(binding: ChannelSessionBinding): void {
    const key = this.getChannelSessionKey(binding.source, binding.channelId, binding.channelName)
    this.currentBindings.delete(key)
    this.sessionDb?.deleteBinding(binding.source, binding.channelId, binding.channelName)
    this.deps.observability?.syncSessionCurrentState(binding.sessionId, false)
    this.emitBindingEvent('binding_cleared', {
      sessionId: binding.sessionId,
      source: binding.source,
      channelId: binding.channelId,
      channelName: binding.channelName,
    })
  }

  private backgroundSession(
    session: Session,
    binding: { source: SessionSource; channelId: string; channelName?: string; sessionId: string },
  ): void {
    // Losing the current binding is the new handoff point: the old session becomes history-only
    // immediately, and any session-memory evaluation happens best-effort after its in-flight turn drains.
    this.deps.observability?.syncSessionCurrentState(session.data.id, false)
    this.emitBindingEvent('session_backgrounded', {
      sessionId: session.data.id,
      source: binding.source,
      channelId: binding.channelId,
      channelName: binding.channelName,
      replacedBySessionId: binding.sessionId,
    })

    const shouldEvaluate =
      session.isAgentInitialized() &&
      shouldEvaluateSessionMemory(session.getMessages(), Session.isTopLevelUserTurn)

    if (!shouldEvaluate || this.pendingBackgroundEvaluations.has(session.data.id)) {
      return
    }

    this.pendingBackgroundEvaluations.add(session.data.id)

    const runEvaluation = async () => {
      try {
        await session.evaluateSessionMemory(SESSION_MEMORY_PROMPT)
      } catch (error) {
        console.warn('[SessionMemory] evaluation failed:', error)
      } finally {
        this.pendingBackgroundEvaluations.delete(session.data.id)
      }
    }

    if (session.isTurnInProgress()) {
      void session
        .waitForTurnComplete()
        .then(runEvaluation)
        .catch((error) => {
          this.pendingBackgroundEvaluations.delete(session.data.id)
          console.warn('[SessionMemory] wait for turn completion failed:', error)
        })
      return
    }

    void runEvaluation()
  }

  private setCurrentBinding(
    source: SessionSource,
    channelId: string,
    session: Session,
    channelName?: string,
  ): { previousSessionId?: string } {
    const key = this.getChannelSessionKey(source, channelId, channelName)
    const previousBinding = this.currentBindings.get(key)
    const previousSessionId =
      previousBinding && previousBinding.sessionId !== session.data.id
        ? previousBinding.sessionId
        : undefined
    const updatedAt = new Date().toISOString()

    session.ensureChannelContext(channelId, channelName)

    const nextBinding: ChannelSessionBinding = {
      source,
      channelName,
      channelId,
      sessionId: session.data.id,
      updatedAt,
    }

    this.currentBindings.set(key, nextBinding)
    this.sessionDb?.saveBinding(source, channelId, session.data.id, channelName, updatedAt)
    this.deps.observability?.syncSessionCurrentState(session.data.id, true)

    if (previousBinding && previousBinding.sessionId !== session.data.id) {
      const previous = this.sessions.get(previousBinding.sessionId)
      this.deps.observability?.syncSessionCurrentState(previousBinding.sessionId, false)
      this.emitBindingEvent('binding_replaced', {
        sessionId: session.data.id,
        source,
        channelId,
        channelName,
        previousSessionId: previousBinding.sessionId,
      })
      if (previous) {
        this.backgroundSession(previous, nextBinding)
      }
    } else if (!previousBinding) {
      this.emitBindingEvent('binding_set', {
        sessionId: session.data.id,
        source,
        channelId,
        channelName,
      })
    }

    return { previousSessionId }
  }

  getOrCreateForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
  ): { session: Session; isNew: boolean } {
    const existingBinding = this.getCurrentBinding(source, channelId, channelName)
    if (existingBinding) {
      const restored = this.restoreSessionById(existingBinding.sessionId)
      if (restored) {
        restored.ensureChannelContext(channelId, channelName)
        return { session: restored, isNew: false }
      }

      this.clearCurrentBinding(existingBinding)
    }

    const session = this.create(source, {
      channelId,
      channelName,
      modelScope: { channelId, channelName },
    })
    this.setCurrentBinding(source, channelId, session, channelName)
    return { session, isNew: true }
  }

  switchCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    sessionId: string,
    channelName?: string,
  ): { session: Session; previousSessionId?: string; isRestored: boolean } | null {
    const existing = this.sessions.get(sessionId)
    const session = existing ?? this.restoreSessionById(sessionId)
    if (!session || session.data.source !== source) {
      return null
    }

    const { previousSessionId } = this.setCurrentBinding(source, channelId, session, channelName)
    return {
      session,
      previousSessionId,
      isRestored: !existing,
    }
  }

  startNewForChannel(
    source: SessionSource,
    channelId: string,
    channelNameOrOptions?: string | { channelName?: string; previousStatus?: string },
    _maybeOptions?: { previousStatus?: string },
  ): { session: Session; previousSessionId?: string } {
    const channelName =
      typeof channelNameOrOptions === 'string'
        ? channelNameOrOptions
        : channelNameOrOptions?.channelName

    const session = this.create(source, {
      channelId,
      channelName,
      modelScope: { channelId, channelName },
    })
    const { previousSessionId } = this.setCurrentBinding(source, channelId, session, channelName)
    return { session, previousSessionId }
  }

  remove(id: string): void {
    const bindings = this.listCurrentBindings().filter((binding) => binding.sessionId === id)
    for (const binding of bindings) {
      this.clearCurrentBinding(binding)
    }
    this.deps.observability?.syncSessionCurrentState(id, false)
    this.sessions.delete(id)
  }

  getCurrentChannelIds(source: SessionSource, channelName?: string): string[] {
    const ids = new Set<string>()
    for (const binding of this.currentBindings.values()) {
      if (binding.source !== source) continue
      if (channelName && binding.channelName !== channelName) continue
      ids.add(binding.channelId)
    }
    return Array.from(ids)
  }

  restoreFromDB(): number {
    if (!this.sessionDb) return 0

    this.loadChannelModelPreferences()
    const bindings = this.sessionDb.loadBindings()
    let restored = 0

    for (const binding of bindings) {
      const session = this.restoreSessionById(binding.sessionId)
      if (!session) {
        this.sessionDb.deleteBinding(binding.source, binding.channelId, binding.channelName)
        continue
      }

      session.ensureChannelContext(binding.channelId, binding.channelName)
      this.currentBindings.set(
        this.getChannelSessionKey(binding.source, binding.channelId, binding.channelName),
        binding,
      )
      this.deps.observability?.syncSessionCurrentState(session.data.id, true)
      restored++
    }

    return restored
  }

  async drainAndCollectInterrupted(timeoutMs = 30_000): Promise<InterruptedSessionRef[]> {
    const currentIds = new Set(this.listCurrentBindings().map((binding) => binding.sessionId))
    const active = Array.from(this.sessions.values()).filter(
      (session) => currentIds.has(session.data.id) && session.isTurnInProgress(),
    )
    if (active.length === 0) return []

    console.log(`[SessionManager] Draining ${active.length} current turn(s)...`)

    const result = await Promise.race([
      Promise.all(active.map((session) => session.waitForTurnComplete())).then(
        () => 'done' as const,
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ])

    if (result === 'done') {
      console.log('[SessionManager] All turns drained.')
      return []
    }

    const interrupted = active
      .filter((session) => session.isTurnInProgress())
      .map((session) => {
        const subAgents = session.getSubAgentSnapshot()
        return {
          sessionId: session.data.id,
          source: session.data.source,
          channelId: session.data.channelId,
          channelName: session.data.channelName,
          ...(subAgents.length > 0 ? { subAgents } : {}),
        }
      })

    console.warn(`[SessionManager] Drain timeout: ${interrupted.length} current turn(s) still active`)
    return interrupted
  }

  flushAll(): void {
    if (!this.sessionDb) return
    for (const [id, session] of this.sessions) {
      const agentConfig = session.getAgentConfig()
      this.sessionDb.saveSession(
        session.data,
        agentConfig ? JSON.stringify(agentConfig) : undefined,
        session.getSystemPrompt() || undefined,
      )
      this.sessionDb.saveMessages(id, session.getMessages())
    }
  }

  async deleteSession(
    id: string,
    memoryStore?: MemoryRepository,
    metrics?: MetricsDB,
  ): Promise<boolean> {
    this.remove(id)
    const dbDeleted = this.sessionDb?.deleteSession(id) ?? false
    metrics?.deleteSessionMetrics(id)
    await memoryStore?.deleteBySessionId(id)
    return dbDeleted
  }

  getFromDB(id: string): SessionRow | null {
    const row = this.sessionDb?.getSession(id)
    return row ? this.normalizeRow(row) : null
  }

  getMessagesFromDB(id: string): Message[] {
    return this.sessionDb?.loadSessionMessages(id) ?? []
  }

  listAllFromDB(filter?: { limit?: number; offset?: number }): SessionRow[] {
    return (this.sessionDb?.loadAllSessions(filter) ?? []).map((row) => this.normalizeRow(row))
  }

  getPlacement(sessionId: string): SessionPlacement {
    return this.isCurrentSessionId(sessionId) ? 'current' : 'background'
  }
}

function normalizeAgentConfig(raw: string): AgentConfig | null {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object') return null

  const candidate = value as Record<string, unknown>
  const agentInstruction = candidate.agentInstruction ?? candidate.systemPrompt
  if (typeof candidate.name !== 'string' || typeof agentInstruction !== 'string') return null

  if (
    candidate.promptMode !== undefined &&
    candidate.promptMode !== 'full' &&
    candidate.promptMode !== 'minimal' &&
    candidate.promptMode !== 'none'
  ) {
    return null
  }

  return {
    name: candidate.name,
    agentInstruction,
    ...(candidate.promptMode ? { promptMode: candidate.promptMode } : {}),
  }
}
