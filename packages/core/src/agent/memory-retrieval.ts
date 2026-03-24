import { buildRetrievalDecisionPrompt, parseRetrievalDecision } from '@zero-os/memory'
import { computeCost } from '@zero-os/model'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionResponse,
  MemorySearchOptions,
  Memory,
  ScoredMemoryMatch,
  ToolLogger,
} from '@zero-os/shared'
import { generateId, now, truncateToTokens } from '@zero-os/shared'
import type { ModelPricing, SecretFilter } from '@zero-os/shared'
import type { Tracer } from '@zero-os/observe'
import { CONTEXT_PARAMS } from './params'

export interface RetrievedMemoryMatch {
  id: string
  type: string
  title: string
  content: string
  score: number
}

interface MemoryRetrievalSearchTraceResult {
  id: string
  type: string
  title: string
  score: number
  scoreBreakdown: {
    keyword: number
    recency: number
    vector?: number
  }
}

interface MemoryRetrievalSearchTrace {
  query: string
  mode: 'scored' | 'basic'
  options: {
    topN: number
    confidenceThreshold: number
    minScore?: number
  }
  resultCount: number
  results: MemoryRetrievalSearchTraceResult[]
}

interface RetrieveMemoriesWithDecisionOptions {
  adapter: ProviderAdapter
  sessionId: string
  memoryRetriever?: {
    retrieve(query: string, options?: MemorySearchOptions): Promise<Memory[]>
    retrieveScored?(query: string, options?: MemorySearchOptions): Promise<ScoredMemoryMatch[]>
  }
  identitySummary?: string
  userMessage: string
  logger: ToolLogger
  failureEvent: string
  trace?: {
    tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
    agentName?: string
    providerName?: string
    modelLabel?: string
    pricing?: ModelPricing
    secretFilter?: SecretFilter
    spanName: string
    metadata?: Record<string, unknown>
  }
}

export async function retrieveMemoriesWithDecision({
  adapter,
  sessionId,
  memoryRetriever,
  identitySummary = '',
  userMessage,
  logger,
  failureEvent,
  trace,
}: RetrieveMemoriesWithDecisionOptions): Promise<RetrievedMemoryMatch[] | undefined> {
  if (!memoryRetriever) return undefined
  if (userMessage.trim().length < 5) return undefined

  let traceSpanId: string | undefined
  let traceDecisionData:
    | {
        model: string
        provider: string
        prompt: string
        response: string
        need: boolean
        queries: string[]
        tokens: CompletionResponse['usage']
        cost: number
        durationMs: number
      }
    | undefined
  let traceStage: 'decision' | 'retrieval' = 'decision'
  try {
    const decisionPrompt = buildRetrievalDecisionPrompt(userMessage, identitySummary)
    const traceSpan = trace?.tracer?.startSpan(sessionId, trace.spanName, undefined, {
      kind: 'llm_request',
      agentName: trace.agentName,
      metadata: {
        purpose: 'memory_retrieval_decision',
        ...trace.metadata,
      },
    })
    traceSpanId = traceSpan?.id
    const startedAt = Date.now()
    const response = await adapter.complete({
      messages: [
        {
          id: generateId(),
          sessionId,
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: decisionPrompt }],
          createdAt: now(),
        },
      ],
      stream: false,
      maxTokens: 128,
    })
    const durationMs = Date.now() - startedAt

    const decisionText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    const decision = parseRetrievalDecision(decisionText)
    const safePrompt = trace?.secretFilter
      ? trace.secretFilter.filter(decisionPrompt)
      : decisionPrompt
    const safeResponse = trace?.secretFilter
      ? trace.secretFilter.filter(decisionText)
      : decisionText
    traceDecisionData = {
      model: trace?.modelLabel ?? response.model,
      provider: trace?.providerName ?? 'unknown',
      prompt: safePrompt,
      response: safeResponse,
      need: decision.need,
      queries: decision.queries ?? [],
      tokens: response.usage,
      cost: computeCost(response.usage, trace?.pricing),
      durationMs,
    }

    if (traceSpanId && traceDecisionData) {
      trace?.tracer?.updateSpan(traceSpanId, {
        data: {
          memoryRetrievalDecision: traceDecisionData,
        },
        metadata: {
          need: traceDecisionData.need,
          queryCount: traceDecisionData.queries.length,
        },
      })
    }

    if (!decision.need || !decision.queries?.length) return undefined

    traceStage = 'retrieval'
    const sanitizeTraceText = (value: string): string =>
      trace?.secretFilter ? trace.secretFilter.filter(value) : value
    const matchesById = new Map<string, RetrievedMemoryMatch>()
    const retrieved = await Promise.all(
      decision.queries.slice(0, CONTEXT_PARAMS.retrieval.maxQueries).map(async (query) => {
        if (memoryRetriever.retrieveScored) {
          const entries = await memoryRetriever.retrieveScored(query, {
            topN: CONTEXT_PARAMS.retrieval.topN,
            confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
            minScore: CONTEXT_PARAMS.retrieval.minScore,
          })
          return {
            entries,
            trace: {
              query: sanitizeTraceText(query),
              mode: 'scored' as const,
              options: {
                topN: CONTEXT_PARAMS.retrieval.topN,
                confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
                minScore: CONTEXT_PARAMS.retrieval.minScore,
              },
              resultCount: entries.length,
              results: entries.map((entry) => ({
                id: entry.memory.id,
                type: entry.memory.type,
                title: sanitizeTraceText(entry.memory.title),
                score: entry.score,
                scoreBreakdown: entry.scoreBreakdown,
              })),
            } satisfies MemoryRetrievalSearchTrace,
          }
        }

        const memories = await memoryRetriever.retrieve(query, {
          topN: CONTEXT_PARAMS.retrieval.topN,
          confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
          minScore: CONTEXT_PARAMS.retrieval.minScore,
        })
        const entries = memories.map((memory) => ({
          memory,
          score: 0,
          scoreBreakdown: {
            keyword: 0,
            recency: 0,
          },
        }))
        return {
          entries,
          trace: {
            query: sanitizeTraceText(query),
            mode: 'basic' as const,
            options: {
              topN: CONTEXT_PARAMS.retrieval.topN,
              confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
              minScore: CONTEXT_PARAMS.retrieval.minScore,
            },
            resultCount: entries.length,
            results: entries.map((entry) => ({
              id: entry.memory.id,
              type: entry.memory.type,
              title: sanitizeTraceText(entry.memory.title),
              score: entry.score,
              scoreBreakdown: entry.scoreBreakdown,
            })),
          } satisfies MemoryRetrievalSearchTrace,
        }
      }),
    )

    for (const { entries } of retrieved) {
      for (const entry of entries) {
        const existing = matchesById.get(entry.memory.id)
        if (existing && existing.score >= entry.score) continue
        matchesById.set(entry.memory.id, {
          id: entry.memory.id,
          type: entry.memory.type,
          title: entry.memory.title,
          content: truncateToTokens(
            entry.memory.content,
            CONTEXT_PARAMS.retrieval.perMemoryMaxTokens,
          ),
          score: entry.score,
        })
      }
    }

    const memories = [...matchesById.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, CONTEXT_PARAMS.retrieval.topN)

    if (traceSpanId && traceDecisionData) {
      trace?.tracer?.updateSpan(traceSpanId, {
        data: {
          memoryRetrievalDecision: {
            ...traceDecisionData,
            searches: retrieved.map((entry) => entry.trace),
            selectedMemoryIds: memories.map((memory) => memory.id),
            selectedMemories: memories.map((memory) => ({
              id: memory.id,
              type: memory.type,
              title: sanitizeTraceText(memory.title),
              score: memory.score,
            })),
          },
        },
        metadata: {
          need: traceDecisionData.need,
          queryCount: traceDecisionData.queries.length,
          searchCount: retrieved.length,
          selectedCount: memories.length,
        },
      })
    }

    return memories.length > 0 ? memories : undefined
  } catch (error) {
    if (traceSpanId) {
      trace?.tracer?.updateSpan(traceSpanId, {
        ...(traceDecisionData
          ? {
              data: {
                memoryRetrievalDecision: {
                  ...traceDecisionData,
                  error: error instanceof Error ? error.message : String(error),
                  errorStage: traceStage,
                },
              },
            }
          : {}),
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          errorStage: traceStage,
        },
      })
      trace?.tracer?.endSpan(traceSpanId, 'error')
    }
    logger.warn(failureEvent, {
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  } finally {
    if (traceSpanId) {
      const current = trace?.tracer?.getSpan?.(traceSpanId)
      if (current && !current.endTime) {
        trace?.tracer?.endSpan(traceSpanId, 'success')
      }
    }
  }
}
