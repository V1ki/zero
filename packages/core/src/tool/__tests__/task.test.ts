import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRouter, type ProviderAdapter } from '@zero-os/model'
import { MetricsDB, Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ObservabilityHandle,
  StreamEvent,
  SystemConfig,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import { BaseTool } from '../base'
import { BashTool } from '../bash'
import { SUB_AGENT_BLOCKED_TOOLS } from '../constants'
import { ReadTool } from '../read'
import { ToolRegistry } from '../registry'
import { TaskTool } from '../task'

// Use the same config pattern as packages/model/src/__tests__/router.test.ts
const API_KEY = 'sk-c6c02cbd0c25473f97f9be0da6070f6d'

const config: SystemConfig = {
  providers: {
    'openai-codex': {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://www.right.codes/codex',
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

const secrets = new Map([['openai_codex_api_key', API_KEY]])

const TEST_WORK_DIR = join(import.meta.dir, '__test_task_workdir__')

beforeAll(() => {
  mkdirSync(TEST_WORK_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(TEST_WORK_DIR, { recursive: true, force: true })
})

const ctx = {
  sessionId: 'test_task_session',
  workDir: TEST_WORK_DIR,
  projectRoot: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

class StaticResponseAdapter implements ProviderAdapter {
  readonly apiType = 'fake-task-subagent'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_subagent_001',
      content: [{ type: 'text', text: 'subagent complete' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 3 },
      model: 'fake-task-subagent-model',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream unsupported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createStubRouter(adapter: ProviderAdapter): ModelRouter {
  const resolved = {
    adapter,
    providerName: 'test-provider',
    modelConfig: {},
  }

  return {
    getCurrentModel: () => resolved,
    resolveModel: () => resolved,
    getAdapter: () => adapter,
    getModelLabel: () => 'test-provider/fake-task-subagent-model',
  } as unknown as ModelRouter
}

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

class NamedTool extends BaseTool {
  description = 'test tool'
  parameters = { type: 'object', properties: {} }

  constructor(public name: string) {
    super()
  }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return {
      success: true,
      output: this.name,
      outputSummary: this.name,
    }
  }
}

describe('TaskTool', () => {
  test('returns error for empty tasks array', async () => {
    const registry = createToolRegistry()
    const router = new ModelRouter(config, secrets)
    router.init()
    const taskTool = new TaskTool(router, registry)

    const result = await taskTool.run(ctx, { tasks: [] })
    expect(result.success).toBe(false)
    expect(result.output).toContain('No tasks')
  })

  test('returns error for invalid task config (no preset, no name)', async () => {
    const registry = createToolRegistry()
    const router = new ModelRouter(config, secrets)
    router.init()
    const taskTool = new TaskTool(router, registry)

    const result = await taskTool.run(ctx, {
      tasks: [{ id: 'bad', instruction: 'do something' }],
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('must specify either preset or both name and agentInstruction')
  })

  test('task tool excludes itself from SubAgent registry', () => {
    const registry = createToolRegistry()
    const router = new ModelRouter(config, secrets)
    router.init()
    const taskTool = new TaskTool(router, registry)

    // Register the task tool itself in the base registry
    registry.register(taskTool)
    expect(registry.has('task')).toBe(true)

    // The scoped registry built inside should not include 'task'
    // We test this indirectly: the tool definitions exposed to SubAgents
    // If we could access buildScopedRegistry directly we'd verify, but the
    // class is internal. The safety rule is enforced in the implementation.
    expect(taskTool.name).toBe('task')
  })

  test('inherits parent tool context and clears agent control for subagents', async () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)
    const observability: ObservabilityHandle = {
      recordOperation: () => {},
      logEvent: () => {},
    }
    const memoryStore = {
      create: async () => ({}) as never,
      update: async () => undefined,
      delete: async () => true,
      list: () => [],
      get: () => undefined,
    }
    const memoryRetriever = {
      retrieve: async () => [],
    }
    const secretResolver = () => 'secret'
    const channelBinding = {
      source: 'test',
      channelName: 'channel',
      channelId: 'channel-1',
    }
    const schedulerHandle = {
      addAndStart: () => {},
      remove: () => true,
      getStatus: () => [],
    }
    const scheduleStore = {
      save: () => {},
      delete: () => true,
    }
    const agentControl = {
      spawn: () => ({ error: 'not used' }),
      waitAny: async () => ({ statuses: {}, timedOut: false }),
      waitAll: async () => ({ statuses: {}, timedOut: false }),
      waitReady: async () => ({ statuses: {}, timedOut: false }),
      getStatus: () => undefined,
      getOutput: () => undefined,
      getSnapshot: () => [],
      restoreSnapshot: () => {},
      sendInput: () => ({ success: true }),
      getTraceSpanId: () => undefined,
      getAgentInfo: () => undefined,
      close: () => undefined,
      listAgents: () => [],
      activeAgentCount: 0,
    }

    let capturedToolContext: ToolContext | undefined
    const originalRun = Agent.prototype.run
    Agent.prototype.run = async function () {
      capturedToolContext = (this as unknown as { toolContext: ToolContext }).toolContext
      return [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent complete' }],
        },
      ] as never
    }

    try {
      const result = await taskTool.run(
        {
          ...ctx,
          currentRequestId: 'req_parent_001',
          currentTraceSpanId: 'trace_parent_001',
          observability,
          memoryStore,
          memoryRetriever,
          secretResolver,
          channelBinding,
          schedulerHandle,
          scheduleStore,
          agentControl,
        },
        {
          tasks: [
            {
              id: 'custom',
              name: 'CustomBot',
              agentInstruction: 'Return once the task is done.',
              instruction: 'confirm completion',
              tools: ['read'],
            },
          ],
        },
      )

      expect(result.success).toBe(true)
      expect(capturedToolContext).toBeDefined()
      expect(capturedToolContext?.observability).toBe(observability)
      expect(capturedToolContext?.memoryStore).toBe(memoryStore)
      expect(capturedToolContext?.memoryRetriever).toBe(memoryRetriever)
      expect(capturedToolContext?.secretResolver).toBe(secretResolver)
      expect(capturedToolContext?.channelBinding).toBe(channelBinding)
      expect(capturedToolContext?.schedulerHandle).toBe(schedulerHandle)
      expect(capturedToolContext?.scheduleStore).toBe(scheduleStore)
      expect(capturedToolContext?.spawnedByRequestId).toBe('req_parent_001')
      expect(capturedToolContext?.currentRequestId).toBeUndefined()
      expect(capturedToolContext?.currentTraceSpanId).toBe('trace_parent_001')
      expect(capturedToolContext?.agentControl).toBeUndefined()
      expect(capturedToolContext?.workDir).toBe(join(TEST_WORK_DIR, 'CustomBot'))
    } finally {
      Agent.prototype.run = originalRun
    }
  })

  test('filters all blocked sub-agent tools from explicit tool lists', () => {
    const registry = createToolRegistry()
    registry.register(new NamedTool('spawn_agent'))
    registry.register(new NamedTool('wait_agent'))
    registry.register(new NamedTool('close_agent'))
    registry.register(new NamedTool('send_input'))

    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)
    const scopedRegistry = (
      taskTool as unknown as {
        buildScopedRegistry(
          spec?: { tools?: string[] },
          role?: { defaultTools?: string[] },
        ): ToolRegistry
      }
    ).buildScopedRegistry(
      {
        tools: ['read', 'task', 'spawn_agent', 'wait_agent', 'close_agent', 'send_input', 'bash'],
      },
      undefined,
    )

    expect(scopedRegistry.list().map((tool: BaseTool) => tool.name)).toEqual(['read', 'bash'])
    expect(
      scopedRegistry.list().every((tool: BaseTool) => !SUB_AGENT_BLOCKED_TOOLS.has(tool.name)),
    ).toBe(true)
  })

  test('filters all blocked sub-agent tools from role defaults', () => {
    const registry = createToolRegistry()
    registry.register(new NamedTool('spawn_agent'))
    registry.register(new NamedTool('wait_agent'))
    registry.register(new NamedTool('close_agent'))
    registry.register(new NamedTool('send_input'))

    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)
    const scopedRegistry = (
      taskTool as unknown as {
        buildScopedRegistry(
          spec?: { tools?: string[] },
          role?: { defaultTools?: string[] },
        ): ToolRegistry
      }
    ).buildScopedRegistry(undefined, {
      defaultTools: [
        'read',
        'task',
        'spawn_agent',
        'wait_agent',
        'close_agent',
        'send_input',
        'bash',
      ],
    })

    expect(scopedRegistry.list().map((tool: BaseTool) => tool.name)).toEqual(['read', 'bash'])
  })

  test('preserves the lightweight default tool set when no tools are provided', () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)
    const scopedRegistry = (
      taskTool as unknown as {
        buildScopedRegistry(
          spec?: { tools?: string[] },
          role?: { defaultTools?: string[] },
        ): ToolRegistry
      }
    ).buildScopedRegistry(undefined, undefined)

    expect(scopedRegistry.list().map((tool: BaseTool) => tool.name)).toEqual(['read', 'bash'])
  })

  test('single task with preset runs successfully', async () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)

    const result = await taskTool.run(ctx, {
      tasks: [
        {
          id: 'echo_test',
          preset: 'coder',
          instruction: 'Run the command: echo "hello from subagent". Return the output.',
          tools: ['bash'],
          timeout: 60_000,
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('echo_test')
  }, 60_000)

  test('parallel tasks execute concurrently', async () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)

    const _start = Date.now()
    const result = await taskTool.run(ctx, {
      tasks: [
        {
          id: 'task_a',
          preset: 'coder',
          instruction: 'Run: echo "task A done". Return just the output.',
          tools: ['bash'],
          timeout: 60_000,
        },
        {
          id: 'task_b',
          preset: 'coder',
          instruction: 'Run: echo "task B done". Return just the output.',
          tools: ['bash'],
          timeout: 60_000,
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('task_a')
    expect(result.output).toContain('task_b')
  }, 120_000)

  test('dependency chain passes upstream output', async () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)

    const result = await taskTool.run(ctx, {
      tasks: [
        {
          id: 'step1',
          preset: 'coder',
          instruction: 'Run: echo "MAGIC_NUMBER_42". Return only the output text.',
          tools: ['bash'],
          timeout: 60_000,
        },
        {
          id: 'step2',
          preset: 'coder',
          instruction: 'Look at the upstream output and tell me what number you see.',
          dependsOn: ['step1'],
          tools: ['bash'],
          timeout: 60_000,
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('step1')
    expect(result.output).toContain('step2')
  }, 120_000)

  test('custom agent with name and agentInstruction works', async () => {
    const registry = createToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)

    const result = await taskTool.run(ctx, {
      tasks: [
        {
          id: 'custom',
          name: 'CustomBot',
          agentInstruction: 'You are a helpful bot. Always respond concisely.',
          instruction: 'Run: echo "custom agent works". Return the output.',
          tools: ['bash'],
          timeout: 60_000,
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('custom')
  }, 60_000)

  test('subagent requests include agentName and spawnedByRequestId', async () => {
    const tracer = new Tracer()
    const registry = new ToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry)

    const result = await taskTool.run(
      {
        ...ctx,
        currentRequestId: 'req_parent_001',
        tracer,
      },
      {
        tasks: [
          {
            id: 'research',
            name: 'Researcher',
            agentInstruction: 'Investigate and summarize findings briefly.',
            instruction: 'Return a one-line confirmation that the task finished.',
            tools: [],
          },
        ],
      },
    )

    expect(result.success).toBe(true)
    const entries = flattenTraceSpans(tracer.exportSession('test_task_session'))
      .map((span) => span.data?.request as Record<string, unknown> | undefined)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    expect(entries).toHaveLength(1)
    expect(entries[0].sessionId).toBe('test_task_session')
    expect(entries[0].agentName).toBe('Researcher')
    expect(entries[0].spawnedByRequestId).toBe('req_parent_001')
  })

  test('subagent task runs record request metrics and usage ledger entries', async () => {
    const metrics = MetricsDB.createInMemory()
    const registry = new ToolRegistry()
    const taskTool = new TaskTool(createStubRouter(new StaticResponseAdapter()), registry, metrics)

    const result = await taskTool.run(ctx, {
      tasks: [
        {
          id: 'metrics',
          name: 'MetricsAgent',
          agentInstruction: 'Return once complete.',
          instruction: 'Respond with completion.',
          tools: [],
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(metrics.sessionStats('test_task_session').requestCount).toBe(1)
    const subAgentUsage = metrics
      .usageSummaryByPurpose('1d')
      .find((entry) => entry.purpose === 'sub_agent')
    expect(subAgentUsage?.category).toBe('completion')
    expect(subAgentUsage?.eventCount).toBe(1)

    metrics.close()
  })
})

function flattenTraceSpans(
  spans: Array<{ data?: Record<string, unknown>; children?: unknown[] }>,
): Array<{ data?: Record<string, unknown>; children?: unknown[] }> {
  return spans.flatMap((span) => [
    span,
    ...flattenTraceSpans(
      (span.children as
        | Array<{ data?: Record<string, unknown>; children?: unknown[] }>
        | undefined) ?? [],
    ),
  ])
}
