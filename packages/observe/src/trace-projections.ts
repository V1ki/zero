import type {
  ClosureLogEntry,
  RequestLogEntry,
  RequestMemoryInjectionEntry,
  RequestQueuedInjectionEntry,
  RequestQueuedInjectionMessageEntry,
  RequestToolCallEntry,
  RequestToolResultEntry,
  SnapshotEntry,
} from './observability-store'
import type { TraceEntry } from './trace'
import { asRecord, asString } from './utils'

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function asToolCalls(value: unknown): RequestToolCallEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is RequestToolCallEntry =>
    Boolean(
      item &&
        typeof item === 'object' &&
        typeof (item as RequestToolCallEntry).id === 'string' &&
        typeof (item as RequestToolCallEntry).name === 'string' &&
        (item as RequestToolCallEntry).input &&
        typeof (item as RequestToolCallEntry).input === 'object' &&
        !Array.isArray((item as RequestToolCallEntry).input),
    ),
  )
}

function asToolResults(value: unknown): RequestToolResultEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is RequestToolResultEntry =>
    Boolean(
      item &&
        typeof item === 'object' &&
        (item as RequestToolResultEntry).type === 'tool_result' &&
        typeof (item as RequestToolResultEntry).toolUseId === 'string' &&
        typeof (item as RequestToolResultEntry).content === 'string' &&
        ((item as RequestToolResultEntry).isError === undefined ||
          typeof (item as RequestToolResultEntry).isError === 'boolean') &&
        ((item as RequestToolResultEntry).outputSummary === undefined ||
          typeof (item as RequestToolResultEntry).outputSummary === 'string'),
    ),
  )
}

function asQueuedInjectionMessages(value: unknown): RequestQueuedInjectionMessageEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is RequestQueuedInjectionMessageEntry =>
    Boolean(
      item &&
        typeof item === 'object' &&
        typeof (item as RequestQueuedInjectionMessageEntry).timestamp === 'string' &&
        typeof (item as RequestQueuedInjectionMessageEntry).content === 'string' &&
        typeof (item as RequestQueuedInjectionMessageEntry).imageCount === 'number' &&
        Number.isFinite((item as RequestQueuedInjectionMessageEntry).imageCount) &&
        Array.isArray((item as RequestQueuedInjectionMessageEntry).mediaTypes) &&
        (item as RequestQueuedInjectionMessageEntry).mediaTypes.every(
          (mediaType) => typeof mediaType === 'string',
        ),
    ),
  )
}

function asQueuedInjection(value: unknown): RequestQueuedInjectionEntry | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const count = asNumber(record.count)
  const formattedText = asString(record.formattedText)
  if (count === undefined || formattedText === undefined) return undefined

  return {
    count,
    formattedText,
    messages: asQueuedInjectionMessages(record.messages),
  }
}

function asMemoryInjections(value: unknown): RequestMemoryInjectionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined

  const normalized = value.filter((item): item is RequestMemoryInjectionEntry =>
    Boolean(
      item &&
        typeof item === 'object' &&
        (((item as RequestMemoryInjectionEntry).layer === 'layer1' &&
          ((item as RequestMemoryInjectionEntry).source === 'retrieved_memories' ||
            (item as RequestMemoryInjectionEntry).source === 'memory_hint')) ||
          ((item as RequestMemoryInjectionEntry).layer === 'layer2' &&
            ((item as RequestMemoryInjectionEntry).source === 'retrieved_memories' ||
              (item as RequestMemoryInjectionEntry).source === 'memory_hint'))) &&
        typeof (item as RequestMemoryInjectionEntry).formattedText === 'string',
    ),
  )

  return normalized.length > 0 ? normalized : undefined
}

function sortByTs<T extends { ts: string }>(entries: T[]): T[] {
  return entries.sort((left, right) => left.ts.localeCompare(right.ts))
}

export function projectSessionRequestsFromTraceEntries(entries: TraceEntry[]): RequestLogEntry[] {
  return sortByTs(
    entries.flatMap((entry) => {
      if (entry.kind !== 'llm_request') return []

      const request = asRecord(asRecord(entry.data)?.request)
      if (!request) return []
      const tokens = asRecord(request?.tokens)
      const id = asString(request?.id)
      const turnIndex = asNumber(request?.turnIndex)
      const model = asString(request?.model)
      const provider = asString(request?.provider)
      const userPrompt = asString(request?.userPrompt)
      const responseText = asString(request?.response)
      const stopReason = asString(request?.stopReason)
      const inputTokens = asNumber(tokens?.input)
      const outputTokens = asNumber(tokens?.output)
      const cost = asNumber(request?.cost)

      if (
        !id ||
        turnIndex === undefined ||
        !model ||
        !provider ||
        userPrompt === undefined ||
        responseText === undefined ||
        !stopReason ||
        inputTokens === undefined ||
        outputTokens === undefined ||
        cost === undefined
      ) {
        return []
      }

      return [
        {
          id,
          turnIndex,
          parentId: asString(request.parentId),
          sessionId: entry.sessionId,
          agentName: asString(request.agentName),
          spawnedByRequestId: asString(request.spawnedByRequestId),
          snapshotId: asString(request.snapshotId),
          model,
          provider,
          userPrompt,
          response: responseText,
          reasoningContent: asString(request.reasoningContent),
          stopReason: stopReason as RequestLogEntry['stopReason'],
          toolUseCount: asNumber(request.toolUseCount) ?? 0,
          toolCalls: asToolCalls(request.toolCalls),
          toolResults: asToolResults(request.toolResults),
          queuedInjection: asQueuedInjection(request.queuedInjection),
          memoryInjections: asMemoryInjections(request.memoryInjections),
          toolNames: asStringArray(request.toolNames),
          toolDefinitionsHash: asString(request.toolDefinitionsHash),
          systemHash: asString(request.systemHash),
          staticPrefixHash: asString(request.staticPrefixHash),
          messageCount: asNumber(request.messageCount),
          tokens: {
            input: inputTokens,
            output: outputTokens,
            cacheWrite: asNumber(tokens?.cacheWrite),
            cacheRead: asNumber(tokens?.cacheRead),
            reasoning: asNumber(tokens?.reasoning),
          },
          cost,
          durationMs: asNumber(request.durationMs) ?? entry.durationMs,
          ts: asString(request.ts) ?? entry.endTime ?? entry.startTime,
        },
      ]
    }),
  )
}

export function projectSessionSnapshotsFromTraceEntries(entries: TraceEntry[]): SnapshotEntry[] {
  return sortByTs(
    entries.flatMap((entry) => {
      if (entry.kind !== 'snapshot') return []

      const snapshot = asRecord(asRecord(entry.data)?.snapshot)
      if (!snapshot) return []
      const id = asString(snapshot?.id)
      const trigger = asString(snapshot?.trigger)
      const systemPrompt = asString(snapshot?.systemPrompt)

      if (!id || !trigger || systemPrompt === undefined) {
        return []
      }

      return [
        {
          id,
          sessionId: entry.sessionId,
          trigger,
          model: asString(snapshot.model),
          parentSnapshot: asString(snapshot.parentSnapshot),
          systemPrompt,
          tools: asStringArray(snapshot.tools),
          identityMemory: asString(snapshot.identityMemory),
          compressedSummary: asString(snapshot.compressedSummary),
          messagesBefore: asNumber(snapshot.messagesBefore),
          messagesAfter: asNumber(snapshot.messagesAfter),
          compressedRange: asString(snapshot.compressedRange),
          ts: asString(snapshot.ts) ?? entry.endTime ?? entry.startTime,
        },
      ]
    }),
  )
}

export function projectSessionClosuresFromTraceEntries(entries: TraceEntry[]): ClosureLogEntry[] {
  const results: ClosureLogEntry[] = []

  for (const entry of entries) {
    if (entry.kind !== 'closure_decision' && entry.kind !== 'closure_failed') continue

    const closure = asRecord(asRecord(entry.data)?.closure)
    if (!closure) continue

    const classifierRequest = asRecord(closure.classifierRequest)
    const system = asString(classifierRequest?.system)
    const prompt = asString(classifierRequest?.prompt)
    const maxTokens = asNumber(classifierRequest?.maxTokens)
    const event = asString(closure.event)

    if (!event || !system || !prompt || maxTokens === undefined) continue

    const base = {
      ts: asString(closure.ts) ?? entry.endTime ?? entry.startTime,
      sessionId: entry.sessionId,
      assistantMessageId: asString(closure.assistantMessageId),
      assistantMessageCreatedAt: asString(closure.assistantMessageCreatedAt),
      classifierRequest: {
        system,
        prompt,
        maxTokens,
      },
    }

    if (event === 'task_closure_decision') {
      const action = asString(closure.action)
      const reason = asString(closure.reason)
      if (!action || !reason) continue

      results.push({
        ...base,
        event,
        action: action as 'finish' | 'continue' | 'block',
        reason,
        classifierResponse: closure.classifierResponse as ClosureLogEntry['classifierResponse'],
        trimFrom: asString(closure.trimFrom),
      })
      continue
    }

    if (event === 'task_closure_failed') {
      const reason = asString(closure.reason)
      const failureStage = asString(closure.failureStage)
      if (!reason || !failureStage) continue

      results.push({
        ...base,
        event,
        reason: reason as 'invalid_classifier_output' | 'classifier_failed',
        failureStage: failureStage as 'parse_classifier_response' | 'request_classifier',
        classifierResponse: closure.classifierResponse as ClosureLogEntry['classifierResponse'],
        classifierResponseRaw: asString(closure.classifierResponseRaw),
        error: asString(closure.error),
      })
    }
  }

  return sortByTs(results)
}
