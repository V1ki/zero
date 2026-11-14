import { createHash } from 'node:crypto'
import type { RequestMemoryInjectionEntry, RequestToolResultEntry } from '@zero-os/observe'
import type { ContentBlock, Message, ToolContext, ToolResult } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import type { AgentLoopHooks, AgentLoopJournal, AgentLoopModule, QueueTaken } from './agent-loop'
import type { AgentTraceRecorder } from './agent-trace'
import {
  cloneMemoryInjections,
  extractTextFromMessage,
  filterContent,
  filterToolInput,
  filterTraceValue,
  stringifyTraceData,
  toRequestToolResults,
} from './agent-trace'
import type { AgentConfig, AgentContext, AgentObservability } from './agent-types'
import { type QueuedInjectionTrace, formatAppliedQueuedIntent } from './queue'
import { attachLargeToolUseEvidence } from './tool-evidence'
import { artifactizeToolOutput } from './truncate'

export interface CreateAgentLoopHooksOptions {
  config: AgentConfig
  toolContext: ToolContext
  obs: AgentObservability
  context: AgentContext
  userMessage: string
  onNewMessage?: (msg: Message) => void
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  turnIndex: number
  rootSpanId?: string
  executionState: {
    currentRequestId?: string
    currentTraceSpanId?: string
  }
  traceRecorder: AgentTraceRecorder
}

export function createAgentLoopHooks(options: CreateAgentLoopHooksOptions): {
  hooks: AgentLoopHooks
  /** loop 写 step、tool、消息事件的入口;没有事件流句柄时为 undefined */
  journal: AgentLoopJournal | undefined
  /** 当前模型请求的 trace span,压缩记在它下面 */
  requestSpanId(): string | undefined
  /** trace 在模块扩展点上的部分(排队取走时的 span 与 bus),放在模块数组最后 */
  traceModule: AgentLoopModule
} {
  const {
    config,
    toolContext,
    obs,
    context,
    userMessage,
    turnIndex,
    rootSpanId,
    executionState,
    traceRecorder,
  } = options

  // 排队消息进入请求的事实:trace 记下它和拼进来的原文的长度
  let pendingQueuedInjection: QueuedInjectionTrace | undefined
  let appliedQueuedIntentText: string | undefined

  const llmRequestHooks = createAgentLLMRequestHooks({
    config,
    toolContext,
    obs,
    userMessage,
    turnIndex,
    rootSpanId,
    executionState,
    traceRecorder,
    initialMemoryInjections: context.requestMemoryInjections,
    queueTrace: {
      getPendingInjection: () => pendingQueuedInjection,
      clearPendingInjection: () => {
        pendingQueuedInjection = undefined
      },
    },
  })

  const toolCallHooks = createAgentToolCallHooks({
    config,
    toolContext,
    obs,
    executionState,
    getCurrentRequestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
  })
  const hooks: AgentLoopHooks = {
    onNewMessage: (message, ctx) => {
      // 消息事件由 loop 在这之前写入:转给调用方的是 canonical 消息,只进请求的阶段不转
      if (!ctx.requestOnly()) options.onNewMessage?.(message)
      // 工具结果之后追加的 notification(记忆检索的 memory_hint)记进下一次请求的 trace
      if (message.role === 'user' && message.messageType === 'notification')
        llmRequestHooks.setPendingMemoryInjections([
          {
            layer: 'layer2',
            source: 'memory_hint',
            formattedText: extractTextFromMessage(message),
          },
        ])

      if (message.role === 'assistant') {
        obs.bus?.emit('session:update', {
          sessionId: toolContext.sessionId,
          event: 'assistant_response',
          model: message.model,
        })
      }
    },
    filterAssistantContent: (content) =>
      filterAssistantContentWithEvidence({
        content,
        obs,
        requestId: executionState.currentRequestId,
        toolContext,
        traceRecorder,
        traceSpanId: llmRequestHooks.getCurrentRequestSpanId(),
        turnIndex,
      }),
    onCompletionStart: llmRequestHooks.onCompletionStart,
    onCompletionEnd: llmRequestHooks.onCompletionEnd,
    onCompletionError: llmRequestHooks.onCompletionError,
    onTextDelta: (delta, meta, ctx) => {
      if (!ctx.requestOnly()) options.onTextDelta?.(delta, meta)
    },
    onToolCallStart: toolCallHooks.onToolCallStart,
    onToolCallEnd: toolCallHooks.onToolCallEnd,
    processToolResults: async (toolResults) => {
      const toolResultBlocks = artifactizeToolResults({
        toolResults,
        toolNamesByUseId: toolCallHooks.toolNamesByUseId,
        toolContext,
        traceRecorder,
        sessionEvents: obs.sessionEvents,
        turnIndex,
        requestId: executionState.currentRequestId,
      })
      llmRequestHooks.setRequestToolResults(toRequestToolResults(toolResultBlocks))
      return { toolResultBlocks }
    },
  }

  const traceModule: AgentLoopModule = {
    onQueueTaken: (taken) => {
      const intentText = formatAppliedQueuedIntent(taken.queued)
      if (intentText)
        appliedQueuedIntentText = appliedQueuedIntentText
          ? `${appliedQueuedIntentText}\n${intentText}`
          : intentText
      pendingQueuedInjection = taken.injection
      if (!taken.continuation) return
      const phase = queueTracePhase(taken)
      const drainSpan = obs.tracer?.startSpan(
        toolContext.sessionId,
        'queue_gate_drain',
        llmRequestHooks.getCurrentRequestSpanId(),
        {
          kind: 'closure_decision',
          agentName: config.name,
          metadata: {
            phase,
            queueCount: taken.queued.length,
            wasDuringNudge: taken.wasRequestOnly,
            appliedQueuedIntentLength: appliedQueuedIntentText?.length ?? 0,
          },
        },
      )
      if (drainSpan) obs.tracer?.endSpan(drainSpan.id, 'success')
      obs.bus?.emit('session:update', {
        sessionId: toolContext.sessionId,
        event: 'queue_drain_on_interrupt',
        queueCount: taken.queued.length,
        wasDuringNudge: taken.wasRequestOnly,
        phase,
      })
    },
  }

  return {
    hooks,
    requestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
    traceModule,
    journal: obs.sessionEvents && {
      events: obs.sessionEvents,
      modelLabel: obs.modelLabel,
      secretFilter: obs.secretFilter,
      requestSpanId: () => llmRequestHooks.getCurrentRequestSpanId(),
      toolSpanId: (toolUseId) => toolCallHooks.getToolSpanId(toolUseId),
    },
  }
}

/** 排队检查点在 trace 里的名字,沿用搬出前的叫法:决定之前的检查按让位的模块命名 */
function queueTracePhase(taken: QueueTaken): string {
  if (taken.point === 'end_turn') return 'pre_closure'
  if (taken.point === 'after_evaluation') return 'post_classifier'
  if (taken.point === 'request_only_empty') return 'memory_nudge_empty'
  if (taken.point === 'before_decision') return `pre_${taken.decider}`
  return taken.point
}

interface ArtifactizeToolResultsOptions {
  toolResults: ContentBlock[]
  toolNamesByUseId: Map<string, string>
  toolContext: Pick<ToolContext, 'sessionId' | 'workDir' | 'logger'>
  traceRecorder: Pick<AgentTraceRecorder, 'logToolEvidence'>
  sessionEvents?: AgentObservability['sessionEvents']
  turnIndex: number
  requestId?: string
}

/** 超大的工具输出在进入 canonical 之前换成 artifact 引用,evidence 记进 trace,替换记 compaction/prune */
function artifactizeToolResults(options: ArtifactizeToolResultsOptions): ContentBlock[] {
  return options.toolResults.map((block) => {
    if (block.type !== 'tool_result') return block

    const toolName = options.toolNamesByUseId.get(block.toolUseId) ?? 'unknown_tool'
    const artifactized = artifactizeToolOutput(toolName, block.content, {
      workDir: options.toolContext.workDir,
      sessionId: options.toolContext.sessionId,
      toolUseId: block.toolUseId,
      outputSummary: block.outputSummary,
    })
    const { content, artifactPath, evidence } = artifactized

    if (artifactPath) {
      options.toolContext.logger.info('tool_output_artifactized', {
        tool: toolName,
        originalChars: block.content.length,
        artifactPath,
      })
    }
    if (evidence) {
      options.traceRecorder.logToolEvidence(evidence, {
        source: 'active_tool_result',
        reason: artifactized.evidenceReason ?? 'tool_result_output',
        turnIndex: options.turnIndex,
        requestId: options.requestId,
        artifactPath,
        originalChars: artifactized.originalChars,
        originalTokens: artifactized.originalTokens,
        promptTokenLimit: artifactized.promptTokenLimit,
        thresholdChars: artifactized.thresholdChars,
        inlineContentChars: content.length,
      })
    }
    if (artifactPath) {
      // 持久替换:canonical tool_result 由原文降级为 artifact 引用,落 prune 事件留证
      options.sessionEvents?.append(options.toolContext.sessionId, [
        {
          type: 'compaction/prune',
          data: {
            toolUseId: block.toolUseId,
            from: {
              chars: artifactized.originalChars ?? block.content.length,
              hash: `sha256:${createHash('sha256').update(block.content).digest('hex')}`,
            },
            to: { chars: content.length, mode: 'artifact_ref' },
            evidence,
          },
        },
      ])
    }

    return {
      ...block,
      content,
      ...(evidence ? { evidence } : {}),
    }
  })
}

interface CreateAgentLLMRequestHooksOptions {
  config: AgentConfig
  toolContext: ToolContext
  obs: AgentObservability
  userMessage: string
  turnIndex: number
  rootSpanId?: string
  executionState: {
    currentRequestId?: string
    currentTraceSpanId?: string
  }
  traceRecorder: AgentTraceRecorder
  initialMemoryInjections?: RequestMemoryInjectionEntry[]
  queueTrace: {
    getPendingInjection(): QueuedInjectionTrace | undefined
    clearPendingInjection(): void
  }
}

interface AgentLLMRequestHooks {
  getCurrentRequestSpanId(): string | undefined
  setRequestToolResults(results: RequestToolResultEntry[]): void
  setPendingMemoryInjections(memoryInjections: RequestMemoryInjectionEntry[]): void
  onCompletionStart: NonNullable<AgentLoopHooks['onCompletionStart']>
  onCompletionEnd: NonNullable<AgentLoopHooks['onCompletionEnd']>
  onCompletionError: NonNullable<AgentLoopHooks['onCompletionError']>
}

function createAgentLLMRequestHooks({
  config,
  toolContext,
  obs,
  userMessage,
  turnIndex,
  rootSpanId,
  executionState,
  traceRecorder,
  initialMemoryInjections,
  queueTrace,
}: CreateAgentLLMRequestHooksOptions): AgentLLMRequestHooks {
  let pendingParentRequestId: string | undefined
  let currentRequestToolResults: RequestToolResultEntry[] = []
  let pendingMemoryInjections = cloneMemoryInjections(initialMemoryInjections)
  let currentRequestSpanId: string | undefined

  return {
    getCurrentRequestSpanId: () => currentRequestSpanId,
    setRequestToolResults: (results) => {
      currentRequestToolResults = results
    },
    setPendingMemoryInjections: (memoryInjections) => {
      pendingMemoryInjections = cloneMemoryInjections(memoryInjections)
    },
    onCompletionStart: () => {
      const llmSpan = obs.tracer?.startSpan(toolContext.sessionId, 'llm_request', rootSpanId, {
        kind: 'llm_request',
        agentName: config.name,
        data: {
          turnIndex,
          parentId: pendingParentRequestId,
          spawnedByRequestId: toolContext.spawnedByRequestId,
        },
      })
      currentRequestSpanId = llmSpan?.id
    },
    onCompletionEnd: (request, response, durationMs) => {
      response.model = obs.modelLabel ?? response.model
      executionState.currentRequestId = response.id

      traceRecorder.logLLMRequest({
        request,
        response,
        userPrompt: userMessage,
        durationMs,
        meta: {
          turnIndex,
          parentId: pendingParentRequestId,
        },
        requestToolResults: currentRequestToolResults,
        queuedInjection: queueTrace.getPendingInjection(),
        memoryInjections: pendingMemoryInjections,
        traceSpanId: currentRequestSpanId,
      })

      currentRequestToolResults = []
      queueTrace.clearPendingInjection()
      pendingMemoryInjections = undefined
      pendingParentRequestId = response.stopReason === 'tool_use' ? response.id : undefined
    },
    onCompletionError: (request, error) => {
      obs.tracer?.logSession?.(toolContext.sessionId, 'error', 'llm_request.error', {
        traceSpanId: currentRequestSpanId,
        turnIndex,
        request: filterTraceValue(request, obs.secretFilter),
        error: toErrorMessage(error),
      })

      if (currentRequestSpanId) {
        obs.tracer?.updateSpan(currentRequestSpanId, {
          metadata: {
            error: toErrorMessage(error),
          },
        })
        obs.tracer?.endSpan(currentRequestSpanId, 'error')
      }
    },
  }
}

interface AgentToolCallHookState {
  currentRequestId?: string
  currentTraceSpanId?: string
}

interface CreateAgentToolCallHooksOptions {
  config: AgentConfig
  toolContext: ToolContext
  obs: AgentObservability
  executionState: AgentToolCallHookState
  getCurrentRequestSpanId: () => string | undefined
}

interface AgentToolCallHooks {
  toolNamesByUseId: Map<string, string>
  getToolSpanId(toolUseId: string): string | undefined
  onToolCallStart: (toolName: string, toolUseId: string, input: Record<string, unknown>) => void
  onToolCallEnd: (
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    result: ToolResult,
  ) => void
}

function createAgentToolCallHooks({
  config,
  toolContext,
  obs,
  executionState,
  getCurrentRequestSpanId,
}: CreateAgentToolCallHooksOptions): AgentToolCallHooks {
  const toolSpanIds = new Map<string, string>()
  const toolNamesByUseId = new Map<string, string>()

  return {
    toolNamesByUseId,
    getToolSpanId: (toolUseId) => toolSpanIds.get(toolUseId),
    onToolCallStart: (toolName, toolUseId, input) => {
      toolNamesByUseId.set(toolUseId, toolName)
      const filteredToolInput = filterToolInput(input, obs.secretFilter)

      obs.bus?.emit('tool:call', {
        sessionId: toolContext.sessionId,
        tool: toolName,
        toolUseId,
        input: filteredToolInput,
      })

      const toolSpan = obs.tracer?.startSpan(
        toolContext.sessionId,
        `tool:${toolName}`,
        getCurrentRequestSpanId(),
        {
          kind: 'tool_call',
          agentName: config.name,
          data: {
            tool: toolName,
            input: filteredToolInput,
            inputSummary: stringifyTraceData(filteredToolInput),
            requestId: executionState.currentRequestId,
          },
        },
      )

      if (toolSpan?.id) {
        toolSpanIds.set(toolUseId, toolSpan.id)
      }
      executionState.currentTraceSpanId = toolSpan?.id
    },
    onToolCallEnd: (toolName, toolUseId, input, result) => {
      const toolSpanId = toolSpanIds.get(toolUseId)
      const filteredToolInput = filterToolInput(input, obs.secretFilter)
      // span 只带有界载荷:完整工具 IO 不再重复写入 trace.jsonl/run.log
      const slimResult = slimToolResultForTrace(result)
      if (toolSpanId) {
        obs.tracer?.updateSpan(toolSpanId, {
          data: {
            input: filteredToolInput,
            toolResult: slimResult,
            outputSummary: result.outputSummary,
          },
          metadata: {
            toolUseId,
            toolName,
            input: filteredToolInput,
            result: slimResult,
            outputSummary: result.outputSummary,
          },
        })
        obs.tracer?.endSpan(toolSpanId, result.success ? 'success' : 'error', {
          toolUseId,
          toolName,
          input: filteredToolInput,
          toolResult: slimResult,
          outputSummary: result.outputSummary,
        })
      }
      obs.bus?.emit('tool:result', {
        sessionId: toolContext.sessionId,
        tool: toolName,
        success: result.success,
        outputSummary: result.outputSummary,
        ...(result.success ? {} : { error: result.outputSummary ?? result.output }),
      })

      executionState.currentTraceSpanId = undefined
      toolSpanIds.delete(toolUseId)
    },
  }
}

interface FilterAssistantContentOptions {
  content: Message['content']
  obs: Pick<AgentObservability, 'secretFilter'>
  requestId?: string
  toolContext: Pick<ToolContext, 'sessionId' | 'workDir'>
  traceRecorder: Pick<AgentTraceRecorder, 'logToolEvidence'>
  traceSpanId?: string
  turnIndex: number
}

function filterAssistantContentWithEvidence(
  options: FilterAssistantContentOptions,
): Message['content'] {
  return attachLargeToolUseEvidence(filterContent(options.content, options.obs.secretFilter), {
    workDir: options.toolContext.workDir,
    sessionId: options.toolContext.sessionId,
    onEvidence: (evidence, toolUse) => {
      options.traceRecorder.logToolEvidence(evidence, {
        source: 'active_tool_use',
        reason: 'large_tool_input',
        turnIndex: options.turnIndex,
        traceSpanId: options.traceSpanId,
        requestId: options.requestId,
        originalChars: JSON.stringify(toolUse.input).length,
      })
    },
  })
}

const TOOL_RESULT_PREVIEW_CHARS = 2048

/** span/事件载荷里的工具结果只保留有界预览;完整 IO 由 evidence 文件承载 */
function slimToolResultForTrace(result: ToolResult): Record<string, unknown> {
  const output = result.output ?? ''
  return {
    success: result.success,
    outputSummary: result.outputSummary,
    chars: output.length,
    output:
      output.length > TOOL_RESULT_PREVIEW_CHARS
        ? `${output.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n…[truncated ${output.length - TOOL_RESULT_PREVIEW_CHARS} chars]`
        : output,
    ...(result.backgroundTaskId ? { backgroundTaskId: result.backgroundTaskId } : {}),
  }
}
