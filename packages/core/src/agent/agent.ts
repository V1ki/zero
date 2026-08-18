import type { ProviderAdapter } from '@zero-os/model'
import type { UsagePurpose } from '@zero-os/observe'
import type { Message, ToolContext, ToolResult } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import type { ToolRegistry } from '../tool/registry'
import { createAgentLoopHooks } from './agent-hooks'
import { AgentLoop, type ToolExecutor } from './agent-loop'
import { AgentTraceRecorder } from './agent-trace'
import type { AgentConfig, AgentContext, AgentObservability } from './agent-types'
import { generateContextCompaction } from './compress'
import {
  type EpisodeCompactionTraceEvent,
  prepareConversationHistoryWithCompaction,
} from './context'
import type { QueuedMessage } from './queue'

const BACKGROUND_BASH_TIMEOUT_MS = 60 * 60 * 1000

export type { AgentConfig, AgentContext, AgentObservability } from './agent-types'

/**
 * Agent execution engine — runs the tool use loop.
 */
export class Agent {
  private config: AgentConfig
  private adapter: ProviderAdapter
  private closureAdapter: ProviderAdapter
  private contextCompactionAdapter: ProviderAdapter
  private toolRegistry: ToolRegistry
  private toolContext: ToolContext
  private obs: AgentObservability

  constructor(
    config: AgentConfig,
    adapter: ProviderAdapter,
    toolRegistry: ToolRegistry,
    toolContext: ToolContext,
    obs: AgentObservability = {},
    closureAdapter?: ProviderAdapter,
    contextCompactionAdapter?: ProviderAdapter,
  ) {
    this.config = config
    this.adapter = adapter
    this.closureAdapter = closureAdapter ?? adapter
    this.contextCompactionAdapter = contextCompactionAdapter ?? closureAdapter ?? adapter
    this.toolRegistry = toolRegistry
    this.toolContext = toolContext
    this.obs = obs
  }

  /**
   * Run the agent's tool-use loop until completion or max loops reached.
   */
  async run(
    context: AgentContext,
    userMessage: string,
    userImages?: Array<{ mediaType: string; data: string }>,
    onNewMessage?: (msg: Message) => void,
    onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void,
    shouldInterrupt?: () => boolean,
    getQueuedMessages?: () => QueuedMessage[],
    requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
    shouldAbort?: () => boolean,
  ): Promise<Message[]> {
    const turnIndex = requestLogMeta?.turnIndex ?? 1
    const episodeCompactionEvents: EpisodeCompactionTraceEvent[] = []
    let emittedMessageCount = 0

    const rootSpan = this.obs.tracer?.startSpan(
      this.toolContext.sessionId,
      `turn:${this.config.name}`,
      this.toolContext.currentTraceSpanId,
      {
        kind: 'turn',
        agentName: this.config.name,
        data: { turnIndex },
      },
    )
    const traceRecorder = this.createTraceRecorder()
    const history = await prepareConversationHistoryWithCompaction(context.conversationHistory, {
      requireThinkingForToolUse: this.adapter.apiType === 'anthropic-deepseek',
      enableEpisodeCompaction: true,
      evidenceWorkDir: this.toolContext.workDir,
      sessionId: this.toolContext.sessionId,
      timelineCompactionBlocks: context.timelineCompactionBlocks,
      onTimelineCompactionBlocksChanged: context.onTimelineCompactionBlocksChanged,
      onEpisodeCompaction: (event) => episodeCompactionEvents.push(event),
      contextCompactor: (input) =>
        generateContextCompaction(input, {
          adapter: this.contextCompactionAdapter,
          sessionId: this.toolContext.sessionId,
          agentName: this.config.name,
          parentSpanId: rootSpan?.id,
          turnIndex,
          reasoningEffort: context.reasoningEffort,
          parentSessionId: this.obs.parentSessionId,
          modelLabel: this.obs.contextCompactionModelLabel ?? this.obs.closureModelLabel,
          providerName:
            this.obs.contextCompactionProviderName ??
            this.obs.closureProviderName ??
            this.obs.providerName,
          pricing: this.obs.contextCompactionPricing ?? this.obs.closurePricing ?? this.obs.pricing,
          tracer: this.obs.tracer,
          secretFilter: this.obs.secretFilter,
          logger: this.toolContext.logger,
        }),
    })

    for (const event of episodeCompactionEvents) {
      traceRecorder.recordEpisodeCompactionTrace(event, rootSpan?.id, turnIndex)
    }

    const systemParts: string[] = [context.systemPrompt]
    if (context.identityMemory) systemParts.push(context.identityMemory)
    const system = systemParts.join('\n\n')

    const executionState = {
      currentRequestId: undefined as string | undefined,
      currentTraceSpanId: undefined as string | undefined,
    }
    const requestPurposeRef: { current: UsagePurpose } = {
      current: this.obs.usagePurpose ?? 'agent_loop',
    }

    try {
      const loopHooks = createAgentLoopHooks({
        config: this.config,
        adapter: this.adapter,
        closureAdapter: this.closureAdapter,
        toolContext: this.toolContext,
        obs: this.obs,
        context,
        userMessage,
        onNewMessage: (message) => {
          emittedMessageCount++
          onNewMessage?.(message)
        },
        onTextDelta,
        shouldInterrupt,
        getQueuedMessages,
        turnIndex,
        rootSpanId: rootSpan?.id,
        executionState,
        requestPurposeRef,
        traceRecorder,
      })
      loopHooks.shouldAbort = shouldAbort

      const loop = new AgentLoop(
        {
          adapter: this.adapter,
          sessionId: this.toolContext.sessionId,
          toolExecutor: createAgentToolExecutor({
            toolRegistry: this.toolRegistry,
            toolContext: this.toolContext,
            executionState,
          }),
          system,
          tools: context.tools,
          maxOutputTokens: context.maxOutput ?? 16384,
          reasoningEffort: context.reasoningEffort,
          stream: true,
          logger: this.toolContext.logger,
          transientRetryDelayMs: this.transientRetryDelayMs.bind(this),
          getMeta: () => ({
            sessionId: this.toolContext.sessionId,
            purpose: requestPurposeRef.current,
            ...(this.obs.parentSessionId ? { parentSessionId: this.obs.parentSessionId } : {}),
          }),
        },
        loopHooks,
      )

      const newMessages = await loop.run(
        userMessage,
        history,
        userImages,
        requestLogMeta?.userMessageEntry,
      )

      if (rootSpan) {
        this.obs.tracer?.endSpan(rootSpan.id, 'success', {
          messageCount: emittedMessageCount,
        })
      }

      return newMessages
    } catch (error) {
      if (rootSpan) {
        this.obs.tracer?.endSpan(rootSpan.id, 'error', {
          error: toErrorMessage(error),
          messageCount: emittedMessageCount,
        })
      }
      throw error
    }
  }

  /** Backoff delay for transient retries. Override in tests to avoid real waits. */
  protected transientRetryDelayMs(attempt: number): number {
    return Math.min(5_000 * 2 ** (attempt - 1), 60_000) // 5s, 10s, 20s, 40s, 60s cap
  }

  private createTraceRecorder(): AgentTraceRecorder {
    return new AgentTraceRecorder({
      sessionId: this.toolContext.sessionId,
      agentName: this.config.name,
      spawnedByRequestId: this.toolContext.spawnedByRequestId,
      logger: this.toolContext.logger,
      tracer: this.obs.tracer,
      secretFilter: this.obs.secretFilter,
      providerName: this.obs.providerName,
      modelLabel: this.obs.modelLabel,
      pricing: this.obs.pricing,
      getCurrentSnapshotId: this.obs.getCurrentSnapshotId,
    })
  }
}

interface AgentExecutionState {
  currentRequestId?: string
  currentTraceSpanId?: string
}

function createAgentToolExecutor(options: {
  toolRegistry: ToolRegistry
  toolContext: ToolContext
  executionState: AgentExecutionState
}): ToolExecutor {
  return {
    has: (toolName) => options.toolRegistry.has(toolName),
    execute: async (toolName, toolUseId, input) => {
      const tool = options.toolRegistry.get(toolName)
      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`)
      }

      const runningToolHandle = options.toolContext.runningToolRegistry?.register({
        toolUseId,
        toolName,
        abortable: toolName === 'bash',
      })
      const backgroundTasks = options.toolContext.backgroundToolTasks
      const executionInput = prepareToolInputForBackgroundExecution(toolName, input, {
        backgroundEnabled: !!backgroundTasks,
      })
      const toolContext: ToolContext = {
        ...options.toolContext,
        currentRequestId: options.executionState.currentRequestId,
        currentTraceSpanId: options.executionState.currentTraceSpanId,
        currentToolUseId: toolUseId,
        tracer: options.toolContext.tracer,
      }

      const runTool = async (): Promise<ToolResult> => {
        const result = await tool.run(toolContext, executionInput)
        runningToolHandle?.markFinished({
          finishedAt: now(),
          cause: 'completed',
          success: result.success,
          outputSummary: result.outputSummary,
        })
        return result
      }

      if (!backgroundTasks) {
        return runTool()
      }

      const managed = await backgroundTasks.run({
        toolName,
        toolUseId,
        inputSummary: summarizeToolInput(executionInput, options.toolContext),
        execute: runTool,
      })

      // Sub-agent wait mode: when a bash execution moves to the background,
      // await its completion in place so the agent turn loop does not end
      // with pending background tasks (premature "completed" states).
      if (
        managed.backgroundTaskId &&
        toolContext.backgroundTaskWait &&
        backgroundTasks.waitForCompletion
      ) {
        const completed = await backgroundTasks.waitForCompletion(managed.backgroundTaskId)
        runningToolHandle?.markFinished({
          finishedAt: now(),
          cause: 'completed',
          success: completed.success,
          outputSummary: completed.outputSummary,
        })
        return completed
      }
      return managed
    },
  }
}

function prepareToolInputForBackgroundExecution(
  toolName: string,
  input: Record<string, unknown>,
  options: { backgroundEnabled: boolean },
): Record<string, unknown> {
  if (!options.backgroundEnabled || toolName !== 'bash' || 'timeout' in input) {
    return input
  }

  return {
    ...input,
    timeout: BACKGROUND_BASH_TIMEOUT_MS,
  }
}

function summarizeToolInput(input: Record<string, unknown>, context: ToolContext): string {
  let summary: string
  try {
    summary = JSON.stringify(input)
  } catch {
    summary = '[unserializable tool input]'
  }
  return context.secretFilter?.filter(summary) ?? summary
}
