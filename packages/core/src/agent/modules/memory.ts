import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import type { Tracer } from '@zero-os/observe'
import type { Message, ModelPricing, SecretFilter, ToolContext } from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import type { AgentLoopModule, FailedToolAttempt } from '../agent-loop'
import { extractTextFromMessage, filterTraceValue, stringifyTraceData } from '../agent-trace'
import type { AgentConfig, AgentContext, AgentObservability } from '../agent-types'
import { retrieveMemoriesWithDecision } from '../memory-retrieval'
import { CONTEXT_PARAMS } from '../params'
import { wrapMemoryInjection } from '../prompt'
import { buildLoopUserMessage } from '../queue'

/**
 * Memory: after a finished turn that wrote no memory, a nudge asks the model whether something is
 * worth recording. The nudge and its answers belong to the request only (`requestOnly`), so the
 * base writes them as `request/message`; queued messages the base takes end the nudge. A memory
 * written through the memory tool is recorded as `memory/recorded`. When tools fail, a layer-2
 * retrieval may add a `<memory_hint>` notification after the tool results.
 */
export function memoryModule(options: {
  config: AgentConfig
  adapter: ProviderAdapter
  toolContext: ToolContext
  obs: AgentObservability
  context: Pick<AgentContext, 'identityMemory' | 'injectedMemoryIds'>
  userMessage: string
  turnIndex: number
  /** Trace span of the current request. */
  requestSpanId(): string | undefined
}): AgentLoopModule {
  const { config, toolContext, obs, turnIndex } = options
  const sessionId = toolContext.sessionId
  const nudge = new AgentMemoryNudgeController({
    sessionId,
    agentName: config.name,
    tracer: obs.tracer,
  })

  return {
    name: 'memory_nudge',
    requestOnly: () => (nudge.isActive ? 'memory_nudge' : undefined),
    onQueueTaken: (taken) => {
      if (taken.continuation || taken.injection) nudge.interrupt()
      if (taken.point === 'request_only_empty')
        toolContext.logger.info?.('memory_nudge_interrupted_by_queue', {
          sessionId,
          phase: 'memory_nudge_empty',
        })
    },
    onNewMessage: (message) => {
      // 提醒的回复只进请求、不进会话记录,trace 是以后唯一能查到它的地方
      if (!nudge.isActive || message.role !== 'assistant') return
      const text = extractTextFromMessage(message).trim()
      if (text !== '')
        nudge.recordResponseText(obs.secretFilter ? obs.secretFilter.filter(text) : text)
    },
    onCompletionError: (error) => nudge.completeError(error),
    onToolCallEnd: (toolName, toolUseId, input, result) => {
      if (toolName !== 'memory' || !result.success) return
      const action =
        typeof input === 'object' && input !== null && 'action' in input
          ? (input as { action?: unknown }).action
          : undefined
      if (action !== 'create' && action !== 'update') return
      nudge.markMemoryWriteSucceeded()
      const memoryInput = input as {
        id?: string
        type?: string
        title?: string
        updates?: { title?: string }
      }
      obs.sessionEvents?.append(sessionId, [
        {
          type: 'memory/recorded',
          data: {
            action,
            memoryId: memoryInput.id,
            memoryType: memoryInput.type,
            title: memoryInput.title ?? memoryInput.updates?.title,
            toolUseId,
          },
        },
      ])
    },
    additionalMessages: async (failedAttempts) => {
      const hint = await buildMemoryHintMessage({
        failedTools: failedAttempts,
        userMessage: options.userMessage,
        adapter: options.adapter,
        sessionId,
        memoryRetriever: toolContext.memoryRetriever,
        logger: toolContext.logger,
        identitySummary: options.context.identityMemory,
        injectedMemoryIds: options.context.injectedMemoryIds,
        sessionEvents: obs.sessionEvents,
        trace: {
          tracer: obs.tracer,
          agentName: config.name,
          providerName: obs.providerName,
          modelLabel: obs.modelLabel,
          pricing: obs.pricing,
          secretFilter: obs.secretFilter,
        },
      })
      return hint ? [hint] : []
    },
    onInvalidAssistantResponse: (request, response, error) => {
      if (!nudge.isActive || !isMissingDeepSeekSignedThinkingError(error)) return undefined
      const errorMessage = toErrorMessage(error)
      toolContext.logger.warn?.('memory_nudge_response_discarded', {
        sessionId,
        responseId: response.id,
        stopReason: response.stopReason,
        reason: errorMessage,
      })
      obs.tracer?.logSession?.(sessionId, 'warn', 'memory_nudge.response_discarded', {
        traceSpanId: options.requestSpanId(),
        turnIndex,
        request: filterTraceValue(request, obs.secretFilter),
        response: filterTraceValue(response, obs.secretFilter),
        reason: errorMessage,
      })
      nudge.completeSuccess({ discardedInvalidResponse: true, reason: errorMessage })
      return { action: 'break' }
    },
    onEmptyResponse: () => {
      if (!nudge.isActive) return undefined
      nudge.completeSuccess()
      toolContext.logger.info?.('memory_nudge_empty_response', { sessionId })
      return 'break'
    },
    decideEndTurn: (_response, ctx) => {
      const promptMode = config.promptMode ?? 'full'
      if (
        !nudge.memoryWritten &&
        !toolContext.spawnedByRequestId &&
        promptMode === 'full' &&
        ctx.iteration >= CONTEXT_PARAMS.memoryNudge.minIterations &&
        nudge.nudgeCount < CONTEXT_PARAMS.memoryNudge.maxNudgesPerTurn
      ) {
        return {
          action: 'continue',
          continuationMessage: buildLoopUserMessage({
            sessionId,
            text: MEMORY_NUDGE_PROMPT,
            controlKind: 'memory_nudge',
          }),
          commit: () => nudge.begin(ctx.iteration, options.requestSpanId()),
        }
      }
      if (nudge.isActive) nudge.completeSuccess()
      return undefined
    },
  }
}

function isMissingDeepSeekSignedThinkingError(error: unknown): boolean {
  return toErrorMessage(error).includes('missing signed thinking content')
}

function endMemoryNudgeSpan(options: {
  tracer?: Pick<Tracer, 'endSpan'>
  spanId?: string
  status: 'success' | 'error'
  memoryWritten: boolean
  metadata?: Record<string, unknown>
}): void {
  if (!options.spanId) return
  options.tracer?.endSpan(options.spanId, options.status, {
    memoryWritten: options.memoryWritten,
    ...(options.metadata ?? {}),
  })
}

class AgentMemoryNudgeController {
  private count = 0
  private memoryWriteSucceededThisTurn = false
  private activeSpanId: string | undefined
  private activeIteration: number | undefined
  private responseParts: string[] = []

  constructor(
    private readonly deps: {
      sessionId: string
      agentName: string
      tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
    },
  ) {}

  get isActive(): boolean {
    return this.count > 0
  }

  get nudgeCount(): number {
    return this.count
  }

  get memoryWritten(): boolean {
    return this.memoryWriteSucceededThisTurn
  }

  markMemoryWriteSucceeded(): void {
    this.memoryWriteSucceededThisTurn = true
  }

  begin(iteration: number, parentSpanId?: string): void {
    this.count++
    this.activeIteration = iteration
    this.responseParts = []
    this.activeSpanId =
      this.deps.tracer?.startSpan(this.deps.sessionId, 'memory_nudge', parentSpanId, {
        kind: 'closure_decision',
        agentName: this.deps.agentName,
        data: {
          memoryNudge: {
            prompt: MEMORY_NUDGE_PROMPT,
            iteration,
          },
        },
        metadata: {
          purpose: 'memory_nudge',
          iteration,
        },
      })?.id ?? this.activeSpanId
  }

  /**
   * Keep the nudge model's answer on the trace span. Nudge replies never reach
   * the session transcript (onNewMessage suppresses them while active), so the
   * span is the only place the answer can be inspected from later.
   */
  recordResponseText(text: string): void {
    if (text.trim() === '') return
    this.responseParts.push(text)
  }

  interrupt(metadata: Record<string, unknown> = { interruptReason: 'pending_queue' }): boolean {
    const wasActive = this.isActive
    this.endSpan('error', metadata)
    if (wasActive) {
      this.count = 0
    }
    return wasActive
  }

  completeSuccess(metadata?: Record<string, unknown>): void {
    this.endSpan('success', metadata)
    this.count = 0
  }

  completeError(error: unknown): void {
    this.endSpan('error', { error: toErrorMessage(error) })
    this.count = 0
  }

  private endSpan(status: 'success' | 'error', metadata?: Record<string, unknown>): void {
    if (!this.activeSpanId) return
    if (this.responseParts.length > 0) {
      this.deps.tracer?.updateSpan(this.activeSpanId, {
        data: {
          memoryNudge: {
            ...(this.activeIteration === undefined ? {} : { iteration: this.activeIteration }),
            response: this.responseParts.join('\n'),
          },
        },
      })
    }
    endMemoryNudgeSpan({
      tracer: this.deps.tracer,
      spanId: this.activeSpanId,
      status,
      memoryWritten: this.memoryWriteSucceededThisTurn,
      metadata,
    })
    this.activeSpanId = undefined
    this.activeIteration = undefined
    this.responseParts = []
  }
}

async function buildMemoryHintMessage(options: {
  failedTools: FailedToolAttempt[]
  userMessage: string
  adapter: ProviderAdapter
  sessionId: string
  memoryRetriever?: ToolContext['memoryRetriever']
  logger: ToolContext['logger']
  identitySummary?: string
  injectedMemoryIds?: Map<string, string>
  sessionEvents?: AgentObservability['sessionEvents']
  trace?: {
    tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
    agentName?: string
    providerName?: string
    modelLabel?: string
    pricing?: ModelPricing
    secretFilter?: SecretFilter
  }
}): Promise<Message | undefined> {
  if (options.failedTools.length === 0) return undefined

  const decisionContext = [
    `用户当前请求：${options.userMessage}`,
    '工具执行失败，需要判断是否检索历史经验来辅助恢复。',
    ...options.failedTools.map((tool, index) =>
      [
        `失败工具 ${index + 1}:`,
        `- tool: ${tool.toolName}`,
        `- input: ${stringifyTraceData(tool.input, 1000)}`,
        `- error_summary: ${tool.outputSummary ?? tool.output}`,
      ].join('\n'),
    ),
  ].join('\n')

  const matches = await retrieveMemoriesWithDecision({
    adapter: options.adapter,
    sessionId: options.sessionId,
    memoryRetriever: options.memoryRetriever,
    identitySummary: options.identitySummary,
    userMessage: decisionContext,
    previouslyInjectedIds: options.injectedMemoryIds,
    logger: options.logger,
    failureEvent: 'memory_hint_retrieval_failed',
    sessionEvents: options.sessionEvents,
    layer: 'layer2',
    trace: {
      tracer: options.trace?.tracer,
      agentName: options.trace?.agentName,
      providerName: options.trace?.providerName,
      modelLabel: options.trace?.modelLabel,
      pricing: options.trace?.pricing,
      secretFilter: options.trace?.secretFilter,
      spanName: 'memory_retrieval_decision',
      metadata: {
        layer: 'layer2',
        source: 'memory_hint',
      },
    },
  })
  if (!matches || matches.length === 0) return undefined

  for (const match of matches) {
    options.injectedMemoryIds?.set(match.id, match.title)
  }

  const hint = [
    '<memory_hint>',
    '工具执行失败。以下是相关的历史经验：',
    ...matches
      .slice(0, 3)
      .flatMap((match) => [
        `  <memory id="${escapeXml(match.id)}" type="${escapeXml(match.type)}">`,
        `    <title>${escapeXml(match.title)}</title>`,
        `    <content>${escapeXml(match.content)}</content>`,
        '  </memory>',
      ]),
    '</memory_hint>',
  ].join('\n')
  const notificationText = wrapMemoryInjection('layer2', hint)

  return {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'notification',
    content: [{ type: 'text', text: notificationText }],
    createdAt: now(),
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
