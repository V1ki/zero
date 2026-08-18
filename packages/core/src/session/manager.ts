import type { MemoryRepository } from '@zero-os/memory'
import { SESSION_MEMORY_PROMPT, shouldEvaluateSessionMemory } from '@zero-os/memory'
import type { ModelRouter } from '@zero-os/model'
import type { MetricsDB, SessionDB, SessionRow } from '@zero-os/observe'
import type {
  ChannelSessionBinding,
  Message,
  MessageChannelSource,
  SessionPlacement,
  SessionSource,
  TimelineCompactionBlock,
} from '@zero-os/shared'
import type { AgentSnapshot } from '../agent/agent-control'
import type { ToolRegistry } from '../tool/registry'
import { Session, type SessionDeps } from './session'
import type { SessionMessageRecallResult } from './session-conversation-state'
import { persistSessionSnapshot } from './session-persistence'
import { normalizeAgentConfig, normalizeSessionRow, sessionDataFromRow } from './session-restore'
import { allocateUniqueSessionId } from './session-runtime'

export interface InterruptedSessionRef {
  sessionId: string
  source: SessionSource
  channelId?: string
  channelName?: string
  participantId?: string
  subAgents?: AgentSnapshot[]
}

/**
 * Manages current channel bindings and delegates session materialization to SessionManagerStore.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map()
  private currentBindings: SessionCurrentBindingCoordinator
  private pendingBackgroundEvaluations = new Set<string>()
  private store: SessionManagerStore
  private channels: SessionChannelLifecycle
  private deps: SessionDeps

  constructor(
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    deps: SessionDeps = {},
    sessionDb?: SessionDB,
  ) {
    this.deps = deps
    this.store = new SessionManagerStore({
      modelRouter,
      toolRegistry,
      deps: this.deps,
      sessionDb,
      sessions: this.sessions,
    })
    this.currentBindings = new SessionCurrentBindingCoordinator({
      bindings: new SessionBindingRegistry(sessionDb),
      sessions: this.sessions,
      deps: this.deps,
      pendingBackgroundEvaluations: this.pendingBackgroundEvaluations,
    })
    this.channels = new SessionChannelLifecycle({
      currentBindings: this.currentBindings,
      deps: this.deps,
      sessionDb,
      sessions: this.sessions,
      store: this.store,
    })
  }

  create(source: SessionSource, options: SessionCreateOptions = {}): Session {
    return this.store.create(source, options)
  }

  get(id: string): Session | undefined {
    return this.store.get(id)
  }

  listCurrent(): Session[] {
    return this.channels.listCurrent()
  }

  listAll(): Session[] {
    return this.store.listAll()
  }

  listCurrentBindings(): ChannelSessionBinding[] {
    return this.currentBindings.list()
  }

  getCurrentBinding(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): ChannelSessionBinding | undefined {
    return this.currentBindings.get(source, channelId, channelName, participantId)
  }

  isCurrentSessionId(sessionId: string): boolean {
    return this.currentBindings.hasSession(sessionId)
  }

  isCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    channelName: string | undefined,
    sessionId: string,
    participantId?: string,
  ): boolean {
    return (
      this.getCurrentBinding(source, channelId, channelName, participantId)?.sessionId === sessionId
    )
  }

  getCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): Session | undefined {
    return this.channels.getCurrentSessionForChannel(source, channelId, channelName, participantId)
  }

  getPreferredModel(
    source: SessionSource,
    channelId?: string,
    channelName?: string,
    participantId?: string,
  ): string {
    return this.store.getPreferredModel(source, channelId, channelName, participantId)
  }

  setPreferredModel(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
    participantId?: string,
  ): string {
    return this.store.setPreferredModel(source, channelId, model, channelName, participantId)
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.store.setTaskClosureModel(taskClosureModel)
  }

  setContextCompactionModels(models: {
    contextCompactionModel?: string
  }): void {
    this.store.setContextCompactionModels(models)
  }

  setBackgroundToolCompletionHandler(
    handler: SessionDeps['backgroundToolCompletionHandler'],
  ): void {
    this.deps.backgroundToolCompletionHandler = handler
    for (const session of this.sessions.values()) {
      session.setBackgroundToolCompletionHandler(handler)
    }
  }

  getOrCreateForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): { session: Session; isNew: boolean } {
    return this.channels.getOrCreateForChannel(source, channelId, channelName, participantId)
  }

  switchCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    sessionId: string,
    channelName?: string,
    participantId?: string,
  ): { session: Session; previousSessionId?: string; isRestored: boolean } | null {
    return this.channels.switchCurrentSessionForChannel(
      source,
      channelId,
      sessionId,
      channelName,
      participantId,
    )
  }

  startNewForChannel(
    source: SessionSource,
    channelId: string,
    channelNameOrOptions?: string | StartNewForChannelOptions,
    _maybeOptions?: { previousStatus?: string },
  ): { session: Session; previousSessionId?: string } {
    return this.channels.startNewForChannel(source, channelId, channelNameOrOptions)
  }

  recoverStalledCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    options: RecoverStalledCurrentSessionForChannelOptions,
  ): StalledSessionRecoveryResult | null {
    return this.channels.recoverStalledCurrentSessionForChannel(source, channelId, options)
  }

  remove(id: string): void {
    this.channels.remove(id)
  }

  getCurrentChannelIds(source: SessionSource, channelName?: string): string[] {
    return this.currentBindings.getChannelIds(source, channelName)
  }

  restoreFromDB(): number {
    return this.channels.restoreFromDB()
  }

  async drainAndCollectInterrupted(timeoutMs = 30_000): Promise<InterruptedSessionRef[]> {
    const currentIds = new Set(this.listCurrentBindings().map((binding) => binding.sessionId))
    return await drainInterruptedSessions({
      sessions: this.sessions.values(),
      currentSessionIds: currentIds,
      timeoutMs,
    })
  }

  flushAll(): void {
    this.store.flushAll()
  }

  async deleteSession(
    id: string,
    memoryStore?: MemoryRepository,
    metrics?: MetricsDB,
  ): Promise<boolean> {
    this.remove(id)
    return await this.store.deletePersistedSession(id, memoryStore, metrics)
  }

  getFromDB(id: string): SessionRow | null {
    return this.store.getFromDB(id)
  }

  getMessagesFromDB(id: string): Message[] {
    return this.store.getMessagesFromDB(id)
  }

  getCompactionBlocksFromDB(id: string) {
    return this.store.getCompactionBlocksFromDB(id)
  }

  listAllFromDB(filter?: { limit?: number; offset?: number }): SessionRow[] {
    return this.store.listAllFromDB(filter)
  }

  getPlacement(sessionId: string): SessionPlacement {
    return this.isCurrentSessionId(sessionId) ? 'current' : 'background'
  }

  markExternalMessageRecalled(options: {
    source: MessageChannelSource
    recalledAt: string
    recallType?: string
  }): SessionMessageRecallResult & { sessionId?: string } {
    for (const session of this.sessions.values()) {
      const result = session.markExternalMessageRecalled(options)
      if (result.matched) {
        return { ...result, sessionId: session.data.id }
      }
    }

    return {
      matched: false,
      changed: false,
      status: 'not_found',
    }
  }
}

export interface SessionCreateOptions {
  channelId?: string
  channelName?: string
  participantId?: string
  initialModel?: string
  modelScope?: SessionModelScope
}

export interface StartNewForChannelOptions {
  channelName?: string
  participantId?: string
  previousStatus?: string
}

export interface RecoverStalledCurrentSessionForChannelOptions {
  channelName?: string
  participantId?: string
  expectedSessionId: string
  stallTimeoutMs: number
}

export interface StalledSessionRecoveryResult {
  session: Session
  previousSessionId: string
  idleForMs: number
  queueDepth: number
}

interface SessionModelScope {
  channelId: string
  channelName?: string
  participantId?: string
}

interface SessionManagerStoreOptions {
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  sessionDb?: SessionDB
  sessions: Map<string, Session>
}

class SessionManagerStore {
  private readonly modelRouter: ModelRouter
  private readonly modelPreferences: SessionModelPreferenceStore
  private readonly toolRegistry: ToolRegistry
  private readonly deps: SessionDeps
  private readonly sessionDb?: SessionDB
  private readonly sessions: Map<string, Session>

  constructor(options: SessionManagerStoreOptions) {
    this.modelRouter = options.modelRouter
    this.toolRegistry = options.toolRegistry
    this.deps = options.deps
    this.sessionDb = options.sessionDb
    this.sessions = options.sessions
    this.modelPreferences = new SessionModelPreferenceStore(options.modelRouter, options.sessionDb)
  }

  create(source: SessionSource, options: SessionCreateOptions = {}): Session {
    const modelScope = options.modelScope ?? getDefaultModelScope(source)
    const initialModel =
      options.initialModel ??
      this.getPreferredModel(
        source,
        modelScope?.channelId,
        modelScope?.channelName,
        modelScope?.participantId,
      )
    const sessionId = allocateUniqueSessionId(source, {
      sessionDb: this.sessionDb,
      isReserved: (id) => this.sessions.has(id),
    })
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
      session.ensureChannelContext(options.channelId, options.channelName, options.participantId)
    } else if (options.channelName) {
      session.data.channelName = options.channelName
    }

    this.sessions.set(session.data.id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  listAll(): Session[] {
    return Array.from(this.sessions.values())
  }

  getPreferredModel(
    source: SessionSource,
    channelId?: string,
    channelName?: string,
    participantId?: string,
  ): string {
    const scope = getModelScope(source, channelId, channelName, participantId)
    if (scope) {
      const preferred = this.modelPreferences.get(
        source,
        scope.channelId,
        scope.channelName,
        scope.participantId,
      )
      if (preferred) return preferred
    }

    return this.modelRouter.getDefaultModelLabel()
  }

  setPreferredModel(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
    participantId?: string,
  ): string {
    return this.modelPreferences.set(source, channelId, model, channelName, participantId)
  }

  reloadModelPreferences(): void {
    this.modelPreferences.reload()
  }

  setTaskClosureModel(taskClosureModel?: string): void {
    this.deps.taskClosureModel = taskClosureModel
    for (const session of this.sessions.values()) {
      session.setTaskClosureModel(taskClosureModel)
    }
  }

  setContextCompactionModels(models: {
    contextCompactionModel?: string
  }): void {
    this.deps.contextCompactionModel = models.contextCompactionModel
    for (const session of this.sessions.values()) {
      session.setContextCompactionModels(models)
    }
  }

  restoreSessionById(sessionId: string): Session | null {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const row = this.sessionDb?.getSession(sessionId)
    if (!row) return null
    return this.restoreSession(row)
  }

  flushAll(): void {
    if (!this.sessionDb) return
    for (const session of this.sessions.values()) {
      persistSessionSnapshot(this.sessionDb, session)
    }
  }

  async deletePersistedSession(
    id: string,
    memoryStore?: MemoryRepository,
    metrics?: MetricsDB,
  ): Promise<boolean> {
    const dbDeleted = this.sessionDb?.deleteSession(id) ?? false
    metrics?.deleteSessionMetrics(id)
    await memoryStore?.deleteBySessionId(id)
    return dbDeleted
  }

  getFromDB(id: string): SessionRow | null {
    const row = this.sessionDb?.getSession(id)
    return row ? normalizeSessionRow(row, this.modelRouter) : null
  }

  getMessagesFromDB(id: string): Message[] {
    return this.sessionDb?.loadSessionMessages(id) ?? []
  }

  getCompactionBlocksFromDB(id: string): TimelineCompactionBlock[] {
    return this.sessionDb?.loadSessionCompactionBlocks(id) ?? []
  }

  listAllFromDB(filter?: { limit?: number; offset?: number }): SessionRow[] {
    return (this.sessionDb?.loadAllSessions(filter) ?? []).map((row) =>
      normalizeSessionRow(row, this.modelRouter),
    )
  }

  private createSessionDeps(source: SessionSource, modelScope?: SessionModelScope): SessionDeps {
    if (!modelScope) return this.deps

    return {
      ...this.deps,
      persistModelPreference: (model: string) => {
        this.setPreferredModel(
          source,
          modelScope.channelId,
          model,
          modelScope.channelName,
          modelScope.participantId,
        )
      },
    }
  }

  private restoreSession(row: SessionRow): Session {
    const existing = this.sessions.get(row.id)
    if (existing) return existing

    const normalizedRow = normalizeSessionRow(row, this.modelRouter)
    const data = sessionDataFromRow(normalizedRow)
    const messages = this.sessionDb?.loadSessionMessages(row.id) ?? []
    const timelineCompactionBlocks = this.sessionDb?.loadSessionCompactionBlocks(row.id) ?? []
    const modelScope = getModelScope(
      data.source,
      data.channelId,
      data.channelName,
      data.participantId,
    )
    const session = Session.restore(
      data,
      messages,
      this.modelRouter,
      this.toolRegistry,
      this.createSessionDeps(data.source, modelScope),
      normalizedRow.systemPrompt,
      timelineCompactionBlocks,
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
}

class SessionModelPreferenceStore {
  private preferences = new Map<string, string>()

  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly sessionDb?: SessionDB,
  ) {
    this.reload()
  }

  reload(): void {
    if (!this.sessionDb) return

    this.preferences.clear()
    for (const row of this.sessionDb.loadChannelModels()) {
      const normalized = this.modelRouter.normalizeModelReference(row.model) ?? row.model
      const key = getChannelSessionKey(
        row.source,
        row.channelId,
        row.channelName,
        row.participantId,
      )
      this.preferences.set(key, normalized)
    }
  }

  get(
    source: SessionSource,
    channelId?: string,
    channelName?: string,
    participantId?: string,
  ): string | undefined {
    if (!channelId) return undefined
    return this.preferences.get(getChannelSessionKey(source, channelId, channelName, participantId))
  }

  set(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
    participantId?: string,
  ): string {
    const normalized = this.modelRouter.normalizeModelReference(model) ?? model
    const key = getChannelSessionKey(source, channelId, channelName, participantId)
    this.preferences.set(key, normalized)
    this.sessionDb?.saveChannelModel(source, channelId, normalized, channelName, participantId)
    return normalized
  }
}

interface SessionBindingRegistrySetResult {
  binding: ChannelSessionBinding
  previousBinding?: ChannelSessionBinding
  previousSessionId?: string
}

class SessionBindingRegistry {
  private bindings = new Map<string, ChannelSessionBinding>()

  constructor(private readonly sessionDb?: SessionDB) {}

  list(): ChannelSessionBinding[] {
    return Array.from(this.bindings.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  get(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): ChannelSessionBinding | undefined {
    return this.bindings.get(getChannelSessionKey(source, channelId, channelName, participantId))
  }

  hasSession(sessionId: string): boolean {
    return Array.from(this.bindings.values()).some((binding) => binding.sessionId === sessionId)
  }

  set(
    source: SessionSource,
    channelId: string,
    sessionId: string,
    channelName?: string,
    participantId?: string,
  ): SessionBindingRegistrySetResult {
    const key = getChannelSessionKey(source, channelId, channelName, participantId)
    const previousBinding = this.bindings.get(key)
    const previousSessionId =
      previousBinding && previousBinding.sessionId !== sessionId
        ? previousBinding.sessionId
        : undefined
    const updatedAt = new Date().toISOString()
    const binding: ChannelSessionBinding = {
      source,
      channelName,
      channelId,
      participantId,
      sessionId,
      updatedAt,
    }

    this.bindings.set(key, binding)
    this.sessionDb?.saveBinding(source, channelId, sessionId, channelName, updatedAt, participantId)

    return { binding, previousBinding, previousSessionId }
  }

  delete(binding: ChannelSessionBinding): void {
    this.bindings.delete(
      getChannelSessionKey(
        binding.source,
        binding.channelId,
        binding.channelName,
        binding.participantId,
      ),
    )
    this.sessionDb?.deleteBinding(
      binding.source,
      binding.channelId,
      binding.channelName,
      binding.participantId,
    )
  }

  restore(binding: ChannelSessionBinding): void {
    this.bindings.set(
      getChannelSessionKey(
        binding.source,
        binding.channelId,
        binding.channelName,
        binding.participantId,
      ),
      binding,
    )
  }

  getChannelIds(source: SessionSource, channelName?: string): string[] {
    const ids = new Set<string>()
    for (const binding of this.bindings.values()) {
      if (binding.source !== source) continue
      if (channelName && binding.channelName !== channelName) continue
      ids.add(binding.channelId)
    }
    return Array.from(ids)
  }
}

interface SessionCurrentBindingCoordinatorOptions {
  bindings: SessionBindingRegistry
  sessions: Map<string, Session>
  deps: SessionDeps
  pendingBackgroundEvaluations: Set<string>
}

interface SetCurrentSessionOptions {
  evaluatePreviousSessionMemory?: boolean
}

type BindingEvent = 'binding_set' | 'binding_replaced' | 'binding_cleared' | 'session_backgrounded'

class SessionCurrentBindingCoordinator {
  private readonly bindings: SessionBindingRegistry
  private readonly sessions: Map<string, Session>
  private readonly deps: SessionDeps
  private readonly pendingBackgroundEvaluations: Set<string>

  constructor(options: SessionCurrentBindingCoordinatorOptions) {
    this.bindings = options.bindings
    this.sessions = options.sessions
    this.deps = options.deps
    this.pendingBackgroundEvaluations = options.pendingBackgroundEvaluations
  }

  list(): ChannelSessionBinding[] {
    return this.bindings.list()
  }

  get(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): ChannelSessionBinding | undefined {
    return this.bindings.get(source, channelId, channelName, participantId)
  }

  hasSession(sessionId: string): boolean {
    return this.bindings.hasSession(sessionId)
  }

  getChannelIds(source: SessionSource, channelName?: string): string[] {
    return this.bindings.getChannelIds(source, channelName)
  }

  restore(binding: ChannelSessionBinding, session: Session): void {
    this.bindings.restore(binding)
    this.deps.observability?.syncSessionCurrentState(session.data.id, true)
  }

  clear(binding: ChannelSessionBinding): void {
    this.bindings.delete(binding)
    this.deps.observability?.syncSessionCurrentState(binding.sessionId, false)
    this.emitBindingEvent('binding_cleared', {
      sessionId: binding.sessionId,
      source: binding.source,
      channelId: binding.channelId,
      channelName: binding.channelName,
      participantId: binding.participantId,
    })
  }

  setCurrent(
    source: SessionSource,
    channelId: string,
    session: Session,
    channelName?: string,
    participantId?: string,
    options: SetCurrentSessionOptions = {},
  ): { previousSessionId?: string } {
    session.ensureChannelContext(channelId, channelName, participantId)
    const {
      binding: nextBinding,
      previousBinding,
      previousSessionId,
    } = this.bindings.set(source, channelId, session.data.id, channelName, participantId)

    const eventBinding = {
      source,
      channelName,
      channelId,
      participantId,
      sessionId: session.data.id,
    }
    this.deps.observability?.syncSessionCurrentState(session.data.id, true)

    if (previousBinding && previousBinding.sessionId !== session.data.id) {
      const previous = this.sessions.get(previousBinding.sessionId)
      this.deps.observability?.syncSessionCurrentState(previousBinding.sessionId, false)
      this.emitBindingEvent('binding_replaced', {
        sessionId: session.data.id,
        source,
        channelId,
        channelName,
        participantId,
        previousSessionId: previousBinding.sessionId,
      })
      if (previous) {
        this.backgroundSession(previous, nextBinding, {
          evaluateSessionMemory: options.evaluatePreviousSessionMemory ?? true,
        })
      }
    } else if (!previousBinding) {
      this.emitBindingEvent('binding_set', {
        ...eventBinding,
      })
    }

    return { previousSessionId }
  }

  private backgroundSession(
    session: Session,
    binding: {
      source: SessionSource
      channelId: string
      channelName?: string
      participantId?: string
      sessionId: string
    },
    options: {
      evaluateSessionMemory: boolean
    },
  ): void {
    // Losing the current binding is the handoff point: the old session becomes history-only
    // immediately. Healthy handoffs evaluate memory best-effort after any in-flight turn.
    this.deps.observability?.syncSessionCurrentState(session.data.id, false)
    this.emitBindingEvent('session_backgrounded', {
      sessionId: session.data.id,
      source: binding.source,
      channelId: binding.channelId,
      channelName: binding.channelName,
      participantId: binding.participantId,
      replacedBySessionId: binding.sessionId,
    })

    if (options.evaluateSessionMemory) {
      scheduleSessionBackgroundEvaluation({
        session,
        pendingBackgroundEvaluations: this.pendingBackgroundEvaluations,
      })
    }
  }

  private emitBindingEvent(
    event: BindingEvent,
    binding: {
      sessionId: string
      source: SessionSource
      channelId: string
      channelName?: string
      participantId?: string
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
      participantId: binding.participantId,
      previousSessionId: binding.previousSessionId ?? null,
      replacedBySessionId: binding.replacedBySessionId ?? null,
    })
  }
}

function scheduleSessionBackgroundEvaluation(options: {
  session: Session
  pendingBackgroundEvaluations: Set<string>
}): void {
  const { session, pendingBackgroundEvaluations } = options
  const shouldEvaluate =
    session.isAgentInitialized() &&
    shouldEvaluateSessionMemory(session.getMessages(), Session.isTopLevelUserTurn)

  if (!shouldEvaluate || pendingBackgroundEvaluations.has(session.data.id)) {
    return
  }

  pendingBackgroundEvaluations.add(session.data.id)

  const runEvaluation = async () => {
    try {
      await session.evaluateSessionMemory(SESSION_MEMORY_PROMPT)
    } catch (error) {
      console.warn('[SessionMemory] evaluation failed:', error)
    } finally {
      pendingBackgroundEvaluations.delete(session.data.id)
    }
  }

  if (session.isTurnInProgress()) {
    void session
      .waitForTurnComplete()
      .then(runEvaluation)
      .catch((error) => {
        pendingBackgroundEvaluations.delete(session.data.id)
        console.warn('[SessionMemory] wait for turn completion failed:', error)
      })
    return
  }

  void runEvaluation()
}

interface SessionChannelLifecycleOptions {
  currentBindings: SessionCurrentBindingCoordinator
  deps: SessionDeps
  sessionDb?: SessionDB
  sessions: Map<string, Session>
  store: SessionManagerStore
}

class SessionChannelLifecycle {
  private readonly currentBindings: SessionCurrentBindingCoordinator
  private readonly deps: SessionDeps
  private readonly sessionDb?: SessionDB
  private readonly sessions: Map<string, Session>
  private readonly store: SessionManagerStore

  constructor(options: SessionChannelLifecycleOptions) {
    this.currentBindings = options.currentBindings
    this.deps = options.deps
    this.sessionDb = options.sessionDb
    this.sessions = options.sessions
    this.store = options.store
  }

  listCurrent(): Session[] {
    const currentIds = new Set(this.currentBindings.list().map((binding) => binding.sessionId))
    return Array.from(currentIds)
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is Session => Boolean(session))
  }

  getCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): Session | undefined {
    const binding = this.currentBindings.get(source, channelId, channelName, participantId)
    if (!binding) return undefined
    return this.store.restoreSessionById(binding.sessionId) ?? undefined
  }

  getOrCreateForChannel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): { session: Session; isNew: boolean } {
    const existingBinding = this.currentBindings.get(source, channelId, channelName, participantId)
    if (existingBinding) {
      const restored = this.store.restoreSessionById(existingBinding.sessionId)
      if (restored) {
        restored.ensureChannelContext(channelId, channelName, participantId)
        return { session: restored, isNew: false }
      }

      this.currentBindings.clear(existingBinding)
    }

    const session = this.createChannelSession(source, {
      channelId,
      channelName,
      participantId,
      modelScope: { channelId, channelName, participantId },
    })
    this.currentBindings.setCurrent(source, channelId, session, channelName, participantId)
    return { session, isNew: true }
  }

  switchCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    sessionId: string,
    channelName?: string,
    participantId?: string,
  ): { session: Session; previousSessionId?: string; isRestored: boolean } | null {
    const existing = this.store.get(sessionId)
    const session = existing ?? this.store.restoreSessionById(sessionId)
    if (!session || session.data.source !== source) {
      return null
    }

    const { previousSessionId } = this.currentBindings.setCurrent(
      source,
      channelId,
      session,
      channelName,
      participantId,
    )
    return {
      session,
      previousSessionId,
      isRestored: !existing,
    }
  }

  startNewForChannel(
    source: SessionSource,
    channelId: string,
    channelNameOrOptions?: string | StartNewForChannelOptions,
  ): { session: Session; previousSessionId?: string } {
    const channelName =
      typeof channelNameOrOptions === 'string'
        ? channelNameOrOptions
        : channelNameOrOptions?.channelName
    const participantId =
      typeof channelNameOrOptions === 'string' ? undefined : channelNameOrOptions?.participantId

    const session = this.createChannelSession(source, {
      channelId,
      channelName,
      participantId,
      modelScope: { channelId, channelName, participantId },
    })
    const { previousSessionId } = this.currentBindings.setCurrent(
      source,
      channelId,
      session,
      channelName,
      participantId,
    )
    return { session, previousSessionId }
  }

  recoverStalledCurrentSessionForChannel(
    source: SessionSource,
    channelId: string,
    options: RecoverStalledCurrentSessionForChannelOptions,
  ): StalledSessionRecoveryResult | null {
    if (!Number.isFinite(options.stallTimeoutMs) || options.stallTimeoutMs < 0) {
      return null
    }

    const binding = this.currentBindings.get(
      source,
      channelId,
      options.channelName,
      options.participantId,
    )
    if (!binding || binding.sessionId !== options.expectedSessionId) {
      return null
    }

    const previous = this.store.restoreSessionById(binding.sessionId)
    if (!previous) {
      return null
    }

    if (!previous.isTurnStalled(options.stallTimeoutMs)) {
      return null
    }
    const health = previous.getTurnHealth()
    const executionAbortRequested = previous.requestTurnAbort()

    const session = this.createChannelSession(source, {
      channelId,
      channelName: options.channelName,
      participantId: options.participantId,
      modelScope: {
        channelId,
        channelName: options.channelName,
        participantId: options.participantId,
      },
    })
    this.currentBindings.setCurrent(
      source,
      channelId,
      session,
      options.channelName,
      options.participantId,
      { evaluatePreviousSessionMemory: false },
    )

    this.deps.bus?.emit('session:update', {
      sessionId: session.data.id,
      event: 'session_stall_recovered',
      source,
      channelId,
      channelName: options.channelName,
      participantId: options.participantId,
      previousSessionId: previous.data.id,
      quarantinedSessionId: previous.data.id,
      replacedBySessionId: session.data.id,
      idleForMs: health.idleForMs,
      stallTimeoutMs: options.stallTimeoutMs,
      turnStartedAt: health.startedAt,
      lastProgressAt: health.lastProgressAt,
      queueDepth: health.queueDepth,
      executionAbortRequested,
    })

    return {
      session,
      previousSessionId: previous.data.id,
      idleForMs: health.idleForMs,
      queueDepth: health.queueDepth,
    }
  }

  remove(sessionId: string): void {
    const bindings = this.currentBindings
      .list()
      .filter((binding) => binding.sessionId === sessionId)
    for (const binding of bindings) {
      this.currentBindings.clear(binding)
    }
    this.deps.observability?.syncSessionCurrentState(sessionId, false)
    this.sessions.delete(sessionId)
  }

  restoreFromDB(): number {
    if (!this.sessionDb) return 0

    this.store.reloadModelPreferences()
    const bindings = this.sessionDb.loadBindings()
    let restored = 0

    for (const binding of bindings) {
      const session = this.store.restoreSessionById(binding.sessionId)
      if (!session) {
        this.sessionDb.deleteBinding(
          binding.source,
          binding.channelId,
          binding.channelName,
          binding.participantId,
        )
        continue
      }

      session.ensureChannelContext(binding.channelId, binding.channelName, binding.participantId)
      this.currentBindings.restore(binding, session)
      restored++
    }

    return restored
  }

  private createChannelSession(source: SessionSource, options: SessionCreateOptions): Session {
    return this.store.create(source, options)
  }
}

async function drainInterruptedSessions(options: {
  sessions: Iterable<Session>
  currentSessionIds: Set<string>
  timeoutMs: number
}): Promise<InterruptedSessionRef[]> {
  const active = Array.from(options.sessions).filter(
    (session) => options.currentSessionIds.has(session.data.id) && session.isTurnInProgress(),
  )
  if (active.length === 0) return []

  console.log(`[SessionManager] Draining ${active.length} current turn(s)...`)

  const result = await Promise.race([
    Promise.all(active.map((session) => session.waitForTurnComplete())).then(() => 'done' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), options.timeoutMs)),
  ])

  if (result === 'done') {
    console.log('[SessionManager] All turns drained.')
    return []
  }

  const interrupted = active.filter((session) => session.isTurnInProgress()).map(toInterruptedRef)

  console.warn(`[SessionManager] Drain timeout: ${interrupted.length} current turn(s) still active`)
  return interrupted
}

function toInterruptedRef(session: Session): InterruptedSessionRef {
  const subAgents = session.getSubAgentSnapshot()
  return {
    sessionId: session.data.id,
    source: session.data.source,
    channelId: session.data.channelId,
    channelName: session.data.channelName,
    participantId: session.data.participantId,
    ...(subAgents.length > 0 ? { subAgents } : {}),
  }
}

function getDefaultModelScope(source: SessionSource): SessionModelScope | undefined {
  if (source === 'web') {
    return { channelId: 'default', channelName: 'web' }
  }
  return undefined
}

function getModelScope(
  source: SessionSource,
  channelId?: string,
  channelName?: string,
  participantId?: string,
): SessionModelScope | undefined {
  if (channelId) {
    return { channelId, channelName, participantId }
  }
  return getDefaultModelScope(source)
}

function getChannelSessionKey(
  source: SessionSource,
  channelId: string,
  channelName?: string,
  participantId?: string,
): string {
  return `${source}:${channelName ?? source}:${channelId}:${participantId ?? ''}`
}
