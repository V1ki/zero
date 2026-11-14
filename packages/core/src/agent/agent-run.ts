import { createHash } from 'node:crypto'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompactionTrigger,
  CompletionRequest,
  ContextCheckpoint,
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
  type AgentLoopModule,
  type ToolExecutionResult,
} from './agent-loop'
import { prepareRequestMessages } from './compaction'
import { assembleRequest } from './request-assembly'

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
  meta?: CompletionRequest['meta']
  /** Request meta that changes during the run; takes precedence over `meta`. */
  getMeta?: AgentLoopConfig['getMeta']
  system: string
  prompt: string
  /** Images of the prompt. */
  userImages?: Array<{ mediaType: string; data: string }>
  /** The prompt as an already built message (its id and time), instead of `prompt`. */
  userMessageEntry?: Message
  /** Canonical history. The request carries `prepareRequestMessages(history, checkpoint)`. */
  history?: Message[]
  /** Checkpoint of `history` when the run starts. */
  checkpoint?: ContextCheckpoint
  /** Provider cleanup of the history (signed thinking before tool use), recorded in `loop/start`. */
  requireThinkingForToolUse?: boolean
  /** The caller's modules, in the order the merge rules apply them. */
  modules?: AgentLoopModule[]
  transientRetryDelayMs?: AgentLoopConfig['transientRetryDelayMs']
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
   * Session events of this run, in a file of its own that holds no messages yet. The base writes
   * `system/prompt`, `tools/set`, then `history` as message events, then `loop/start`, before the
   * loop writes its steps, tool calls and messages, so every request can be rebuilt from the file
   * even when the caller built `history` from records that expire. Replay passes that history
   * through `prepareRequestMessages`, so it must be history that leaves unchanged: no notification
   * messages and nothing between a tool call and its result. A response or tool result that
   * lands after the run stopped is still written: it happened, even though the caller no longer
   * receives it.
   */
  journal?: AgentLoopJournal
  /**
   * The journal's file is the session's own and already holds the system prompt, the tool set and
   * `history` (written when they changed and when the messages were made): the base writes only
   * `loop/start`.
   */
  historyLogged?: boolean
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

  const requireThinkingForToolUse = options.requireThinkingForToolUse ?? false
  if (options.journal && !options.historyLogged) {
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
    ])
    for (const message of options.history ?? [])
      options.journal.events.appendMessage(options.sessionId, message)
  }
  // The request history is the canonical projection at this point, before the loop's compaction.
  options.journal?.events.append(options.sessionId, [
    { type: 'loop/start', data: { requireThinkingForToolUse } },
  ])

  const modules = options.modules ?? []
  const history = options.history ?? []
  let checkpoint = options.checkpoint
  const compact = async (canonical: Message[], trigger: CompactionTrigger) => {
    let changed = false
    for (const module of modules) {
      const next = await module.compact?.(canonical, trigger, checkpoint)
      if (!next) continue
      checkpoint = next
      changed = true
    }
    return changed
  }
  await compact(history, 'turn_start')
  const requestBase = { checkpoint, requireThinkingForToolUse }
  const toolNames = (options.tools ?? []).map((tool) => tool.name)

  const loop = new AgentLoop(
    {
      adapter: options.adapter,
      sessionId: options.sessionId,
      journal: options.journal,
      modules,
      meta: options.meta,
      getMeta: options.getMeta,
      transientRetryDelayMs: options.transientRetryDelayMs,
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
      async afterToolResults(ctx) {
        await hooks.afterToolResults?.(ctx)
        // In-turn compaction: canonical = the run's history and its new messages. A new checkpoint
        // rebuilds the request with assembleRequest, which puts back what is only in the request.
        if (!(await compact([...history, ...ctx.newMessages], 'in_turn'))) return
        ctx.requestEntries.push({ kind: 'checkpoint', checkpoint: checkpoint ?? null })
        const rebuilt = assembleRequest({
          systemPrompt: options.system,
          toolNames,
          history,
          ...requestBase,
          entries: ctx.requestEntries,
        })
        ctx.messages.splice(0, ctx.messages.length, ...rebuilt.messages)
      },
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
      loop.run(
        options.prompt,
        prepareRequestMessages(history, checkpoint, { requireThinkingForToolUse }),
        options.userImages,
        options.userMessageEntry,
      ),
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
