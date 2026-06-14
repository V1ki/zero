import { afterAll, describe, expect, test } from 'bun:test'
import type { MemoryRetriever } from '@zero-os/memory'
import {
  ModelRouter,
  type ProviderAdapter,
  type ResolvedModel,
  TrackedAdapter,
} from '@zero-os/model'
import { MetricsDB, Tracer, flattenTraceSpans } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  MemorySearchOptions,
  Session as SessionData,
  StreamEvent,
  SystemConfig,
} from '@zero-os/shared'
import { ToolRegistry } from '../../tool/registry'
import { Session } from '../session'
import { createTestProjectRoot, setSessionAgentForTest } from './test-helpers'

const API_KEY = 'sk-test-placeholder'
const testProject = createTestProjectRoot('zero-session-memory-retrieval-')

const config: SystemConfig = {
  providers: {
    'openai-codex': {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://example.invalid',
      auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
      models: {
        'gpt-5.3-codex-medium': {
          modelId: 'gpt-5.3-codex-medium',
          maxContext: 400000,
          maxOutput: 128000,
          capabilities: ['tools', 'vision', 'reasoning'],
          tags: ['powerful', 'coding'],
        },
      },
    },
  },
  defaultModel: 'gpt-5.3-codex-medium',
  fallbackChain: ['gpt-5.3-codex-medium'],
  schedules: [],
  fuseList: [],
}

class LoopRetrievalAdapter implements ProviderAdapter {
  readonly apiType = 'fake-retrieval-decision-loop'
  private completeCalls = 0

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++

    if (this.completeCalls === 1) {
      return {
        id: 'resp_retrieval_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_memory_search_1',
            name: 'memory_search',
            input: { query: 'x.com browser' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 5 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_retrieval_final',
      content: [
        {
          type: 'text',
          text: '{"result":[{"id":"mem_twitter","reason":"x.com 访问需要 browser 经验"}]}',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 5, output: 5 },
      model: 'fake-model',
    }
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class DedupLoopRetrievalAdapter implements ProviderAdapter {
  readonly apiType = 'fake-retrieval-dedup'
  private completeCalls = 0

  async complete(): Promise<CompletionResponse> {
    this.completeCalls++

    if (this.completeCalls === 1 || this.completeCalls === 3) {
      return {
        id: `resp_tool_use_${this.completeCalls}`,
        content: [
          {
            type: 'tool_use',
            id: `call_memory_search_${this.completeCalls}`,
            name: 'memory_search',
            input: { query: 'x.com browser' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 4, output: 3 },
        model: 'fake-model',
      }
    }

    return {
      id: `resp_final_${this.completeCalls}`,
      content: [
        {
          type: 'text',
          text: '{"result":[{"id":"mem_twitter","reason":"same memory"}]}',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 4, output: 3 },
      model: 'fake-model',
    }
  }

  async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createRouter(metrics?: MetricsDB): ModelRouter {
  const router = new ModelRouter(config, new Map([['openai_codex_api_key', API_KEY]]), {
    usageRecorder: metrics
      ? {
          record(entry) {
            metrics.recordUsage({
              id: `${entry.purpose}_${Math.random().toString(36).slice(2)}`,
              sessionId: entry.sessionId,
              category: 'completion',
              purpose: entry.purpose as import('@zero-os/observe').UsagePurpose,
              parentSessionId: entry.parentSessionId,
              model: entry.model,
              provider: entry.provider,
              inputTokens: entry.usage.input,
              outputTokens: entry.usage.output,
              cacheWriteTokens: entry.usage.cacheWrite,
              cacheReadTokens: entry.usage.cacheRead,
              reasoningTokens: entry.usage.reasoning,
              cost: entry.cost,
              durationMs: entry.durationMs,
              createdAt: new Date().toISOString(),
            })
          },
        }
      : undefined,
  })
  router.init()
  return router
}

function trackAdapter(
  adapter: ProviderAdapter,
  metrics: MetricsDB,
  modelLabel = 'fake/fake-model',
): ProviderAdapter {
  return new TrackedAdapter(
    adapter,
    {
      record(entry) {
        metrics.recordUsage({
          id: `${entry.purpose}_${Math.random().toString(36).slice(2)}`,
          sessionId: entry.sessionId,
          category: 'completion',
          purpose: entry.purpose as import('@zero-os/observe').UsagePurpose,
          parentSessionId: entry.parentSessionId,
          model: entry.model,
          provider: entry.provider,
          inputTokens: entry.usage.input,
          outputTokens: entry.usage.output,
          cacheWriteTokens: entry.usage.cacheWrite,
          cacheReadTokens: entry.usage.cacheRead,
          reasoningTokens: entry.usage.reasoning,
          cost: entry.cost,
          durationMs: entry.durationMs,
          createdAt: new Date().toISOString(),
        })
      },
    },
    {
      providerName: modelLabel.split('/')[0] ?? 'fake',
      modelLabel,
    },
  )
}

describe('Session memory retrieval', () => {
  afterAll(() => {
    testProject.cleanup()
  })

  test('injects retrieved memories into dynamic context before agent.run', async () => {
    const metrics = MetricsDB.createInMemory()
    const router = createRouter(metrics)
    const tracer = new Tracer()
    let capturedSearchOptions: MemorySearchOptions | undefined
    const session = new Session('web', router, new ToolRegistry(), {
      identityMemory: '用户曾经要求优先使用浏览器插件',
      tracer,
      metrics,
      projectRoot: testProject.projectRoot,
      memoryRetriever: {
        async retrieve() {
          return []
        },
        async retrieveScored(_query: string, options?: MemorySearchOptions) {
          capturedSearchOptions = options
          return [
            {
              memory: {
                id: 'mem_twitter',
                type: 'preference',
                title: 'Twitter 访问偏好',
                content: 'x.com 需要登录，优先使用 browser skill。',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                status: 'verified',
                confidence: 0.98,
                tags: ['twitter'],
                related: [],
              },
              score: 0.91,
              scoreBreakdown: {
                keyword: 0,
                recency: 1,
                vector: 0.91,
              },
            },
          ]
        },
      } as unknown as MemoryRetriever,
    })

    session.initAgent({
      name: 'memory-agent',
      agentInstruction: 'memory test agent',
    })

    const fakeResolvedModel: ResolvedModel = {
      providerName: 'fake',
      modelName: 'fake-model',
      modelConfig: {
        modelId: 'fake-model',
        maxContext: 400000,
        maxOutput: 128000,
        capabilities: ['tools'],
        tags: [],
      },
      providerConfig: {
        apiType: 'openai_chat_completions',
        baseUrl: 'https://example.invalid',
        auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
        models: {},
      },
      adapter: trackAdapter(new LoopRetrievalAdapter(), metrics),
    }

    let capturedContext:
      | {
          dynamicContext?: string
          injectedMemoryIds?: Map<string, string>
          requestMemoryInjections?: Array<{
            layer: 'layer1' | 'layer2'
            source: 'retrieved_memories' | 'memory_hint'
            formattedText: string
          }>
        }
      | undefined
    ;(session as unknown as { activeModel: ResolvedModel }).activeModel = fakeResolvedModel
    setSessionAgentForTest(session, {
      async run(
        context: {
          dynamicContext?: string
          injectedMemoryIds?: Map<string, string>
          requestMemoryInjections?: Array<{
            layer: 'layer1' | 'layer2'
            source: 'retrieved_memories' | 'memory_hint'
            formattedText: string
          }>
        },
        _userMessage: string,
        _images?: unknown,
        _onNewMessage?: unknown,
      ) {
        capturedContext = context
        return []
      },
    })

    await session.handleMessage('分析这个链接 https://x.com/openai/status/123')

    expect(capturedContext?.dynamicContext).toContain('<system-reminder>')
    expect(capturedContext?.dynamicContext).toContain('<retrieved_memories>')
    expect(capturedContext?.dynamicContext).toContain('Twitter 访问偏好')
    expect(capturedContext?.injectedMemoryIds?.get('mem_twitter')).toBe('Twitter 访问偏好')
    expect(capturedSearchOptions).toEqual(
      expect.objectContaining({
        topN: 8,
        confidenceThreshold: 0.5,
        minScore: 0.3,
        sessionId: session.data.id,
      }),
    )
    const retrievalUsage = metrics
      .usageSummaryByPurpose('1d')
      .find((entry) => entry.purpose === 'memory_retrieval')
    expect(retrievalUsage?.eventCount).toBe(2)
    expect(capturedContext?.requestMemoryInjections).toEqual([
      expect.objectContaining({
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText: expect.stringContaining('<memory_inject layer="layer1">'),
      }),
    ])
    expect(session.getMessages()).toEqual([])
    const decisionSpan = flattenTraceSpans(tracer.exportSession(session.data.id)).find(
      (span) => span.name === 'memory_retrieval_decision',
    )
    expect(decisionSpan?.data?.memoryRetrievalDecision).toEqual(
      expect.objectContaining({
        need: true,
        queries: ['x.com browser'],
        searches: [
          expect.objectContaining({
            query: 'x.com browser',
            mode: 'scored',
            options: expect.objectContaining({
              minScore: 0.3,
            }),
            resultCount: 1,
            results: [
              expect.objectContaining({
                id: 'mem_twitter',
                title: 'Twitter 访问偏好',
                contentPreview: expect.stringContaining('x.com 需要登录'),
                score: 0.91,
                scoreBreakdown: expect.objectContaining({
                  keyword: 0,
                  recency: 1,
                  vector: 0.91,
                }),
              }),
            ],
          }),
        ],
        selectedMemoryIds: ['mem_twitter'],
        selectedMemories: [
          expect.objectContaining({
            id: 'mem_twitter',
            title: 'Twitter 访问偏好',
            score: 0.91,
          }),
        ],
      }),
    )
    expect(decisionSpan?.metadata).toEqual(
      expect.objectContaining({
        need: true,
        queryCount: 1,
        searchCount: 1,
        selectedCount: 1,
      }),
    )
  })

  test('deduplicates previously injected memories across turns', async () => {
    const router = createRouter()
    const tracer = new Tracer()
    const session = new Session('web', router, new ToolRegistry(), {
      identityMemory: '用户曾经要求优先使用浏览器插件',
      tracer,
      projectRoot: testProject.projectRoot,
      memoryRetriever: {
        async retrieve() {
          return []
        },
        async retrieveScored() {
          return [
            {
              memory: {
                id: 'mem_twitter',
                type: 'preference',
                title: 'Twitter 访问偏好',
                content: 'x.com 需要登录，优先使用 browser skill。',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                status: 'verified',
                confidence: 0.98,
                tags: ['twitter'],
                related: [],
              },
              score: 0.91,
              scoreBreakdown: {
                keyword: 0,
                recency: 1,
                vector: 0.91,
              },
            },
          ]
        },
      } as unknown as MemoryRetriever,
    })

    session.initAgent({
      name: 'memory-agent',
      agentInstruction: 'memory test agent',
    })

    const fakeResolvedModel: ResolvedModel = {
      providerName: 'fake',
      modelName: 'fake-model',
      modelConfig: {
        modelId: 'fake-model',
        maxContext: 400000,
        maxOutput: 128000,
        capabilities: ['tools'],
        tags: [],
      },
      providerConfig: {
        apiType: 'openai_chat_completions',
        baseUrl: 'https://example.invalid',
        auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
        models: {},
      },
      adapter: new DedupLoopRetrievalAdapter(),
    }

    const capturedContexts: Array<{
      dynamicContext?: string
      injectedMemoryIds?: Map<string, string>
    }> = []
    ;(session as unknown as { activeModel: ResolvedModel }).activeModel = fakeResolvedModel
    setSessionAgentForTest(session, {
      async run(context: { dynamicContext?: string; injectedMemoryIds?: Map<string, string> }) {
        capturedContexts.push(context)
        return []
      },
    })

    await session.handleMessage('第一次分析这个链接 https://x.com/openai/status/1')
    await session.handleMessage('第二次分析这个链接 https://x.com/openai/status/2')

    expect(capturedContexts[0]?.dynamicContext).toContain('Twitter 访问偏好')
    expect(capturedContexts[1]?.dynamicContext ?? '').not.toContain('Twitter 访问偏好')
    expect(capturedContexts[0]?.injectedMemoryIds?.get('mem_twitter')).toBe('Twitter 访问偏好')
    expect(capturedContexts[1]?.injectedMemoryIds?.get('mem_twitter')).toBe('Twitter 访问偏好')
  })

  test('restored sessions initialize injected memory tracking before retrieval', async () => {
    const router = createRouter()
    const tracer = new Tracer()
    const data: SessionData = {
      id: 'sess_restore_memory_retrieval',
      createdAt: '2026-03-26T00:00:00.000Z',
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'web',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [
        {
          model: 'gpt-5.3-codex-medium',
          from: '2026-03-26T00:00:00.000Z',
          to: null,
        },
      ],
      tags: [],
    }
    const session = Session.restore(data, [], router, new ToolRegistry(), {
      identityMemory: '用户曾经要求优先使用浏览器插件',
      tracer,
      projectRoot: testProject.projectRoot,
      memoryRetriever: {
        async retrieve() {
          return []
        },
        async retrieveScored() {
          return [
            {
              memory: {
                id: 'mem_twitter',
                type: 'preference',
                title: 'Twitter 访问偏好',
                content: 'x.com 需要登录，优先使用 browser skill。',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                status: 'verified',
                confidence: 0.98,
                tags: ['twitter'],
                related: [],
              },
              score: 0.91,
              scoreBreakdown: {
                keyword: 0,
                recency: 1,
                vector: 0.91,
              },
            },
          ]
        },
      } as unknown as MemoryRetriever,
    })

    session.initAgent({
      name: 'memory-agent',
      agentInstruction: 'memory test agent',
    })

    const fakeResolvedModel: ResolvedModel = {
      providerName: 'fake',
      modelName: 'fake-model',
      modelConfig: {
        modelId: 'fake-model',
        maxContext: 400000,
        maxOutput: 128000,
        capabilities: ['tools'],
        tags: [],
      },
      providerConfig: {
        apiType: 'openai_chat_completions',
        baseUrl: 'https://example.invalid',
        auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
        models: {},
      },
      adapter: new LoopRetrievalAdapter(),
    }

    let capturedContext:
      | {
          dynamicContext?: string
          injectedMemoryIds?: Map<string, string>
        }
      | undefined
    ;(session as unknown as { activeModel: ResolvedModel }).activeModel = fakeResolvedModel
    setSessionAgentForTest(session, {
      async run(context: { dynamicContext?: string; injectedMemoryIds?: Map<string, string> }) {
        capturedContext = context
        return []
      },
    })

    await session.handleMessage('恢复后的会话继续分析这个链接 https://x.com/openai/status/123')

    expect(capturedContext?.dynamicContext).toContain('Twitter 访问偏好')
    expect(capturedContext?.injectedMemoryIds).toBeInstanceOf(Map)
    expect(capturedContext?.injectedMemoryIds?.get('mem_twitter')).toBe('Twitter 访问偏好')
  })
})
