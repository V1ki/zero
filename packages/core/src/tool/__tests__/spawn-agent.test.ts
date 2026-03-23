import { describe, expect, test } from 'bun:test'
import { ModelRouter, type ProviderAdapter } from '@zero-os/model'
import type {
  AgentControlHandle,
  CompletionRequest,
  CompletionResponse,
  ObservabilityHandle,
  ToolContext,
  ToolResult,
  StreamEvent,
} from '@zero-os/shared'
import { BashTool } from '../bash'
import { BaseTool } from '../base'
import { SUB_AGENT_BLOCKED_TOOLS } from '../constants'
import { ReadTool } from '../read'
import { ToolRegistry } from '../registry'
import { SpawnAgentTool } from '../spawn-agent'

class StaticResponseAdapter implements ProviderAdapter {
  readonly apiType = 'fake-spawn-subagent'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_spawn_001',
      content: [{ type: 'text', text: 'spawn complete' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 3 },
      model: 'fake-spawn-subagent-model',
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
    getModelLabel: () => 'test-provider/fake-spawn-subagent-model',
  } as unknown as ModelRouter
}

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

const ctx = {
  sessionId: 'test_spawn_session',
  workDir: process.cwd(),
  projectRoot: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

describe('SpawnAgentTool', () => {
  test('inherits full parent tool context and clears agent control', async () => {
    const registry = createToolRegistry()
    const tool = new SpawnAgentTool(createStubRouter(new StaticResponseAdapter()), registry)
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

    let capturedToolContext: ToolContext | undefined
    const agentControl = {
      spawn: (agent: unknown) => {
        capturedToolContext = (agent as any).toolContext as ToolContext
        return { agentId: 'agent_123', label: 'Explorer' }
      },
      waitAny: async () => ({ statuses: {}, timedOut: false }),
      waitAll: async () => ({ statuses: {}, timedOut: false }),
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
    } as AgentControlHandle

    const result = await tool.run(
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
        instruction: 'Inspect the workspace and report back.',
        label: 'Explorer',
        tools: ['read'],
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
    expect(capturedToolContext?.workDir).toContain('/subagents/')
  })

  test('filters blocked tools from explicit allowlists', () => {
    const registry = createToolRegistry()
    registry.register(new NamedTool('spawn_agent'))
    registry.register(new NamedTool('wait_agent'))
    registry.register(new NamedTool('close_agent'))
    registry.register(new NamedTool('send_input'))

    const tool = new SpawnAgentTool(createStubRouter(new StaticResponseAdapter()), registry)
    const scopedRegistry = (tool as any).buildScopedRegistry([
      'read',
      'task',
      'spawn_agent',
      'wait_agent',
      'close_agent',
      'send_input',
      'bash',
    ]) as ToolRegistry

    expect(scopedRegistry.list().map((entry: BaseTool) => entry.name)).toEqual(['read', 'bash'])
    expect(
      scopedRegistry.list().every((entry: BaseTool) => !SUB_AGENT_BLOCKED_TOOLS.has(entry.name)),
    ).toBe(true)
  })

  test('defaults exclude blocked tools from the full registry', () => {
    const registry = createToolRegistry()
    registry.register(new NamedTool('task'))
    registry.register(new NamedTool('spawn_agent'))
    registry.register(new NamedTool('wait_agent'))
    registry.register(new NamedTool('close_agent'))
    registry.register(new NamedTool('send_input'))

    const tool = new SpawnAgentTool(createStubRouter(new StaticResponseAdapter()), registry)
    const scopedRegistry = (tool as any).buildScopedRegistry() as ToolRegistry

    expect(scopedRegistry.list().map((entry: BaseTool) => entry.name)).toEqual(['read', 'bash'])
  })
})
