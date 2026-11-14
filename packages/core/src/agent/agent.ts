import type { ProviderAdapter } from '@zero-os/model'
import type { UsagePurpose } from '@zero-os/observe'
import type { Message, ToolContext, ToolResult } from '@zero-os/shared'
import { isAbortableTool, now, toErrorMessage } from '@zero-os/shared'
import type { ToolRegistry } from '../tool/registry'
import { createAgentLoopHooks } from './agent-hooks'
import type { ToolExecutor } from './agent-loop'
import { runAgentLoop } from './agent-run'
import { AgentTraceRecorder } from './agent-trace'
import type { AgentConfig, AgentContext, AgentObservability } from './agent-types'
import { closureModule } from './modules/closure'
import { compactionModule } from './modules/compaction'
import { memoryModule } from './modules/memory'
import { queueModule } from './modules/queue'
import { requestContextModule } from './modules/request-context'
import type { QueuedMessage } from './queue'
import { composeSystemPrompt } from './request-assembly'

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

    const system = composeSystemPrompt(context.systemPrompt, context.identityMemory)

    const requireThinkingForToolUse = this.adapter.apiType === 'anthropic-deepseek'

    const executionState = {
      currentRequestId: undefined as string | undefined,
      currentTraceSpanId: undefined as string | undefined,
    }
    const baseUsagePurpose: UsagePurpose = this.obs.usagePurpose ?? 'agent_loop'

    try {
      const {
        hooks: loopHooks,
        journal,
        requestSpanId,
        traceModule,
      } = createAgentLoopHooks({
        config: this.config,
        toolContext: this.toolContext,
        obs: this.obs,
        context,
        userMessage,
        onNewMessage: (message) => {
          emittedMessageCount++
          onNewMessage?.(message)
        },
        onTextDelta,
        turnIndex,
        rootSpanId: rootSpan?.id,
        executionState,
        traceRecorder,
      })
      loopHooks.shouldAbort = shouldAbort

      const toolExecutor = createAgentToolExecutor({
        toolRegistry: this.toolRegistry,
        toolContext: this.toolContext,
        executionState,
      })
      const { messages: newMessages } = await runAgentLoop({
        adapter: this.adapter,
        sessionId: this.toolContext.sessionId,
        journal,
        // 会话自己的事件文件:系统提示词、工具集和历史已在变化时与消息产生时写入,基座只写 loop/start
        historyLogged: true,
        history: context.conversationHistory,
        checkpoint: context.checkpoint,
        requireThinkingForToolUse,
        modules: [
          requestContextModule(context),
          compactionModule({
            sessionId: this.toolContext.sessionId,
            context,
            system,
            adapter: this.contextCompactionAdapter,
            modelLabel: this.obs.contextCompactionModelLabel ?? this.obs.closureModelLabel,
            providerName:
              this.obs.contextCompactionProviderName ??
              this.obs.closureProviderName ??
              this.obs.providerName,
            pricing:
              this.obs.contextCompactionPricing ?? this.obs.closurePricing ?? this.obs.pricing,
            parentSessionId: this.obs.parentSessionId,
            agentName: this.config.name,
            tracer: this.obs.tracer,
            secretFilter: this.obs.secretFilter,
            events: this.obs.sessionEvents,
            logger: this.toolContext.logger,
            parentSpanId: (trigger) => (trigger === 'turn_start' ? rootSpan?.id : requestSpanId()),
          }),
          queueModule({
            sessionId: this.toolContext.sessionId,
            logger: this.toolContext.logger,
            events: this.obs.sessionEvents,
            shouldInterrupt,
            getQueuedMessages,
          }),
          closureModule({
            config: this.config,
            closureAdapter: this.closureAdapter,
            toolContext: this.toolContext,
            obs: this.obs,
            context,
            userMessage,
            turnIndex,
            requestSpanId,
          }),
          memoryModule({
            config: this.config,
            adapter: this.adapter,
            toolContext: this.toolContext,
            obs: this.obs,
            context,
            userMessage,
            turnIndex,
            requestSpanId,
          }),
          traceModule,
        ],
        toolExecutor: {
          has: (name) => toolExecutor.has(name),
          execute: (name, toolUseId, input) => toolExecutor.execute(name, toolUseId, input),
        },
        system,
        prompt: userMessage,
        userImages,
        userMessageEntry: requestLogMeta?.userMessageEntry,
        tools: context.tools,
        maxOutputTokens: context.maxOutput ?? 16384,
        reasoningEffort: context.reasoningEffort,
        stream: true,
        logger: this.toolContext.logger,
        transientRetryDelayMs: this.transientRetryDelayMs.bind(this),
        getMeta: (ctx) => ({
          sessionId: this.toolContext.sessionId,
          // 只进请求的阶段(记忆提醒)按它的原因记 usage 用途
          purpose: ctx.requestOnly() ?? baseUsagePurpose,
          ...(this.obs.parentSessionId ? { parentSessionId: this.obs.parentSessionId } : {}),
        }),
        hooks: loopHooks,
      })

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

// wait_agent exists to hold the turn until sub-agents settle; backgrounding
// it would detach the wait from the turn and emit a background_tool.completed
// message on every timeout, so it always runs in the foreground.
// A worker steer call also waits for acknowledgement before reporting success.
function runsInForeground(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === 'wait_agent' || (toolName === 'worker' && input.action === 'steer')
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
        abortable: isAbortableTool(toolName, input.action),
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

      if (!backgroundTasks || runsInForeground(toolName, input)) {
        return runTool()
      }

      const managed = await backgroundTasks.run({
        toolName,
        toolUseId,
        inputSummary: summarizeToolInput(executionInput, options.toolContext),
        workDir: options.toolContext.workDir,
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
