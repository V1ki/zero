import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { compareText } from './hash'
import type { TraceEntryLike, TraceObservation, TraceSnapshot } from './types'

const digestLength = 16
const knownSpanOperations = new Set([
  'context_compaction_model',
  'llm_request',
  'memory_nudge',
  'memory_retrieval_decision',
  'session_evaluate',
  'snapshot:context_updated',
  'snapshot:session_start',
  'task_closure_decision',
  'task_closure_failed',
  'timeline_compaction_block',
  'tool_environment_digest_model',
])
const knownTraceKinds = new Set([
  'closure_decision',
  'context_compaction',
  'llm_request',
  'snapshot',
  'tool_call',
  'turn',
])
const knownTraceStatuses = new Set(['cancelled', 'error', 'running', 'success'])
const knownToolNames = new Set([
  'bash',
  'close_agent',
  'codex',
  'edit',
  'fetch',
  'followup_task',
  'glob',
  'grep',
  'interrupt_agent',
  'list_agents',
  'memory',
  'memory_read',
  'memory_search',
  'read',
  'read_image',
  'schedule',
  'send_input',
  'send_message',
  'spawn_agent',
  'wait_agent',
  'web_search',
  'write',
  'x_search',
])
const readOnlyToolNames = new Set([
  'glob',
  'grep',
  'list_agents',
  'memory_read',
  'memory_search',
  'read',
  'read_image',
  'wait_agent',
  'web_search',
  'x_search',
])
const alwaysMutatingToolNames = new Set([
  'bash',
  'close_agent',
  'codex',
  'edit',
  'followup_task',
  'interrupt_agent',
  'send_input',
  'send_message',
  'spawn_agent',
  'write',
])

export async function readTraceSnapshot(options: {
  tracePath: string
  sourceSessionId: string
  allowedTraceRoot?: string
  maxLineChars?: number
  maxObservations?: number
}): Promise<TraceSnapshot> {
  const canonicalPath = await realpath(options.tracePath)
  if (options.allowedTraceRoot) {
    const canonicalRoot = await realpath(options.allowedTraceRoot)
    const relativePath = relative(canonicalRoot, canonicalPath)
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      resolve(canonicalRoot, relativePath) !== canonicalPath
    ) {
      throw new Error('trace_path_outside_allowed_root')
    }
  }

  const handle = await open(canonicalPath, 'r')
  const sourceStat = await handle.stat()
  const snapshotBytes = await findCompleteJsonlSize(handle, sourceStat.size)
  const inputHasher = createHash('sha256')
  const latestBySpan = new Map<string, TraceObservation>()
  const maxLineChars = options.maxLineChars ?? 8 * 1024 * 1024
  const maxObservations = options.maxObservations ?? 200_000

  let sourceLines = 0
  let parsedLines = 0
  let invalidJsonLines = 0
  let invalidShapeLines = 0
  let foreignSessionLines = 0
  let supersededLifecycleEntries = 0
  let supersededPayloadChars = 0
  let observedMaxLineChars = 0
  let buffer = ''
  let endSize = sourceStat.size

  try {
    if (snapshotBytes > 0) {
      const stream = createReadStream(canonicalPath, {
        fd: handle.fd,
        autoClose: false,
        start: 0,
        end: snapshotBytes - 1,
        encoding: 'utf-8',
      })
      for await (const chunk of stream) {
        inputHasher.update(chunk)
        buffer += chunk
        if (buffer.length > maxLineChars && !buffer.includes('\n')) {
          throw new Error(`trace_line_exceeds_limit:${maxLineChars}`)
        }

        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          sourceLines++
          observedMaxLineChars = Math.max(observedMaxLineChars, line.length)
          if (line.length > maxLineChars) {
            throw new Error(`trace_line_exceeds_limit:${maxLineChars}`)
          }
          if (line.trim().length > 0) {
            let parsed: TraceEntryLike
            try {
              parsed = JSON.parse(line) as TraceEntryLike
            } catch {
              invalidJsonLines++
              newlineIndex = buffer.indexOf('\n')
              continue
            }

            const parsedSessionId = asString(parsed.sessionId)
            if (!parsedSessionId) {
              invalidShapeLines++
              newlineIndex = buffer.indexOf('\n')
              continue
            }
            if (parsedSessionId !== options.sourceSessionId) {
              foreignSessionLines++
              newlineIndex = buffer.indexOf('\n')
              continue
            }

            const observation = projectTraceEntry(parsed, {
              sourceLine: sourceLines,
              payloadChars: line.length,
              expectedSessionId: options.sourceSessionId,
            })
            if (!observation) {
              invalidShapeLines++
              newlineIndex = buffer.indexOf('\n')
              continue
            }

            parsedLines++
            const previous = latestBySpan.get(observation.spanId)
            if (previous) {
              supersededLifecycleEntries++
              supersededPayloadChars += previous.payloadChars
            }
            latestBySpan.set(observation.spanId, observation)
            if (latestBySpan.size > maxObservations) {
              throw new Error(`trace_observations_exceed_limit:${maxObservations}`)
            }
          }
          newlineIndex = buffer.indexOf('\n')
        }
      }
    }
    endSize = (await handle.stat()).size
  } finally {
    await handle.close().catch(() => undefined)
  }

  if (buffer.length > 0) throw new Error('trace_snapshot_ended_with_partial_line')
  if (endSize < snapshotBytes) throw new Error('trace_source_truncated_during_snapshot')

  const observations = [...latestBySpan.values()].sort(
    (left, right) =>
      compareText(left.startedAt, right.startedAt) || left.sourceLine - right.sourceLine,
  )
  const terminalPayloadChars = observations.reduce(
    (total, observation) => total + observation.payloadChars,
    0,
  )
  const projectedObservationChars = observations.reduce(
    (total, observation) => total + JSON.stringify(observation).length,
    0,
  )
  const sourceRevision = `file:${sourceStat.dev}:${sourceStat.ino}:${snapshotBytes}:${Math.trunc(sourceStat.mtimeMs)}`

  return {
    sourceSessionId: options.sourceSessionId,
    sourceRevision,
    sourceDigest: inputHasher.digest('hex'),
    coveredRange: {
      fromLine: observations.length > 0 ? 1 : 0,
      toLine: sourceLines,
    },
    observations,
    stats: {
      sourcePath: canonicalPath,
      sourceBytes: snapshotBytes,
      sourceLines,
      parsedLines,
      invalidJsonLines,
      invalidShapeLines,
      foreignSessionLines,
      lifecycleEntries: parsedLines,
      supersededLifecycleEntries,
      supersededPayloadChars,
      uniqueSpans: observations.length,
      terminalPayloadChars,
      projectedObservationChars,
      maxLineChars: observedMaxLineChars,
    },
  }
}

async function findCompleteJsonlSize(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<number> {
  if (fileSize === 0) return 0
  const chunkSize = 64 * 1024
  let end = fileSize
  while (end > 0) {
    const start = Math.max(0, end - chunkSize)
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    for (let index = bytesRead - 1; index >= 0; index--) {
      if (buffer[index] === 0x0a) return start + index + 1
    }
    end = start
  }
  return 0
}

export function projectTraceEntry(
  entry: TraceEntryLike,
  options: {
    sourceLine: number
    payloadChars: number
    expectedSessionId: string
  },
): TraceObservation | undefined {
  const spanId = asString(entry.spanId)
  const sessionId = asString(entry.sessionId)
  const name = asString(entry.name)
  const startTime = asString(entry.startTime)
  if (!spanId || !sessionId || !name || !startTime) return undefined
  if (sessionId !== options.expectedSessionId) return undefined

  const kind = projectEnumLabel(asString(entry.kind), knownTraceKinds, 'kind')
  const status = projectEnumLabel(asString(entry.status), knownTraceStatuses, 'status')
  const data = asRecord(entry.data)
  const metadata = asRecord(entry.metadata)
  const operation = deriveOperation(name, data, kind)
  const errorClass = status === 'error' ? classifyError(entry, operation) : undefined
  const subject = deriveSubject(operation, data, metadata)
  const outcome = deriveOutcome(operation, status, errorClass, data, metadata)

  const projectedSpanId = `span_${digestValue(spanId)}`
  const parentSpanId = asString(entry.parentSpanId)
  return {
    ref: `span:${projectedSpanId}`,
    spanId: projectedSpanId,
    ...(parentSpanId ? { parentSpanId: `span_${digestValue(parentSpanId)}` } : {}),
    sourceLine: options.sourceLine,
    sessionId,
    kind,
    operation,
    lane: classifyLane(kind, operation),
    status,
    startedAt: startTime,
    ...(asString(entry.endTime) ? { endedAt: asString(entry.endTime) } : {}),
    ...(asNumber(entry.durationMs) !== undefined ? { durationMs: asNumber(entry.durationMs) } : {}),
    subjectDigest: digestValue(subject),
    outcomeDigest: digestValue(outcome),
    ...(errorClass ? { errorClass } : {}),
    sideEffect: isSideEffect(operation),
    payloadChars: options.payloadChars,
    metrics: extractMetrics(entry, data, metadata),
  }
}

function deriveOperation(name: string, data: Record<string, unknown>, kind: string): string {
  const hasToolPrefix = name.slice(0, 'tool:'.length).toLowerCase() === 'tool:'
  if (!hasToolPrefix && kind !== 'tool_call') {
    if (name === 'task_closure_decision') {
      const closure = asRecord(data.closure)
      const action = asString(closure.action)
      if (!action) return name
      const normalizedAction = action.trim().toLowerCase()
      return ['block', 'continue', 'finish'].includes(normalizedAction)
        ? `${name}:${normalizedAction}`
        : `${name}:action_${digestValue(action)}`
    }
    if (name.startsWith('turn:')) return 'turn'
    if (name.startsWith('sub_agent:')) return 'sub_agent'
    if (knownSpanOperations.has(name)) return name
    return `operation:unknown_${digestValue(name)}`
  }

  const rawToolName = hasToolPrefix ? name.slice('tool:'.length) : name
  const normalizedToolName = rawToolName.trim().toLowerCase()
  const toolName = knownToolNames.has(normalizedToolName)
    ? normalizedToolName
    : `custom_${digestValue(rawToolName)}`
  const input = asRecord(data.input)
  const action = deriveToolAction(toolName, input)
  return action ? `tool:${toolName}:${action}` : `tool:${toolName}`
}

function deriveToolAction(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'fetch') {
    return projectAction(asString(input.method) ?? 'get', [
      'delete',
      'get',
      'head',
      'patch',
      'post',
      'put',
    ])
  }
  const rawAction =
    asString(input.action) ??
    asString(input.operation) ??
    asString(input.mode) ??
    asString(input.commandType)
  if (toolName === 'schedule') {
    return projectAction(rawAction ?? 'missing', [
      'cancel',
      'create',
      'delete',
      'get',
      'list',
      'pause',
      'resume',
      'update',
    ])
  }
  if (toolName === 'memory') {
    return projectAction(rawAction ?? 'missing', [
      'create',
      'delete',
      'list',
      'read',
      'remove',
      'search',
      'set',
      'update',
      'write',
    ])
  }
  if (toolName.startsWith('custom_') && rawAction) {
    return `action_${digestValue(rawAction)}`
  }
  return undefined
}

function projectAction(value: string, allowed: string[]): string {
  const normalized = value.trim().toLowerCase()
  return allowed.includes(normalized) ? normalized : `action_${digestValue(value)}`
}

function deriveSubject(
  operation: string,
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
): unknown {
  if (operation.startsWith('tool:')) return projectToolSubject(operation, asRecord(data.input))

  const compaction = asRecord(data.compaction)
  if (Object.keys(compaction).length > 0) {
    return {
      strategyVersion: compaction.strategyVersion,
      lifecycle: compaction.lifecycle,
      blockStatus: compaction.blockStatus,
      model: compaction.model,
      provider: compaction.provider,
    }
  }

  const compactionModel = asRecord(data.contextCompactionModel)
  if (Object.keys(compactionModel).length > 0) {
    return {
      promptVersion: compactionModel.promptVersion,
      primaryModel: compactionModel.primaryModel,
      primaryProvider: compactionModel.primaryProvider,
      usedModel: compactionModel.model,
      usedProvider: compactionModel.provider,
    }
  }

  return {
    purpose: metadata.purpose,
    agentName: metadata.agentName,
    layer: metadata.layer,
  }
}

function deriveOutcome(
  operation: string,
  status: string,
  errorClass: string | undefined,
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
): unknown {
  if (errorClass) return { status, errorClass }

  const compaction = asRecord(data.compaction)
  if (Object.keys(compaction).length > 0) {
    return {
      status,
      lifecycle: compaction.lifecycle,
      validationStatus: compaction.validationStatus,
      blockStatus: compaction.blockStatus,
      model: compaction.model,
    }
  }

  const toolResult = asRecord(data.toolResult)
  if (Object.keys(toolResult).length > 0) {
    return {
      status,
      success: toolResult.success,
      ...(isSideEffect(operation) ? { mutation: canonicalHashInput(data.input) } : {}),
      outputSummary: canonicalHashInput(data.outputSummary ?? metadata.outputSummary),
    }
  }

  const closure = asRecord(data.closure)
  if (Object.keys(closure).length > 0) {
    return {
      status,
      action: closure.action,
      confidence: closure.confidence,
      reason: closure.reason,
    }
  }

  return { status }
}

function classifyLane(kind: string, operation: string): TraceObservation['lane'] {
  if (
    kind === 'context_compaction' ||
    operation === 'context_compaction_model' ||
    operation === 'tool_environment_digest_model'
  ) {
    return 'diagnostic'
  }
  if (
    kind === 'closure_decision' ||
    operation === 'memory_nudge' ||
    operation === 'memory_retrieval_decision' ||
    operation === 'task_closure_failed' ||
    operation.startsWith('task_closure_decision')
  ) {
    return 'control'
  }
  return 'source'
}

function isSideEffect(operation: string): boolean {
  if (!operation.startsWith('tool:')) return false
  const [, toolName, action] = operation.split(':')
  if (!toolName) return true
  if (toolName.startsWith('custom_')) return true
  if (readOnlyToolNames.has(toolName)) return false
  if (alwaysMutatingToolNames.has(toolName)) return true
  if (toolName === 'fetch') return action !== 'get' && action !== 'head'
  if (toolName === 'schedule') return action !== 'get' && action !== 'list'
  if (toolName === 'memory') return !['list', 'read', 'search'].includes(action ?? '')
  return true
}

function projectToolSubject(operation: string, input: Record<string, unknown>): unknown {
  const [, toolName, action] = operation.split(':')
  if (toolName === 'memory') {
    return pickFields(input, ['id', 'memoryId', 'key', 'path', 'type', 'title', 'tag'])
  }
  if (toolName === 'schedule') {
    if (action === 'list') return { scope: 'all_schedules' }
    return pickFields(input, ['id', 'scheduleId', 'name', 'channelId', 'sessionId'])
  }
  if (toolName === 'memory_read') return pickFields(input, ['path', 'id', 'memoryId'])
  if (toolName === 'fetch') return pickFields(input, ['url', 'method'])
  if (toolName === 'x_search') return canonicalHashInput(input)

  const identity = pickFields(input, [
    'id',
    'key',
    'name',
    'path',
    'url',
    'target',
    'sessionId',
    'channelId',
    'messageId',
  ])
  return Object.keys(asRecord(identity)).length > 0 ? identity : canonicalHashInput(input)
}

function pickFields(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, canonicalHashInput(input[key])]),
  )
}

function classifyError(entry: TraceEntryLike, operation: string): string {
  const data = asRecord(entry.data)
  const metadata = asRecord(entry.metadata)
  const toolResult = asRecord(data.toolResult)
  const compactionModel = asRecord(data.contextCompactionModel)
  const validation = asRecord(compactionModel.validation)
  const text = [
    metadata.error,
    metadata.outputSummary,
    data.outputSummary,
    toolResult.outputSummary,
    toolResult.output,
    validation.status === 'failed' ? 'validation failed' : undefined,
    compactionModel.parsed === false ? 'parse failed' : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()

  if (/empty response|empty_response/.test(text)) return 'empty_response'
  if (/permission_error|oauth authentication|\b403\b/.test(text)) return 'permission_error'
  if (/resource-exhausted|at capacity|\b429\b/.test(text)) return 'resource_exhausted'
  if (/allowed_x_handles supports at most|invalid.*input|bad request|\b400\b/.test(text)) {
    return 'invalid_input'
  }
  if (/validation failed|invalid.*ref|missing.*ref/.test(text)) return 'validation_failed'
  if (/parse failed|invalid xml|no final text|parsed=false/.test(text)) return 'parse_failed'
  if (/timeout|timed out|deadline/.test(text)) return 'timeout'
  if (/cancel|abort|interrupt/.test(text)) return 'cancelled'
  return `other_${digestValue({ operation, text })}`
}

function extractMetrics(
  entry: TraceEntryLike,
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, number> {
  const metrics: Record<string, number> = {}
  addMetric(metrics, 'durationMs', entry.durationMs)
  addMetric(metrics, 'messageCount', metadata.messageCount)
  addMetric(metrics, 'turnIndex', data.turnIndex ?? metadata.turnIndex)

  const model = asRecord(data.contextCompactionModel)
  for (const key of [
    'coveredMessageCount',
    'evidenceCount',
    'promptChars',
    'responseChars',
    'toolDigestCount',
    'toolDigestRawChars',
    'toolDigestChars',
    'topicCount',
    'attempts',
  ]) {
    addMetric(metrics, key, model[key])
  }
  if (typeof model.parsed === 'boolean') metrics.parsedCandidate = model.parsed ? 1 : 0
  const modelValidation = asRecord(model.validation)
  if (modelValidation.status === 'passed') metrics.validationPassed = 1
  if (modelValidation.status === 'failed') metrics.validationFailed = 1

  const compaction = asRecord(data.compaction)
  for (const key of [
    'blockGeneration',
    'compactedMessageCount',
    'messagesBefore',
    'messagesAfter',
    'promptCharsBefore',
    'promptCharsAfter',
    'tokensBefore',
    'tokensAfter',
    'evidenceCount',
    'evidenceChars',
    'evidenceBytes',
    'rawCharsMovedToEvidence',
    'topicCount',
  ]) {
    addMetric(metrics, key, compaction[key])
  }
  if (compaction.lifecycle === 'created') metrics.createdBlock = 1
  if (compaction.lifecycle === 'superseded') metrics.supersededBlock = 1
  if (compaction.lifecycle === 'created' && compaction.model === 'deterministic-fallback') {
    metrics.deterministicFallbackBlock = 1
  }
  if (compaction.lifecycle === 'created' && compaction.model !== 'deterministic-fallback') {
    metrics.semanticBlockCreated = 1
  }

  const evidence = Array.isArray(compaction.evidence) ? compaction.evidence : []
  if (evidence.length > 0) {
    metrics.traceEvidenceItems = evidence.length
    const digests = new Set<string>()
    for (const item of evidence) {
      const record = asRecord(item)
      const digest = asString(record.sha256)
      if (digest) digests.add(digest)
    }
    metrics.traceUniqueEvidencePayloads = digests.size
  }

  return metrics
}

function addMetric(target: Record<string, number>, key: string, value: unknown): void {
  const numeric = asNumber(value)
  if (numeric !== undefined && Number.isFinite(numeric)) target[key] = numeric
}

function canonicalHashInput(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.map((item) => canonicalHashInput(item))
  }
  const record = asRecord(value)
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalHashInput(item)]),
  )
}

function digestValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalHashInput(value)))
    .digest('hex')
    .slice(0, digestLength)
}

function projectEnumLabel(value: string | undefined, allowed: Set<string>, prefix: string): string {
  if (!value) return `${prefix}:unknown_missing`
  const normalized = value.trim().toLowerCase()
  return allowed.has(normalized) ? normalized : `${prefix}:unknown_${digestValue(value)}`
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
