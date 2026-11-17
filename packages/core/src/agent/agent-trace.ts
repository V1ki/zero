import { createHash } from 'node:crypto'
import type { Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  SecretFilter,
  ToolEvidence,
  ToolLogger,
} from '@zero-os/shared'
import type { ToolEvidenceReason } from './truncate'

export interface AgentTraceRecorderDeps {
  sessionId: string
  agentName: string
  logger: ToolLogger
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'> & {
    logSession?: Tracer['logSession']
  }
  secretFilter?: SecretFilter
  getCurrentSnapshotId?: () => string | undefined
}

export class AgentTraceRecorder {
  constructor(private readonly deps: AgentTraceRecorderDeps) {}

  logToolEvidence(
    evidence: ToolEvidence,
    meta: {
      source: 'active_tool_use' | 'active_tool_result'
      reason: ToolEvidenceReason | 'large_tool_input' | 'tool_result_output'
      turnIndex: number
      traceSpanId?: string
      requestId?: string
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

  /**
   * 请求本身(回复、工具调用、工具结果、token、费用)记在事件流里,会话详情按 span 编号补回,见
   * `attachRequestsToSpans`;span 上只留编号、工具名、hash 和当时的快照。
   */
  logLLMRequest(options: {
    request: CompletionRequest
    response: CompletionResponse
    traceSpanId?: string
  }): void {
    if (!options.traceSpanId) return
    const requestMetadata = buildRequestMetadata(options.request)
    this.deps.tracer?.updateSpan(options.traceSpanId, {
      metadata: {
        requestId: options.response.id,
        toolNames: requestMetadata.toolNames,
        toolDefinitionsHash: requestMetadata.toolDefinitionsHash,
        systemHash: requestMetadata.systemHash,
        staticPrefixHash: requestMetadata.staticPrefixHash,
        snapshotId: this.deps.getCurrentSnapshotId?.(),
      },
    })
    this.deps.tracer?.endSpan(options.traceSpanId, 'success')
  }
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
