import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import {
  ObservabilityStore,
  type RequestLogEntry,
  SessionEventStore,
  Tracer,
  attachRequestsToSpans,
  flattenTraceSpans,
  projectSessionRequestsFromEvents,
  readEventsFile,
} from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  SecretFilter,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'
import { buildDynamicContext, buildRetrievedMemoriesBlock } from '../prompt'

/**
 * 会话详情的请求列表从事件流算出(步骤 7a),trace 的 llm_request span 不再带请求本身(步骤 7c),
 * span 树和决策读 trace 时按 span 编号补回(步骤 7b)。7a 当时对每个场景做过「事件算出 = 原 trace 算出」的逐项比对,
 * 7c 之后新的 trace 没有请求可比,这里直接断言事件算出的各字段。
 */

const SESSION = 'sess_request_list'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Do nothing'
  parameters = { type: 'object', properties: {} }
  protected async execute(): Promise<ToolResult> {
    return { success: true, output: 'ok token-123', outputSummary: 'ok' }
  }
}

class FlakyTool extends BaseTool {
  name = 'flaky'
  description = 'Fails'
  parameters = { type: 'object', properties: {} }
  protected async execute(): Promise<ToolResult> {
    return { success: false, output: 'connection refused', outputSummary: 'connection refused' }
  }
}

const filter: SecretFilter = {
  filter: (text) => text.replaceAll('token-123', '[redacted]'),
  addSecret() {},
  removeSecret() {},
}

type Reply = Partial<CompletionResponse> & { content: ContentBlock[] }
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const call = (id: string, name = 'noop', input: Record<string, unknown> = {}): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
})
const isNudge = (request: CompletionRequest) =>
  request.messages.at(-1)?.controlKind === 'memory_nudge'

function adapterFor(main: (request: CompletionRequest, n: number) => Reply): ProviderAdapter {
  let n = 0
  return {
    apiType: 'fake-request-list',
    async complete(request) {
      const purpose = request.meta?.purpose
      if (purpose === 'task_closure')
        return reply('closure', { content: text('{"action":"finish","reason":"done"}') })
      if (purpose === 'memory_retrieval') {
        const searched = request.messages.some((message) =>
          message.content.some((block) => block.type === 'tool_result'),
        )
        return searched
          ? reply('mem_final', { content: text('{"result":[{"id":"mem_x","reason":"relevant"}]}') })
          : reply('mem_search', {
              content: [call('ms_1', 'memory_search', { query: 'refused' })],
              stopReason: 'tool_use',
            })
      }
      if (isNudge(request)) return reply('nudge', { content: text('nothing worth recording') })
      n += 1
      return reply(`resp_${n}`, main(request, n))
    },
    async *stream(): AsyncIterable<StreamEvent> {
      yield* []
      throw new Error('stream not supported in test')
    },
    async healthCheck() {
      return true
    },
  }
}

function reply(id: string, partial: Reply): CompletionResponse {
  return {
    id,
    stopReason: partial.content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'fake',
    ...partial,
  }
}

const memory = {
  id: 'mem_x',
  type: 'note',
  title: 'Retry on refused connections',
  content: 'Wait and retry.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'verified',
  confidence: 0.8,
  tags: [],
  related: [],
}

/** 跑一个 turn,写 Session 在 Agent.run 之前写的 tools/set 与 turn/start */
async function runTurn(options: {
  main: (request: CompletionRequest, n: number) => Reply
  queueAt?: (n: number) => boolean
  layer1?: boolean
  memories?: boolean
}) {
  const logs = mkdtempSync(join(tmpdir(), 'zero-request-list-'))
  dirs.push(logs)
  const store = new SessionEventStore({ basePath: logs })
  store.ensureSession({ v: 1, sessionId: SESSION, schemaVersion: 1, source: 'web' })
  const registry = new ToolRegistry()
  registry.register(new NoopTool())
  registry.register(new FlakyTool())
  const toolNames = registry.getDefinitions().map((tool) => tool.name)
  store.append(SESSION, [
    { type: 'tools/set', data: { hash: 'sha256:x', toolNames, count: toolNames.length } },
    { type: 'turn/start', data: { turnIndex: 3, trigger: 'channel', agentName: 'test-agent' } },
  ])

  const queue: Array<{ content: string; timestamp: string }> = []
  let requests = 0
  const adapter = adapterFor((request, n) => {
    requests = n
    if (options.queueAt?.(n))
      queue.push({ content: 'also check token-123', timestamp: '2026-01-01T00:00:00.000Z' })
    return options.main(request, n)
  })
  const toolContext = {
    sessionId: SESSION,
    workDir: logs,
    logger: { info() {}, warn() {}, error() {} },
    secretFilter: filter,
    ...(options.memories && {
      memoryRetriever: {
        retrieve: async () => [memory],
        retrieveScored: async () => [
          { memory, score: 0.9, scoreBreakdown: { keyword: 0, recency: 0, vector: 0.9 } },
        ],
      },
    }),
  } as unknown as ToolContext
  const agent = new Agent(
    { name: 'test-agent', agentInstruction: 'Test prompt' },
    adapter,
    registry,
    toolContext,
    {
      sessionEvents: store,
      tracer: new Tracer(logs),
      secretFilter: filter,
      modelLabel: 'provider/model',
      providerName: 'fake-provider',
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  )
  const context: AgentContext = {
    systemPrompt: 'Test prompt',
    conversationHistory: [],
    tools: registry.getDefinitions(),
  }
  if (options.layer1) {
    const block = buildRetrievedMemoriesBlock([
      { id: 'mem_x', type: 'note', title: 'Answer token-123', content: 'C', score: 0.9 },
    ])
    context.dynamicContext = buildDynamicContext({ retrievedMemories: block })
  }
  await agent.run(
    context,
    'do the task token-123',
    undefined,
    undefined,
    undefined,
    () => queue.length > 0,
    () => queue.splice(0),
    { turnIndex: 3 },
  )
  expect(requests).toBeGreaterThan(0)
  return { logs, observability: new ObservabilityStore(logs) }
}

function fromEvents(logs: string): RequestLogEntry[] {
  return projectSessionRequestsFromEvents(
    SESSION,
    [{ events: readEventsFile(join(logs, 'sessions', SESSION, 'session.jsonl')), subagent: false }],
    filter.filter,
  )
}

/** 读请求列表,并核对 7b、7c:trace 的 span 不带请求,补回后每个 llm_request span 都对上一条请求 */
function requestsOf(run: Awaited<ReturnType<typeof runTurn>>): RequestLogEntry[] {
  const requests = run.observability.readSessionRequests(SESSION, filter.filter)
  expect(requests).toEqual(fromEvents(run.logs))
  const spans = flattenTraceSpans(new Tracer(run.logs).exportSession(SESSION)).filter(
    (span) => span.name === 'llm_request',
  )
  expect(spans.length).toBe(requests.length)
  expect(spans.every((span) => span.data?.request === undefined)).toBe(true)
  const attached = flattenTraceSpans(
    attachRequestsToSpans(new Tracer(run.logs).exportSession(SESSION), requests),
  ).filter((span) => span.name === 'llm_request')
  expect(attached.map((span) => (span.data?.request as RequestLogEntry | undefined)?.id)).toEqual(
    requests.map((request) => request.id),
  )
  expect(attached.map((span) => span.metadata?.requestId)).toEqual(
    requests.map((request) => request.id),
  )
  return requests
}

describe('request list from the event stream', () => {
  test('tool calls with a secret, an unknown tool and an empty response', async () => {
    const run = await runTurn({
      main: (_request, n) =>
        n === 1
          ? {
              content: [
                ...text('working'),
                call('call_1', 'noop', { secret: 'token-123' }),
                call('call_2', 'missing'),
              ],
            }
          : n === 2
            ? { content: [] }
            : { content: text('all done token-123') },
    })
    const requests = requestsOf(run)
    // 第一次请求、回复为空的那次、重试拿到的回答、记忆提醒
    expect(requests.map((entry) => entry.id)).toEqual(['resp_1', 'resp_2', 'resp_3', 'nudge'])
    expect(requests[0]).toMatchObject({
      sessionId: SESSION,
      turnIndex: 3,
      agentName: 'test-agent',
      model: 'provider/model',
      provider: 'fake-provider',
      userPrompt: 'do the task [redacted]',
      response: 'working',
      stopReason: 'tool_use',
      toolUseCount: 2,
      toolCalls: [
        { id: 'call_1', name: 'noop', input: { secret: '[redacted]' } },
        { id: 'call_2', name: 'missing', input: {} },
      ],
      toolResults: [],
      toolNames: ['noop', 'flaky'],
      messageCount: 1,
      tokens: { input: 10, output: 5 },
    })
    expect(requests[0].cost).toBeCloseTo((10 * 3 + 5 * 15) / 1_000_000, 12)
    expect(requests[0].parentId).toBeUndefined()
    // 工具结果进入下一次请求;工具输出在执行时已经过滤过密钥
    expect(requests[1]).toMatchObject({
      parentId: 'resp_1',
      response: '',
      stopReason: 'end_turn',
      toolResults: [
        { toolUseId: 'call_1', isError: false, content: 'ok [redacted]' },
        { toolUseId: 'call_2', isError: true },
      ],
    })
    expect(requests[2]).toMatchObject({ response: 'all done [redacted]', toolResults: [] })
  })

  test('queued messages spliced into tool results, and a queued continuation', async () => {
    const run = await runTurn({
      queueAt: (n) => n === 1 || n === 3,
      main: (_request, n) =>
        n <= 2 ? { content: [call(`call_${n}`)] } : { content: text(`answer ${n}`) },
    })
    const requests = requestsOf(run)
    const queued = requests.filter((entry) => entry.queuedInjection)
    expect(queued).toHaveLength(2)
    for (const entry of queued) {
      expect(entry.queuedInjection).toMatchObject({
        count: 1,
        formattedText: expect.stringContaining('also check [redacted]'),
        messages: [
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            content: 'also check [redacted]',
            imageCount: 0,
            mediaTypes: [],
          },
        ],
      })
    }
    // 第一份拼在工具结果后面,第二份是一轮结束时取走的续写消息
    expect(queued[0].toolResults).toHaveLength(1)
    expect(queued[1].toolResults).toEqual([])
  })

  test('reasoning text, cache usage and a layer-1 memory injection', async () => {
    const run = await runTurn({
      layer1: true,
      main: (_request, n) => ({
        content: n === 1 ? [call('call_1')] : text('done'),
        reasoningContent: `thinking ${n} token-123`,
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 7 },
      }),
    })
    const requests = requestsOf(run)
    expect(requests[0].reasoningContent).toBe('thinking 1 [redacted]')
    expect(requests[0].memoryInjections).toEqual([
      {
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText: expect.stringMatching(
          /^<memory_inject layer="layer1">\n<retrieved_memories>[\s\S]*Answer \[redacted\][\s\S]*<\/retrieved_memories>\n<\/memory_inject>$/,
        ),
      },
    ])
    expect(requests[1].memoryInjections).toBeUndefined()
    expect(requests[0].tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      reasoning: 7,
    })
  })

  test('a layer-2 memory hint after a failed tool', async () => {
    const run = await runTurn({
      memories: true,
      main: (_request, n) => ({ content: n === 1 ? [call('call_1', 'flaky')] : text('recovered') }),
    })
    const requests = requestsOf(run)
    expect(requests[1].memoryInjections).toEqual([
      {
        layer: 'layer2',
        source: 'memory_hint',
        formattedText: expect.stringContaining('<memory_inject layer="layer2">'),
      },
    ])
    expect(requests[1].toolResults).toEqual([
      expect.objectContaining({ toolUseId: 'call_1', isError: true }),
    ])
  })

  test('decisions still find each tool-selection request through its span', async () => {
    const run = await runTurn({
      main: (_request, n) => ({
        content: n === 1 ? [call('call_1')] : text('done'),
        reasoningContent: `why ${n}`,
      }),
    })
    requestsOf(run)
    const decisions = run.observability.readSessionDecisions(SESSION, filter.filter)
    expect(decisions.filter((decision) => decision.decisionType === 'tool_selection')).toEqual([
      expect.objectContaining({ outcome: 'noop', rationale: 'why 1', sourceKind: 'llm_request' }),
    ])
  })

  test('requests logged before the events carried them come from the trace, merged by time', async () => {
    const run = await runTurn({
      main: (_request, n) => ({ content: n === 1 ? [call('call_1')] : text('done') }),
    })
    const current = requestsOf(run)
    // 升级前写的 trace:span 上带着整条请求
    const old = {
      spanId: 'span_old',
      sessionId: SESSION,
      kind: 'llm_request',
      name: 'llm_request',
      startTime: '2020-01-01T00:00:00.000Z',
      endTime: '2020-01-01T00:00:01.000Z',
      status: 'success',
      data: {
        request: {
          id: 'resp_old',
          turnIndex: 1,
          model: 'provider/old',
          provider: 'fake-provider',
          userPrompt: 'earlier [redacted]',
          response: 'old answer',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: { input: 1, output: 1 },
          cost: 0,
        },
      },
    }
    const traceFile = join(run.logs, 'sessions', SESSION, 'trace.jsonl')
    writeFileSync(traceFile, `${JSON.stringify(old)}\n${readFileSync(traceFile, 'utf-8')}`)

    const merged = new ObservabilityStore(run.logs).readSessionRequests(SESSION, filter.filter)
    expect(merged.map((entry) => entry.id)).toEqual([
      'resp_old',
      ...current.map((entry) => entry.id),
    ])
    expect(merged[0]).toMatchObject({ traceSpanId: 'span_old', userPrompt: 'earlier [redacted]' })
    expect(merged.slice(1)).toEqual(current)
  })
})
