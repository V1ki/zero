import type { ProviderAdapter } from '@zero-os/model'
import type { SessionEventStore, Tracer } from '@zero-os/observe'
import type {
  CompactionTrigger,
  ModelPricing,
  SecretFilter,
  ToolDefinition,
  ToolLogger,
} from '@zero-os/shared'
import { estimateTokens, generateId } from '@zero-os/shared'
import type { AgentLoopModule } from '../agent-loop'
import type { AgentContext } from '../agent-types'
import { compactContext, computeCompactionBudget, createCheckpointSummarizer } from '../compaction'

/**
 * Context compaction: when the model declared its window, compacts the canonical messages under
 * pressure at the start of the loop and after tool results. A new checkpoint is written as
 * `compaction/checkpoint` at the moment it is made; the base projects the request from it. After a
 * failed summary the module does not try again within the loop: a long turn would wait for the
 * timeout at every step. The next loop tries again.
 */
export function compactionModule(options: {
  sessionId: string
  context: Pick<
    AgentContext,
    'maxContext' | 'maxOutput' | 'reasoningEffort' | 'onCheckpointChanged'
  > & {
    checkpoint?: AgentContext['checkpoint']
    tools: ToolDefinition[]
  }
  /** The system text sent with each request, counted against the window. */
  system: string
  adapter: ProviderAdapter
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  parentSessionId?: string
  agentName: string
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
  secretFilter?: SecretFilter
  events?: Pick<SessionEventStore, 'append'>
  logger: ToolLogger
  /** Trace span the compaction belongs to. */
  parentSpanId(trigger: CompactionTrigger): string | undefined
}): AgentLoopModule {
  const { context, sessionId } = options
  let summaryFailed = false

  return {
    compact: async (messages, trigger, checkpointBefore) => {
      if (summaryFailed || !context.maxContext || !context.maxOutput) return undefined
      const budget = computeCompactionBudget(context.maxContext, context.maxOutput)
      const compactionId = generateId()
      const startedAt = Date.now()
      const result = await compactContext({
        messages,
        checkpoint: checkpointBefore,
        sessionId,
        budget,
        fixedTokens: estimateTokens(options.system) + estimateTokens(JSON.stringify(context.tools)),
        summarize: createCheckpointSummarizer({
          adapter: options.adapter,
          modelLabel: options.modelLabel,
          providerName: options.providerName,
          pricing: options.pricing,
          reasoningEffort: context.reasoningEffort,
          parentSessionId: options.parentSessionId,
          agentName: options.agentName,
          parentSpanId: options.parentSpanId(trigger),
          tracer: options.tracer,
          secretFilter: options.secretFilter,
        }),
        onStart: (tokens) => {
          options.events?.append(sessionId, [
            {
              type: 'compaction/start',
              data: { compactionId, trigger, tokens, thresholdTokens: budget.thresholdTokens },
            },
          ])
        },
      })
      if (result.status === 'not_needed') return undefined

      const { checkpoint } = result
      const durationMs = Date.now() - startedAt
      options.events?.append(sessionId, [
        ...(checkpoint ? [{ type: 'compaction/checkpoint' as const, data: { checkpoint } }] : []),
        {
          type: 'compaction/end',
          data: {
            compactionId,
            status: result.status,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            durationMs,
            ...(result.status === 'summarized' ? { usage: result.usage } : {}),
            ...(result.status === 'failed' ? { error: result.error } : {}),
          },
        },
      ])
      options.logger[result.status === 'failed' ? 'warn' : 'info']('context_compaction', {
        compactionId,
        trigger,
        status: result.status,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        thresholdTokens: budget.thresholdTokens,
        generation: checkpoint?.generation,
        durationMs,
        ...(result.status === 'failed' ? { error: result.error } : {}),
      })

      summaryFailed = result.status === 'failed'
      if (!checkpoint) return undefined
      context.checkpoint = checkpoint
      context.onCheckpointChanged?.(checkpoint)
      return checkpoint
    },
  }
}
