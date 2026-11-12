import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionEventStore } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContextCheckpoint,
  Message,
  SessionEvent,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext, type AgentObservability } from '../agent'
import { prepareRequestMessages } from '../compaction'

const SESSION = 'sess_agent_compaction'
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zero-agent-compaction-'))
  tempDirs.push(dir)
  return dir
}

/** `big_tool` 返回 input.size 个字符,开头带上调用序号 */
class BigTool extends BaseTool {
  name = 'big_tool'
  description = 'Return a large output'
  parameters = {
    type: 'object',
    properties: { step: { type: 'number' }, size: { type: 'number' } },
    required: ['step', 'size'],
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { step, size } = input as { step: number; size: number }
    return { success: true, output: toolOutput(step, size), outputSummary: `step ${step}` }
  }
}

function toolOutput(step: number, size: number): string {
  const head = `RESULT_${step}_`
  return `${head}${'r'.repeat(size - head.length)}`
}

/**
 * 主模型:按 steps 依次调用 big_tool,之后回复 done。只记录 agent loop 请求(深拷贝,
 * 因为 loop 会原地修改请求消息数组)。
 */
class ScriptedAdapter implements ProviderAdapter {
  readonly apiType = 'fake-scripted'
  requests: CompletionRequest[] = []

  constructor(private readonly steps: Array<{ size: number; text?: string }>) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.meta?.purpose === 'task_closure') {
      return response('closure', [{ type: 'text', text: '{"action":"finish","reason":"done"}' }])
    }
    this.requests.push(structuredClone(req))
    const index = this.requests.length - 1
    const step = this.steps[index]
    if (!step) return response(`resp_${index}`, [{ type: 'text', text: 'done' }])
    return {
      ...response(`resp_${index}`, [
        ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
        {
          type: 'tool_use',
          id: `call_${index + 1}`,
          name: 'big_tool',
          input: { step: index + 1, size: step.size },
        },
      ]),
      stopReason: 'tool_use',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

/** 压缩模型:返回 SUMMARY n,或按要求失败 */
class SummaryAdapter implements ProviderAdapter {
  readonly apiType = 'fake-summary'
  requests: CompletionRequest[] = []

  constructor(private readonly error?: Error) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req)
    if (this.error) throw this.error
    return response(`summary_${this.requests.length}`, [
      { type: 'text', text: `SUMMARY ${this.requests.length}` },
    ])
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function response(id: string, content: CompletionResponse['content']): CompletionResponse {
  return { id, content, stopReason: 'end_turn', usage: { input: 10, output: 5 }, model: 'fake' }
}

function textMessage(id: string, role: 'user' | 'assistant', text: string): Message {
  return {
    id,
    sessionId: SESSION,
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: '2026-11-01T00:00:00.000Z',
  }
}

/** 10 条交替的长文本消息 h0..h9,每条约 2000 token,裁剪无法降低压力 */
function textHistory(): Message[] {
  return Array.from({ length: 10 }, (_, i) =>
    textMessage(`h${i}`, i % 2 === 0 ? 'user' : 'assistant', `H${i} ${'x'.repeat(7000)}`),
  )
}

function createAgent(options: {
  adapter: ProviderAdapter
  summaryAdapter: ProviderAdapter
  workDir?: string
  obs?: AgentObservability
  logged?: Array<{ event: string; data?: Record<string, unknown> }>
}) {
  const registry = new ToolRegistry()
  registry.register(new BigTool())
  const log = (event: string, data?: Record<string, unknown>) =>
    options.logged?.push({ event, data })
  const toolContext: ToolContext = {
    sessionId: SESSION,
    workDir: options.workDir ?? tempDir(),
    logger: { info: log, warn: log, error: log },
  }
  const agent = new Agent(
    { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
    options.adapter,
    registry,
    toolContext,
    options.obs ?? {},
    undefined,
    options.summaryAdapter,
  )
  return { agent, tools: registry.getDefinitions() }
}

function createEventStore(): SessionEventStore {
  const store = new SessionEventStore({ basePath: tempDir() })
  store.ensureSession({ v: 1, sessionId: SESSION, schemaVersion: 1, source: 'web' })
  return store
}

function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
  return value
}

function isCheckpointMessage(message: Message | undefined): boolean {
  return (
    message?.content.some(
      (block) => block.type === 'text' && block.text.includes('<context_checkpoint>'),
    ) ?? false
  )
}

/** 每个 tool_use 紧接着有对应的 tool_result,每个 tool_result 前面都有对应的 tool_use */
function expectToolPairing(messages: Message[]): void {
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        expect(
          messages[index + 1]?.content.some(
            (next) => next.type === 'tool_result' && next.toolUseId === block.id,
          ),
        ).toBe(true)
      }
      if (block.type === 'tool_result') {
        expect(
          messages[index - 1]?.content.some(
            (previous) => previous.type === 'tool_use' && previous.id === block.toolUseId,
          ),
        ).toBe(true)
      }
    }
  })
}

function compactionEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.type.startsWith('compaction/'))
}

describe('Agent context compaction at turn start', () => {
  test('below threshold the request carries canonical history unchanged', async () => {
    const adapter = new ScriptedAdapter([])
    const summaryAdapter = new SummaryAdapter()
    const { agent, tools } = createAgent({ adapter, summaryAdapter })
    const history = textHistory()
    const changed: ContextCheckpoint[] = []
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: history,
      tools,
      maxContext: 200_000,
      maxOutput: 8_000,
      onCheckpointChanged: (checkpoint) => changed.push(checkpoint),
    }

    const newMessages = await agent.run(context, 'next question')

    expect(adapter.requests[0].messages).toEqual([...history, newMessages[0]])
    expect(summaryAdapter.requests).toHaveLength(0)
    expect(changed).toHaveLength(0)
    expect(context.checkpoint).toBeUndefined()
  })

  test('above threshold the request starts with the checkpoint and the raw tail', async () => {
    const adapter = new ScriptedAdapter([])
    const summaryAdapter = new SummaryAdapter()
    const logged: Array<{ event: string; data?: Record<string, unknown> }> = []
    const { agent, tools } = createAgent({ adapter, summaryAdapter, logged })
    const history = textHistory()
    const changed: ContextCheckpoint[] = []
    // U = 18000:阈值 14400、保留 3600;历史约 20000 token,尾部只容得下 h9
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: history,
      tools,
      maxContext: 20_000,
      maxOutput: 2_000,
      onCheckpointChanged: (checkpoint) => changed.push(checkpoint),
    }

    const newMessages = await agent.run(context, 'next question')

    expect(summaryAdapter.requests).toHaveLength(1)
    expect(changed).toHaveLength(1)
    expect(context.checkpoint).toBe(changed[0])
    expect(context.checkpoint).toMatchObject({
      generation: 1,
      summarizedThroughMessageId: 'h8',
      summary: 'SUMMARY 1',
      coveredMessageCount: 9,
    })
    const [first, ...rest] = adapter.requests[0].messages
    expect(first.id).toBe(expectDefined(context.checkpoint).id)
    expect(isCheckpointMessage(first)).toBe(true)
    expect(rest).toEqual([history[9], newMessages[0]])
    expect(logged.find((entry) => entry.event === 'context_compaction')?.data).toMatchObject({
      trigger: 'turn_start',
      status: 'summarized',
      generation: 1,
    })
  })

  test('events are written before the request and reproduce it from the log', async () => {
    const store = createEventStore()
    const history = textHistory()
    store.syncCanonical(SESSION, { messages: history, blocks: [] })
    const adapter = new ScriptedAdapter([])
    const { agent, tools } = createAgent({
      adapter,
      summaryAdapter: new SummaryAdapter(),
      obs: { sessionEvents: store },
    })
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: history,
      tools,
      maxContext: 20_000,
      maxOutput: 2_000,
    }

    const newMessages = await agent.run(context, 'next question')

    const events = store.readEvents(SESSION)
    const stepStart = events.find((event) => event.type === 'step/start')
    if (!stepStart) throw new Error('missing step/start')
    const compaction = compactionEvents(events)
    expect(compaction.map((event) => event.type)).toEqual([
      'compaction/start',
      'compaction/checkpoint',
      'compaction/end',
    ])
    expect(compaction.every((event) => event.seq < stepStart.seq)).toBe(true)
    expect(compaction[0].data).toMatchObject({ trigger: 'turn_start', thresholdTokens: 14_400 })
    expect(compaction[1].data).toEqual({ checkpoint: expectDefined(context.checkpoint) })
    expect(compaction[2].data).toMatchObject({
      status: 'summarized',
      usage: { input: 10, output: 5 },
    })

    // 本 turn 的消息事件在 turn 结束时才由 Session 写入,这里把本次请求的 user 消息接到投影后面
    const upTo = store.projectUpTo(SESSION, stepStart.seq)
    if (!upTo) throw new Error('missing projection')
    expect(upTo.checkpoint).toEqual(context.checkpoint)
    expect(
      prepareRequestMessages([...upTo.messages, newMessages[0]], upTo.checkpoint, {
        requireThinkingForToolUse: false,
      }),
    ).toEqual(adapter.requests[0].messages)
  })

  test('a failed summary keeps only the prune advance and the turn proceeds', async () => {
    const store = createEventStore()
    const adapter = new ScriptedAdapter([])
    const summaryAdapter = new SummaryAdapter(new Error('provider down'))
    const { agent, tools } = createAgent({
      adapter,
      summaryAdapter,
      obs: { sessionEvents: store },
    })
    const history = textHistory()
    const changed: ContextCheckpoint[] = []
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: history,
      tools,
      maxContext: 20_000,
      maxOutput: 2_000,
      onCheckpointChanged: (checkpoint) => changed.push(checkpoint),
    }

    const newMessages = await agent.run(context, 'next question')

    expect(summaryAdapter.requests).toHaveLength(1)
    expect(context.checkpoint).toMatchObject({
      generation: 1,
      prunedThroughMessageId: 'h8',
      coveredMessageCount: 0,
    })
    expect(context.checkpoint?.summary).toBeUndefined()
    expect(changed).toEqual(context.checkpoint ? [context.checkpoint] : [])
    expect(adapter.requests[0].messages).toEqual([...history, newMessages[0]])
    expect(newMessages.at(-1)?.role).toBe('assistant')

    const end = compactionEvents(store.readEvents(SESSION)).find(
      (event) => event.type === 'compaction/end',
    )
    expect(end?.data).toMatchObject({ status: 'failed', error: 'provider down' })
  })
})

describe('Agent context compaction inside a turn', () => {
  test('a failed summary is not retried within the same turn', async () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      size: 10_000,
      text: `step ${i + 1} ${'t'.repeat(7000)}`,
    }))
    const adapter = new ScriptedAdapter(steps)
    const summaryAdapter = new SummaryAdapter(new Error('provider down'))
    const store = createEventStore()
    const { agent, tools } = createAgent({ adapter, summaryAdapter, obs: { sessionEvents: store } })
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools,
      maxContext: 16_000,
      maxOutput: 1_000,
    }

    const newMessages = await agent.run(context, 'long task')

    // 压力在多个步骤上都超过阈值,但失败后的步骤不再调用压缩模型
    expect(adapter.requests).toHaveLength(7)
    expect(summaryAdapter.requests).toHaveLength(1)
    expect(newMessages.at(-1)?.content).toEqual([{ type: 'text', text: 'done' }])
    const ends = compactionEvents(store.readEvents(SESSION)).filter(
      (event) => event.type === 'compaction/end',
    )
    expect(
      ends.filter((event) => (event.data as { status: string }).status === 'failed'),
    ).toHaveLength(1)
  })

  test('a long turn compacts between steps and keeps tool pairs intact', async () => {
    // 每步:约 2000 token 的 assistant 文本 + 约 2860 token 的工具结果
    const steps = Array.from({ length: 6 }, (_, i) => ({
      size: 10_000,
      text: `step ${i + 1} ${'t'.repeat(7000)}`,
    }))
    const adapter = new ScriptedAdapter(steps)
    const summaryAdapter = new SummaryAdapter()
    const store = createEventStore()
    const { agent, tools } = createAgent({ adapter, summaryAdapter, obs: { sessionEvents: store } })
    const changed: ContextCheckpoint[] = []
    // U = 15000:阈值 12000、保留 3000
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools,
      maxContext: 16_000,
      maxOutput: 1_000,
      onCheckpointChanged: (checkpoint) => changed.push(checkpoint),
    }

    const newMessages = await agent.run(context, 'long task')

    expect(adapter.requests).toHaveLength(7)
    expect(summaryAdapter.requests.length).toBeGreaterThanOrEqual(1)
    expect(changed.length).toBeGreaterThanOrEqual(2)
    expect(context.checkpoint).toBe(changed.at(-1))
    expect(newMessages.at(-1)?.content).toEqual([{ type: 'text', text: 'done' }])

    const summarized = adapter.requests.findIndex((request) =>
      isCheckpointMessage(request.messages[0]),
    )
    expect(summarized).toBeGreaterThan(0)
    for (const request of adapter.requests) {
      expectToolPairing(request.messages)
      // 最新的工具结果总是原文
      const last = request.messages.at(-1)?.content.at(-1)
      if (last?.type === 'tool_result') {
        const step = Number(last.toolUseId.replace('call_', ''))
        expect(last.content).toBe(toolOutput(step, 10_000))
      }
    }

    const events = store.readEvents(SESSION)
    const inTurn = compactionEvents(events).filter((event) => event.type === 'compaction/start')
    expect(inTurn.length).toBeGreaterThanOrEqual(2)
    expect(inTurn.every((event) => (event.data as { trigger: string }).trigger === 'in_turn')).toBe(
      true,
    )
  })

  test('the turn user message keeps its request-only content after a rebuild', async () => {
    const steps = Array.from({ length: 4 }, () => ({ size: 10_000, text: 't'.repeat(7000) }))
    const adapter = new ScriptedAdapter(steps)
    const { agent, tools } = createAgent({ adapter, summaryAdapter: new SummaryAdapter() })
    // U = 20000:阈值 16000、保留 4000;第 3 步之后只需裁剪,turn 的 user 消息仍在投影里
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      dynamicContext: '<system-reminder>DYNAMIC</system-reminder>',
      conversationHistory: [],
      tools,
      maxContext: 21_000,
      maxOutput: 1_000,
    }

    const newMessages = await agent.run(context, 'long task')

    const rebuilt = adapter.requests.find((request) =>
      request.messages.some((message) =>
        message.content.some(
          (block) => block.type === 'tool_result' && block.content.includes('…[省略 '),
        ),
      ),
    )
    if (!rebuilt) throw new Error('expected a pruned request')
    expect(rebuilt.messages[0].id).toBe(newMessages[0].id)
    expect(rebuilt.messages[0].content).toEqual([
      { type: 'text', text: '<system-reminder>DYNAMIC</system-reminder>' },
      ...newMessages[0].content,
    ])
  })
})

describe('compaction/prune events', () => {
  test('emitted only when the tool result is replaced by an artifact reference', async () => {
    const store = createEventStore()
    const adapter = new ScriptedAdapter([{ size: 70_000 }, { size: 20_000 }])
    const { agent, tools } = createAgent({
      adapter,
      summaryAdapter: new SummaryAdapter(),
      obs: { sessionEvents: store },
    })

    await agent.run({ systemPrompt: 'Test prompt', conversationHistory: [], tools }, 'run tools')

    const prunes = store.readEvents(SESSION).filter((event) => event.type === 'compaction/prune')
    expect(prunes.map((event) => (event.data as { toolUseId: string }).toolUseId)).toEqual([
      'call_1',
    ])
    // 中等大小的输出写了 evidence 但原文留在 canonical
    const medium = adapter.requests[2].messages
      .at(-1)
      ?.content.find((block) => block.type === 'tool_result')
    expect(medium?.type === 'tool_result' && medium.content).toBe(toolOutput(2, 20_000))
  })
})
