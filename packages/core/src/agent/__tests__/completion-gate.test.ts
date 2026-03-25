import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { ObservabilityStore, Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  ToolContext,
} from '@zero-os/shared'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'
import { TASK_CLOSURE_PROMPT } from '../task-closure'

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

function getLastUserText(request: CompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]
    if (message.role === 'user') return getTextFromMessage(message)
  }
  return ''
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

    const lastUserText = getLastUserText(request)
    if (lastUserText.includes(TASK_CLOSURE_PROMPT)) {
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

function createToolContext(): ToolContext {
  return {
    sessionId: 'test-session',
    workDir: process.cwd(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
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
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      createToolContext(),
    )

    const messages = await agent.run(createContext(registry), '帮我看看这帖值不值得信')
    const assistantMessages = messages.filter((message) => message.role === 'assistant')

    expect(assistantMessages).toHaveLength(2)
    expect(getTextFromMessage(assistantMessages[0])).toBe(INITIAL_REPLY)
    expect(getTextFromMessage(assistantMessages[1])).toBe(CONTINUED_REPLY)
    expect(adapter.normalCalls).toBe(2)
    expect(adapter.classifierCalls).toBe(2)
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
      { name: 'test-agent', agentInstruction: 'Test prompt' },
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
})

function flattenTraceSpans<T extends { children?: T[] }>(span: T): T[] {
  return [span, ...(span.children ?? []).flatMap(flattenTraceSpans)]
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
