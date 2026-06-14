import type {
  ClosureLogEntry,
  DecisionLogEntry,
  RequestLogEntry,
  RequestMemoryInjectionEntry,
  RequestQueuedInjectionEntry,
  RequestQueuedInjectionMessageEntry,
  RequestToolCallEntry,
  RequestToolResultEntry,
  SnapshotEntry,
} from './observability-store'
import type { TraceEntry } from './trace-types'
import { asRecord, asString } from './utils'

const MAX_DECISION_RATIONALE_LENGTH = 1500

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function asTokens(value: unknown): { input: number; output: number } | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const input = asNumber(record.input)
  const output = asNumber(record.output)
  if (input === undefined && output === undefined) return undefined

  return {
    input: input ?? 0,
    output: output ?? 0,
  }
}

function asCompressionTokens(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  return compactRecord({
    input: asNumber(record.input),
    output: asNumber(record.output),
    cacheWrite: asNumber(record.cacheWrite),
    cacheRead: asNumber(record.cacheRead),
    reasoning: asNumber(record.reasoning),
  }) as Record<string, number> | undefined
}

function asSelectedMemories(
  value: unknown,
): Array<{ id: string; type: string; title: string; score?: number }> | undefined {
  if (!Array.isArray(value)) return undefined

  const selectedMemories = value.flatMap((item) => {
    const record = asRecord(item)
    const id = asString(record?.id)
    const type = asString(record?.type)
    const title = asString(record?.title)
    if (!id || !type || !title) return []

    return [
      {
        id,
        type,
        title,
        score: asNumber(record?.score),
      },
    ]
  })

  return selectedMemories.length > 0 ? selectedMemories : undefined
}

function asSearchSummaries(
  value: unknown,
): Array<{ query: string; resultCount: number; topResultTitle?: string }> | undefined {
  if (!Array.isArray(value)) return undefined

  const searchSummaries = value.flatMap((item) => {
    const record = asRecord(item)
    const query = asString(record?.query)
    const resultCount = asNumber(record?.resultCount)
    if (!query || resultCount === undefined) return []

    const results = Array.isArray(record?.results) ? record.results : []
    const topResultTitle = asString(asRecord(results[0])?.title)

    return [
      {
        query,
        resultCount,
        topResultTitle,
      },
    ]
  })

  return searchSummaries.length > 0 ? searchSummaries : undefined
}

function compactRecord(
  entries: Record<string, unknown | undefined>,
): Record<string, unknown> | undefined {
  const next = Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  )
  return Object.keys(next).length > 0 ? next : undefined
}

function asCompressionDecisionContext(
  value: unknown,
): SnapshotEntry['decisionContext'] | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const currentTokens = asNumber(record.currentTokens)
  const conversationBudget = asNumber(record.conversationBudget)

  if (currentTokens === undefined || conversationBudget === undefined) {
    return undefined
  }

  return {
    currentTokens,
    conversationBudget,
  }
}

function truncateDecisionRationale(value: string): {
  rationale: string
  truncated: boolean
} {
  if (value.length <= MAX_DECISION_RATIONALE_LENGTH) {
    return {
      rationale: value,
      truncated: false,
    }
  }

  return {
    rationale: `${value.slice(0, MAX_DECISION_RATIONALE_LENGTH - 3)}...`,
    truncated: true,
  }
}

function sortByTs<T extends { ts: string }>(entries: T[]): T[] {
  return entries.sort((left, right) => left.ts.localeCompare(right.ts))
}

function toMs(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function findNearestCompressionSpan(
  entries: TraceEntry[],
  snapshotEntry: TraceEntry,
  usedCompressionSpanIds: Set<string>,
): TraceEntry | undefined {
  const snapshotStartMs = toMs(snapshotEntry.startTime)
  if (snapshotStartMs === undefined) return undefined

  const snapshotParentId = snapshotEntry.parentSpanId
  const candidates = entries
    .filter((entry) => {
      if (usedCompressionSpanIds.has(entry.spanId)) return false
      if (entry.sessionId !== snapshotEntry.sessionId) return false
      if (entry.kind !== 'llm_request' || entry.name !== 'compression') return false
      if (entry.status !== 'success') return false

      const candidateEndMs = toMs(entry.endTime)
      if (candidateEndMs === undefined || candidateEndMs > snapshotStartMs) return false

      return snapshotStartMs - candidateEndMs <= 5_000
    })
    .sort((left, right) => {
      const leftSharesParent =
        snapshotParentId !== undefined &&
        left.parentSpanId !== undefined &&
        left.parentSpanId === snapshotParentId
      const rightSharesParent =
        snapshotParentId !== undefined &&
        right.parentSpanId !== undefined &&
        right.parentSpanId === snapshotParentId

      if (leftSharesParent !== rightSharesParent) {
        return leftSharesParent ? -1 : 1
      }

      const leftGap = snapshotStartMs - (toMs(left.endTime) ?? snapshotStartMs)
      const rightGap = snapshotStartMs - (toMs(right.endTime) ?? snapshotStartMs)
      if (leftGap !== rightGap) return leftGap - rightGap

      return left.startTime.localeCompare(right.startTime)
    })

  const matched = candidates[0]
  if (matched) {
    usedCompressionSpanIds.add(matched.spanId)
  }
  return matched
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
          decisionContext: asCompressionDecisionContext(snapshot.decisionContext),
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

export function projectSessionDecisionsFromTraceEntries(entries: TraceEntry[]): DecisionLogEntry[] {
  const results: DecisionLogEntry[] = []
  const usedCompressionSpanIds = new Set<string>()

  for (const entry of entries) {
    const base = {
      id: entry.spanId,
      sessionId: entry.sessionId,
      agentName: entry.agentName,
      durationMs: entry.durationMs,
      parentSpanId: entry.parentSpanId,
      sourceKind: entry.kind,
    } satisfies Omit<DecisionLogEntry, 'decisionType' | 'outcome' | 'ts'>

    if (entry.kind === 'snapshot') {
      const snapshot = asRecord(asRecord(entry.data)?.snapshot)
      if (!snapshot || asString(snapshot.trigger) !== 'context_compression') continue
      const decisionContext = asCompressionDecisionContext(snapshot.decisionContext)
      const compressionSpan = findNearestCompressionSpan(entries, entry, usedCompressionSpanIds)
      const compressionData = asRecord(asRecord(compressionSpan?.data)?.compression)

      results.push({
        ...base,
        decisionType: 'context_compression',
        outcome: 'compress',
        context: decisionContext ? compactRecord(decisionContext) : undefined,
        detail: compactRecord({
          messagesBefore: asNumber(snapshot.messagesBefore),
          messagesAfter: asNumber(snapshot.messagesAfter),
          compressedRange: asString(snapshot.compressedRange),
          model: asString(compressionData?.model),
          provider: asString(compressionData?.provider),
          tokens: asCompressionTokens(compressionData?.tokens),
          cost: asNumber(compressionData?.cost),
          durationMs: asNumber(compressionData?.durationMs),
        }),
        ts: asString(snapshot.ts) ?? entry.endTime ?? entry.startTime,
      })
      continue
    }

    if (entry.kind === 'context_compaction') {
      const compaction = asRecord(asRecord(entry.data)?.compaction)
      const compactionEvent = asString(compaction?.event)
      if (
        !compaction ||
        (compactionEvent !== 'episode_compaction' &&
          compactionEvent !== 'timeline_compaction_block')
      ) {
        continue
      }

      results.push({
        ...base,
        decisionType: 'context_compression',
        outcome:
          compactionEvent === 'timeline_compaction_block'
            ? `timeline_compaction_${asString(compaction.lifecycle) ?? 'event'}`
            : 'episode_compaction',
        context: compactRecord({
          blockId: asString(compaction.blockId),
          lifecycle: asString(compaction.lifecycle),
          strategy: asString(compaction.strategy),
          strategyVersion: asString(compaction.strategyVersion),
          boundaryReason: asString(compaction.boundaryReason),
          turnIndex: asNumber(compaction.turnIndex),
          episodeFullRetainTurns: asNumber(compaction.episodeFullRetainTurns),
          skippedUnfinishedToolUseIds: asStringArray(compaction.skippedUnfinishedToolUseIds),
        }),
        detail: compactRecord({
          messagesBefore: asNumber(compaction.messagesBefore),
          messagesAfter: asNumber(compaction.messagesAfter),
          compactedMessageCount: asNumber(compaction.compactedMessageCount),
          retainedMessageCount: asNumber(compaction.retainedMessageCount),
          coveredRange: asRecord(compaction.coveredRange),
          coveredMessageIds: asStringArray(compaction.coveredMessageIds),
          promptCharsBefore: asNumber(compaction.promptCharsBefore),
          promptCharsAfter: asNumber(compaction.promptCharsAfter),
          tokensBefore: asNumber(compaction.tokensBefore),
          tokensAfter: asNumber(compaction.tokensAfter),
          episodesCreated: asNumber(compaction.episodesCreated),
          workingStateId: asString(compaction.workingStateId),
          toolUseIds: asStringArray(compaction.toolUseIds),
          evidenceCount: asNumber(compaction.evidenceCount),
          evidenceChars: asNumber(compaction.evidenceChars),
          evidenceBytes: asNumber(compaction.evidenceBytes),
          rawCharsMovedToEvidence: asNumber(compaction.rawCharsMovedToEvidence),
          evidenceWriteStatusCounts: asRecord(compaction.evidenceWriteStatusCounts),
          topicCount: asNumber(compaction.topicCount),
          validationStatus: asString(compaction.validationStatus),
          validationErrors: asStringArray(compaction.validationErrors),
          validationWarnings: asStringArray(compaction.validationWarnings),
          model: asString(compaction.model),
          provider: asString(compaction.provider),
          promptVersion: asString(compaction.promptVersion),
          modelAttempts: asNumber(compaction.modelAttempts),
          supersedesBlockIds: asStringArray(compaction.supersedesBlockIds),
          supersededByBlockId: asString(compaction.supersededByBlockId),
        }),
        rationale: asString(compaction.boundaryReason),
        ts: entry.endTime ?? entry.startTime,
      })
      continue
    }

    if (entry.kind === 'llm_request') {
      const metadata = asRecord(entry.metadata)
      const request = asRecord(asRecord(entry.data)?.request)
      const turnIndex = asNumber(request?.turnIndex)

      if (metadata && asString(metadata.purpose) === 'memory_retrieval_decision') {
        const decision = asRecord(asRecord(entry.data)?.memoryRetrievalDecision)
        if (!decision) continue

        const need = asBoolean(decision.need)
        if (need === undefined) continue

        const queries = asStringArray(decision.queries) ?? []
        const selectedMemoryIds = asStringArray(decision.selectedMemoryIds) ?? []
        const searches = Array.isArray(decision.searches) ? decision.searches : []
        const searchResultCount = searches.reduce((count, search) => {
          const resultCount = asNumber(asRecord(search)?.resultCount)
          return count + (resultCount ?? 0)
        }, 0)
        const response = asString(decision.response)
        const rationale = response ? truncateDecisionRationale(response).rationale : undefined

        results.push({
          ...base,
          decisionType: 'memory_retrieval',
          outcome: need ? (selectedMemoryIds.length > 0 ? 'injected' : 'empty') : 'skipped',
          detail: compactRecord({
            need,
            turnIndex,
            queries,
            searchResultCount,
            selectedMemoryIds,
            selectedMemories: asSelectedMemories(decision.selectedMemories),
            usedFallbackSelection: asBoolean(decision.usedFallbackSelection),
            layer: asString(metadata.layer),
            tokens: asTokens(decision.tokens),
            cost: asNumber(decision.cost),
            searches: asSearchSummaries(decision.searches),
          }),
          rationale,
          ts: asString(request?.ts) ?? entry.endTime ?? entry.startTime,
        })
        continue
      }

      const stopReason = asString(request?.stopReason)
      const reasoningContent = asString(request?.reasoningContent)

      if (stopReason === 'tool_use' && reasoningContent) {
        const selectedTools = asStringArray(request?.toolNames) ?? []
        const toolCount = asNumber(request?.toolUseCount) ?? selectedTools.length
        const { rationale, truncated } = truncateDecisionRationale(reasoningContent)

        results.push({
          ...base,
          decisionType: 'tool_selection',
          outcome: selectedTools.length > 0 ? selectedTools.join(', ') : 'tool_use',
          detail: compactRecord({
            selectedTools,
            toolCount,
            rationaleTruncated: truncated ? true : undefined,
          }),
          rationale,
          ts: asString(request?.ts) ?? entry.endTime ?? entry.startTime,
        })
      }

      continue
    }

    if (entry.kind !== 'closure_decision') continue

    const closure = asRecord(asRecord(entry.data)?.closure)
    if (!closure || asString(closure.event) !== 'task_closure_decision') continue

    const action = asString(closure.action)
    const reason = asString(closure.reason)
    if (!action || !reason) continue

    const classifierModel = asString(asRecord(closure.classifierResponse)?.model)

    results.push({
      ...base,
      decisionType: 'task_closure',
      outcome: action,
      detail: compactRecord({
        classifierModel,
      }),
      rationale: reason,
      ts: asString(closure.ts) ?? entry.endTime ?? entry.startTime,
    })
  }

  return sortByTs(results)
}
