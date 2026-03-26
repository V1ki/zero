import type {
  LoopRunner,
  LoopToolCallRecord,
  LoopToolSpec,
  Memory,
  MemorySearchOptions,
  ScoredMemoryMatch,
} from '@zero-os/shared'
import { truncateToTokens } from '@zero-os/shared'

export interface RetrievedMemoryMatch {
  id: string
  type: string
  title: string
  content: string
  score: number
}

export interface MemoryRetrievalAgentOptions {
  runLoop: LoopRunner
  memoryRetriever: {
    retrieve?(query: string, options?: MemorySearchOptions): Promise<Memory[]>
    retrieveScored?(query: string, options?: MemorySearchOptions): Promise<ScoredMemoryMatch[]>
  }
  identitySummary: string
  userMessage: string
  previouslyInjectedIds?: Map<string, string>
  config: {
    topN: number
    confidenceThreshold: number
    minScore: number
    perMemoryMaxTokens: number
    maxSelectedMemories: number
    agentMaxIterations: number
    agentMaxOutputTokens: number
  }
}

interface ParsedLoopSelection {
  id: string
  reason: string
}

interface ParsedLoopSelectionResult {
  parsed: boolean
  selections: ParsedLoopSelection[]
  explicitEmptySelectionIntent: boolean
}

interface SearchTrace {
  query: string
  mode: 'scored' | 'basic'
  options: {
    topN: number
    confidenceThreshold: number
    minScore: number
  }
  resultCount: number
  results: Array<{
    id: string
    type: string
    title: string
    contentPreview: string
    score: number
    scoreBreakdown: {
      keyword: number
      recency: number
      vector?: number
    }
  }>
}

interface SearchCacheEntry {
  memory: Memory
  score: number
  scoreBreakdown: {
    keyword: number
    recency: number
    vector?: number
  }
}

export interface MemoryRetrievalAgentRun {
  memories?: RetrievedMemoryMatch[]
  queries: string[]
  toolCalls: LoopToolCallRecord[]
  finalText: string
  usage: { input: number; output: number }
  durationMs: number
  searches: SearchTrace[]
  selectedMemoryIds: string[]
  selectedMemories: Array<{ id: string; type: string; title: string; score: number }>
  usedFallbackSelection: boolean
}

const MEMORY_SEARCH_TOOL: LoopToolSpec = {
  name: 'memory_search',
  description:
    'Search prior memories relevant to the current request. Use this before selecting memories to inject.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A focused semantic search query for one retrieval intent.',
      },
    },
    required: ['query'],
  },
}

export async function runMemoryRetrievalAgent(
  options: MemoryRetrievalAgentOptions,
): Promise<RetrievedMemoryMatch[] | undefined> {
  return (await runMemoryRetrievalAgentDetailed(options)).memories
}

export async function runMemoryRetrievalAgentDetailed(
  options: MemoryRetrievalAgentOptions,
): Promise<MemoryRetrievalAgentRun> {
  const searchCache = new Map<string, SearchCacheEntry>()
  const searchTraces: SearchTrace[] = []
  const searchOptions: MemorySearchOptions = {
    topN: options.config.topN,
    confidenceThreshold: options.config.confidenceThreshold,
    minScore: options.config.minScore,
  }

  const toolHandler = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; isError?: boolean }> => {
    if (toolName !== MEMORY_SEARCH_TOOL.name) {
      return { output: `Unknown tool: ${toolName}`, isError: true }
    }

    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) {
      return { output: 'query is required', isError: true }
    }

    const entries = await retrieveEntries(options.memoryRetriever, query, searchOptions)
    for (const entry of entries) {
      const existing = searchCache.get(entry.memory.id)
      if (existing && existing.score >= entry.score) continue
      searchCache.set(entry.memory.id, entry)
    }

    const trace: SearchTrace = {
      query,
      mode: options.memoryRetriever.retrieveScored ? 'scored' : 'basic',
      options: {
        topN: options.config.topN,
        confidenceThreshold: options.config.confidenceThreshold,
        minScore: options.config.minScore,
      },
      resultCount: entries.length,
      results: entries.map((entry) => ({
        id: entry.memory.id,
        type: entry.memory.type,
        title: entry.memory.title,
        contentPreview: buildContentPreview(entry.memory.content),
        score: entry.score,
        scoreBreakdown: entry.scoreBreakdown,
      })),
    }
    searchTraces.push(trace)

    return {
      output: JSON.stringify({
        query,
        result: trace.results.map((entry) => ({
          id: entry.id,
          type: entry.type,
          title: entry.title,
          content: entry.contentPreview,
          score: entry.score,
        })),
      }),
    }
  }

  const loopResult = await options.runLoop({
    system: buildRetrievalAgentSystemPrompt(options),
    userMessage: options.userMessage,
    tools: [MEMORY_SEARCH_TOOL],
    toolHandler,
    maxIterations: options.config.agentMaxIterations,
    maxTokens: options.config.agentMaxOutputTokens,
  })

  const selected = parseSelectedMemories(loopResult.finalText)
  const dedupedSelections = selected.selections.filter(
    (entry) => !options.previouslyInjectedIds?.has(entry.id),
  )

  const memories =
    dedupedSelections.length > 0
      ? materializeSelections(dedupedSelections, searchCache, options.config.perMemoryMaxTokens)
      : undefined

  if (memories && memories.length > 0) {
    return {
      memories,
      queries: searchTraces.map((entry) => entry.query),
      toolCalls: loopResult.toolCalls,
      finalText: loopResult.finalText,
      usage: loopResult.usage,
      durationMs: loopResult.durationMs,
      searches: searchTraces,
      selectedMemoryIds: memories.map((entry) => entry.id),
      selectedMemories: memories.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        score: entry.score,
      })),
      usedFallbackSelection: false,
    }
  }

  const shouldUseFallback =
    (!selected.parsed && !selected.explicitEmptySelectionIntent) ||
    selected.selections.some((entry) => !searchCache.has(entry.id))
  const fallbackMemories = shouldUseFallback
    ? fallbackSelection(
        searchCache,
        options.previouslyInjectedIds,
        options.config.maxSelectedMemories,
        options.config.perMemoryMaxTokens,
      )
    : undefined

  return {
    memories: fallbackMemories,
    queries: searchTraces.map((entry) => entry.query),
    toolCalls: loopResult.toolCalls,
    finalText: loopResult.finalText,
    usage: loopResult.usage,
    durationMs: loopResult.durationMs,
    searches: searchTraces,
    selectedMemoryIds: fallbackMemories?.map((entry) => entry.id) ?? [],
    selectedMemories:
      fallbackMemories?.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        score: entry.score,
      })) ?? [],
    usedFallbackSelection: shouldUseFallback,
  }
}

function buildRetrievalAgentSystemPrompt(options: MemoryRetrievalAgentOptions): string {
  const injectedList =
    options.previouslyInjectedIds && options.previouslyInjectedIds.size > 0
      ? Array.from(options.previouslyInjectedIds.entries())
          .map(([id, title]) => `- ${id}: ${title}`)
          .join('\n')
      : '（无）'

  return `<instruction>
你是一个 memory retrieval agent。你的目标是决定当前请求是否需要注入历史记忆，并且只选择真正相关的少量记忆。

工作方式：
1. 如有必要，调用 memory_search 工具搜索候选记忆。一次搜索只聚焦一个明确意图。
2. 审查搜索结果，只保留与当前请求直接相关、能帮助后续回答或恢复执行的记忆。
3. 默认不要重复选择 <already_injected_memories> 中的记忆，除非它们对当前请求不可替代。
4. 最多选择 ${options.config.maxSelectedMemories} 条记忆；如果没有明确帮助，返回空数组。

返回 JSON，不要输出其他内容：
{"result":[{"id":"memory_id","reason":"为什么这条记忆相关"}]}

如果不需要注入记忆，返回：
{"result":[]}
</instruction>

<identity_summary>
${options.identitySummary || '（无身份记忆）'}
</identity_summary>

<already_injected_memories>
${injectedList}
</already_injected_memories>`
}

async function retrieveEntries(
  memoryRetriever: MemoryRetrievalAgentOptions['memoryRetriever'],
  query: string,
  options: MemorySearchOptions,
): Promise<SearchCacheEntry[]> {
  if (memoryRetriever.retrieveScored) {
    const entries = await memoryRetriever.retrieveScored(query, options)
    return entries.map((entry) => ({
      memory: entry.memory,
      score: entry.score,
      scoreBreakdown: entry.scoreBreakdown,
    }))
  }

  if (!memoryRetriever.retrieve) {
    return []
  }

  const memories = await memoryRetriever.retrieve(query, options)
  return memories.map((memory) => ({
    memory,
    score: 0,
    scoreBreakdown: {
      keyword: 0,
      recency: 0,
    },
  }))
}

function parseSelectedMemories(finalText: string): ParsedLoopSelectionResult {
  const trimmed = finalText.trim()
  const explicitEmptySelectionIntent = hasExplicitEmptySelectionIntent(trimmed)
  if (!trimmed) {
    return {
      parsed: false,
      selections: [],
      explicitEmptySelectionIntent,
    }
  }

  try {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) {
      return {
        parsed: false,
        selections: [],
        explicitEmptySelectionIntent,
      }
    }
    const parsed = JSON.parse(match[0]) as { result?: unknown }
    if (!Array.isArray(parsed.result)) {
      return {
        parsed: false,
        selections: [],
        explicitEmptySelectionIntent,
      }
    }

    return {
      parsed: true,
      selections: parsed.result
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return undefined
          const data = entry as Record<string, unknown>
          return typeof data.id === 'string'
            ? {
                id: data.id,
                reason: typeof data.reason === 'string' ? data.reason : '',
              }
            : undefined
        })
        .filter((entry): entry is ParsedLoopSelection => entry !== undefined),
      explicitEmptySelectionIntent: parsed.result.length === 0,
    }
  } catch {
    return {
      parsed: false,
      selections: [],
      explicitEmptySelectionIntent,
    }
  }
}

function hasExplicitEmptySelectionIntent(text: string): boolean {
  return /["']?results?["']?\s*:\s*\[\s*\]/i.test(text)
}

function materializeSelections(
  selected: ParsedLoopSelection[],
  searchCache: Map<string, SearchCacheEntry>,
  perMemoryMaxTokens: number,
): RetrievedMemoryMatch[] | undefined {
  const results = selected.flatMap((entry) => {
    const cached = searchCache.get(entry.id)
    if (!cached) return []
    return [toRetrievedMemoryMatch(cached, perMemoryMaxTokens)]
  })

  return results.length > 0 ? results : undefined
}

function fallbackSelection(
  searchCache: Map<string, SearchCacheEntry>,
  previouslyInjectedIds: Map<string, string> | undefined,
  maxSelectedMemories: number,
  perMemoryMaxTokens: number,
): RetrievedMemoryMatch[] | undefined {
  const memories = [...searchCache.values()]
    .filter((entry) => !previouslyInjectedIds?.has(entry.memory.id))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSelectedMemories)
    .map((entry) => toRetrievedMemoryMatch(entry, perMemoryMaxTokens))

  return memories.length > 0 ? memories : undefined
}

function toRetrievedMemoryMatch(
  entry: SearchCacheEntry,
  perMemoryMaxTokens: number,
): RetrievedMemoryMatch {
  return {
    id: entry.memory.id,
    type: entry.memory.type,
    title: entry.memory.title,
    content: truncateToTokens(entry.memory.content, perMemoryMaxTokens),
    score: entry.score,
  }
}

function buildContentPreview(content: string, maxChars = 160): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}
