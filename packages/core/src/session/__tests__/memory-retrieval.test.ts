import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter, ResolvedModel } from '@zero-os/model'
import { ModelRouter } from '@zero-os/model'
import { Tracer, flattenTraceSpans } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  MemorySearchOptions,
  StreamEvent,
  SystemConfig,
} from '@zero-os/shared'
import type { MemoryRetriever } from '@zero-os/memory'
import { ToolRegistry } from '../../tool/registry'
import { Session } from '../session'

const API_KEY = 'sk-test-placeholder'

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

class RetrievalDecisionAdapter implements ProviderAdapter {
  readonly apiType = 'fake-retrieval-decision'

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_retrieval_decision',
      content: [{ type: 'text', text: '{"need": true, "queries": ["x.com browser"]}' }],
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

function createRouter(): ModelRouter {
  const router = new ModelRouter(config, new Map([['openai_codex_api_key', API_KEY]]))
  router.init()
  return router
}

describe('Session memory retrieval', () => {
  test('injects retrieved memories into dynamic context before agent.run', async () => {
    const router = createRouter()
    const tracer = new Tracer()
    let capturedSearchOptions: MemorySearchOptions | undefined
    const session = new Session('web', router, new ToolRegistry(), {
      identityMemory: '用户曾经要求优先使用浏览器插件',
      tracer,
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
      adapter: new RetrievalDecisionAdapter(),
    }

    let capturedContext:
      | {
          dynamicContext?: string
          requestMemoryInjections?: Array<{
            layer: 'layer1' | 'layer2'
            source: 'retrieved_memories' | 'memory_hint'
            formattedText: string
          }>
        }
      | undefined

    ;(session as unknown as { activeModel: ResolvedModel }).activeModel = fakeResolvedModel
    ;(
      session as unknown as {
        agent: {
          run: (
            context: { dynamicContext?: string },
            userMessage: string,
            images?: unknown,
            onNewMessage?: (message: Message) => void,
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      async run(context, _userMessage, _images, _onNewMessage) {
        capturedContext = context
        return []
      },
    }

    await session.handleMessage('分析这个链接 https://x.com/openai/status/123')

    expect(capturedContext?.dynamicContext).toContain('<system-reminder>')
    expect(capturedContext?.dynamicContext).toContain('<retrieved_memories>')
    expect(capturedContext?.dynamicContext).toContain('Twitter 访问偏好')
    expect(capturedSearchOptions).toEqual(
      expect.objectContaining({
        topN: 5,
        confidenceThreshold: 0.6,
        minScore: 0.15,
      }),
    )
    expect(capturedContext?.requestMemoryInjections).toEqual([
      expect.objectContaining({
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText: expect.stringContaining('<memory_inject layer="layer1">'),
      }),
    ])
    expect(session.getMessages()).toEqual([
      expect.objectContaining({
        messageType: 'notification',
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('<memory_inject layer="layer1">'),
          }),
        ],
      }),
    ])
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
              minScore: 0.15,
            }),
            resultCount: 1,
            results: [
              expect.objectContaining({
                id: 'mem_twitter',
                title: 'Twitter 访问偏好',
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
})
