import { createHash } from 'node:crypto'
import { computeCost } from '@zero-os/model'
import type {
  RequestMemoryInjectionEntry,
  RequestToolCallEntry,
  RequestToolResultEntry,
  Tracer,
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  ModelPricing,
  SecretFilter,
  ToolEvidence,
  ToolLogger,
} from '@zero-os/shared'
import type { EpisodeCompactionTraceEvent } from './context'
import type { QueuedInjectionTrace } from './queue'
import type { ToolEvidenceReason } from './truncate'

export interface AgentTraceRecorderDeps {
  sessionId: string
  agentName: string
  spawnedByRequestId?: string
  logger: ToolLogger
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'> & {
    logSession?: Tracer['logSession']
  }
  secretFilter?: SecretFilter
  providerName?: string
  modelLabel?: string
  pricing?: ModelPricing
  getCurrentSnapshotId?: () => string | undefined
}

export class AgentTraceRecorder {
  constructor(private readonly deps: AgentTraceRecorderDeps) {}

  recordEpisodeCompactionTrace(
    event: EpisodeCompactionTraceEvent,
    parentSpanId: string | undefined,
    turnIndex: number,
  ): void {
    const payload = filterTraceValue(
      {
        ...event,
        turnIndex,
        agentName: this.deps.agentName,
      },
      this.deps.secretFilter,
    ) as Record<string, unknown>
    const span = this.deps.tracer?.startSpan(
      this.deps.sessionId,
      'timeline_compaction_block',
      parentSpanId,
      {
        kind: 'context_compaction',
        agentName: this.deps.agentName,
        data: {
          compaction: payload,
        },
        metadata: {
          turnIndex,
          lifecycle: event.lifecycle,
          blockId: event.blockId,
          strategy: event.strategy,
          strategyVersion: event.strategyVersion,
          episodesCreated: event.episodesCreated,
          evidenceCount: event.evidenceCount,
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter,
          compactedMessageCount: event.compactedMessageCount,
        },
      },
    )

    this.deps.tracer?.logSession?.(this.deps.sessionId, 'info', 'context_compaction.block', {
      traceSpanId: span?.id,
      ...payload,
    })

    if (span) {
      this.deps.tracer?.endSpan(span.id, 'success', {
        turnIndex,
        lifecycle: event.lifecycle,
        blockId: event.blockId,
        episodesCreated: event.episodesCreated,
        evidenceCount: event.evidenceCount,
      })
    }
  }

  logToolEvidence(
    evidence: ToolEvidence,
    meta: {
      source: 'active_tool_use' | 'active_tool_result' | 'episode_compaction'
      reason: ToolEvidenceReason | 'large_tool_input' | 'replay_compaction' | 'tool_result_output'
      turnIndex: number
      traceSpanId?: string
      requestId?: string
      compactionId?: string
      artifactPath?: string
      originalChars?: number
      originalTokens?: number
      promptTokenLimit?: number
      thresholdChars?: number
      inlineContentChars?: number
    },
  ): void {
    const payload = filterTraceValue(
      {
        traceSpanId: meta.traceSpanId,
        requestId: meta.requestId,
        compactionId: meta.compactionId,
        source: meta.source,
        reason: meta.reason,
        turnIndex: meta.turnIndex,
        tool: evidence.toolName,
        toolUseId: evidence.toolUseId,
        artifactPath: meta.artifactPath,
        originalChars: meta.originalChars,
        originalTokens: meta.originalTokens,
        promptTokenLimit: meta.promptTokenLimit,
        thresholdChars: meta.thresholdChars,
        inlineContentChars: meta.inlineContentChars,
        evidence: {
          kind: evidence.kind,
          sessionId: evidence.sessionId,
          toolUseId: evidence.toolUseId,
          toolName: evidence.toolName,
          path: evidence.path,
          chars: evidence.chars,
          bytes: evidence.bytes,
          sha256: evidence.sha256,
          createdAt: evidence.createdAt,
          summary: evidence.summary,
          strategy: evidence.strategy,
          writeStatus: evidence.writeStatus,
        },
      },
      this.deps.secretFilter,
    ) as Record<string, unknown>

    this.deps.tracer?.logSession?.(this.deps.sessionId, 'info', 'tool_evidence.persisted', payload)
    this.deps.logger.info('tool_evidence_persisted', payload)
  }

  logLLMRequest(options: {
    request: CompletionRequest
    response: CompletionResponse
    userPrompt: string
    durationMs: number
    meta: {
      turnIndex: number
      parentId?: string
    }
    requestToolResults: RequestToolResultEntry[]
    queuedInjection?: QueuedInjectionTrace
    memoryInjections?: RequestMemoryInjectionEntry[]
    traceSpanId?: string
  }): void {
    const cost = computeCost(options.response.usage, this.deps.pricing)
    const filter = this.deps.secretFilter
    const requestMetadata = buildRequestMetadata(options.request)
    const snapshotId = this.deps.getCurrentSnapshotId?.()
    const responseText = options.response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
    const toolCalls = extractToolCalls(options.response.content, filter)
    const toolUseCount = toolCalls.length
    const safeUserPrompt = filter ? filter.filter(options.userPrompt) : options.userPrompt
    const safeResponseText = filter ? filter.filter(responseText) : responseText
    const safeReasoningContent = options.response.reasoningContent
      ? filter
        ? filter.filter(options.response.reasoningContent)
        : options.response.reasoningContent
      : undefined
    const safeQueuedInjection = filterQueuedInjection(options.queuedInjection, filter)
    const safeMemoryInjections = filterMemoryInjections(options.memoryInjections, filter)

    if (options.traceSpanId) {
      this.deps.tracer?.updateSpan(options.traceSpanId, {
        data: {
          request: {
            id: options.response.id,
            turnIndex: options.meta.turnIndex,
            parentId: options.meta.parentId,
            sessionId: this.deps.sessionId,
            agentName: this.deps.agentName,
            spawnedByRequestId: this.deps.spawnedByRequestId,
            snapshotId,
            model: this.deps.modelLabel ?? options.response.model,
            provider: this.deps.providerName ?? 'unknown',
            userPrompt: safeUserPrompt,
            response: safeResponseText,
            reasoningContent: safeReasoningContent,
            stopReason: options.response.stopReason,
            toolUseCount,
            toolCalls,
            toolResults: options.requestToolResults,
            ...(safeQueuedInjection ? { queuedInjection: safeQueuedInjection } : {}),
            ...(safeMemoryInjections ? { memoryInjections: safeMemoryInjections } : {}),
            toolNames: requestMetadata.toolNames,
            toolDefinitionsHash: requestMetadata.toolDefinitionsHash,
            systemHash: requestMetadata.systemHash,
            staticPrefixHash: requestMetadata.staticPrefixHash,
            messageCount: options.request.messages.length,
            tokens: {
              input: options.response.usage.input,
              output: options.response.usage.output,
              cacheWrite: options.response.usage.cacheWrite,
              cacheRead: options.response.usage.cacheRead,
              reasoning: options.response.usage.reasoning,
            },
            cost,
            durationMs: options.durationMs,
          },
        },
        metadata: {
          requestId: options.response.id,
          toolNames: requestMetadata.toolNames,
          toolDefinitionsHash: requestMetadata.toolDefinitionsHash,
          systemHash: requestMetadata.systemHash,
          staticPrefixHash: requestMetadata.staticPrefixHash,
        },
      })
      this.deps.tracer?.endSpan(options.traceSpanId, 'success')
    }
  }
}

export function cloneMemoryInjections(
  memoryInjections?: RequestMemoryInjectionEntry[],
): RequestMemoryInjectionEntry[] | undefined {
  if (!memoryInjections || memoryInjections.length === 0) return undefined
  return memoryInjections.map((memoryInjection) => ({ ...memoryInjection }))
}

export function filterQueuedInjection(
  queuedInjection: QueuedInjectionTrace | undefined,
  secretFilter: SecretFilter | undefined,
): QueuedInjectionTrace | undefined {
  if (!queuedInjection) return undefined
  if (!secretFilter) return queuedInjection

  return {
    ...queuedInjection,
    formattedText: secretFilter.filter(queuedInjection.formattedText),
    messages: queuedInjection.messages.map((message) => ({
      ...message,
      content: secretFilter.filter(message.content),
    })),
  }
}

export function filterMemoryInjections(
  memoryInjections: RequestMemoryInjectionEntry[] | undefined,
  secretFilter: SecretFilter | undefined,
): RequestMemoryInjectionEntry[] | undefined {
  if (!memoryInjections || memoryInjections.length === 0) return undefined
  if (!secretFilter) return cloneMemoryInjections(memoryInjections)

  return memoryInjections.map((memoryInjection) => ({
    ...memoryInjection,
    formattedText: secretFilter.filter(memoryInjection.formattedText),
  }))
}

export function buildRequestMetadata(request: CompletionRequest): {
  toolNames: string[]
  toolDefinitionsHash?: string
  systemHash?: string
  staticPrefixHash?: string
} {
  const toolNames = request.tools?.map((tool) => tool.name) ?? []
  const toolDefinitionsHash =
    request.tools && request.tools.length > 0 ? hashValue(request.tools) : undefined
  const systemHash = request.system ? hashValue(request.system) : undefined
  const staticPrefixHash =
    request.system || request.tools?.length
      ? hashValue({
          system: request.system,
          tools: request.tools ?? [],
        })
      : undefined

  return {
    toolNames,
    toolDefinitionsHash,
    systemHash,
    staticPrefixHash,
  }
}

export function extractTextFromMessage(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function extractToolCalls(
  content: ContentBlock[],
  secretFilter?: SecretFilter,
): RequestToolCallEntry[] {
  return content.flatMap((block) => {
    if (block.type !== 'tool_use') return []
    return [
      {
        id: block.id,
        name: block.name,
        input: filterToolInput(block.input, secretFilter),
        evidence: block.evidence,
      },
    ]
  })
}

export function toRequestToolResults(content: ContentBlock[]): RequestToolResultEntry[] {
  return content.flatMap((block) => {
    if (block.type !== 'tool_result') return []
    return [
      {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        isError: block.isError,
        outputSummary: block.outputSummary,
        evidence: block.evidence,
      },
    ]
  })
}

export function filterToolInput(
  input: Record<string, unknown>,
  secretFilter?: SecretFilter,
): Record<string, unknown> {
  const filtered = filterTraceValue(input, secretFilter)
  return filtered && typeof filtered === 'object' && !Array.isArray(filtered)
    ? (filtered as Record<string, unknown>)
    : {}
}

export function filterTraceValue(value: unknown, secretFilter?: SecretFilter): unknown {
  if (typeof value === 'string') {
    return secretFilter ? secretFilter.filter(value) : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => filterTraceValue(item, secretFilter))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        filterTraceValue(nestedValue, secretFilter),
      ]),
    )
  }

  return value
}

export function stringifyTraceData(value: unknown, maxLength = 500): string {
  try {
    const serialized = JSON.stringify(value)
    if (!serialized) return ''
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized
  } catch {
    return ''
  }
}

export function filterContent(
  content: ContentBlock[],
  secretFilter?: SecretFilter,
): ContentBlock[] {
  if (!secretFilter) return content

  return content.map((block): ContentBlock => {
    if (block.type === 'text') {
      return { ...block, text: secretFilter.filter(block.text) }
    }
    if (block.type === 'thinking') {
      const thinking = secretFilter.filter(block.thinking)
      return thinking === block.thinking ? block : { ...block, thinking, signature: undefined }
    }
    return block
  })
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
