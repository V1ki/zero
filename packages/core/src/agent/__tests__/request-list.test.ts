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
import { buildDynamicContext, buildRetrievedMemoriesBlock, wrapMemoryInjection } from '../prompt'

/**
 * 步骤 7a 的验收:会话详情的请求列表从事件流算出,与原来从 trace 的 llm_request span 算出的条目逐项相同。
 * 事件不带的只有没人读的四个 hash / 快照字段;ts 取 step/end 的时间,比 span 结束早不到几毫秒。
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
    context.requestMemoryInjections = [
      {
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText: wrapMemoryInjection('layer1', block),
      },
    ]
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

function fromTrace(observability: ObservabilityStore): RequestLogEntry[] {
  return observability.readSessionRequests(SESSION, filter.filter)
}

/** 去掉事件不带的四个字段,ts 允许几毫秒的差 */
function comparable(entries: RequestLogEntry[], reference: RequestLogEntry[]) {
  return entries.map((entry, index) => {
    const { systemHash, toolDefinitionsHash, staticPrefixHash, snapshotId, ...rest } = entry
    const ts = reference[index]?.ts
    const close = ts !== undefined && Math.abs(Date.parse(ts) - Date.parse(entry.ts)) <= 20
    return JSON.parse(JSON.stringify({ ...rest, ts: close ? 'close' : entry.ts }))
  })
}

async function expectSameRequests(run: Awaited<ReturnType<typeof runTurn>>) {
  const events = fromEvents(run.logs)
  // 清空事件文件再读一次,得到只从 trace 算出的条目
  const eventFile = join(run.logs, 'sessions', SESSION, 'session.jsonl')
  const saved = readFileSync(eventFile, 'utf-8')
  writeFileSync(eventFile, '')
  const trace = fromTrace(run.observability)
  writeFileSync(eventFile, saved)
  expect(events.length).toBeGreaterThan(0)
  expect(comparable(events, trace)).toEqual(comparable(trace, trace))
  return { events, trace }
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
    const { events } = await expectSameRequests(run)
    expect(events[0]).toMatchObject({
      turnIndex: 3,
      agentName: 'test-agent',
      model: 'provider/model',
      provider: 'fake-provider',
      userPrompt: 'do the task [redacted]',
      toolCalls: [{ id: 'call_1', input: { secret: '[redacted]' } }, { id: 'call_2' }],
      toolNames: ['noop', 'flaky'],
    })
    expect(events[1].parentId).toBe(events[0].id)
    expect(events[0].cost).toBeGreaterThan(0)
  })

  test('queued messages spliced into tool results, and a queued continuation', async () => {
    const run = await runTurn({
      queueAt: (n) => n === 1 || n === 3,
      main: (_request, n) =>
        n <= 2 ? { content: [call(`call_${n}`)] } : { content: text(`answer ${n}`) },
    })
    const { events } = await expectSameRequests(run)
    const queued = events.filter((entry) => entry.queuedInjection)
    expect(queued.length).toBeGreaterThan(0)
    expect(queued[0].queuedInjection?.messages).toEqual([
      expect.objectContaining({ content: 'also check [redacted]', imageCount: 0 }),
    ])
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
    const { events } = await expectSameRequests(run)
    expect(events[0].reasoningContent).toBe('thinking 1 [redacted]')
    expect(events[0].memoryInjections?.[0]).toMatchObject({ layer: 'layer1' })
    expect(events[0].tokens).toEqual({
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
    const { events } = await expectSameRequests(run)
    expect(events[1].memoryInjections?.[0]).toMatchObject({
      layer: 'layer2',
      source: 'memory_hint',
    })
  })

  test('requests whose events predate the new fields come from the trace, merged by id', async () => {
    const run = await runTurn({
      main: (_request, n) => ({ content: n === 1 ? [call('call_1')] : text('done') }),
    })
    const all = run.observability.readSessionRequests(SESSION, filter.filter)
    // 两次正常请求加一次记忆提醒
    expect(all).toHaveLength(3)
    // 把第一次请求的 step/end 改成旧格式(没有 cost)
    const eventFile = join(run.logs, 'sessions', SESSION, 'session.jsonl')
    const lines = readFileSync(eventFile, 'utf-8').trimEnd().split('\n')
    const first = lines.findIndex((line) => line.includes('"type":"step/end"'))
    const { cost, ...oldData } = JSON.parse(lines[first]).data
    expect(cost).toBeDefined()
    lines[first] = JSON.stringify({ ...JSON.parse(lines[first]), data: oldData })
    writeFileSync(eventFile, `${lines.join('\n')}\n`)

    const merged = new ObservabilityStore(run.logs).readSessionRequests(SESSION, filter.filter)
    expect(fromEvents(run.logs).map((entry) => entry.id)).toEqual(
      all.slice(1).map((entry) => entry.id),
    )
    expect(merged.map((entry) => entry.id)).toEqual(all.map((entry) => entry.id))
    expect(comparable(merged, all)).toEqual(comparable(all, all))
  })
})
