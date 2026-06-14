import {
  type MemoryRetrievalAgentRun,
  type RetrievedMemoryMatch,
  runMemoryRetrievalAgentDetailed,
} from '@zero-os/memory'
import { type ProviderAdapter, computeCost } from '@zero-os/model'
import type { Tracer } from '@zero-os/observe'
import type {
  LoopRunner,
  LoopToolCallRecord,
  ModelPricing,
  ReasoningEffort,
  SecretFilter,
  ToolLogger,
} from '@zero-os/shared'
import { AgentLoop, type ToolExecutor } from './agent-loop'
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
}: RetrieveMemoriesWithDecisionOptions): Promise<RetrievedMemoryMatch[] | undefined> {
  if (!memoryRetriever) return undefined
  if (userMessage.trim().length < 5) return undefined

  const traceSpanId = startMemoryRetrievalTrace(sessionId, trace)

  try {
    const result = await runMemoryRetrievalAgentDetailed({
      runLoop: createLoopRunner(adapter, sessionId, logger, reasoningEffort),
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

    recordMemoryRetrievalTraceResult({ trace, traceSpanId, userMessage, result })

    return result.memories
  } catch (error) {
    recordMemoryRetrievalTraceError({ trace, traceSpanId, error })
    logger.warn(failureEvent, {
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  } finally {
    finishMemoryRetrievalTrace(trace, traceSpanId)
  }
}

export function createLoopRunner(
  adapter: ProviderAdapter,
  sessionId: string,
  logger: ToolLogger,
  reasoningEffort?: ReasoningEffort,
): LoopRunner {
  return async (config) => {
    const startedAt = Date.now()
    const usage = { input: 0, output: 0 }
    const toolCalls: LoopToolCallRecord[] = []

    const toolExecutor: ToolExecutor = {
      has: (name) => config.tools.some((tool) => tool.name === name),
      execute: async (name, _toolUseId, input) => {
        const result = await config.toolHandler(name, input)
        return {
          output: result.output,
          outputSummary: summarizeLoopToolOutput(result.output),
          success: !result.isError,
        }
      },
    }

    const loop = new AgentLoop(
      {
        adapter,
        sessionId,
        meta: {
          sessionId,
          purpose: 'memory_retrieval',
        },
        toolExecutor,
        system: config.system,
        tools: config.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
        maxOutputTokens: config.maxTokens ?? 512,
        reasoningEffort,
        maxIterations: config.maxIterations ?? 3,
        stream: false,
        logger,
      },
      {
        onCompletionEnd(_request, response) {
          usage.input += response.usage.input
          usage.output += response.usage.output
        },
        onToolCallEnd(toolName, _toolUseId, input, result) {
          toolCalls.push({
            name: toolName,
            input,
            output: result.output,
          })
        },
      },
    )

    const messages = await loop.run(config.userMessage, [])
    const finalText =
      [...messages]
        .reverse()
        .find((message) => message.role === 'assistant')
        ?.content.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? ''

    return {
      finalText,
      toolCalls,
      usage,
      durationMs: Date.now() - startedAt,
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
}): void {
  const { result, trace, traceSpanId } = options
  if (!traceSpanId) return

  const safeUserMessage = sanitizeText(options.userMessage, trace?.secretFilter)
  const safeFinalText = sanitizeText(result.finalText, trace?.secretFilter)
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
        response: safeFinalText,
        need: result.queries.length > 0,
        queries: result.queries,
        tokens: result.usage,
        cost: computeCost(result.usage, trace?.pricing),
        durationMs: result.durationMs,
        searches: sanitizeSearches(result.searches, trace?.secretFilter),
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

function sanitizeText(text: string, secretFilter?: SecretFilter): string {
  return secretFilter ? secretFilter.filter(text) : text
}

function summarizeLoopToolOutput(output: string): string {
  if (output.length <= CONTEXT_PARAMS.history.summaryMaxChars) return output
  return `${output.slice(0, CONTEXT_PARAMS.history.summaryMaxChars - 3)}...`
}
