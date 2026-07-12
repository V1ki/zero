import type {
  CompletionRequest,
  CompletionResponse,
  ModelConfig,
  ReasoningEffort,
  StreamEvent,
} from '@zero-os/shared'
import type { ProviderAdapter } from './base'

const REASONING_ORDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

export interface RuntimeModelError {
  providerName: string
  modelName: string
  modelId: string
  reason: 'model_not_found' | 'unsupported_model'
}

export type RuntimeModelErrorHandler = (event: RuntimeModelError) => void | Promise<void>

export class ModelPolicyAdapter implements ProviderAdapter {
  readonly apiType: string
  readonly supportsNonStreamingFallback?: boolean

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly providerName: string,
    private readonly modelName: string,
    private readonly modelConfig: ModelConfig,
    private readonly onRuntimeModelError?: RuntimeModelErrorHandler,
  ) {
    this.apiType = inner.apiType
    this.supportsNonStreamingFallback = inner.supportsNonStreamingFallback
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    try {
      return await this.inner.complete(this.normalizeRequest(req))
    } catch (error) {
      this.observeError(error)
      throw error
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    try {
      yield* this.inner.stream(this.normalizeRequest(req))
    } catch (error) {
      this.observeError(error)
      throw error
    }
  }

  healthCheck(): Promise<boolean> {
    return this.inner.healthCheck()
  }

  private normalizeRequest(req: CompletionRequest): CompletionRequest {
    const reasoningEffort = negotiateReasoningEffort(
      req.reasoningEffort ?? this.modelConfig.reasoningEffort,
      this.modelConfig.supportedReasoningEfforts,
    )
    return reasoningEffort === req.reasoningEffort ? req : { ...req, reasoningEffort }
  }

  private observeError(error: unknown): void {
    const reason = classifyRuntimeModelError(error)
    if (!reason || !this.onRuntimeModelError) return
    void Promise.resolve(
      this.onRuntimeModelError({
        providerName: this.providerName,
        modelName: this.modelName,
        modelId: this.modelConfig.modelId,
        reason,
      }),
    ).catch(() => {})
  }
}

export function negotiateReasoningEffort(
  requested: ReasoningEffort | undefined,
  supported: ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
  if (!requested || !supported?.length || supported.includes(requested)) return requested
  const requestedIndex = REASONING_ORDER.indexOf(requested)
  return [...supported].sort((left, right) => {
    const leftDistance = Math.abs(REASONING_ORDER.indexOf(left) - requestedIndex)
    const rightDistance = Math.abs(REASONING_ORDER.indexOf(right) - requestedIndex)
    return (
      leftDistance - rightDistance || REASONING_ORDER.indexOf(left) - REASONING_ORDER.indexOf(right)
    )
  })[0]
}

export function classifyRuntimeModelError(error: unknown): RuntimeModelError['reason'] | undefined {
  const record = isRecord(error) ? error : undefined
  const nested = isRecord(record?.error) ? record.error : undefined
  const errorCodes = [record?.error_type, record?.code, record?.type, nested?.code, nested?.type]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase())
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  if (
    errorCodes.includes('model_not_found') ||
    /model.{0,160}?(?:not found|does not exist|is unknown)/.test(message)
  ) {
    return 'model_not_found'
  }
  if (
    errorCodes.includes('unsupported_model') ||
    /model.{0,160}?(?:is not supported|is unsupported|does not support)/.test(message)
  ) {
    return 'unsupported_model'
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
