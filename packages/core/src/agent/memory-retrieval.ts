import {
  type MemoryRetrievalAgentRun,
  type RetrievedMemoryMatch,
  runMemoryRetrievalAgentDetailed,
} from '@zero-os/memory'
import { type ProviderAdapter, computeCost } from '@zero-os/model'
import type { SessionEventStore, Tracer } from '@zero-os/observe'
import type {
  LoopRunner,
  MemoryRetrievalLayer,
  ModelPricing,
  ReasoningEffort,
  SecretFilter,
  ToolLogger,
} from '@zero-os/shared'
import { generatePrefixedId } from '@zero-os/shared'
import { runAgentLoop } from './agent-run'
import { CONTEXT_PARAMS } from './params'

interface RetrieveMemoriesWithDecisionOptions {
  adapter: ProviderAdapter
  sessionId: string
  reasoningEffort?: ReasoningEffort
  memoryRetriever?: {
    retrieve(
      query: string,
      options?: import('@zero-os/shared').MemorySearchOptions,
    ): Promise<import('@zero-os/shared').Memory[]>
    retrieveScored?(
      query: string,
      options?: import('@zero-os/shared').MemorySearchOptions,
    ): Promise<import('@zero-os/shared').ScoredMemoryMatch[]>
  }
  identitySummary?: string
  userMessage: string
  previouslyInjectedIds?: Map<string, string>
  logger: ToolLogger
  failureEvent: string
  trace?: MemoryRetrievalTraceOptions
  /**
   * 事件流:提供时发射 memory/retrieval/start|end 成对事件;检索 loop 自己的请求、工具调用和消息写进
   * 父会话目录下的 `sub-<id>.jsonl`,父会话记一条 `subagent/spawn` 指向它
   */
  sessionEvents?: MemoryRetrievalJournal['events']
  layer?: MemoryRetrievalLayer
  turnIndex?: number
}

export interface MemoryRetrievalTraceOptions {
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
  agentName?: string
  providerName?: string
  modelLabel?: string
  pricing?: ModelPricing
  secretFilter?: SecretFilter
  spanName: string
  metadata?: Record<string, unknown>
}

export async function retrieveMemoriesWithDecision({
  adapter,
  sessionId,
  reasoningEffort,
  memoryRetriever,
  identitySummary = '',
  userMessage,
  previouslyInjectedIds,
  logger,
  failureEvent,
  trace,
  sessionEvents,
  layer = 'layer1',
  turnIndex,
}: RetrieveMemoriesWithDecisionOptions): Promise<RetrievedMemoryMatch[] | undefined> {
  if (!memoryRetriever) return undefined
  if (userMessage.trim().length < 5) return undefined

  const traceSpanId = startMemoryRetrievalTrace(sessionId, trace)
  const sideLoop: MemoryRetrievalSideLoopCapture = {}
  const retrievalStartedAt = Date.now()
  sessionEvents?.append(sessionId, [{ type: 'memory/retrieval/start', data: { layer, turnIndex } }])

  try {
    const result = await runMemoryRetrievalAgentDetailed({
      runLoop: createLoopRunner(
        adapter,
        sessionId,
        logger,
        reasoningEffort,
        sideLoop,
        sessionEvents && {
          events: sessionEvents,
          layer,
          modelLabel: trace?.modelLabel,
          secretFilter: trace?.secretFilter,
        },
      ),
      memoryRetriever: {
        retrieve: (query, options) =>
          memoryRetriever.retrieve(query, {
            ...options,
            sessionId,
          }),
        retrieveScored: memoryRetriever.retrieveScored
          ? (query, options) =>
              memoryRetriever.retrieveScored?.(query, {
                ...options,
                sessionId,
              }) ?? Promise.resolve([])
          : undefined,
      },
      identitySummary,
      userMessage,
      previouslyInjectedIds,
      config: {
        topN: CONTEXT_PARAMS.retrieval.topN,
        confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
        minScore: CONTEXT_PARAMS.retrieval.minScore,
        perMemoryMaxTokens: CONTEXT_PARAMS.retrieval.perMemoryMaxTokens,
        maxSelectedMemories: CONTEXT_PARAMS.retrieval.agentMaxSelectedMemories,
        agentMaxIterations: CONTEXT_PARAMS.retrieval.agentMaxIterations,
        agentMaxOutputTokens: CONTEXT_PARAMS.retrieval.agentMaxOutputTokens,
      },
    })

    recordMemoryRetrievalTraceResult({ trace, traceSpanId, userMessage, result, sideLoop })

    sessionEvents?.append(sessionId, [
      {
        type: 'memory/retrieval/end',
        data: {
          layer,
          turnIndex,
          status: (result.memories?.length ?? 0) > 0 ? 'injected' : 'skipped',
          queries: result.queries,
          searchCount: result.searches.length,
          selected: result.selectedMemories.map((memory) => ({
            id: memory.id,
            title: memory.title,
            score: memory.score,
          })),
          durationMs: result.durationMs,
          usage: result.usage as Record<string, number>,
        },
      },
    ])

    return result.memories
  } catch (error) {
    recordMemoryRetrievalTraceError({ trace, traceSpanId, error })
    sessionEvents?.append(sessionId, [
      {
        type: 'memory/retrieval/end',
        data: {
          layer,
          turnIndex,
          status: 'failed',
          queries: [],
          selected: [],
          durationMs: Date.now() - retrievalStartedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      },
    ])
    logger.warn(failureEvent, {
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  } finally {
    finishMemoryRetrievalTrace(trace, traceSpanId)
  }
}

/** Bag the caller can read side-loop details from after the run completes. */
export interface MemoryRetrievalSideLoopCapture {
  system?: string
}

/**
 * Where a retrieval loop writes its events. Each run takes a new `sub-<id>.jsonl` in the parent
 * session directory, the same layout as a `spawn_agent` child, and the parent records a
 * `subagent/spawn` pointing to it.
 */
export interface MemoryRetrievalJournal {
  events: Pick<SessionEventStore, 'append' | 'appendMessage' | 'registerSubagent' | 'release'>
  layer: MemoryRetrievalLayer
  modelLabel?: string
  secretFilter?: SecretFilter
}

export function createLoopRunner(
  adapter: ProviderAdapter,
  sessionId: string,
  logger: ToolLogger,
  reasoningEffort?: ReasoningEffort,
  capture?: MemoryRetrievalSideLoopCapture,
  journal?: MemoryRetrievalJournal,
): LoopRunner {
  return async (config) => {
    if (capture && config.system !== undefined) capture.system = config.system
    const childId = generatePrefixedId('memory')
    const logFile = journal?.events.registerSubagent({
      childSessionId: childId,
      parentSessionId: sessionId,
      name: 'memory_retrieval',
      role: journal.layer,
    })
    const events = logFile ? journal?.events : undefined
    if (journal && logFile)
      journal.events.append(sessionId, [
        {
          type: 'subagent/spawn',
          data: { childSessionId: childId, name: 'memory_retrieval', role: journal.layer, logFile },
        },
      ])
    try {
      // Messages keep the parent session id, as in a spawn_agent child; only the file differs.
      const { finalText, toolCalls, usage, durationMs } = await runAgentLoop({
        adapter,
        sessionId,
        journal: events && {
          events: {
            append: (_sessionId, input) => events.append(childId, input),
            appendMessage: (_sessionId, message) => events.appendMessage(childId, message),
          },
          modelLabel: journal?.modelLabel,
          secretFilter: journal?.secretFilter,
        },
        meta: { sessionId, purpose: 'memory_retrieval' },
        system: config.system,
        prompt: config.userMessage,
        tools: config.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
        toolExecutor: {
          has: (name) => config.tools.some((tool) => tool.name === name),
          execute: async (name, _toolUseId, input) => {
            const result = await config.toolHandler(name, input)
            return {
              output: result.output,
              outputSummary: summarizeLoopToolOutput(result.output),
              success: !result.isError,
            }
          },
        },
        maxOutputTokens: config.maxTokens ?? 512,
        reasoningEffort,
        maxIterations: config.maxIterations ?? 3,
        stream: false,
        logger,
      })
      return { finalText, toolCalls, usage, durationMs }
    } finally {
      events?.release(childId)
    }
  }
}

function startMemoryRetrievalTrace(
  sessionId: string,
  trace: MemoryRetrievalTraceOptions | undefined,
): string | undefined {
  return trace?.tracer?.startSpan(sessionId, trace.spanName, undefined, {
    kind: 'llm_request',
    agentName: trace.agentName,
    metadata: {
      purpose: 'memory_retrieval_decision',
      ...trace.metadata,
    },
  })?.id
}

function recordMemoryRetrievalTraceResult(options: {
  trace: MemoryRetrievalTraceOptions | undefined
  traceSpanId: string | undefined
  userMessage: string
  result: MemoryRetrievalAgentRun
  sideLoop: MemoryRetrievalSideLoopCapture
}): void {
  const { result, trace, traceSpanId } = options
  if (!traceSpanId) return

  const safeUserMessage = sanitizeText(options.userMessage, trace?.secretFilter)
  const safeFinalText = sanitizeText(result.finalText, trace?.secretFilter)
  const safeSystem =
    options.sideLoop.system === undefined
      ? undefined
      : sanitizeText(options.sideLoop.system, trace?.secretFilter)
  const selectedMemories = result.selectedMemories.map((memory) => ({
    ...memory,
    title: sanitizeText(memory.title, trace?.secretFilter),
  }))

  trace?.tracer?.updateSpan(traceSpanId, {
    data: {
      memoryRetrievalDecision: {
        model: trace?.modelLabel ?? 'unknown',
        provider: trace?.providerName ?? 'unknown',
        prompt: safeUserMessage,
        ...(safeSystem === undefined || safeSystem === '' ? {} : { system: safeSystem }),
        response: safeFinalText,
        need: result.queries.length > 0,
        queries: result.queries,
        tokens: result.usage,
        cost: computeCost(result.usage, trace?.pricing),
        durationMs: result.durationMs,
        searches: sanitizeSearches(result.searches, trace?.secretFilter),
        toolCalls: sanitizeToolCalls(result.toolCalls, trace?.secretFilter),
        selectedMemoryIds: result.selectedMemoryIds,
        selectedMemories,
        usedFallbackSelection: result.usedFallbackSelection,
      },
    },
    metadata: {
      need: result.queries.length > 0,
      queryCount: result.queries.length,
      searchCount: result.searches.length,
      selectedCount: result.selectedMemoryIds.length,
    },
  })
}

function recordMemoryRetrievalTraceError(options: {
  trace: MemoryRetrievalTraceOptions | undefined
  traceSpanId: string | undefined
  error: unknown
}): void {
  if (!options.traceSpanId) return
  options.trace?.tracer?.updateSpan(options.traceSpanId, {
    metadata: {
      error: options.error instanceof Error ? options.error.message : String(options.error),
    },
  })
  options.trace?.tracer?.endSpan(options.traceSpanId, 'error')
}

function finishMemoryRetrievalTrace(
  trace: MemoryRetrievalTraceOptions | undefined,
  traceSpanId: string | undefined,
): void {
  if (!traceSpanId) return
  const current = trace?.tracer?.getSpan?.(traceSpanId)
  if (current && !current.endTime) {
    trace?.tracer?.endSpan(traceSpanId, 'success')
  }
}

function sanitizeSearches(
  searches: MemoryRetrievalAgentRun['searches'],
  secretFilter?: SecretFilter,
): MemoryRetrievalAgentRun['searches'] {
  return searches.map((search) => ({
    ...search,
    query: sanitizeText(search.query, secretFilter),
    results: search.results.map((entry) => ({
      ...entry,
      title: sanitizeText(entry.title, secretFilter),
      contentPreview: sanitizeText(entry.contentPreview, secretFilter),
    })),
  }))
}

/** 检索 side-loop 的工具输出与 searches 内容同源,截断只为防 trace 膨胀,不追求完整。 */
const TOOL_OUTPUT_MAX_CHARS = 4_000

function sanitizeToolCalls(
  toolCalls: MemoryRetrievalAgentRun['toolCalls'],
  secretFilter?: SecretFilter,
): MemoryRetrievalAgentRun['toolCalls'] {
  return toolCalls.map((call) => ({
    name: call.name,
    input: Object.fromEntries(
      Object.entries(call.input).map(([key, value]) => [
        key,
        typeof value === 'string' ? sanitizeText(value, secretFilter) : value,
      ]),
    ),
    output: sanitizeText(call.output, secretFilter).slice(0, TOOL_OUTPUT_MAX_CHARS),
  }))
}

function sanitizeText(text: string, secretFilter?: SecretFilter): string {
  return secretFilter ? secretFilter.filter(text) : text
}

function summarizeLoopToolOutput(output: string): string {
  if (output.length <= CONTEXT_PARAMS.history.summaryMaxChars) return output
  return `${output.slice(0, CONTEXT_PARAMS.history.summaryMaxChars - 3)}...`
}
