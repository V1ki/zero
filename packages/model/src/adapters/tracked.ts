import type { ModelPricing } from '@zero-os/shared'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  TokenUsage,
} from '@zero-os/shared'
import { computeCost } from '../cost'
import type { ProviderAdapter } from './base'

export interface UsageRecorder {
  record(entry: {
    sessionId: string
    purpose: string
    parentSessionId?: string
    model: string
    provider: string
    usage: TokenUsage
    cost: number
    durationMs: number
  }): void
}

export class TrackedAdapter implements ProviderAdapter {
  constructor(
    private readonly inner: ProviderAdapter,
    private readonly recorder: UsageRecorder,
    private readonly defaults: {
      providerName: string
      modelLabel: string
      pricing?: ModelPricing
    },
  ) {}

  get apiType(): string {
    return this.inner.apiType
  }

  get supportsNonStreamingFallback(): boolean | undefined {
    return this.inner.supportsNonStreamingFallback
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startedAt = Date.now()
    const response = await this.inner.complete(req)

    if (req.meta) {
      this.recorder.record({
        sessionId: req.meta.sessionId,
        purpose: req.meta.purpose,
        parentSessionId: req.meta.parentSessionId,
        model: this.resolveModelLabel(response.model),
        provider: this.defaults.providerName,
        usage: response.usage,
        cost: computeCost(response.usage, this.defaults.pricing),
        durationMs: Date.now() - startedAt,
      })
    }

    return response
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const startedAt = Date.now()
    let finalUsage: TokenUsage | undefined
    let finalModel: string | undefined

    try {
      for await (const event of this.inner.stream(req)) {
        if (event.type === 'done') {
          const data = event.data as { usage?: TokenUsage; model?: string }
          finalUsage = data.usage
          finalModel = data.model
        }

        yield event
      }
    } finally {
      // Streaming adapters only expose normalized usage on the terminal `done` event.
      // If the stream aborts before that event, we intentionally skip recording here
      // and let any higher-level fallback completion attempt account for its own usage.
      if (req.meta && finalUsage) {
        this.recorder.record({
          sessionId: req.meta.sessionId,
          purpose: req.meta.purpose,
          parentSessionId: req.meta.parentSessionId,
          model: this.resolveModelLabel(finalModel),
          provider: this.defaults.providerName,
          usage: finalUsage,
          cost: computeCost(finalUsage, this.defaults.pricing),
          durationMs: Date.now() - startedAt,
        })
      }
    }
  }

  healthCheck(): Promise<boolean> {
    return this.inner.healthCheck()
  }

  private resolveModelLabel(model?: string): string {
    if (typeof model === 'string' && model.includes('/')) {
      return model
    }

    return this.defaults.modelLabel ?? model ?? 'unknown'
  }
}
