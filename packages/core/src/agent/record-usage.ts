import { computeCost } from '@zero-os/model'
import type { MetricsDB, UsagePurpose } from '@zero-os/observe'
import type { CompletionResponse, ModelPricing } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'

export function recordCompletionUsage(
  metrics: MetricsDB | undefined,
  response: CompletionResponse,
  ctx: {
    sessionId: string
    purpose: UsagePurpose
    model: string
    provider: string
    pricing?: ModelPricing
    durationMs: number
    parentSessionId?: string
  },
): void {
  if (!metrics) return

  metrics.recordUsage({
    id: generateId(),
    sessionId: ctx.sessionId,
    category: 'completion',
    purpose: ctx.purpose,
    parentSessionId: ctx.parentSessionId,
    model: ctx.model,
    provider: ctx.provider,
    inputTokens: response.usage.input,
    outputTokens: response.usage.output,
    cacheWriteTokens: response.usage.cacheWrite,
    cacheReadTokens: response.usage.cacheRead,
    cost: computeCost(response.usage, ctx.pricing),
    durationMs: ctx.durationMs,
    createdAt: now(),
  })
}
