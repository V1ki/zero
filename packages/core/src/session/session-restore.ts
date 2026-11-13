import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import { type SessionEventStore, type SessionRow, projectEvents } from '@zero-os/observe'
import type {
  ContextCheckpoint,
  Message,
  Session as SessionData,
  TimelineCompactionBlock,
  ToolLogger,
  TurnStartEvent,
} from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'
import type { ToolRegistry } from '../tool/registry'
import type { BackgroundToolCompletionEvent } from './background-tool-tasks'
import { SessionAgentRuntimeController } from './session-agent-controller'
import { SessionConversationState } from './session-conversation-state'
import { applyFailedTurnRollback } from './session-messages'
import { deriveNextTurnIndex } from './session-runtime'
import { SessionSnapshotRecorder } from './session-snapshots'
import { SessionTurnRuntime } from './session-turn-runtime'
import type { SessionDeps } from './session-types'

export function normalizeSessionRow(row: SessionRow, modelRouter: ModelRouter): SessionRow {
  return {
    ...row,
    currentModel: modelRouter.normalizeModelReference(row.currentModel) ?? row.currentModel,
    modelHistory: row.modelHistory.map((entry) => ({
      ...entry,
      model: modelRouter.normalizeModelReference(entry.model) ?? entry.model,
    })),
    reasoningEffort: row.reasoningEffort,
  }
}

export function sessionDataFromRow(row: SessionRow): SessionData {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    currentModel: row.currentModel,
    reasoningEffort: row.reasoningEffort,
    modelHistory: row.modelHistory,
    summary: row.summary,
    tags: row.tags,
    channelName: row.channelName,
    channelId: row.channelId,
    participantId: row.participantId,
  }
}

export function normalizeAgentConfig(raw: string): AgentConfig | null {
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

/**
 * 进程在 turn 中途退出,事件流里会留下只有 turn/start 没有 turn/end 的 turn
 * (docs/session-log-replay.md「没封口的 turn」)。恢复时按 turn 失败的规则处理这个 turn 的消息,
 * 截断记 restore_repair,再补写 turn/end 封口;封口过的 turn 不再处理。
 */
export function sealInterruptedTurn(sessionEvents: SessionEventStore, sessionId: string): void {
  const current = sessionEvents.project(sessionId)
  if (!current) return

  const events = sessionEvents.readEvents(sessionId)
  const turnStart = events.findLast((event): event is TurnStartEvent => event.type === 'turn/start')
  if (!turnStart) return
  if (events.some((event) => event.type === 'turn/end' && event.seq > turnStart.seq)) return

  const atTurnStart = projectEvents(events.filter((event) => event.seq <= turnStart.seq))
  const messages = current.messages
  const rolledBack = applyFailedTurnRollback({
    messages,
    messageCountBefore: atTurnStart.messages.length,
    onRollback: () => {},
    onPartialFailure: () => {},
  })
  sessionEvents.syncMessages(sessionId, messages, 'restore_repair')
  // 与 turn 失败一致:回滚时恢复 turn 开始时的检查点
  if (
    rolledBack &&
    events.some((event) => event.type === 'compaction/checkpoint' && event.seq > turnStart.seq)
  ) {
    sessionEvents.append(sessionId, [
      { type: 'compaction/checkpoint', data: { checkpoint: atTurnStart.checkpoint ?? null } },
    ])
  }
  sessionEvents.append(sessionId, [
    {
      type: 'turn/end',
      data: { turnIndex: turnStart.data.turnIndex, status: 'failed', reason: 'process_restart' },
    },
  ])
}

/**
 * 恢复出的会话状态(会话元数据之外)。有事件文件时全部取自 SessionEventStore.projectForRestore;
 * 没有事件文件的旧会话取自 DB 行,nextTurnIndex 缺省时按 trace 的请求记录与消息推算。
 */
export interface RestoredSessionContext {
  systemPrompt?: string
  timelineCompactionBlocks?: TimelineCompactionBlock[]
  checkpoint?: ContextCheckpoint
  injectedMemoryIds?: Map<string, string>
  nextTurnIndex?: number
}

export interface PreparedSessionRestoreState {
  data: SessionData
  activeModel: ResolvedModel | undefined
  logger: ToolLogger
  nextTurnIndex: number
}

/**
 * 恢复只读:canonical 消息原样交给会话,面向 provider 的清理(排队消息合并、签名 thinking)
 * 在请求组装时做(prepareRequestMessages)。
 */
export function prepareSessionRestoreState(options: {
  data: SessionData
  messages: Message[]
  modelRouter: ModelRouter
  deps: SessionDeps
  nextTurnIndex: number | undefined
}): PreparedSessionRestoreState {
  const { data, messages, modelRouter, deps } = options
  const normalizedData = normalizeSessionDataForRestore(data, modelRouter)

  return {
    data: normalizedData,
    activeModel: modelRouter.resolveModel(normalizedData.currentModel),
    logger: createRestoredSessionLogger(data.id),
    nextTurnIndex:
      options.nextTurnIndex ??
      deriveNextTurnIndex({ sessionId: data.id, messages, observability: deps.observability }),
  }
}

export function createRestoredSessionRuntime(options: {
  data: SessionData
  messages: Message[]
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  restored: RestoredSessionContext
  getAgentName: () => string
  onBackgroundToolCompletion(event: BackgroundToolCompletionEvent): Promise<void> | void
}): Record<string, unknown> {
  const restored = prepareSessionRestoreState({
    data: options.data,
    messages: options.messages,
    modelRouter: options.modelRouter,
    deps: options.deps,
    nextTurnIndex: options.restored.nextTurnIndex,
  })

  return {
    data: restored.data,
    conversation: new SessionConversationState({
      messages: options.messages,
      timelineCompactionBlocks: options.restored.timelineCompactionBlocks,
      checkpoint: options.restored.checkpoint,
      injectedMemoryIds: options.restored.injectedMemoryIds,
    }),
    modelRouter: options.modelRouter,
    toolRegistry: options.toolRegistry,
    activeModel: restored.activeModel,
    deps: options.deps,
    logger: restored.logger,
    agentRuntime: new SessionAgentRuntimeController({
      data: restored.data,
      modelRouter: options.modelRouter,
      toolRegistry: options.toolRegistry,
      deps: options.deps,
      logger: restored.logger,
      onBackgroundToolCompletion: options.onBackgroundToolCompletion,
    }),
    turnRuntime: new SessionTurnRuntime({ nextTurnIndex: restored.nextTurnIndex }),
    snapshotRecorder: new SessionSnapshotRecorder({
      sessionId: options.data.id,
      observability: options.deps.observability,
      tracer: options.deps.tracer,
      getAgentName: options.getAgentName,
    }),
  }
}

function normalizeSessionDataForRestore(data: SessionData, modelRouter: ModelRouter): SessionData {
  const normalizedCurrentModel =
    modelRouter.normalizeModelReference(data.currentModel) ?? data.currentModel
  const normalizedHistory = data.modelHistory.map((entry) => ({
    ...entry,
    model: modelRouter.normalizeModelReference(entry.model) ?? entry.model,
  }))

  return {
    ...data,
    currentModel: normalizedCurrentModel,
    modelHistory: normalizedHistory,
    reasoningEffort: data.reasoningEffort,
  }
}

function createRestoredSessionLogger(sessionId: string): ToolLogger {
  return {
    info: (event: string, data?: Record<string, unknown>) =>
      console.log(`[${sessionId}] ${event}`, data ?? ''),
    warn: (event: string, data?: Record<string, unknown>) =>
      console.warn(`[${sessionId}] ${event}`, data ?? ''),
    error: (event: string, data?: Record<string, unknown>) =>
      console.error(`[${sessionId}] ${event}`, data ?? ''),
  }
}
