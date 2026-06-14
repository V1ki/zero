import type {
  MetricsDB,
  RequestMemoryInjectionEntry,
  SnapshotEntry,
  Tracer,
  UsagePurpose,
} from '@zero-os/observe'
import type {
  CompressionResult,
  Message,
  ReasoningEffort,
  SecretFilter,
  TimelineCompactionBlock,
  ToolDefinition,
} from '@zero-os/shared'

export interface AgentConfig {
  name: string
  /** High-level role or task intent consumed by the prompt builder, not the rendered system prompt. */
  agentInstruction: string
  identityMemory?: string
  /** Controls which prompt sections are included. Defaults to 'full'. */
  promptMode?: import('@zero-os/shared').PromptMode
}

export interface AgentContext {
  systemPrompt: string
  identityMemory?: string
  /** Dynamic context (<system-reminder>) injected into user message for the API only, not stored. */
  dynamicContext?: string
  /** Local image files saved for text-only models to delegate to a vision sub-agent. */
  imageDelegationFiles?: Array<{ path: string; mediaType: string }>
  /** Request-scoped memory injections for observability and UI trace previews. */
  requestMemoryInjections?: RequestMemoryInjectionEntry[]
  /** Session-scoped memory ids already injected in prior layer1/layer2 retrievals. */
  injectedMemoryIds?: Map<string, string>
  conversationHistory: Message[]
  timelineCompactionBlocks?: TimelineCompactionBlock[]
  onTimelineCompactionBlocksChanged?: (blocks: TimelineCompactionBlock[]) => void
  tools: ToolDefinition[]
  maxContext?: number
  maxOutput?: number
  reasoningEffort?: ReasoningEffort
}

/**
 * Optional observability dependencies for the agent.
 */
export interface AgentObservability {
  metrics?: MetricsDB
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'> & {
    logSession?: Tracer['logSession']
  }
  secretFilter?: SecretFilter
  bus?: {
    emit(topic: string, data: Record<string, unknown>): void
  }
  /** Provider name for logging, e.g. "openai-codex" */
  providerName?: string
  /** Provider-qualified model label, e.g. "chatgpt/gpt-5.4" */
  modelLabel?: string
  /** ModelPricing from config for cost calculation */
  pricing?: import('@zero-os/shared').ModelPricing
  closurePricing?: import('@zero-os/shared').ModelPricing
  closureProviderName?: string
  closureModelLabel?: string
  contextCompactionPricing?: import('@zero-os/shared').ModelPricing
  contextCompactionProviderName?: string
  contextCompactionModelLabel?: string
  usagePurpose?: UsagePurpose
  parentSessionId?: string
  getCurrentSnapshotId?: () => string | undefined
  onContextCompressed?: (event: {
    summary: string
    stats: CompressionResult['stats']
    decisionContext: NonNullable<SnapshotEntry['decisionContext']>
  }) => void
}
