import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import { ObservabilityStore, Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'
import type { QueuedMessage } from '../queue'
import { buildTaskClosurePrompt } from '../task-closure'

async function* failStream(error: Error): AsyncIterable<StreamEvent> {
  yield* []
  throw error
}

const OPTIONAL_TAIL = `如果你愿意，我下一步可以继续帮你做两件更有用的事之一：
1. 把里面的已知事实和猜测拆开
2. 去查官方和媒体源，看看哪些引用是真的`

const INITIAL_REPLY = `我先给你一个初步判断：这帖更像高信息密度的传闻汇总，不能直接当事实依据。

${OPTIONAL_TAIL}`

const CONTINUED_REPLY =
  '我已继续核验关键来源。当前没有看到足够官方证据支持帖中的具体发布时间和 benchmark 数字。'

const BLOCK_REPLY = '要继续线上核验，我需要你的账号登录态或截图授权。'

type ClassifierMode = 'continue' | 'finish' | 'block' | 'malformed' | 'throw'
const tempDirs: string[] = []

function createTextResponse(text: string, reasoningContent?: string): CompletionResponse {
  return {
    id: 'resp_test',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 8, output: 8 },
    model: 'fake-model',
    reasoningContent,
  }
}

function createToolResponse(id: string, toolUseId: string, toolName = 'noop'): CompletionResponse {
  return {
    id,
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
    stopReason: 'tool_use',
    usage: { input: 5, output: 5 },
    model: 'fake-model',
  }
}

function getTextFromMessage(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('')
}

function getTextFromRequest(request: CompletionRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n')
}

function getLastUserMessage(request: CompletionRequest): Message | undefined {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]
    if (message.role === 'user') return message
  }
  return undefined
}

function isTaskClosureClassifierRequest(request: CompletionRequest): boolean {
  const text = getTextFromRequest(request)
  return text.includes('任务收尾判定器') && text.includes('<assistant_tail>')
}

class TaskClosureAdapter implements ProviderAdapter {
  readonly apiType = 'fake'
  normalCalls = 0
  classifierCalls = 0
  lastClassifierPrompt = ''
  lastClassifierSystem = ''
  lastTaskClosurePrompt = ''

  constructor(private readonly mode: ClassifierMode) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (isTaskClosureClassifierRequest(request)) {
      this.classifierCalls++

      if (this.mode === 'throw') {
        throw new Error('classifier failed')
      }

      if (this.mode === 'malformed') {
        return createTextResponse('not-json', 'classifier reasoning before malformed output')
      }

      if (this.mode === 'block') {
        return createTextResponse(
          '{"action":"block","reason":"缺少登录态"}',
          'classifier reasoning for block',
        )
      }

      const prompt = getTextFromRequest(request)
      this.lastClassifierPrompt = prompt
      this.lastClassifierSystem = request.system ?? ''
      if (this.mode === 'continue' && prompt.includes(OPTIONAL_TAIL)) {
        return createTextResponse(
          JSON.stringify({
            action: 'continue',
            reason: '后续核验仍属于当前任务',
          }),
          'classifier reasoning for continue',
        )
      }

      return createTextResponse(
        '{"action":"finish","reason":"当前回复应直接结束"}',
        'classifier reasoning for finish',
      )
    }

    this.normalCalls++

    const lastUserMessage = getLastUserMessage(request)
    if (
      lastUserMessage?.messageType === 'control' &&
      lastUserMessage.controlKind === 'task_closure'
    ) {
      this.lastTaskClosurePrompt = getTextFromMessage(lastUserMessage)
      return createTextResponse(CONTINUED_REPLY)
    }

    if (this.mode === 'block') {
      return createTextResponse(BLOCK_REPLY)
    }

    return createTextResponse(INITIAL_REPLY)
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream not supported in test'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Returns a short success payload'
  parameters = { type: 'object', properties: {} }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

class MemoryToolStub extends BaseTool {
  name = 'memory'
  description = 'Stores a memory entry'
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['action'],
  }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: true, output: 'memory ok', outputSummary: 'memory ok' }
  }
}

class FailingMemoryToolStub extends BaseTool {
  name = 'memory'
  description = 'Fails to store a memory entry'
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['action'],
  }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: false, output: 'memory failed', outputSummary: 'memory failed' }
  }
}

type MemoryNudgeMode =
  | 'skip'
  | 'empty-on-nudge'
  | 'write-on-nudge'
  | 'write-fails-on-nudge'
  | 'already-written'
  | 'delete-before-finish'
  | 'continue-after-nudge'

class MemoryNudgeAdapter implements ProviderAdapter {
  readonly apiType = 'fake-memory-nudge'
  normalCalls = 0
  classifierCalls = 0
  nudgeCalls = 0

  constructor(private readonly mode: MemoryNudgeMode) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (isTaskClosureClassifierRequest(request)) {
      this.classifierCalls++
      if (this.mode === 'continue-after-nudge') {
        const prompt = getTextFromRequest(request)
        if (prompt.includes(OPTIONAL_TAIL)) {
          return createTextResponse(
            '{"action":"continue","reason":"后续核验仍属于当前任务"}',
            'classifier reasoning for continue',
          )
        }
      }
      return createTextResponse(
        '{"action":"finish","reason":"当前回复应直接结束"}',
        'classifier reasoning for finish',
      )
    }

    this.normalCalls++
    const lastUserMessage = getLastUserMessage(request)
    if (this.mode === 'continue-after-nudge') {
      if (
        lastUserMessage?.messageType === 'control' &&
        lastUserMessage.controlKind === 'task_closure'
      ) {
        return createTextResponse('这轮工作已经完成')
      }
      if (
        lastUserMessage?.messageType === 'control' &&
        lastUserMessage.controlKind === 'memory_nudge'
      ) {
        return createTextResponse(INITIAL_REPLY)
      }
      return createTextResponse(INITIAL_REPLY)
    }
    if (
      lastUserMessage?.messageType === 'control' &&
      lastUserMessage.controlKind === 'memory_nudge'
    ) {
      this.nudgeCalls++
      if (this.mode === 'empty-on-nudge') {
        return {
          id: 'resp_nudge_empty',
          content: [],
          stopReason: 'end_turn',
          usage: { input: 1, output: 0 },
          model: 'fake-model',
        }
      }
      if (this.mode === 'write-on-nudge' || this.mode === 'write-fails-on-nudge') {
        return {
          id: 'resp_nudge_memory',
          content: [
            {
              type: 'tool_use',
              id: 'call_memory_1',
              name: 'memory',
              input: {
                action: 'create',
                type: 'note',
                title: '跨会话结论',
                content: '记录一个长期有用的结论',
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input: 5, output: 5 },
          model: 'fake-model',
        }
      }

      return createTextResponse('无需记忆')
    }

    if (this.mode === 'already-written') {
      if (this.normalCalls === 1) {
        return {
          id: 'resp_memory_tool',
          content: [
            {
              type: 'tool_use',
              id: 'call_memory_existing',
              name: 'memory',
              input: {
                action: 'create',
                type: 'decision',
                title: '已有决策',
                content: '这轮里已经写过 memory',
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input: 5, output: 5 },
          model: 'fake-model',
        }
      }

      return createTextResponse('这轮工作已经完成')
    }

    if (this.mode === 'delete-before-finish') {
      if (this.normalCalls === 1) {
        return {
          id: 'resp_memory_delete',
          content: [
            {
              type: 'tool_use',
              id: 'call_memory_delete',
              name: 'memory',
              input: {
                action: 'delete',
                path: '.zero/memory/note/test.md',
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input: 5, output: 5 },
          model: 'fake-model',
        }
      }

      return createTextResponse('这轮工作已经完成')
    }

    if (this.normalCalls === 1) {
      return {
        id: 'resp_tool_use',
        content: [{ type: 'tool_use', id: 'call_noop_1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
        model: 'fake-model',
      }
    }

    if (
      (this.mode === 'write-on-nudge' || this.mode === 'write-fails-on-nudge') &&
      this.normalCalls === 4
    ) {
      return createTextResponse('已记录这条长期记忆')
    }

    return createTextResponse('这轮工作已经完成')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream not supported in test'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class QueueGateAdapter implements ProviderAdapter {
  readonly apiType = 'fake-queue-gate'
  classifierCalls = 0
  normalCalls = 0

  constructor(
    private readonly mode: 'pre-closure' | 'post-classifier',
    private readonly onClassifierEvaluated?: () => void,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (isTaskClosureClassifierRequest(request)) {
      this.classifierCalls++
      this.onClassifierEvaluated?.()
      return createTextResponse(
        '{"action":"continue","reason":"后续核验仍属于当前任务"}',
        'classifier reasoning for continue',
      )
    }

    this.normalCalls++
    const lastUserMessage = getLastUserMessage(request)
    if (
      lastUserMessage?.messageType === 'control' &&
      lastUserMessage.controlKind === 'queued_injection'
    ) {
      return createTextResponse('已处理排队消息，已完成')
    }

    if (this.mode === 'pre-closure') {
      return createTextResponse(INITIAL_REPLY)
    }

    return createTextResponse(INITIAL_REPLY)
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream not supported in test'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class AppliedQueuedIntentAdapter implements ProviderAdapter {
  readonly apiType = 'fake-applied-queued-intent'
  lastClassifierPrompt = ''
  normalCalls = 0
  classifierCalls = 0

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (isTaskClosureClassifierRequest(request)) {
      this.classifierCalls++
      this.lastClassifierPrompt = getTextFromRequest(request)
      return createTextResponse(
        '{"action":"finish","reason":"当前回复应直接结束"}',
        'classifier reasoning for finish',
      )
    }

    this.normalCalls++
    const lastUserMessage = getLastUserMessage(request)
    if (
      lastUserMessage?.content.some(
        (block) => block.type === 'text' && block.text.includes('<queued_message>'),
      )
    ) {
      return createTextResponse('已吸收补充约束，任务已完成')
    }

    return createToolResponse('resp_tool_1', 'call_noop_1')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream not supported in test'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workDir: process.cwd(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  }
}

function createContext(registry: ToolRegistry): AgentContext {
  return {
    systemPrompt: 'Test prompt',
    conversationHistory: [],
    tools: registry.getDefinitions(),
  }
}

describe('Agent task closure gate', () => {
  test('uses closure adapter for task closure classifier requests when provided', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const closureAdapter = new TaskClosureAdapter('finish')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      {},
      closureAdapter,
    )

    const messages = await agent.run(createContext(registry), '帮我看看这帖值不值得信')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(getTextFromMessage(assistantMessages[0])).toContain('如果你愿意')
    expect(adapter.normalCalls).toBe(1)
    expect(adapter.classifierCalls).toBe(0)
    expect(closureAdapter.normalCalls).toBe(0)
    expect(closureAdapter.classifierCalls).toBe(1)
  })

  test('continues automatically when classifier marks optional tail as required work', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '帮我看看这帖值不值得信')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const controlMessages = messages.filter((message) => message.messageType === 'control')

    expect(assistantMessages).toHaveLength(2)
    expect(getTextFromMessage(assistantMessages[0])).toBe(INITIAL_REPLY)
    expect(getTextFromMessage(assistantMessages[1])).toBe(CONTINUED_REPLY)
    expect(controlMessages).toHaveLength(1)
    expect(controlMessages[0]).toMatchObject({
      messageType: 'control',
      controlKind: 'task_closure',
    })
    expect(adapter.normalCalls).toBe(2)
    expect(adapter.classifierCalls).toBe(2)
  })

  test('injects classifier reason into the continuation prompt', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
    )

    await agent.run(createContext(registry), '帮我看看这帖值不值得信')

    expect(adapter.lastTaskClosurePrompt).toContain(
      '<classifier_reason>后续核验仍属于当前任务</classifier_reason>',
    )
  })

  test('marks task closure continuation messages with control metadata', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '帮我看看这帖值不值得信')
    const controlMessage = messages.find((message) => message.controlKind === 'task_closure')

    expect(controlMessage).toBeDefined()
    expect(controlMessage).toMatchObject({
      role: 'user',
      messageType: 'control',
      controlKind: 'task_closure',
      content: [{ type: 'text', text: buildTaskClosurePrompt('后续核验仍属于当前任务') }],
    })
  })

  test('does not auto-continue when user explicitly asks for next-step options', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('finish')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '先给我几个下一步选项')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(getTextFromMessage(assistantMessages[0])).toContain('如果你愿意')
    expect(adapter.normalCalls).toBe(1)
    expect(adapter.classifierCalls).toBe(1)
  })

  test('does not auto-continue when classifier reports a real blocker', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('block')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '继续把线上证据查完')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(getTextFromMessage(assistantMessages[0])).toBe(BLOCK_REPLY)
    expect(adapter.normalCalls).toBe(1)
    expect(adapter.classifierCalls).toBe(1)
  })

  test('fails closed when classifier returns malformed JSON', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('malformed')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '帮我继续核验')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(getTextFromMessage(assistantMessages[0])).toContain('如果你愿意')
    expect(adapter.normalCalls).toBe(1)
    expect(adapter.classifierCalls).toBe(1)
  })

  test('records task closure decisions in tracer metadata', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '帮我看看这帖值不值得信')

    const taskClosureSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'task_closure_decision')

    expect(taskClosureSpan).toBeDefined()
    expect(taskClosureSpan?.metadata?.called).toBe(true)
    expect(taskClosureSpan?.metadata?.action).toBe('continue')
    expect(taskClosureSpan?.metadata?.classifierRequest).toEqual({
      system: expect.stringContaining('严格的任务收尾判定器'),
      prompt: expect.stringContaining('帮我看看这帖值不值得信'),
      maxTokens: 200,
    })
  })

  test('emits task closure session events with the trace span id', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const tracer = new Tracer()
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = []
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      {
        tracer,
        bus: {
          emit(topic, data) {
            emitted.push({ topic, data })
          },
        },
      },
    )

    await agent.run(createContext(registry), '帮我看看这帖值不值得信')

    const closureSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'task_closure_decision')

    const closureEvent = emitted.find(
      (entry) => entry.topic === 'session:update' && entry.data.event === 'task_closure_decision',
    )

    expect(closureSpan).toBeDefined()
    expect(closureEvent).toBeDefined()
    expect(closureEvent?.data.spanId).toBe(closureSpan?.id)
    expect(closureEvent?.data.sessionId).toBe('test-session')
  })

  test('passes explicit system prompt into the classifier request', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('finish')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    await agent.run(createContext(registry), '先给我几个下一步选项')
    expect(adapter.lastClassifierSystem).toContain('严格的任务收尾判定器')
  })

  test('passes research-depth context into the classifier prompt', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    await agent.run(
      createContext(registry),
      '看看 https://example.com 这个内容, 然后把可能相关的信息也分析下, 尽可能深入',
    )

    expect(adapter.lastClassifierPrompt).toContain('研究/分析类任务额外规则')
    expect(adapter.lastClassifierPrompt).toContain(
      '<tool_calls_this_turn>\nnone\n</tool_calls_this_turn>',
    )
    expect(adapter.lastClassifierPrompt).not.toContain('<task_context>')
  })

  test('fails closed when classifier request throws', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('throw')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '帮我继续核验')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(getTextFromMessage(assistantMessages[0])).toContain('如果你愿意')
    expect(adapter.normalCalls).toBe(1)
    expect(adapter.classifierCalls).toBe(1)
  })

  test('persists the new task closure decision schema in trace data', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '帮我看看这帖值不值得信')

    const closureSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'task_closure_decision')

    expect(closureSpan?.data).toMatchObject({
      closure: {
        event: 'task_closure_decision',
        action: 'continue',
        reason: '后续核验仍属于当前任务',
        assistantMessageId: expect.any(String),
        assistantMessageCreatedAt: expect.any(String),
        classifierResponse: {
          id: 'resp_test',
          model: 'fake-model',
          stopReason: 'end_turn',
          usage: { input: 8, output: 8 },
          reasoningContent: 'classifier reasoning for continue',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'continue',
                reason: '后续核验仍属于当前任务',
              }),
            },
          ],
        },
        classifierRequest: {
          system: expect.stringContaining('严格的任务收尾判定器'),
          prompt: expect.stringContaining('<assistant_tail>'),
          maxTokens: 200,
        },
      },
    })
  })

  test('persists invalid classifier output as task_closure_failed in trace data', async () => {
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('malformed')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '帮我继续核验')

    const closureSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'task_closure_failed')

    expect(closureSpan?.data).toMatchObject({
      closure: {
        event: 'task_closure_failed',
        reason: 'invalid_classifier_output',
        failureStage: 'parse_classifier_response',
        assistantMessageId: expect.any(String),
        assistantMessageCreatedAt: expect.any(String),
        classifierResponse: {
          id: 'resp_test',
          model: 'fake-model',
          stopReason: 'end_turn',
          usage: { input: 8, output: 8 },
          reasoningContent: 'classifier reasoning before malformed output',
          content: [{ type: 'text', text: 'not-json' }],
        },
        classifierRequest: {
          system: expect.stringContaining('严格的任务收尾判定器'),
          prompt: expect.stringContaining('<assistant_tail>'),
          maxTokens: 200,
        },
        classifierResponseRaw: 'not-json',
      },
    })
  })

  test('uses trace-only session writes when tracer is file-backed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-completion-gate-'))
    tempDirs.push(dir)
    const observability = new ObservabilityStore(dir)
    const tracer = new Tracer(dir)
    const registry = new ToolRegistry()
    const adapter = new TaskClosureAdapter('continue')
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '帮我看看这帖值不值得信')

    const sessionDir = join(dir, 'sessions', 'test-session')
    expect(existsSync(join(sessionDir, 'trace.jsonl'))).toBe(true)
    expect(existsSync(join(sessionDir, 'requests.jsonl'))).toBe(false)
    expect(existsSync(join(sessionDir, 'closure.jsonl'))).toBe(false)
    expect(observability.readSessionRequests('test-session')).toHaveLength(2)
    expect(observability.readSessionClosures('test-session')).toHaveLength(2)
  })

  test('drains pending queue before control flow and emits a queued_injection continuation', async () => {
    const registry = new ToolRegistry()
    const adapter = new QueueGateAdapter('pre-closure')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    let drained = false
    const queuedMessages: QueuedMessage[] = [
      {
        content: '往前再推一个小时有 OOM 吗',
        timestamp: '2026-03-30T05:55:32.137Z',
      },
    ]

    const messages = await agent.run(
      createContext(registry),
      '先看这个会话',
      undefined,
      undefined,
      undefined,
      () => !drained,
      () => {
        drained = true
        return queuedMessages
      },
    )

    const drainSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'queue_gate_drain')
    const firstControl = messages.find((message) => message.messageType === 'control')

    expect(firstControl?.controlKind).toBe('queued_injection')
    expect(messages.some((message) => message.controlKind === 'queued_injection')).toBe(true)
    expect(drainSpan?.metadata).toMatchObject({
      phase: 'pre_closure',
      queueCount: 1,
      wasDuringNudge: false,
    })
  })

  test('drains pending queue before task_closure retry when classifier returns continue', async () => {
    const registry = new ToolRegistry()
    const adapter = new QueueGateAdapter('pre-closure')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    let interruptChecks = 0
    let drained = false
    const messages = await agent.run(
      createContext(registry),
      '帮我继续核验',
      undefined,
      undefined,
      undefined,
      () => {
        interruptChecks += 1
        return interruptChecks === 3 && !drained
      },
      () => {
        drained = true
        return [{ content: '追加一个边界条件', timestamp: '2026-03-30T06:01:00.000Z' }]
      },
    )

    const drainSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'queue_gate_drain' && span.metadata?.phase === 'pre_task_closure_retry')
    const firstQueuedInjectionIndex = messages.findIndex(
      (message) => message.controlKind === 'queued_injection',
    )
    const firstTaskClosureIndex = messages.findIndex(
      (message) => message.controlKind === 'task_closure',
    )

    expect(adapter.classifierCalls).toBeGreaterThanOrEqual(1)
    expect(firstQueuedInjectionIndex).toBeGreaterThanOrEqual(0)
    expect(firstTaskClosureIndex).toBeGreaterThan(firstQueuedInjectionIndex)
    expect(drainSpan?.metadata).toMatchObject({
      phase: 'pre_task_closure_retry',
      queueCount: 1,
      wasDuringNudge: false,
    })
  })

  test('discards classifier result when a queued message arrives during classifier evaluation', async () => {
    const registry = new ToolRegistry()
    let shouldInterrupt = false
    let drained = false
    const adapter = new QueueGateAdapter('post-classifier', () => {
      shouldInterrupt = true
    })
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(
      createContext(registry),
      '帮我继续核验',
      undefined,
      undefined,
      undefined,
      () => shouldInterrupt && !drained,
      () => {
        drained = true
        shouldInterrupt = false
        return [{ content: '追加一个限制条件', timestamp: '2026-03-30T05:56:48.319Z' }]
      },
    )

    const spans = tracer.exportSession('test-session').flatMap(flattenTraceSpans)
    const discardedClosureSpan = spans.find(
      (span) =>
        span.name === 'task_closure_decision' && span.metadata?.discardedDuePendingQueue === true,
    )
    const drainSpan = spans.find(
      (span) => span.name === 'queue_gate_drain' && span.metadata?.phase === 'post_classifier',
    )
    expect(discardedClosureSpan?.status).toBe('success')
    expect(discardedClosureSpan?.metadata).toMatchObject({
      discardedDuePendingQueue: true,
      originalAction: 'continue',
      originalReason: '后续核验仍属于当前任务',
    })
    expect(drainSpan?.metadata).toMatchObject({
      phase: 'post_classifier',
      queueCount: 1,
    })
    expect(messages.some((message) => message.controlKind === 'queued_injection')).toBe(true)
  })

  test('passes applied queued intent text into the classifier after tool-result queue injection', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new AppliedQueuedIntentAdapter()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
    )

    let drained = false
    await agent.run(
      createContext(registry),
      '先把主结论核验掉',
      undefined,
      undefined,
      undefined,
      () => false,
      () => {
        if (drained) return []
        drained = true
        return [{ content: '顺便核验 changelog', timestamp: '2026-03-30T05:55:32.137Z' }]
      },
    )

    expect(adapter.classifierCalls).toBe(1)
    expect(adapter.lastClassifierPrompt).toContain('<applied_queued_messages>')
    expect(adapter.lastClassifierPrompt).toContain('顺便核验 changelog')
    expect(adapter.lastClassifierPrompt).not.toContain('<queued_message>')
  })

  test('nudges for memory after a substantive turn with no prior memory tool call', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new MemoryNudgeAdapter('skip')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(createContext(registry), '完成一个需要先查再总结的任务')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(assistantMessages).toHaveLength(3)
    expect(getTextFromMessage(assistantMessages[1])).toBe('这轮工作已经完成')
    expect(getTextFromMessage(assistantMessages[2])).toBe('无需记忆')
    expect(adapter.nudgeCalls).toBe(1)
    expect(memoryNudgeSpan?.data).toMatchObject({
      memoryNudge: {
        prompt: MEMORY_NUDGE_PROMPT,
        iteration: 2,
      },
    })
    expect(memoryNudgeSpan?.metadata).toMatchObject({
      purpose: 'memory_nudge',
      iteration: 2,
      memoryWritten: false,
    })
  })

  test('treats an empty memory nudge response as a normal end of turn', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new MemoryNudgeAdapter('empty-on-nudge')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(createContext(registry), '完成一个需要先查再总结的任务')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(assistantMessages).toHaveLength(2)
    expect(getTextFromMessage(assistantMessages[1])).toBe('这轮工作已经完成')
    expect(adapter.nudgeCalls).toBe(1)
    expect(memoryNudgeSpan?.status).toBe('success')
    expect(memoryNudgeSpan?.metadata).toMatchObject({
      purpose: 'memory_nudge',
      memoryWritten: false,
    })
  })

  test('drains queue instead of breaking when memory_nudge returns an empty response', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new MemoryNudgeAdapter('empty-on-nudge')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    let drained = false
    const messages = await agent.run(
      createContext(registry),
      '完成一个需要先查再总结的任务',
      undefined,
      undefined,
      undefined,
      () => adapter.nudgeCalls > 0 && !drained,
      () => {
        drained = true
        return [{ content: '往前再推一个小时有 OOM 吗', timestamp: '2026-03-30T05:55:32.137Z' }]
      },
    )

    expect(adapter.nudgeCalls).toBe(1)
    expect(adapter.normalCalls).toBeGreaterThan(3)
    expect(messages.some((message) => getTextFromMessage(message) === '这轮工作已经完成')).toBe(true)
  })

  test('drains pending queue before memory_nudge starts', async () => {
    const registry = new ToolRegistry()
    const adapter = new MemoryNudgeAdapter('skip')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    let interruptChecks = 0
    let drained = false
    const hooks = (
      agent as unknown as {
        createHooks: (options: {
          context: AgentContext
          userMessage: string
          onNewMessage?: (msg: Message) => void
          onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
          shouldInterrupt?: () => boolean
          getQueuedMessages?: () => QueuedMessage[]
          turnIndex: number
          rootSpanId?: string
          system: string
          executionState: {
            currentRequestId?: string
            currentTraceSpanId?: string
          }
        }) => ReturnType<Agent['createHooks']>
      }
    ).createHooks({
      context: createContext(registry),
      userMessage: '完成一个需要先查再总结的任务',
      shouldInterrupt: () => {
        interruptChecks += 1
        return interruptChecks === 3 && !drained
      },
      getQueuedMessages: () => {
        drained = true
        return [{ content: '顺便核验更早一小时的窗口', timestamp: '2026-03-30T06:02:00.000Z' }]
      },
      turnIndex: 1,
      system: 'Test prompt',
      executionState: {},
    })

    const assistantMessage: Message = {
      id: 'msg_assistant_done',
      sessionId: 'test-session',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'text', text: '这轮工作已经完成' }],
      createdAt: '2026-03-30T06:03:00.000Z',
    }

    const decision = await hooks.onEndTurn?.(createTextResponse('这轮工作已经完成'), {
      messages: [assistantMessage],
      newMessages: [],
      iteration: 2,
      userMessage: '完成一个需要先查再总结的任务',
      state: {},
    })

    const drainSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'queue_gate_drain' && span.metadata?.phase === 'pre_memory_nudge')

    expect(decision).toMatchObject({
      action: 'continue',
      continuationMessage: {
        controlKind: 'queued_injection',
      },
    })
    expect(drainSpan?.metadata).toMatchObject({
      phase: 'pre_memory_nudge',
      queueCount: 1,
      wasDuringNudge: false,
    })
  })

  test('marks memory_nudge trace as written when the nudge leads to memory.create', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    registry.register(new MemoryToolStub())
    const adapter = new MemoryNudgeAdapter('write-on-nudge')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '完成一个需要先查再总结的任务')

    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(adapter.nudgeCalls).toBe(1)
    expect(memoryNudgeSpan?.metadata).toMatchObject({
      purpose: 'memory_nudge',
      memoryWritten: true,
    })
  })

  test('skips task closure evaluation after a memory nudge continuation', async () => {
    const registry = new ToolRegistry()
    const adapter = new MemoryNudgeAdapter('continue-after-nudge')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(
      createContext(registry),
      '先给这个结论做完整核验, 然后再收尾',
    )
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const taskClosureSpans = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .filter((span) => span.name === 'task_closure_decision')
    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(assistantMessages).toHaveLength(3)
    expect(adapter.normalCalls).toBe(3)
    expect(adapter.classifierCalls).toBe(2)
    expect(taskClosureSpans).toHaveLength(2)
    expect(memoryNudgeSpan).toBeDefined()
  })

  test('does not nudge again when memory was already written earlier in the turn', async () => {
    const registry = new ToolRegistry()
    registry.register(new MemoryToolStub())
    const adapter = new MemoryNudgeAdapter('already-written')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '先记下这次决策, 再结束')

    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(adapter.nudgeCalls).toBe(0)
    expect(memoryNudgeSpan).toBeUndefined()
  })

  test('still nudges after a non-write memory action like delete', async () => {
    const registry = new ToolRegistry()
    registry.register(new MemoryToolStub())
    const adapter = new MemoryNudgeAdapter('delete-before-finish')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(createContext(registry), '先清理旧记忆, 再结束')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(assistantMessages).toHaveLength(3)
    expect(adapter.nudgeCalls).toBe(1)
    expect(memoryNudgeSpan?.metadata).toMatchObject({
      purpose: 'memory_nudge',
      memoryWritten: false,
    })
  })

  test('keeps memory_nudge trace as not written when memory.create fails', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    registry.register(new FailingMemoryToolStub())
    const adapter = new MemoryNudgeAdapter('write-fails-on-nudge')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    await agent.run(createContext(registry), '完成一个需要先查再总结的任务')

    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(adapter.nudgeCalls).toBe(1)
    expect(memoryNudgeSpan?.metadata).toMatchObject({
      purpose: 'memory_nudge',
      memoryWritten: false,
    })
  })

  test('does not nudge in minimal prompt mode', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new MemoryNudgeAdapter('skip')
    const tracer = new Tracer()
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt', promptMode: 'minimal' },
      adapter,
      registry,
      createToolContext(),
      { tracer },
    )

    const messages = await agent.run(createContext(registry), '完成一个需要先查再总结的任务')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')
    const memoryNudgeSpan = tracer
      .exportSession('test-session')
      .flatMap(flattenTraceSpans)
      .find((span) => span.name === 'memory_nudge')

    expect(assistantMessages).toHaveLength(2)
    expect(adapter.nudgeCalls).toBe(0)
    expect(memoryNudgeSpan).toBeUndefined()
  })
})

function flattenTraceSpans<T extends { children?: T[] }>(span: T): T[] {
  return [span, ...(span.children ?? []).flatMap(flattenTraceSpans)]
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
