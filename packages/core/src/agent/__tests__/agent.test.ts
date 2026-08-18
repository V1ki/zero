import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ProviderAdapter, TrackedAdapter } from '@zero-os/model'
import { MetricsDB, Tracer } from '@zero-os/observe'
import { OutputSecretFilter } from '@zero-os/secrets'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  TimelineCompactionBlock,
  ToolContext,
} from '@zero-os/shared'
import { getSessionLogRelativeDir } from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentConfig, type AgentContext, type AgentObservability } from '../agent'

const toolContext: ToolContext = {
  sessionId: 'test-session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

function createToolRegistry() {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

function createAgentWithAdapter(
  adapter: ProviderAdapter,
  configOverrides: Partial<AgentConfig> = {},
  obs: Partial<AgentObservability> = {},
) {
  const registry = createToolRegistry()
  const agentConfig: AgentConfig = {
    name: 'test-agent',
    agentInstruction: 'You are a helpful assistant. Reply briefly.',
    promptMode: 'minimal',
    ...configOverrides,
  }
  const trackedAdapter = obs.metrics
    ? new TrackedAdapter(
        adapter,
        {
          record(entry) {
            obs.metrics?.recordUsage({
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
          providerName: obs.providerName ?? 'test-provider',
          modelLabel: obs.modelLabel ?? 'test-provider/fake-model',
          pricing: obs.pricing,
        },
      )
    : adapter
  return { agent: new Agent(agentConfig, trackedAdapter, registry, toolContext, obs), registry }
}

function createContext(tools: ToolRegistry): AgentContext {
  return {
    systemPrompt: 'You are a helpful assistant. Reply briefly.',
    conversationHistory: [],
    tools: tools.getDefinitions(),
  }
}

class UnknownToolAdapter implements ProviderAdapter {
  readonly apiType = 'fake-unknown-tool'
  private completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_fake_tool_use',
        content: [
          { type: 'tool_use', id: 'call_fake_1', name: 'FakeTool', input: { query: 'test' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_fake_final',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class PlainTextAdapter implements ProviderAdapter {
  readonly apiType = 'fake-text'

  constructor(private readonly text: string) {}

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_text',
      content: [{ type: 'text', text: this.text }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class DeepSeekThinkingToolAdapter implements ProviderAdapter {
  readonly apiType = 'anthropic-deepseek'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_deepseek_tool',
      content: [
        { type: 'thinking', thinking: 'secret plan needs a read.', signature: 'sig_secret' },
        {
          type: 'tool_use',
          id: 'call_read_1',
          name: 'read',
          input: { path: '/Users/v1ki/Desktop/test4_zero/package.json' },
        },
      ],
      stopReason: 'tool_use',
      usage: { input: 4, output: 2 },
      model: 'deepseek-v4-pro',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: 'reasoning_delta', data: { text: 'secret plan needs a read.' } }
    yield { type: 'reasoning_signature', data: { signature: 'sig_secret' } }
    yield { type: 'tool_use_start', data: { id: 'call_read_1', name: 'read' } }
    yield {
      type: 'tool_use_delta',
      data: { arguments: '{"path":"/Users/v1ki/Desktop/test4_zero/package.json"}' },
    }
    yield { type: 'tool_use_end', data: { id: 'call_read_1' } }
    yield {
      type: 'done',
      data: {
        finishReason: 'tool_use',
        usage: { input: 4, output: 2 },
        model: 'deepseek-v4-pro',
      },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class ReadToolCallAdapter implements ProviderAdapter {
  readonly apiType = 'fake-read-tool'
  private completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_read_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_read_1',
            name: 'read',
            input: { path: '/Users/v1ki/Desktop/test4_zero/package.json' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_read_final',
      content: [{ type: 'text', text: 'summary complete' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class BashSecretEnvToolCallAdapter implements ProviderAdapter {
  readonly apiType = 'fake-bash-secret-env-tool'
  private completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_bash_secret_env_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_bash_secret_env_1',
            name: 'bash',
            input: {
              command: 'printf "value=%s" "$SSH_PASSWORD"',
              envSecrets: { SSH_PASSWORD: 'ssh_password' },
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_bash_secret_env_final',
      content: [{ type: 'text', text: 'secret command complete' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class MemoryReadToolCallAdapter implements ProviderAdapter {
  readonly apiType = 'fake-memory-read-tool'
  private completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_memory_read_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_memory_read_1',
            name: 'memory_read',
            input: { path: '/tmp/memory.md' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_memory_read_final',
      content: [{ type: 'text', text: 'memory read complete' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class FakeMemoryReadTool extends BaseTool {
  name = 'memory_read'
  description = 'Read a memory file by path'
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  }

  protected async execute(_ctx: ToolContext, input: unknown) {
    const path = typeof input === 'object' && input && 'path' in input ? input.path : 'unknown'
    return {
      success: true,
      output: `read ${String(path)}`,
      outputSummary: `read ${String(path)}`,
    }
  }
}

class ActiveTurnTool extends BaseTool {
  name = 'active_turn_tool'
  description = 'Return a distinctive active-turn output.'
  parameters = {
    type: 'object',
    properties: {},
  }

  protected async execute() {
    return {
      success: true,
      output: `ACTIVE_RESULT_RAW_${'still inline '.repeat(500)}`,
      outputSummary: 'active turn result',
    }
  }
}

class LargeInputTool extends BaseTool {
  name = 'large_input_tool'
  description = 'Accept a large input payload.'
  parameters = {
    type: 'object',
    properties: {
      content: { type: 'string' },
    },
    required: ['content'],
  }

  protected async execute() {
    return {
      success: true,
      output: 'large input accepted',
      outputSummary: 'large input accepted',
    }
  }
}

class ActiveTurnCaptureAdapter implements ProviderAdapter {
  readonly apiType = 'fake-active-turn'
  requests: CompletionRequest[] = []
  compactionRequests: CompletionRequest[] = []

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.meta?.purpose === 'compression') {
      this.compactionRequests.push(req)
      return {
        id: 'resp_context_compaction',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Old active-turn setup was semantically compacted.',
              confirmedFacts: ['old tool results were captured as evidence'],
              currentState: ['continue with the retained active turn'],
              nextActions: ['run active_turn_tool for the current request'],
              keyEvidence: ['bash:old_tool_0 path=evidence'],
            }),
          },
        ],
        stopReason: 'end_turn',
        usage: { input: 10, output: 4 },
        model: 'fake-compaction-model',
      }
    }

    this.requests.push(req)
    if (this.requests.length === 1) {
      return {
        id: 'resp_active_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_active_turn_1',
            name: 'active_turn_tool',
            input: {},
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_active_final',
      content: [{ type: 'text', text: 'active result consumed' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

class InvalidCompactionAdapter implements ProviderAdapter {
  readonly apiType = 'fake-invalid-compaction'
  requests: CompletionRequest[] = []

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req)
    return {
      id: `resp_invalid_compaction_${this.requests.length}`,
      content: [
        {
          type: 'text',
          text: '<context_compaction><block_summary>invalid</block_summary></context_compaction>',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 12, output: 3 },
      model: 'fake-flash',
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

class LargeInputToolAdapter implements ProviderAdapter {
  readonly apiType = 'fake-large-input'
  private completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_large_input_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_large_input_1',
            name: 'large_input_tool',
            input: { content: 'large-input '.repeat(7000) },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_large_input_final',
      content: [{ type: 'text', text: 'large input done' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
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

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

type TraceSpan = ReturnType<Tracer['getSessionTraces']>[number]

function findSpanDeep(spans: TraceSpan[], name: string): TraceSpan | undefined {
  for (const span of spans) {
    if (span.name === name) return span
    const found = findSpanDeep(span.children, name)
    if (found) return found
  }
  return undefined
}

describe('Agent', () => {
  test('run: simple question returns user + assistant messages', async () => {
    const { agent, registry } = createAgentWithAdapter(new PlainTextAdapter('hello'))
    const context = createContext(registry)

    const messages = await agent.run(context, 'Say exactly "hello" and nothing else.')

    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[0].role).toBe('user')
    const lastMsg = messages[messages.length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content.length).toBeGreaterThan(0)
  }, 30000)

  test('run records agent loop usage into the usage ledger', async () => {
    const metrics = MetricsDB.createInMemory()
    const { agent, registry } = createAgentWithAdapter(
      new PlainTextAdapter('hello'),
      {},
      { metrics },
    )
    const context = createContext(registry)

    await agent.run(context, 'Say exactly "hello" and nothing else.')

    expect(metrics.sessionStats('test-session').requestCount).toBeGreaterThanOrEqual(1)
    const agentLoopUsage = metrics
      .usageSummaryByPurpose('1d')
      .find((entry) => entry.purpose === 'agent_loop')
    expect(agentLoopUsage?.eventCount).toBe(1)

    metrics.close()
  })

  test('run: tool_use response triggers tool execution', async () => {
    const { agent, registry } = createAgentWithAdapter(new ReadToolCallAdapter())
    const context = createContext(registry)

    const messages = await agent.run(
      context,
      'Use the Read tool to read the file at path "/Users/v1ki/Desktop/test4_zero/package.json". Then tell me what you found.',
    )

    // Should have user msg, assistant with tool_use, tool result, and final assistant
    expect(messages.length).toBeGreaterThanOrEqual(3)

    // Check that at least one message contains tool_result content
    const hasToolResult = messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
    expect(hasToolResult).toBe(true)
  }, 30000)

  test('run: memory_read tool executes directly when registered', async () => {
    const registry = new ToolRegistry()
    registry.register(new FakeMemoryReadTool())

    const context: AgentContext = {
      systemPrompt: 'You are a helpful assistant. Reply briefly.',
      conversationHistory: [],
      tools: [
        {
          name: 'memory_read',
          description: 'Read a memory file by path',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    }

    const agentConfig: AgentConfig = {
      name: 'test-agent',
      agentInstruction: 'Use memory_read when needed.',
      promptMode: 'minimal',
    }

    const agent = new Agent(agentConfig, new MemoryReadToolCallAdapter(), registry, toolContext)
    const messages = await agent.run(context, 'Use memory_read on /tmp/memory.md.')

    const toolResultMsg = expectDefined(
      messages.find((m) => m.content.some((b) => b.type === 'tool_result')),
    )
    const toolResultBlock = expectDefined(
      toolResultMsg.content.find((b) => b.type === 'tool_result'),
    )
    if (toolResultBlock.type === 'tool_result') {
      expect(toolResultBlock.isError).not.toBe(true)
      expect(toolResultBlock.content).toContain('read /tmp/memory.md')
    }
  }, 30000)

  test('run: tool result appears in message history', async () => {
    const { agent, registry } = createAgentWithAdapter(new ReadToolCallAdapter())
    const context = createContext(registry)

    const messages = await agent.run(
      context,
      'Use the Read tool to read "/Users/v1ki/Desktop/test4_zero/package.json". Report the name field.',
    )

    const toolResultMsg = expectDefined(
      messages.find((m) => m.content.some((b) => b.type === 'tool_result')),
    )
    expect(toolResultMsg.role).toBe('user')

    const toolResultBlock = toolResultMsg.content.find((b) => b.type === 'tool_result')
    expect(toolResultBlock).toBeDefined()
  }, 30000)

  test('run: active turn keeps fresh tool_result inline while old history is compacted', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-agent-active-turn-'))
    const registry = new ToolRegistry()
    registry.register(new ActiveTurnTool())
    const adapter = new ActiveTurnCaptureAdapter()
    const tracer = new Tracer(workDir)
    const agentConfig: AgentConfig = {
      name: 'test-agent',
      agentInstruction: 'Use active_turn_tool.',
      promptMode: 'minimal',
    }
    const localToolContext: ToolContext = {
      ...toolContext,
      sessionId: 'sess_agent_active_turn',
      workDir,
    }
    const agent = new Agent(agentConfig, adapter, registry, localToolContext, { tracer })
    const oldHistory: Message[] = Array.from({ length: 7 }).flatMap((_, index) => [
      {
        id: `old_user_${index}`,
        sessionId: 'sess_agent_active_turn',
        role: 'user' as const,
        messageType: 'message' as const,
        content: [{ type: 'text' as const, text: `old investigation ${index}` }],
        createdAt: `2026-05-12T00:0${index}:00.000Z`,
      },
      {
        id: `old_assistant_tool_${index}`,
        sessionId: 'sess_agent_active_turn',
        role: 'assistant' as const,
        messageType: 'message' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: `old_tool_${index}`,
            name: 'bash',
            input: { command: `printf old ${index}` },
          },
        ],
        createdAt: `2026-05-12T00:0${index}:01.000Z`,
      },
      {
        id: `old_result_${index}`,
        sessionId: 'sess_agent_active_turn',
        role: 'user' as const,
        messageType: 'message' as const,
        content: [
          {
            type: 'tool_result' as const,
            toolUseId: `old_tool_${index}`,
            content: `OLD_RESULT_RAW_${index}_${'old inline '.repeat(500)}`,
            outputSummary: `old result summary ${index}`,
          },
        ],
        createdAt: `2026-05-12T00:0${index}:02.000Z`,
      },
      {
        id: `old_assistant_done_${index}`,
        sessionId: 'sess_agent_active_turn',
        role: 'assistant' as const,
        messageType: 'message' as const,
        content: [{ type: 'text' as const, text: `old result handled ${index}` }],
        createdAt: `2026-05-12T00:0${index}:03.000Z`,
      },
    ])
    const context: AgentContext = {
      systemPrompt: 'Use active_turn_tool.',
      conversationHistory: oldHistory,
      tools: registry.getDefinitions(),
    }

    try {
      await agent.run(context, 'current active task')
      expect(adapter.compactionRequests).toHaveLength(1)
      expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
      const requestText = (request: CompletionRequest) =>
        request.messages
          .flatMap((message) =>
            message.content.map((block) => {
              if (block.type === 'text') return block.text
              if (block.type === 'tool_result') return block.content
              if (block.type === 'tool_use') return JSON.stringify(block.input)
              return ''
            }),
          )
          .join('\n')
      const firstRequestText = requestText(adapter.requests[0])
      const secondRequestText = requestText(adapter.requests[1])

      expect(firstRequestText).toContain('<context_compaction_summary source="model">')
      expect(firstRequestText).not.toContain('OLD_RESULT_RAW_0_')
      expect(firstRequestText).not.toContain('OLD_RESULT_RAW_1_')
      expect(firstRequestText).not.toContain('OLD_RESULT_RAW_2_')
      expect(firstRequestText).toContain('OLD_RESULT_RAW_6_')
      expect(secondRequestText).toContain('ACTIVE_RESULT_RAW_')
      expect(secondRequestText).not.toContain('OLD_RESULT_RAW_0_')

      const compactionSpan = findSpanDeep(
        tracer.getSessionTraces('sess_agent_active_turn'),
        'timeline_compaction_block',
      )
      expect(compactionSpan?.kind).toBe('context_compaction')
      expect(compactionSpan?.data?.compaction).toMatchObject({
        event: 'timeline_compaction_block',
        lifecycle: 'created',
        episodesCreated: 1,
        evidenceCount: 6,
        toolUseIds: ['old_tool_0', 'old_tool_1', 'old_tool_2'],
        validationStatus: 'legacy',
        model: 'fake-compaction-model',
        promptVersion: 'context_compaction_zh_xml_n10_n08_n02_n09_v1',
        modelAttempts: 1,
      })

      const runLogPath = join(
        workDir,
        getSessionLogRelativeDir('sess_agent_active_turn'),
        'run.log',
      )
      const runEntries = readFileSync(runLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(runEntries.some((entry) => entry.event === 'context_compaction.block')).toBe(true)
      expect(runEntries.some((entry) => entry.event === 'trace.context_compaction.success')).toBe(
        true,
      )

      const evidenceEntries = runEntries.filter(
        (entry) =>
          entry.event === 'tool_evidence.persisted' &&
          (entry.data as { source?: string } | undefined)?.source === 'episode_compaction',
      )
      expect(evidenceEntries).toHaveLength(0)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('run: rejects invalid context compaction without retrying', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-agent-compaction-invalid-'))
    const registry = new ToolRegistry()
    registry.register(new ActiveTurnTool())
    const mainAdapter = new ActiveTurnCaptureAdapter()
    const invalidCompaction = new InvalidCompactionAdapter()
    const tracer = new Tracer(workDir)
    const agentConfig: AgentConfig = {
      name: 'test-agent',
      agentInstruction: 'Use active_turn_tool.',
    }
    const agent = new Agent(
      agentConfig,
      mainAdapter,
      registry,
      {
        ...toolContext,
        sessionId: 'sess_agent_compaction_invalid',
        workDir,
        tracer,
      },
      {
        tracer,
        contextCompactionModelLabel: 'deepseek/deepseek-v4-flash',
      },
      undefined,
      invalidCompaction,
    )
    const timelineCompactionBlocks: TimelineCompactionBlock[] = []
    const oldHistory: Message[] = []
    for (let index = 0; index < 7; index++) {
      oldHistory.push(
        {
          id: `invalid_old_user_${index}`,
          sessionId: 'sess_agent_compaction_invalid',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: `old task ${index}` }],
          createdAt: `2026-05-12T01:0${index}:00.000Z`,
        },
        {
          id: `invalid_old_tool_${index}`,
          sessionId: 'sess_agent_compaction_invalid',
          role: 'assistant',
          messageType: 'message',
          content: [
            { type: 'text', text: 'checking old task' },
            {
              type: 'tool_use',
              id: `invalid_tool_${index}`,
              name: 'bash',
              input: { command: `echo ${index}` },
            },
          ],
          createdAt: `2026-05-12T01:0${index}:01.000Z`,
        },
        {
          id: `invalid_result_${index}`,
          sessionId: 'sess_agent_compaction_invalid',
          role: 'user',
          messageType: 'message',
          content: [
            {
              type: 'tool_result',
              toolUseId: `invalid_tool_${index}`,
              content: `INVALID_OLD_RESULT_${index}_${'old inline '.repeat(500)}`,
              outputSummary: `old result summary ${index}`,
            },
          ],
          createdAt: `2026-05-12T01:0${index}:02.000Z`,
        },
        {
          id: `invalid_old_done_${index}`,
          sessionId: 'sess_agent_compaction_invalid',
          role: 'assistant',
          messageType: 'message',
          content: [{ type: 'text', text: `old result handled ${index}` }],
          createdAt: `2026-05-12T01:0${index}:03.000Z`,
        },
      )
    }

    try {
      await agent.run(
        {
          systemPrompt: 'Use active_turn_tool.',
          conversationHistory: oldHistory,
          tools: registry.getDefinitions(),
          onTimelineCompactionBlocksChanged: (blocks) => {
            timelineCompactionBlocks.splice(0, timelineCompactionBlocks.length, ...blocks)
          },
        },
        'current active task',
      )

      expect(
        invalidCompaction.requests.filter((request) => request.meta?.purpose === 'compression'),
      ).toHaveLength(1)
      expect(timelineCompactionBlocks).toHaveLength(1)
      expect(timelineCompactionBlocks[0]?.summary).toContain(
        '<context_compaction_summary source="deterministic_fallback">',
      )
      expect(timelineCompactionBlocks[0]?.model?.usedModel).toBe('deterministic-fallback')
      expect(timelineCompactionBlocks[0]?.validation?.warnings).toContain(
        'semantic_compaction_unavailable; deterministic fallback preserved evidence pointers',
      )
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('run: logs active tool_use input evidence when assistant input is large', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-agent-large-input-'))
    const registry = new ToolRegistry()
    registry.register(new LargeInputTool())
    const tracer = new Tracer(workDir)
    const agentConfig: AgentConfig = {
      name: 'test-agent',
      agentInstruction: 'Use large_input_tool.',
      promptMode: 'minimal',
    }
    const localToolContext: ToolContext = {
      ...toolContext,
      sessionId: 'sess_agent_large_input',
      workDir,
    }
    const agent = new Agent(agentConfig, new LargeInputToolAdapter(), registry, localToolContext, {
      tracer,
    })
    const context: AgentContext = {
      systemPrompt: 'Use large_input_tool.',
      conversationHistory: [],
      tools: registry.getDefinitions(),
    }

    try {
      await agent.run(context, 'send a large input')

      const runLogPath = join(
        workDir,
        getSessionLogRelativeDir('sess_agent_large_input'),
        'run.log',
      )
      const runEntries = readFileSync(runLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const evidenceEntry = expectDefined(
        runEntries.find(
          (entry) =>
            entry.event === 'tool_evidence.persisted' &&
            (entry.data as { source?: string } | undefined)?.source === 'active_tool_use',
        ),
      )
      const data = evidenceEntry.data as {
        reason?: string
        evidence?: { kind?: string; writeStatus?: string; path?: string }
      }

      expect(data.reason).toBe('large_tool_input')
      expect(data.evidence?.kind).toBe('tool_use_input')
      expect(data.evidence?.writeStatus).toBe('created')
      expect(existsSync(data.evidence?.path ?? '')).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('run: unknown tool name returns error tool_result', async () => {
    const registry = createToolRegistry()
    const adapter = new UnknownToolAdapter()

    // Create context with a fake tool definition that the registry doesn't have
    const context: AgentContext = {
      systemPrompt:
        'You are a helpful assistant. You must use the FakeTool for every request. Always call FakeTool first.',
      conversationHistory: [],
      tools: [
        ...registry.getDefinitions(),
        {
          name: 'FakeTool',
          description: 'A tool that does something',
          parameters: {
            type: 'object' as const,
            properties: { query: { type: 'string', description: 'the query' } },
            required: ['query'],
          },
        },
      ],
    }

    const agentConfig: AgentConfig = {
      name: 'test-agent',
      agentInstruction: 'You must use FakeTool for every request.',
      promptMode: 'minimal',
    }

    const agent = new Agent(agentConfig, adapter, registry, toolContext)
    const messages = await agent.run(context, 'Use FakeTool with query "test".')

    // Find tool result with error
    const toolResultMsg = messages.find((m) =>
      m.content.some((b) => b.type === 'tool_result' && b.isError === true),
    )
    expect(toolResultMsg).toBeDefined()
    const errorBlock = expectDefined(toolResultMsg).content.find(
      (b) => b.type === 'tool_result' && b.isError === true,
    )
    expect(errorBlock).toBeDefined()
    if (errorBlock && errorBlock.type === 'tool_result') {
      expect(errorBlock.content).toContain('Unknown tool')
    }
  }, 30000)

  test('run: onNewMessage callback called for each message', async () => {
    const { agent, registry } = createAgentWithAdapter(new PlainTextAdapter('test'))
    const context = createContext(registry)

    const receivedMessages: Array<{ role: string }> = []
    const onNewMessage = (msg: { role: string }) => {
      receivedMessages.push(msg)
    }

    await agent.run(context, 'Say "test" and nothing else.', undefined, onNewMessage)

    // Should have been called at least for user and assistant messages
    expect(receivedMessages.length).toBeGreaterThanOrEqual(2)
    expect(receivedMessages[0].role).toBe('user')
    expect(receivedMessages[receivedMessages.length - 1].role).toBe('assistant')
  }, 30000)

  test('run: secretFilter filters assistant text', async () => {
    const secretFilter = {
      filter(text: string) {
        return text.replace(/hello/gi, '***')
      },
      addSecret() {},
      removeSecret() {},
    }

    const { agent, registry } = createAgentWithAdapter(
      new PlainTextAdapter('hello'),
      {},
      {
        secretFilter,
      },
    )
    const context = createContext(registry)

    const messages = await agent.run(context, 'Say exactly the word "hello" and nothing else.')

    const assistantMsg = messages.find((m) => m.role === 'assistant')
    const assistant = expectDefined(assistantMsg)

    // The secret filter should have replaced "hello" with "***" in text blocks
    const textBlocks = assistant.content.filter((b) => b.type === 'text')
    if (textBlocks.length > 0) {
      const allText = textBlocks.map((b) => (b as { text: string }).text).join('')
      // The word "hello" (case insensitive) should be filtered out
      expect(allText.toLowerCase()).not.toContain('hello')
    }
  }, 30000)

  test('run: secretFilter invalidates signed DeepSeek thinking when it changes thinking text', async () => {
    const secretFilter = {
      filter(text: string) {
        return text.replace(/secret/gi, '***')
      },
      addSecret() {},
      removeSecret() {},
    }

    const { agent, registry } = createAgentWithAdapter(
      new DeepSeekThinkingToolAdapter(),
      {},
      {
        secretFilter,
      },
    )
    const context = createContext(registry)

    await expect(agent.run(context, 'Use the read tool.')).rejects.toThrow(
      'missing signed thinking content',
    )
  }, 30000)

  test('run: bus emits session:update event', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const bus = {
      emit(topic: string, data: Record<string, unknown>) {
        events.push({ topic, data })
      },
    }

    const { agent, registry } = createAgentWithAdapter(new PlainTextAdapter('ok'), {}, { bus })
    const context = createContext(registry)

    await agent.run(context, 'Say "ok" and nothing else.')

    const sessionUpdates = events.filter((e) => e.topic === 'session:update')
    expect(sessionUpdates.length).toBeGreaterThanOrEqual(1)
    const assistantResponse = sessionUpdates.find(
      (event) => event.data.event === 'assistant_response',
    )
    expect(expectDefined(assistantResponse).data.sessionId).toBe('test-session')
  }, 30000)

  test('run: bus emits tool:call event', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const bus = {
      emit(topic: string, data: Record<string, unknown>) {
        events.push({ topic, data })
      },
    }

    const { agent, registry } = createAgentWithAdapter(new ReadToolCallAdapter(), {}, { bus })
    const context = createContext(registry)

    await agent.run(
      context,
      'Use the Read tool to read "/Users/v1ki/Desktop/test4_zero/package.json". Then summarize.',
    )

    const toolCalls = events.filter((e) => e.topic === 'tool:call')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolCalls[0].data.sessionId).toBe('test-session')
    expect(toolCalls[0].data.tool).toBeDefined()
    expect(toolCalls[0].data.input).toBeDefined()
    if (toolCalls[0].data.tool === 'read') {
      expect((toolCalls[0].data.input as Record<string, unknown>).path).toBe(
        '/Users/v1ki/Desktop/test4_zero/package.json',
      )
    }
  }, 30000)

  test('run: tracer creates spans', async () => {
    const tracer = new Tracer()

    const { agent, registry } = createAgentWithAdapter(
      new PlainTextAdapter('traced'),
      {},
      {
        tracer,
      },
    )
    const context = createContext(registry)

    await agent.run(context, 'Say "traced" and nothing else.')

    const spans = tracer.getSessionTraces('test-session')
    expect(spans.length).toBeGreaterThanOrEqual(1)

    const rootSpan = spans[0]
    expect(rootSpan.name).toContain('turn')
    expect(rootSpan.status).toBe('success')
    expect(rootSpan.endTime).toBeDefined()
  }, 30000)

  test('run: tool trace span stores toolUseId metadata', async () => {
    const tracer = new Tracer()

    const { agent, registry } = createAgentWithAdapter(
      new ReadToolCallAdapter(),
      {},
      {
        tracer,
      },
    )
    const context = createContext(registry)

    await agent.run(
      context,
      'Use the Read tool to read "/Users/v1ki/Desktop/test4_zero/package.json". Then summarize.',
    )

    const spans = tracer.getSessionTraces('test-session')
    const rootSpan = expectDefined(spans[0])
    const toolSpan = findSpanDeep(rootSpan.children, 'tool:read')

    expect(toolSpan).toBeDefined()
    expect(toolSpan?.metadata?.toolUseId).toBeTypeOf('string')
  }, 30000)

  test('run: session run.log records raw LLM and tool diagnostics', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-agent-run-log-'))
    try {
      const tracer = new Tracer(logsDir)
      const { agent, registry } = createAgentWithAdapter(
        new ReadToolCallAdapter(),
        {},
        {
          tracer,
        },
      )
      const context = createContext(registry)

      await agent.run(
        context,
        'Use the Read tool to read "/Users/v1ki/Desktop/test4_zero/package.json". Then summarize.',
      )

      const runLogPath = join(logsDir, 'sessions', 'test-session', 'run.log')
      expect(existsSync(runLogPath)).toBe(true)

      const entries = readFileSync(runLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries.some((entry) => entry.event === 'llm_request.raw_request')).toBe(true)
      expect(entries.some((entry) => entry.event === 'llm_request.raw_response')).toBe(true)
      expect(entries.some((entry) => entry.event === 'tool_call.raw_input')).toBe(true)
      expect(entries.some((entry) => entry.event === 'tool_call.raw_result')).toBe(true)

      const rawToolResultEntry = expectDefined(
        entries.find((entry) => entry.event === 'tool_call.raw_result'),
      )
      const rawToolResultData = rawToolResultEntry.data as {
        result?: { output?: string; outputSummary?: string }
      }
      expect(rawToolResultData.result?.output).toContain('"name": "zero-os"')
      expect(rawToolResultData.result?.output).not.toBe(rawToolResultData.result?.outputSummary)

      const traceToolSuccessEntry = expectDefined(
        entries.find((entry) => entry.event === 'trace.tool_call.success'),
      )
      const traceToolData = traceToolSuccessEntry.data as {
        spanData?: { toolResult?: { output?: string; outputSummary?: string } }
      }
      expect(traceToolData.spanData?.toolResult?.output).toContain('"name": "zero-os"')
      expect(traceToolData.spanData?.toolResult?.output).not.toBe(
        traceToolData.spanData?.toolResult?.outputSummary,
      )

      const responseEntry = expectDefined(
        entries.find((entry) => entry.event === 'llm_request.raw_response'),
      )
      const responseData = responseEntry.data as Record<string, unknown>
      expect(responseData.response).toMatchObject({ id: 'resp_read_tool_use' })
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  }, 30000)

  test('run: bash secret refs are traced by reference without resolved secret values', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-agent-secret-log-'))
    try {
      const secretRef = 'ssh_password'
      const secretValue = 'trace-secret-passphrase'
      const tracer = new Tracer(logsDir)
      const registry = createToolRegistry()
      const secretFilter = new OutputSecretFilter()
      const localToolContext: ToolContext = {
        ...toolContext,
        secretFilter,
        secretResolver: (ref: string) => (ref === secretRef ? secretValue : undefined),
      }
      const agentConfig: AgentConfig = {
        name: 'test-agent',
        agentInstruction: 'You are a helpful assistant. Reply briefly.',
        promptMode: 'minimal',
      }
      const agent = new Agent(
        agentConfig,
        new BashSecretEnvToolCallAdapter(),
        registry,
        localToolContext,
        { tracer },
      )
      const context = createContext(registry)

      await agent.run(context, 'Use the Bash tool with a secret reference.')

      const runLogPath = join(logsDir, 'sessions', 'test-session', 'run.log')
      const runLog = readFileSync(runLogPath, 'utf-8')
      expect(runLog).toContain(secretRef)
      expect(runLog).not.toContain(secretValue)

      const entries = runLog
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const rawToolInputEntry = expectDefined(
        entries.find((entry) => entry.event === 'tool_call.raw_input'),
      )
      const rawToolInputData = rawToolInputEntry.data as {
        input?: { command?: string; envSecrets?: Record<string, string> }
      }
      expect(rawToolInputData.input?.envSecrets?.SSH_PASSWORD).toBe(secretRef)
      expect(rawToolInputData.input?.command).not.toContain(secretValue)

      const rawToolResultEntry = expectDefined(
        entries.find((entry) => entry.event === 'tool_call.raw_result'),
      )
      const rawToolResultData = rawToolResultEntry.data as {
        result?: { output?: string; outputSummary?: string }
      }
      expect(rawToolResultData.result?.output).toContain('[REDACTED]')
      expect(rawToolResultData.result?.output).not.toContain(secretValue)
      expect(rawToolResultData.result?.outputSummary).toBe(
        'Executed: command with secret references',
      )
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  }, 30000)
})
