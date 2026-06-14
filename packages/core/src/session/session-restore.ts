import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type { SessionRow } from '@zero-os/observe'
import type {
  Message,
  Session as SessionData,
  TimelineCompactionBlock,
  ToolLogger,
} from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'
import { sanitizeConversationHistoryForSignedThinkingToolUse } from '../agent/context'
import type { ToolRegistry } from '../tool/registry'
import { SessionAgentRuntimeController } from './session-agent-controller'
import { SessionConversationState } from './session-conversation-state'
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

export interface PreparedSessionRestoreState {
  data: SessionData
  messages: Message[]
  activeModel: ResolvedModel | undefined
  logger: ToolLogger
  nextTurnIndex: number
}

export function prepareSessionRestoreState(options: {
  data: SessionData
  messages: Message[]
  modelRouter: ModelRouter
  deps: SessionDeps
}): PreparedSessionRestoreState {
  const { data, messages, modelRouter, deps } = options
  const normalizedData = normalizeSessionDataForRestore(data, modelRouter)
  const activeModel = modelRouter.resolveModel(normalizedData.currentModel)
  const restoredMessages =
    activeModel?.adapter.apiType === 'anthropic-deepseek'
      ? sanitizeConversationHistoryForSignedThinkingToolUse(messages)
      : messages

  return {
    data: normalizedData,
    messages: restoredMessages,
    activeModel,
    logger: createRestoredSessionLogger(data.id),
    nextTurnIndex: deriveNextTurnIndex({
      sessionId: data.id,
      messages: restoredMessages,
      observability: deps.observability,
    }),
  }
}

export function createRestoredSessionRuntime(options: {
  data: SessionData
  messages: Message[]
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  timelineCompactionBlocks: TimelineCompactionBlock[]
  getAgentName: () => string
}): Record<string, unknown> {
  const restored = prepareSessionRestoreState({
    data: options.data,
    messages: options.messages,
    modelRouter: options.modelRouter,
    deps: options.deps,
  })

  return {
    data: restored.data,
    conversation: new SessionConversationState({
      messages: restored.messages,
      timelineCompactionBlocks: options.timelineCompactionBlocks,
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
