import { describe, expect, test } from 'bun:test'
import type { LoopRunner } from '@zero-os/shared'
import { runMemoryRetrievalAgentDetailed } from '../retrieval-agent'

function makeScoredMemory(id: string, title: string, score: number, content = `${title} content`) {
  return {
    memory: {
      id,
      type: 'decision' as const,
      title,
      content,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      status: 'verified' as const,
      confidence: 0.95,
      tags: ['test'],
      related: [],
    },
    score,
    scoreBreakdown: {
      keyword: 0,
      recency: 1,
      vector: score,
    },
  }
}

const baseConfig = {
  topN: 8,
  confidenceThreshold: 0.5,
  minScore: 0.3,
  perMemoryMaxTokens: 400,
  maxSelectedMemories: 3,
  agentMaxIterations: 3,
  agentMaxOutputTokens: 512,
}

describe('runMemoryRetrievalAgentDetailed', () => {
  test('returns no memories when the loop selects none', async () => {
    const runLoop: LoopRunner = async () => ({
      finalText: '{"result":[]}',
      toolCalls: [],
      usage: { input: 1, output: 1 },
      durationMs: 5,
    })

    const result = await runMemoryRetrievalAgentDetailed({
      runLoop,
      memoryRetriever: {
        async retrieveScored() {
          return []
        },
      },
      identitySummary: '',
      userMessage: 'hello',
      config: baseConfig,
    })

    expect(result.memories).toBeUndefined()
    expect(result.selectedMemoryIds).toEqual([])
    expect(result.usedFallbackSelection).toBe(false)
  })

  test('materializes selected memories from tool-driven searches', async () => {
    const longContent = 'x.com requires login and should be opened with the browser skill. '.repeat(
      6,
    )
    let searchOutput = ''
    const runLoop: LoopRunner = async (config) => {
      const toolResult = await config.toolHandler('memory_search', { query: 'x.com browser' })
      searchOutput = toolResult.output
      return {
        finalText: '{"result":[{"id":"mem_x","reason":"needed for x.com"}]}',
        toolCalls: [
          {
            name: 'memory_search',
            input: { query: 'x.com browser' },
            output: 'unused in test',
          },
        ],
        usage: { input: 4, output: 3 },
        durationMs: 8,
      }
    }

    const result = await runMemoryRetrievalAgentDetailed({
      runLoop,
      memoryRetriever: {
        async retrieveScored() {
          return [makeScoredMemory('mem_x', 'Twitter requires browser', 0.92, longContent)]
        },
      },
      identitySummary: 'user prefers browser workflows',
      userMessage: 'Analyze this x.com link',
      config: baseConfig,
    })

    expect(result.memories).toEqual([
      expect.objectContaining({
        id: 'mem_x',
        title: 'Twitter requires browser',
        score: 0.92,
      }),
    ])
    expect(result.queries).toEqual(['x.com browser'])
    expect(result.searches).toEqual([
      expect.objectContaining({
        query: 'x.com browser',
        resultCount: 1,
      }),
    ])
    expect(JSON.parse(searchOutput)).toEqual({
      query: 'x.com browser',
      result: [
        expect.objectContaining({
          id: 'mem_x',
          title: 'Twitter requires browser',
          content: expect.stringContaining('x.com requires login'),
        }),
      ],
    })
    expect(JSON.parse(searchOutput).result[0].content.length).toBeLessThan(longContent.length)
    expect(result.usedFallbackSelection).toBe(false)
  })

  test('filters out previously injected memories across turns', async () => {
    const runLoop: LoopRunner = async (config) => {
      await config.toolHandler('memory_search', { query: 'x.com browser' })
      return {
        finalText: '{"result":[{"id":"mem_x","reason":"duplicate memory"}]}',
        toolCalls: [],
        usage: { input: 3, output: 2 },
        durationMs: 6,
      }
    }

    const result = await runMemoryRetrievalAgentDetailed({
      runLoop,
      memoryRetriever: {
        async retrieveScored() {
          return [makeScoredMemory('mem_x', 'Twitter requires browser', 0.92)]
        },
      },
      identitySummary: '',
      userMessage: 'Analyze this x.com link again',
      previouslyInjectedIds: new Map([['mem_x', 'Twitter requires browser']]),
      config: baseConfig,
    })

    expect(result.memories).toBeUndefined()
    expect(result.selectedMemoryIds).toEqual([])
    expect(result.usedFallbackSelection).toBe(false)
  })

  test('falls back to the best retrieved memory when final JSON is malformed', async () => {
    const runLoop: LoopRunner = async (config) => {
      await config.toolHandler('memory_search', { query: 'x.com browser' })
      return {
        finalText: 'not json',
        toolCalls: [],
        usage: { input: 3, output: 2 },
        durationMs: 6,
      }
    }

    const result = await runMemoryRetrievalAgentDetailed({
      runLoop,
      memoryRetriever: {
        async retrieveScored() {
          return [
            makeScoredMemory('mem_x', 'Twitter requires browser', 0.92),
            makeScoredMemory('mem_y', 'Secondary memory', 0.7),
          ]
        },
      },
      identitySummary: '',
      userMessage: 'Analyze this x.com link',
      config: baseConfig,
    })

    expect(result.memories).toEqual([
      expect.objectContaining({
        id: 'mem_x',
        title: 'Twitter requires browser',
      }),
      expect.objectContaining({
        id: 'mem_y',
        title: 'Secondary memory',
      }),
    ])
    expect(result.usedFallbackSelection).toBe(true)
  })

  test('does not fall back when malformed output still clearly indicates an empty selection', async () => {
    const runLoop: LoopRunner = async (config) => {
      await config.toolHandler('memory_search', { query: 'x.com browser' })
      return {
        finalText: '{"results":[]',
        toolCalls: [],
        usage: { input: 3, output: 2 },
        durationMs: 6,
      }
    }

    const result = await runMemoryRetrievalAgentDetailed({
      runLoop,
      memoryRetriever: {
        async retrieveScored() {
          return [
            makeScoredMemory('mem_x', 'Twitter requires browser', 0.92),
            makeScoredMemory('mem_y', 'Secondary memory', 0.7),
          ]
        },
      },
      identitySummary: '',
      userMessage: 'Analyze this x.com link',
      config: baseConfig,
    })

    expect(result.memories).toBeUndefined()
    expect(result.selectedMemoryIds).toEqual([])
    expect(result.usedFallbackSelection).toBe(false)
  })
})
