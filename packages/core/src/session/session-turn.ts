import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type { RequestMemoryInjectionEntry } from '@zero-os/observe'
import type {
  Message,
  ReasoningEffort,
  Session as SessionData,
  TimelineCompactionBlock,
  ToolLogger,
} from '@zero-os/shared'
import { now } from '@zero-os/shared'
import type { Agent, AgentConfig, AgentContext } from '../agent/agent'
import { retrieveMemoriesWithDecision } from '../agent/memory-retrieval'
import {
  buildDynamicContext,
  buildRetrievedMemoriesBlock,
  wrapMemoryInjection,
} from '../agent/prompt'
import { supportsVision } from '../tool/capabilities'
import {
  applyFailedTurnRollback,
  createUserMessage,
  saveImagesForDelegation,
} from './session-messages'
import type { SessionSnapshotContext, SessionSnapshotRecorder } from './session-snapshots'
import type { SessionStaticContextProvider } from './session-static-context'
import type { SessionTurnRuntime } from './session-turn-runtime'
import type { HandleMessageOptions, SessionDeps } from './session-types'

export interface ProcessSessionMessageTurnOptions {
  content: string
  options?: HandleMessageOptions
  sessionData: SessionData
  agent: Agent | null
  activeModel?: ResolvedModel
  lastAgentConfig: AgentConfig | null
  deps: SessionDeps
  logger: ToolLogger
  modelRouter: ModelRouter
  staticContext: SessionStaticContextProvider
  snapshotRecorder: SessionSnapshotRecorder
  messages: Message[]
  timelineCompactionBlocks: TimelineCompactionBlock[]
  injectedMemoryIds: Map<string, string>
  getAgentName(): string
  getCurrentSnapshotContext(toolNames?: string[]): SessionSnapshotContext | null
  turnRuntime: SessionTurnRuntime
  setTimelineCompactionBlocks(blocks: TimelineCompactionBlock[]): void
}

export async function processSessionMessageTurn({
  content,
  options,
  sessionData,
  agent,
  activeModel,
  lastAgentConfig,
  deps,
  logger,
  modelRouter,
  staticContext,
  snapshotRecorder,
  messages,
  timelineCompactionBlocks,
  injectedMemoryIds,
  getAgentName,
  getCurrentSnapshotContext,
  turnRuntime,
  setTimelineCompactionBlocks,
}: ProcessSessionMessageTurnOptions): Promise<Message[]> {
  const { currentModel, tools, toolNames, systemPrompt, projectRoot, workspacePath } =
    staticContext.ensure()
  snapshotRecorder.ensureCurrentContextSnapshot(getCurrentSnapshotContext(toolNames))
  const userMessageEntry = createUserMessage({
    sessionId: sessionData.id,
    text: content,
    createdAt: now(),
    images: options?.images,
    source: options?.source,
    messageType: options?.messageType,
    controlKind: options?.controlKind,
  })
  const imageDelegationFiles = supportsVision(currentModel?.modelConfig)
    ? undefined
    : saveImagesForDelegation(options?.images, workspacePath)

  const [newSkills, retrievedMemories] = await Promise.all([
    Promise.resolve().then(() => staticContext.loadNewSkills(projectRoot, workspacePath)),
    retrieveSessionMemories({
      activeModel,
      agentConfig: lastAgentConfig,
      agentName: getAgentName(),
      data: sessionData,
      deps,
      injectedMemoryIds,
      logger,
      modelRouter,
      userMessage: content,
    }),
  ])
  turnRuntime.markProgress()

  const dynamicContext = buildDynamicContext({
    newSkills: newSkills.length > 0 ? newSkills : undefined,
    retrievedMemories,
  })
  const requestMemoryInjections: RequestMemoryInjectionEntry[] | undefined = retrievedMemories
    ? [
        {
          layer: 'layer1',
          source: 'retrieved_memories',
          formattedText: wrapMemoryInjection('layer1', retrievedMemories),
        },
      ]
    : undefined

  const context: AgentContext = {
    systemPrompt,
    identityMemory: deps.identityMemory,
    dynamicContext,
    requestMemoryInjections,
    injectedMemoryIds,
    imageDelegationFiles,
    conversationHistory: [...messages],
    timelineCompactionBlocks,
    onTimelineCompactionBlocksChanged: (blocks) => {
      setTimelineCompactionBlocks(blocks)
      deps.sessionDb?.saveCompactionBlocks(sessionData.id, blocks)
      deps.bus?.emit('session:update', {
        sessionId: sessionData.id,
        event: 'timeline_compaction_blocks_updated',
        blockCount: blocks.filter((block) => block.status === 'active').length,
      })
    },
    tools,
    maxContext: currentModel?.modelConfig.maxContext,
    maxOutput: currentModel?.modelConfig.maxOutput,
    reasoningEffort: sessionData.reasoningEffort ?? currentModel?.modelConfig.reasoningEffort,
  }

  const onNewMessage = (msg: Message) => {
    turnRuntime.markProgress()
    messages.push(msg)
    sessionData.updatedAt = now()
    options?.onProgress?.(msg)
  }
  const onTextDelta = (delta: string, meta: { role: 'assistant'; turnId: string }) => {
    turnRuntime.markProgress()
    options?.onTextDelta?.(delta, meta)
  }

  if (!agent) {
    throw new Error('Agent not initialized. Call initAgent() first.')
  }

  const messageCountBefore = messages.length
  try {
    return await agent.run(
      context,
      content,
      imageDelegationFiles?.length ? undefined : options?.images,
      onNewMessage,
      onTextDelta,
      () => turnRuntime.shouldInterrupt(),
      () => turnRuntime.drainQueuedMessages(),
      { turnIndex: turnRuntime.allocateTurnIndex(), userMessageEntry },
      () => turnRuntime.shouldAbort(),
    )
  } catch (error) {
    const rolledBack = applyFailedTurnRollback({
      messages,
      messageCountBefore,
      onRollback: () => {
        deps.bus?.emit('session:update', {
          sessionId: sessionData.id,
          event: 'message_rollback',
          messageCount: messages.length,
        })
      },
      onPartialFailure: () => {
        deps.bus?.emit('session:update', {
          sessionId: sessionData.id,
          event: 'message_partial_failure',
          messageCount: messages.length,
        })
      },
    })

    if (error instanceof Error) {
      ;(error as Error & { rolledBack?: boolean }).rolledBack = rolledBack
    }
    throw error
  }
}

async function retrieveSessionMemories(options: {
  activeModel?: ResolvedModel
  agentConfig: AgentConfig | null
  agentName: string
  data: {
    id: string
    reasoningEffort?: ReasoningEffort
  }
  deps: SessionDeps
  injectedMemoryIds: Map<string, string>
  logger: ToolLogger
  modelRouter: ModelRouter
  userMessage: string
}): Promise<string | undefined> {
  if ((options.agentConfig?.promptMode ?? 'full') !== 'full') return undefined

  const resolved =
    options.activeModel ??
    options.modelRouter.getDefaultModel() ??
    options.modelRouter.getCurrentModel()
  if (!resolved) return undefined

  const memories = await retrieveMemoriesWithDecision({
    adapter: resolved.adapter,
    sessionId: options.data.id,
    reasoningEffort: options.data.reasoningEffort ?? resolved.modelConfig.reasoningEffort,
    memoryRetriever: options.deps.memoryRetriever,
    identitySummary: options.deps.identityMemory ?? '',
    userMessage: options.userMessage,
    previouslyInjectedIds: options.injectedMemoryIds,
    logger: options.logger,
    failureEvent: 'memory_retrieval_failed',
    trace: {
      tracer: options.deps.tracer,
      agentName: options.agentName,
      providerName: resolved.providerName,
      modelLabel: options.modelRouter.getModelLabel(resolved),
      pricing: resolved.modelConfig.pricing,
      secretFilter: options.deps.secretFilter,
      spanName: 'memory_retrieval_decision',
      metadata: {
        layer: 'layer1',
      },
    },
  })
  if (!memories || memories.length === 0) return undefined

  for (const memory of memories) {
    options.injectedMemoryIds.set(memory.id, memory.title)
  }

  return buildRetrievedMemoriesBlock(memories)
}
