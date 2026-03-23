import {
  buildRetrievalDecisionPrompt,
  parseRetrievalDecision,
} from '@zero-os/memory'
import { computeCost } from '@zero-os/model'
import type { ProviderAdapter } from '@zero-os/model'
import type { MemorySearchOptions, Memory, ScoredMemoryMatch, ToolLogger } from '@zero-os/shared'
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

interface RetrieveMemoriesWithDecisionOptions {
  adapter: ProviderAdapter
  sessionId: string
  memoryRetriever?: {
    retrieve(query: string, options?: MemorySearchOptions): Promise<Memory[]>
    retrieveScored?(
      query: string,
      options?: MemorySearchOptions,
    ): Promise<ScoredMemoryMatch[]>
  }
  identitySummary?: string
  userMessage: string
  logger: ToolLogger
  failureEvent: string
  trace?: {
    tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
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
    const safePrompt =
      trace?.secretFilter ? trace.secretFilter.filter(decisionPrompt) : decisionPrompt
    const safeResponse =
      trace?.secretFilter ? trace.secretFilter.filter(decisionText) : decisionText
    const traceHandle = trace
    if (traceSpanId && traceHandle) {
      traceHandle.tracer?.updateSpan(traceSpanId, {
        data: {
          memoryRetrievalDecision: {
            model: traceHandle.modelLabel ?? response.model,
            provider: traceHandle.providerName ?? 'unknown',
            prompt: safePrompt,
            response: safeResponse,
            need: decision.need,
            queries: decision.queries ?? [],
            tokens: response.usage,
            cost: computeCost(response.usage, traceHandle.pricing),
            durationMs,
          },
        },
        metadata: {
          need: decision.need,
          queryCount: decision.queries?.length ?? 0,
        },
      })
      traceHandle.tracer?.endSpan(traceSpanId, 'success')
    }

    if (!decision.need || !decision.queries?.length) return undefined

    const matchesById = new Map<string, RetrievedMemoryMatch>()
    const retrieved = await Promise.all(
      decision.queries.slice(0, CONTEXT_PARAMS.retrieval.maxQueries).map(async (query) => {
        if (memoryRetriever.retrieveScored) {
          return await memoryRetriever.retrieveScored(query, {
            topN: CONTEXT_PARAMS.retrieval.topN,
            confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
          })
        }

        const memories = await memoryRetriever.retrieve(query, {
          topN: CONTEXT_PARAMS.retrieval.topN,
          confidenceThreshold: CONTEXT_PARAMS.retrieval.confidenceThreshold,
        })
        return memories.map((memory) => ({
          memory,
          score: 0,
          scoreBreakdown: {
            keyword: 0,
            recency: 0,
          },
        }))
      }),
    )

    for (const entries of retrieved) {
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

    return memories.length > 0 ? memories : undefined
  } catch (error) {
    if (traceSpanId) {
      trace?.tracer?.updateSpan(traceSpanId, {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      trace?.tracer?.endSpan(traceSpanId, 'error')
    }
    logger.warn(failureEvent, {
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
