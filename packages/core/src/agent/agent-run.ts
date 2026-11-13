import { createHash } from 'node:crypto'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  LoopRunnerUsage,
  LoopToolCallRecord,
  Message,
  ReasoningEffort,
  ToolDefinition,
} from '@zero-os/shared'
import {
  AgentLoop,
  type AgentLoopConfig,
  type AgentLoopHooks,
  type AgentLoopJournal,
  type ToolExecutionResult,
} from './agent-loop'

/** Like `ToolExecutor`, but each call also receives the run's stop signal (timeout or caller abort). */
export interface AgentLoopRunToolExecutor {
  has(toolName: string): boolean
  execute(
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>
}

export interface AgentLoopRunOptions {
  adapter: ProviderAdapter
  sessionId: string
  meta: CompletionRequest['meta']
  system: string
  prompt: string
  history?: Message[]
  tools?: ToolDefinition[]
  toolExecutor?: AgentLoopRunToolExecutor
  maxIterations?: number
  /**
   * Tool-call budget for the whole run. A batch is rejected before its first call executes when it
   * would exceed this count, or when it arrives on the last allowed iteration and so would leave no
   * step for an answer.
   */
  maxToolCalls?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  stream?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  logger: AgentLoopConfig['logger']
  /**
   * Session events of this run. The base writes `system/prompt`, `tools/set` and `loop/start`
   * before the loop writes its steps, tool calls and messages, so every request can be rebuilt
   * from the file. The file must already hold exactly `history` as its canonical messages; a run
   * without history takes a new file. A response or tool result that lands after the run stopped
   * is still written: it happened, even though the caller no longer receives it.
   */
  journal?: AgentLoopJournal
  /**
   * Caller policy. `onCompletionEnd`, `onToolCallStart`, `onToolCallEnd` and `shouldAbort` are
   * composed with the base's bookkeeping; every other hook is passed to `AgentLoop` unchanged.
   * Once the run has stopped, tool calls that finish late are neither recorded nor reported.
   */
  hooks?: AgentLoopHooks
}

export interface AgentLoopRun {
  /** New messages of this run, starting with the prompt. */
  messages: Message[]
  /** Text of the last assistant message, or '' when there is none. */
  finalText: string
  toolCalls: LoopToolCallRecord[]
  usage: LoopRunnerUsage
  durationMs: number
}

export type AgentLoopStopReason = 'timeout' | 'cancelled' | 'tool_budget'

/** The run was stopped by the base. Callers decide how to word each reason for their users. */
export class AgentLoopStoppedError extends Error {
  constructor(readonly reason: AgentLoopStopReason) {
    super(`Agent loop stopped: ${reason}`)
    this.name = 'AgentLoopStoppedError'
  }
}

/** Runs one `AgentLoop` with usage, tool-call and final-text bookkeeping plus timeout and budgets. */
export async function runAgentLoop(options: AgentLoopRunOptions): Promise<AgentLoopRun> {
  const startedAt = Date.now()
  const { hooks = {}, toolExecutor, maxIterations, maxToolCalls } = options
  const timeout =
    options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
  const stop = AbortSignal.any([options.signal, timeout].filter((signal) => signal !== undefined))
  const stopped = () => new AgentLoopStoppedError(timeout?.aborted ? 'timeout' : 'cancelled')
  if (stop.aborted) throw stopped()

  const usage = { input: 0, output: 0 }
  const toolCalls: LoopToolCallRecord[] = []
  let acceptedToolCalls = 0

  if (options.journal) {
    const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
    const toolNames = (options.tools ?? []).map((tool) => tool.name)
    options.journal.events.append(options.sessionId, [
      {
        type: 'system/prompt',
        data: {
          hash: sha256(options.system),
          chars: options.system.length,
          content: options.system,
        },
      },
      {
        type: 'tools/set',
        data: { hash: sha256(JSON.stringify(toolNames)), toolNames, count: toolNames.length },
      },
      // History goes to the adapter as given, without the signed-thinking cleanup.
      { type: 'loop/start', data: { requireThinkingForToolUse: false } },
    ])
  }

  const loop = new AgentLoop(
    {
      adapter: options.adapter,
      sessionId: options.sessionId,
      journal: options.journal,
      meta: options.meta,
      system: options.system,
      tools: options.tools ?? [],
      toolExecutor: toolExecutor
        ? {
            has: (name) => toolExecutor.has(name),
            execute: (name, toolUseId, input) => toolExecutor.execute(name, toolUseId, input, stop),
          }
        : {
            has: () => false,
            execute: () => {
              throw new Error('No tool executor was supplied')
            },
          },
      maxIterations,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      stream: options.stream,
      logger: options.logger,
    },
    {
      ...hooks,
      shouldAbort: (ctx) => stop.aborted || (hooks.shouldAbort?.(ctx) ?? false),
      onCompletionEnd(request, response, durationMs, ctx) {
        if (stop.aborted) throw stopped()
        usage.input += response.usage.input
        usage.output += response.usage.output
        hooks.onCompletionEnd?.(request, response, durationMs, ctx)
        if (maxToolCalls === undefined) return
        const calls = response.content.filter((block) => block.type === 'tool_use').length
        if (!calls) return
        // Reject the entire batch before the first call when the model cannot finish within budget.
        if (
          (maxIterations !== undefined && ctx.iteration >= maxIterations) ||
          acceptedToolCalls + calls > maxToolCalls
        )
          throw new AgentLoopStoppedError('tool_budget')
        acceptedToolCalls += calls
      },
      onToolCallStart(toolName, toolUseId, input, ctx) {
        if (stop.aborted) throw stopped()
        hooks.onToolCallStart?.(toolName, toolUseId, input, ctx)
      },
      onToolCallEnd(toolName, toolUseId, input, result, durationMs, ctx) {
        if (stop.aborted) return
        toolCalls.push({ name: toolName, input, output: result.output })
        hooks.onToolCallEnd?.(toolName, toolUseId, input, result, durationMs, ctx)
      },
    },
  )

  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => cancelled.reject(stopped())
  stop.addEventListener('abort', onAbort, { once: true })
  try {
    // Adapters own their transport. A completion that lands after the stop must never be returned.
    const messages = await Promise.race([
      loop.run(options.prompt, options.history ?? []),
      cancelled.promise,
    ])
    const finalText =
      messages
        .findLast((message) => message.role === 'assistant')
        ?.content.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? ''
    return { messages, finalText, toolCalls, usage, durationMs: Date.now() - startedAt }
  } finally {
    stop.removeEventListener('abort', onAbort)
  }
}
