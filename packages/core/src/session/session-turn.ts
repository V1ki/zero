import { createHash } from 'node:crypto'
import { type RetrievedMemoryMatch, detectMemoryEcho } from '@zero-os/memory'
import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type { RequestMemoryInjectionEntry } from '@zero-os/observe'
import type {
  Message,
  ReasoningEffort,
  Session as SessionData,
  SessionTrigger,
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
  ensureToolsSetEvent(deps, sessionData.id, toolNames)
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

  const [newSkills, memoryInjection] = await Promise.all([
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
    retrievedMemories: memoryInjection.block,
  })
  const requestMemoryInjections: RequestMemoryInjectionEntry[] | undefined = memoryInjection.block
    ? [
        {
          layer: 'layer1',
          source: 'retrieved_memories',
          formattedText: wrapMemoryInjection('layer1', memoryInjection.block),
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
  const turnIndex = turnRuntime.allocateTurnIndex()
  const turnStartedAt = Date.now()
  deps.sessionEvents?.append(sessionData.id, [
    {
      type: 'turn/start',
      data: {
        turnIndex,
        trigger: deriveTurnTrigger(options),
        model: activeModel ? modelRouter.getModelLabel(activeModel) : undefined,
        agentName: getAgentName(),
        baseSeq: deps.sessionEvents.getLastSeq(sessionData.id) ?? undefined,
      },
    },
  ])
  try {
    const turnMessages = await agent.run(
      context,
      content,
      imageDelegationFiles?.length ? undefined : options?.images,
      onNewMessage,
      onTextDelta,
      () => turnRuntime.shouldInterrupt(),
      () => turnRuntime.drainQueuedMessages(),
      { turnIndex, userMessageEntry },
      () => turnRuntime.shouldAbort(),
    )
    deps.sessionEvents?.append(sessionData.id, [
      {
        type: 'turn/end',
        data: { turnIndex, status: 'completed', durationMs: Date.now() - turnStartedAt },
      },
    ])
    recordMemoryEchoUsage({
      recorder: deps.memoryUsage,
      sessionId: sessionData.id,
      userMessage: content,
      injectedMemories: memoryInjection.memories,
      turnMessages,
    })
    return turnMessages
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
    deps.sessionEvents?.append(sessionData.id, [
      {
        type: 'turn/end',
        data: { turnIndex, status: 'failed', durationMs: Date.now() - turnStartedAt },
      },
    ])
    throw error
  }
}

/** 工具集是 model-visible 请求输入:名字列表变化时落一条 tools/set 事件 */
function ensureToolsSetEvent(deps: SessionDeps, sessionId: string, toolNames: string[]): void {
  const store = deps.sessionEvents
  if (!store || toolNames.length === 0) return

  const hash = `sha256:${createHash('sha256').update(JSON.stringify(toolNames)).digest('hex')}`
  if (store.getToolSet(sessionId)?.hash === hash) return

  store.append(sessionId, [
    { type: 'tools/set', data: { hash, toolNames: [...toolNames], count: toolNames.length } },
  ])
}

function deriveTurnTrigger(options?: HandleMessageOptions): SessionTrigger {
  if (options?.messageType === 'control') return 'control'
  if (options?.messageType === 'queued') return 'queued_drain'
  return 'channel'
}

interface SessionMemoryInjection {
  block?: string
  memories: RetrievedMemoryMatch[]
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
}): Promise<SessionMemoryInjection> {
  if ((options.agentConfig?.promptMode ?? 'full') !== 'full') {
    return { block: undefined, memories: [] }
  }

  const resolved =
    options.activeModel ??
    options.modelRouter.getDefaultModel() ??
    options.modelRouter.getCurrentModel()
  if (!resolved) return { block: undefined, memories: [] }

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
    sessionEvents: options.deps.sessionEvents,
    layer: 'layer1',
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
  if (!memories || memories.length === 0) return { block: undefined, memories: [] }

  for (const memory of memories) {
    options.injectedMemoryIds.set(memory.id, memory.title)
    // S1 使用反馈:记"被注入"观测账(injected 不进评分,只作后续归因的基数)
    options.deps.memoryUsage?.record(memory.id, 'injected', options.data.id)
  }

  return { block: buildRetrievedMemoriesBlock(memories), memories }
}

// S3 使用反馈:turn 成功结束后做回声检测——注入记忆的特征词出现在本 turn
// 助手输出(文本+工具调用入参)里即记 used。纯计算且 best-effort,绝不影响主流程。
function recordMemoryEchoUsage(options: {
  recorder: SessionDeps['memoryUsage']
  sessionId: string
  userMessage: string
  injectedMemories: RetrievedMemoryMatch[]
  turnMessages: Message[]
}): void {
  const { recorder } = options
  if (!recorder || options.injectedMemories.length === 0) return

  try {
    const outputText = options.turnMessages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .map((block) => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool_use') return `${block.name} ${JSON.stringify(block.input)}`
        return ''
      })
      .join('\n')

    const usedIds = detectMemoryEcho(
      options.injectedMemories.map((memory) => ({
        id: memory.id,
        text: `${memory.title}\n${memory.content}`,
      })),
      { userMessage: options.userMessage, outputText },
    )
    for (const id of usedIds) {
      recorder.record(id, 'used', options.sessionId)
    }
  } catch {
    // best-effort:回声检测失败静默跳过
  }
}
