export interface MemoryInjectionEntry {
  layer: 'layer1' | 'layer2'
  source: 'retrieved_memories' | 'memory_hint'
  formattedText: string
}

export interface MemoryRetrievalSearchSummary {
  query: string
  resultCount: number
  topResultTitle?: string
}

export interface MemoryRetrievalSelectedMemory {
  id: string
  type: string
  title: string
  score?: number
}

export interface MemoryRetrievalTokens {
  input: number
  output: number
}

export interface MemoryRetrievalDetail {
  need?: boolean
  layer?: string
  turnIndex?: number
  queries: string[]
  searches: MemoryRetrievalSearchSummary[]
  searchResultCount?: number
  selectedMemoryIds: string[]
  selectedMemories: MemoryRetrievalSelectedMemory[]
  usedFallbackSelection: boolean
  tokens?: MemoryRetrievalTokens
  cost?: number
}

export interface MemoryRetrievalRequestLike {
  id?: string
  turnIndex?: number
  ts: string
  memoryInjections?: MemoryInjectionEntry[]
}

export function isMemoryInjectText(value: string): boolean {
  return /<memory_inject\b/i.test(value)
}

export function isMemoryHintText(value: string): boolean {
  return /<memory_hint\b/i.test(value)
}

export function readMemoryRetrievalDetail(detail?: Record<string, unknown>): MemoryRetrievalDetail {
  const record = detail ?? {}

  return {
    need: typeof record.need === 'boolean' ? record.need : undefined,
    layer: typeof record.layer === 'string' ? record.layer : undefined,
    turnIndex:
      typeof record.turnIndex === 'number' && Number.isFinite(record.turnIndex)
        ? record.turnIndex
        : undefined,
    queries: toStringArray(record.queries),
    searches: toMemoryRetrievalSearchSummaries(record.searches),
    searchResultCount:
      typeof record.searchResultCount === 'number' && Number.isFinite(record.searchResultCount)
        ? record.searchResultCount
        : undefined,
    selectedMemoryIds: toStringArray(record.selectedMemoryIds),
    selectedMemories: toMemoryRetrievalSelectedMemories(record.selectedMemories),
    usedFallbackSelection: record.usedFallbackSelection === true,
    tokens: toMemoryRetrievalTokens(record.tokens),
    cost: typeof record.cost === 'number' && Number.isFinite(record.cost) ? record.cost : undefined,
  }
}

export function pickMemoryInjectionPreview(
  decision: { outcome: string; createdAt: string },
  detail: MemoryRetrievalDetail,
  llmRequests: MemoryRetrievalRequestLike[],
): MemoryInjectionEntry[] {
  if (decision.outcome !== 'injected' || !detail.layer) return []

  const candidates = llmRequests.filter((request) =>
    request.memoryInjections?.some((memoryInjection) => memoryInjection.layer === detail.layer),
  )

  const turnMatched =
    detail.turnIndex === undefined
      ? []
      : candidates.filter((request) => request.turnIndex === detail.turnIndex)
  const ranked = (turnMatched.length > 0
    ? turnMatched
    : candidates.filter((request) => request.ts >= decision.createdAt)
  ).sort((left, right) => left.ts.localeCompare(right.ts))
  const matchedRequest = ranked[0]

  return (
    matchedRequest?.memoryInjections?.filter(
      (memoryInjection) => memoryInjection.layer === detail.layer,
    ) ?? []
  )
}

export function getMemoryRetrievalSearchCount(detail: MemoryRetrievalDetail): number {
  return detail.searches.length > 0 ? detail.searches.length : detail.queries.length
}

export function getMemoryRetrievalSelectedCount(detail: MemoryRetrievalDetail): number {
  return detail.selectedMemories.length > 0
    ? detail.selectedMemories.length
    : detail.selectedMemoryIds.length
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function toMemoryRetrievalSearchSummaries(value: unknown): MemoryRetrievalSearchSummary[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const summary = item as Record<string, unknown>
    if (
      typeof summary.query !== 'string' ||
      typeof summary.resultCount !== 'number' ||
      !Number.isFinite(summary.resultCount)
    ) {
      return []
    }

    return [
      {
        query: summary.query,
        resultCount: summary.resultCount,
        topResultTitle:
          typeof summary.topResultTitle === 'string' ? summary.topResultTitle : undefined,
      },
    ]
  })
}

function toMemoryRetrievalSelectedMemories(value: unknown): MemoryRetrievalSelectedMemory[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const memory = item as Record<string, unknown>
    if (
      typeof memory.id !== 'string' ||
      typeof memory.type !== 'string' ||
      typeof memory.title !== 'string'
    ) {
      return []
    }

    return [
      {
        id: memory.id,
        type: memory.type,
        title: memory.title,
        score:
          typeof memory.score === 'number' && Number.isFinite(memory.score)
            ? memory.score
            : undefined,
      },
    ]
  })
}

function toMemoryRetrievalTokens(value: unknown): MemoryRetrievalTokens | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tokens = value as Record<string, unknown>
  const input =
    typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : undefined
  const output =
    typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : undefined

  if (input === undefined && output === undefined) return undefined

  return {
    input: input ?? 0,
    output: output ?? 0,
  }
}
