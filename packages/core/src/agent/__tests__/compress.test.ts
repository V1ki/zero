import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type { TraceSpan as ObserveTraceSpan } from '@zero-os/observe'
import { type Message, type SecretFilter, generateId, now } from '@zero-os/shared'
import {
  CONTEXT_COMPACTION_PROMPT_VERSION,
  TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
  buildContextCompactionPrompt,
  compressConversation,
  generateContextCompaction,
} from '../compress'
import type { ContextCompactionModelInput } from '../context'

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: generateId(),
    sessionId: 'test-session',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

const mockAdapter = {
  apiType: 'mock',
  async complete() {
    return {
      id: 'test',
      content: [{ type: 'text' as const, text: 'Summary of conversation' }],
      stopReason: 'end_turn' as const,
      usage: { input: 100, output: 50 },
      model: 'mock',
    }
  },
  async *stream() {},
  async healthCheck() {
    return true
  },
} satisfies ProviderAdapter

function makeTraceRecorder() {
  const startCalls: Array<{
    sessionId: string
    name: string
    parentId?: string
    options?: Record<string, unknown>
  }> = []
  const updateCalls: Array<{ spanId: string; update: Record<string, unknown> }> = []
  const endCalls: Array<{ spanId: string; status?: string; metadata?: Record<string, unknown> }> =
    []
  const logSessionCalls: Array<{
    sessionId: string
    level: string
    event: string
    data?: Record<string, unknown>
  }> = []
  const spans = new Map<string, ObserveTraceSpan>()

  return {
    tracer: {
      startSpan(
        sessionId: string,
        name: string,
        parentId?: string,
        options: Record<string, unknown> = {},
      ) {
        startCalls.push({ sessionId, name, parentId, options })
        const span = {
          id: 'span_compression',
          sessionId,
          parentId,
          kind: 'llm_request' as const,
          name,
          startTime: now(),
          status: 'running' as const,
          children: [],
        }
        spans.set(span.id, span)
        return span
      },
      updateSpan(spanId: string, update: Record<string, unknown>) {
        updateCalls.push({ spanId, update })
      },
      endSpan(spanId: string, status?: string, metadata?: Record<string, unknown>) {
        endCalls.push({ spanId, status, metadata })
        const span = spans.get(spanId)
        if (span && !span.endTime) {
          span.endTime = now()
          span.status = (status as 'success' | 'error' | undefined) ?? 'success'
        }
      },
      getSpan(spanId: string) {
        return spans.get(spanId)
      },
      logSession(sessionId: string, level: string, event: string, data?: Record<string, unknown>) {
        logSessionCalls.push({ sessionId, level, event, data })
      },
    },
    startCalls,
    updateCalls,
    endCalls,
    logSessionCalls,
  }
}

const secretFilter: SecretFilter = {
  filter(text: string) {
    return text.replaceAll('secret-token', '[REDACTED]')
  },
  addSecret() {},
  removeSecret() {},
}

function makeContextCompactionInput(): ContextCompactionModelInput {
  const messages: Message[] = [
    {
      id: 'msg_user_context',
      sessionId: 'sess_context_runner',
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: '检查 context compaction runner' }],
      createdAt: '2026-05-26T00:00:00.000Z',
    },
    {
      id: 'msg_tool_context',
      sessionId: 'sess_context_runner',
      role: 'assistant',
      messageType: 'message',
      content: [
        { type: 'text', text: '读取 runner 文件。' },
        {
          type: 'tool_use',
          id: 'tool_read_runner',
          name: 'read',
          input: { path: '/repo/packages/core/src/agent/compress.ts' },
        },
      ],
      createdAt: '2026-05-26T00:00:01.000Z',
    },
    {
      id: 'msg_result_context',
      sessionId: 'sess_context_runner',
      role: 'user',
      messageType: 'message',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool_read_runner',
          content: 'compress.ts now owns the context compaction model request runner.',
          outputSummary: 'Read context compaction runner.',
        },
      ],
      createdAt: '2026-05-26T00:00:02.000Z',
    },
  ]

  return {
    sessionId: 'sess_context_runner',
    blockId: 'block_context_runner',
    strategyVersion: 'timeline_compaction_block_v3',
    currentGoal: '瘦身 agent.ts',
    segment: messages,
    retainedMessages: [],
    workingStateSummary: '<working_state_compaction>continue</working_state_compaction>',
    episode: {
      id: 'episode_context_runner',
      sessionId: 'sess_context_runner',
      status: 'confirmed',
      boundaryStrategy: 'test',
      boundaryReason: 'fixture',
      goal: '瘦身 agent.ts',
      scope: ['/repo/packages/core/src/agent/compress.ts'],
      toolUseIds: ['tool_read_runner'],
      confirmedFacts: ['runner moved to compress.ts'],
      inferredFacts: [],
      blockers: [],
      needsRawReview: [],
      evidence: [],
      summary: 'fixture episode',
      messageIds: messages.map((message) => message.id),
    },
  }
}

describe('compressConversation', () => {
  test('returns messages unchanged when nothing to compress', async () => {
    // Few messages + large budget = no compression needed
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
      makeMessage('user', 'How are you?'),
      makeMessage('assistant', 'I am fine.'),
    ]

    const result = await compressConversation(messages, 100_000, mockAdapter, 'test-session')

    expect(result.summary).toBe('')
    expect(result.retainedMessages.length).toBe(messages.length)
    expect(result.stats.messagesBefore).toBe(messages.length)
    expect(result.stats.messagesAfter).toBe(messages.length)
    expect(result.stats.tokensBefore).toBe(result.stats.tokensAfter)
  })

  test('compresses when many messages exceed small budget', async () => {
    // Create 20 messages (10 turns) with substantial text
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const text = `Message number ${i}: ${'x'.repeat(200)}`
      messages.push(makeMessage(role as 'user' | 'assistant', text))
    }

    // Use a very small budget to force compression
    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // Compression should have happened
    expect(result.summary).toBe('Summary of conversation')
    expect(result.stats.messagesAfter).toBeLessThan(result.stats.messagesBefore)
    expect(result.stats.messagesBefore).toBe(20)
  })

  test('retained messages include summary as first message', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Turn ${i}: ${'y'.repeat(200)}`))
    }

    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // When compression occurs, first retained message should be the summary
    if (result.summary !== '') {
      const firstMsg = result.retainedMessages[0]
      expect(firstMsg.role).toBe('user')
      expect(firstMsg.content[0].type).toBe('text')
      const textBlock = firstMsg.content[0] as { type: 'text'; text: string }
      expect(textBlock.text).toContain('[以下是之前对话的摘要]')
      expect(textBlock.text).toContain('Summary of conversation')
      expect(textBlock.text).toContain('[摘要结束，以下是最近的对话]')
    }
  })

  test('stats are accurate', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'z'.repeat(200)}`))
    }

    const result = await compressConversation(messages, 100, mockAdapter, 'test-session')

    // messagesBefore should be the original count
    expect(result.stats.messagesBefore).toBe(20)

    // messagesAfter should equal the actual retained array length
    expect(result.stats.messagesAfter).toBe(result.retainedMessages.length)

    // tokensAfter should be less than tokensBefore (compression reduced tokens)
    expect(result.stats.tokensAfter).toBeLessThan(result.stats.tokensBefore)

    // tokensBefore and tokensAfter should both be positive
    expect(result.stats.tokensBefore).toBeGreaterThan(0)
    expect(result.stats.tokensAfter).toBeGreaterThan(0)
  })

  test('adds compression meta to the summary request', async () => {
    let seenMeta: import('@zero-os/shared').CompletionRequest['meta'] | undefined
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'z'.repeat(200)}`))
    }

    const adapter = {
      ...mockAdapter,
      async complete(request) {
        seenMeta = request.meta
        return {
          id: 'test',
          content: [{ type: 'text' as const, text: 'Summary of conversation' }],
          stopReason: 'end_turn' as const,
          usage: { input: 100, output: 50 },
          model: 'mock',
        }
      },
    } satisfies ProviderAdapter

    await compressConversation(messages, 100, adapter, 'test-session', {
      parentSessionId: 'parent-session',
    })

    expect(seenMeta).toEqual({
      sessionId: 'test-session',
      purpose: 'compression',
      parentSessionId: 'parent-session',
    })
  })

  test('writes a compression trace span on success', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(
        makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'secret-token '.repeat(40)}`),
      )
    }

    const trace = makeTraceRecorder()
    const adapter = {
      ...mockAdapter,
      async complete() {
        return {
          id: 'resp_trace',
          content: [{ type: 'text' as const, text: 'Summary with secret-token removed' }],
          stopReason: 'end_turn' as const,
          usage: {
            input: 100,
            output: 50,
            cacheWrite: 25,
            cacheRead: 10,
            reasoning: 5,
          },
          model: 'provider/model-trace',
        }
      },
    } satisfies ProviderAdapter

    await compressConversation(
      messages,
      100,
      adapter,
      'test-session',
      { parentSessionId: 'parent-session' },
      {
        tracer: trace.tracer,
        parentSpanId: 'parent-span',
        agentName: 'agent-trace',
        providerName: 'provider-x',
        modelLabel: 'provider-x/model-y',
        pricing: {
          input: 1,
          output: 2,
          cacheWrite: 3,
          cacheRead: 4,
        },
        secretFilter,
      },
    )

    expect(trace.startCalls).toEqual([
      {
        sessionId: 'test-session',
        name: 'compression',
        parentId: 'parent-span',
        options: {
          kind: 'llm_request',
          agentName: 'agent-trace',
          metadata: {
            purpose: 'compression',
          },
        },
      },
    ])
    expect(trace.updateCalls).toHaveLength(1)
    expect(trace.updateCalls[0]?.spanId).toBe('span_compression')
    expect(trace.updateCalls[0]?.update).toMatchObject({
      data: {
        compression: {
          model: 'provider-x/model-y',
          provider: 'provider-x',
          tokens: {
            input: 100,
            output: 50,
            cacheWrite: 25,
            cacheRead: 10,
            reasoning: 5,
          },
        },
      },
    })
    const compressionData = (
      trace.updateCalls[0]?.update.data as { compression?: Record<string, unknown> } | undefined
    )?.compression
    expect(compressionData?.compressedMessageCount).toBeGreaterThan(0)
    expect(compressionData?.compressedMessageCount).toBeLessThan(messages.length)
    expect(typeof compressionData?.durationMs).toBe('number')
    expect((compressionData?.cost as number | undefined) ?? 0).toBeCloseTo(0.000325, 8)
    expect(
      (trace.updateCalls[0]?.update.metadata as { compressedMessageCount?: number } | undefined)
        ?.compressedMessageCount,
    ).toBe(compressionData?.compressedMessageCount as number | undefined)
    expect((compressionData?.prompt as string | undefined)?.includes('[REDACTED]')).toBe(true)
    expect((compressionData?.response as string | undefined)?.includes('[REDACTED]')).toBe(true)
    expect((compressionData?.prompt as string | undefined)?.includes('secret-token')).toBe(false)
    expect((compressionData?.response as string | undefined)?.includes('secret-token')).toBe(false)
    expect((compressionData?.prompt as string | undefined)?.length).toBeLessThanOrEqual(500)
    expect((compressionData?.response as string | undefined)?.length).toBeLessThanOrEqual(500)
    expect(trace.endCalls).toEqual([{ spanId: 'span_compression', status: 'success' }])
  })

  test('falls back to response model and tolerates missing optional usage fields', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'m'.repeat(200)}`))
    }

    const trace = makeTraceRecorder()
    const adapter = {
      ...mockAdapter,
      async complete() {
        return {
          id: 'resp_fallback',
          content: [{ type: 'text' as const, text: 'Summary fallback model' }],
          stopReason: 'end_turn' as const,
          usage: {
            input: 80,
            output: 20,
          },
          model: 'provider/model-fallback',
        }
      },
    } satisfies ProviderAdapter

    await compressConversation(messages, 100, adapter, 'test-session', undefined, {
      tracer: trace.tracer,
      providerName: 'provider-x',
      pricing: {
        input: 1,
        output: 2,
      },
    })

    const compressionData = (
      trace.updateCalls[0]?.update.data as { compression?: Record<string, unknown> } | undefined
    )?.compression
    expect(compressionData?.model).toBe('provider/model-fallback')
    expect(compressionData?.provider).toBe('provider-x')
    expect(compressionData?.tokens).toEqual({
      input: 80,
      output: 20,
      cacheWrite: undefined,
      cacheRead: undefined,
      reasoning: undefined,
    })
    expect((compressionData?.cost as number | undefined) ?? 0).toBeCloseTo(0.00012, 8)
  })

  test('ends compression trace span with error and rethrows', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'x'.repeat(200)}`))
    }

    const trace = makeTraceRecorder()
    const adapter = {
      ...mockAdapter,
      async complete() {
        throw new Error('compression failed')
      },
    } satisfies ProviderAdapter

    await expect(
      compressConversation(messages, 100, adapter, 'test-session', undefined, {
        tracer: trace.tracer,
      }),
    ).rejects.toThrow('compression failed')

    expect(trace.updateCalls).toEqual([
      {
        spanId: 'span_compression',
        update: {
          metadata: {
            error: 'compression failed',
          },
        },
      },
    ])
    expect(trace.endCalls).toEqual([{ spanId: 'span_compression', status: 'error' }])
  })

  test('remains backward compatible when trace options are omitted', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(makeMessage(role as 'user' | 'assistant', `Msg ${i}: ${'q'.repeat(200)}`))
    }

    const result = await compressConversation(messages, 100, mockAdapter, 'test-session', {
      parentSessionId: 'parent-session',
    })

    expect(result.summary).toBe('Summary of conversation')
    expect(result.retainedMessages[0]?.sessionId).toBe('test-session')
  })
})

describe('generateContextCompaction', () => {
  test('renders tool environment digests instead of raw tool result content', () => {
    const input = makeContextCompactionInput()
    const prompt = buildContextCompactionPrompt({
      ...input,
      toolEnvironmentDigests: [
        {
          id: 'tool_digest_fixture',
          scope: 'single',
          toolUseIds: ['tool_read_runner'],
          messageIds: ['msg_tool_context', 'msg_result_context'],
          rawChars: 48000,
          digestChars: 120,
          summary:
            '环境摘要：K1/read 读取 /repo/packages/core/src/agent/compress.ts，结果显示 runner 已迁移。',
          model: {
            promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
            usedModel: 'mock',
            usedProvider: 'mock',
          },
        },
      ],
    })

    expect(prompt).toContain('<tool_environment_digests>')
    expect(prompt).toContain('tool_digest_fixture')
    expect(prompt).toContain('环境摘要')
    expect(prompt).toContain('raw_replaced_by_tool_environment_digest=true')
    expect(prompt).not.toContain('<tool_result_raw><![CDATA[')
    expect(prompt).not.toContain('compress.ts now owns the context compaction model request runner')
  })

  test('runs context compaction model request with trace, cost, and model metadata', async () => {
    const input = makeContextCompactionInput()
    const trace = makeTraceRecorder()
    let seenRequest: import('@zero-os/shared').CompletionRequest | undefined
    const adapter = {
      ...mockAdapter,
      async complete(request) {
        seenRequest = request
        return {
          id: 'resp_context_compaction',
          content: [
            {
              type: 'text' as const,
              text: `<context_compaction prompt_version="${CONTEXT_COMPACTION_PROMPT_VERSION}">
  <block_summary>context compaction runner 已从 agent.ts 移到 compress.ts。</block_summary>
  <topics>
    <topic id="T1" status="completed" message_refs="E1,E2,E3" tool_refs="K1" needs_raw_review="false">
      <title>runner 边界收敛</title>
      <summary>用户要求瘦身 agent.ts，工具读取 compress.ts 后确认 runner 现在由 compress.ts 承担。</summary>
      <confirmed_facts><item>K1 结果说明 compress.ts now owns the context compaction model request runner.</item></confirmed_facts>
      <current_state><item>agent.ts 只需要传入 compaction runtime。</item></current_state>
      <evidence><item>K1 result Read context compaction runner.</item></evidence>
    </topic>
  </topics>
  <user_constraints><item>agent.ts 不承载 context compaction 执行细节。</item></user_constraints>
  <do_not_infer><item>不能把测试 fixture 当成线上验证。</item></do_not_infer>
</context_compaction>`,
            },
          ],
          stopReason: 'end_turn' as const,
          usage: { input: 200, output: 100, reasoning: 10 },
          model: 'provider/raw-context-model',
        }
      },
    } satisfies ProviderAdapter

    const output = await generateContextCompaction(input, {
      adapter,
      sessionId: 'sess_context_runner',
      agentName: 'agent-test',
      parentSpanId: 'parent-span',
      turnIndex: 7,
      parentSessionId: 'parent-session',
      modelLabel: 'provider/context-model',
      providerName: 'provider',
      pricing: { input: 1, output: 2 },
      tracer: trace.tracer,
      secretFilter,
    })

    expect(output?.validation?.status).toBe('passed')
    expect(output?.model).toMatchObject({
      promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
      primaryModel: 'provider/context-model',
      primaryProvider: 'provider',
      usedModel: 'provider/context-model',
      usedProvider: 'provider',
      attempts: 1,
    })
    expect(seenRequest?.meta).toEqual({
      sessionId: 'sess_context_runner',
      purpose: 'compression',
      parentSessionId: 'parent-session',
    })
    expect(seenRequest?.system).toContain('Context Compaction Model')
    expect(trace.startCalls[0]).toMatchObject({
      sessionId: 'sess_context_runner',
      name: 'context_compaction_model',
      parentId: 'parent-span',
    })
    expect(trace.logSessionCalls.map((call) => call.event)).toEqual([
      'context_compaction.model_request',
      'context_compaction.model_response',
    ])
    const responseLog = trace.logSessionCalls.find(
      (call) => call.event === 'context_compaction.model_response',
    )
    expect((responseLog?.data?.cost as number | undefined) ?? 0).toBeCloseTo(0.00042, 8)
    expect(trace.updateCalls[0]?.update).toMatchObject({
      data: {
        contextCompactionModel: {
          blockId: 'block_context_runner',
          promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
          parsed: true,
          validation: { status: 'passed' },
          topicCount: 1,
          model: 'provider/context-model',
          provider: 'provider',
          attempts: 1,
        },
      },
    })
    expect(trace.endCalls[0]).toMatchObject({
      spanId: 'span_compression',
      status: 'success',
      metadata: {
        parsed: true,
        validationStatus: 'passed',
      },
    })
  })

  test('pre-digests large tool IO before the main context compaction request', async () => {
    const input = makeContextCompactionInput()
    const resultBlock = input.segment[2]?.content.find((block) => block.type === 'tool_result')
    if (!resultBlock || resultBlock.type !== 'tool_result') throw new Error('missing tool_result')
    resultBlock.content = [
      'secret-token',
      '/repo/packages/core/src/agent/compress.ts --inspect',
      'large tool output line'.repeat(1200),
    ].join('\n')

    const trace = makeTraceRecorder()
    const seenRequests: import('@zero-os/shared').CompletionRequest[] = []
    const adapter = {
      ...mockAdapter,
      async complete(request) {
        seenRequests.push(request)
        if (request.meta?.purpose === 'tool_io_digest') {
          return {
            id: 'resp_tool_digest',
            content: [
              {
                type: 'text' as const,
                text: '环境摘要：K1/read 读取 /repo/packages/core/src/agent/compress.ts，输出显示 large tool output line，保留 --inspect；仍需回看 K1 raw evidence。',
              },
            ],
            stopReason: 'end_turn' as const,
            usage: { input: 300, output: 80 },
            model: 'provider/raw-context-model',
          }
        }
        return {
          id: 'resp_context_compaction',
          content: [
            {
              type: 'text' as const,
              text: `<context_compaction prompt_version="${CONTEXT_COMPACTION_PROMPT_VERSION}">
  <block_summary>context compaction 使用 tool digest 压缩了大工具输出。</block_summary>
  <topics>
    <topic id="T1" status="completed" message_refs="E1,E2,E3" tool_refs="K1" needs_raw_review="true">
      <title>tool digest 接入</title>
      <summary>主 compaction 基于 K1 的 tool_environment_digest 理解工具观察，而不是读取完整 raw。</summary>
      <confirmed_facts><item>K1 digest 保留了 /repo/packages/core/src/agent/compress.ts 和 --inspect。</item></confirmed_facts>
      <current_state><item>大工具输出进入 tool_environment_digest。</item></current_state>
      <evidence><item>K1 raw evidence 需要时再回看。</item></evidence>
    </topic>
  </topics>
  <user_constraints><item>tool digest 不解释调用动机。</item></user_constraints>
  <do_not_infer><item>不能把局部工具环境摘要当成用户完整目标。</item></do_not_infer>
</context_compaction>`,
            },
          ],
          stopReason: 'end_turn' as const,
          usage: { input: 500, output: 180 },
          model: 'provider/raw-context-model',
        }
      },
    } satisfies ProviderAdapter

    const output = await generateContextCompaction(input, {
      adapter,
      sessionId: 'sess_context_runner',
      agentName: 'agent-test',
      parentSpanId: 'parent-span',
      turnIndex: 8,
      parentSessionId: 'parent-session',
      modelLabel: 'provider/context-model',
      providerName: 'provider',
      pricing: { input: 1, output: 2 },
      tracer: trace.tracer,
      secretFilter,
    })

    expect(output?.validation?.status).toBe('passed')
    expect(seenRequests.map((request) => request.meta?.purpose)).toEqual([
      'tool_io_digest',
      'compression',
    ])
    const digestPrompt = seenRequests[0]?.messages[0]?.content[0]
    if (!digestPrompt || digestPrompt.type !== 'text') throw new Error('missing digest prompt')
    expect(digestPrompt.text).toContain('不要解释工具为什么被调用')
    expect(digestPrompt.text).toContain('/repo/packages/core/src/agent/compress.ts --inspect')

    const compactionPrompt = seenRequests[1]?.messages[0]?.content[0]
    if (!compactionPrompt || compactionPrompt.type !== 'text') {
      throw new Error('missing compaction prompt')
    }
    expect(compactionPrompt.text).toContain('<tool_environment_digests>')
    expect(compactionPrompt.text).toContain('环境摘要：K1/read')
    expect(compactionPrompt.text).toContain('raw_replaced_by_tool_environment_digest=true')
    expect(compactionPrompt.text).not.toContain('<tool_result_raw><![CDATA[')
    expect(compactionPrompt.text).not.toContain('secret-token')
    expect(trace.logSessionCalls.map((call) => call.event)).toEqual([
      'tool_environment_digest.model_request',
      'tool_environment_digest.model_response',
      'context_compaction.model_request',
      'context_compaction.model_response',
    ])
    const contextSpanUpdate = trace.updateCalls.find((call) => {
      const data = call.update.data as
        | { contextCompactionModel?: { toolDigestCount?: number } }
        | undefined
      return data?.contextCompactionModel?.toolDigestCount === 1
    })
    expect(contextSpanUpdate).toBeDefined()
  })
})
