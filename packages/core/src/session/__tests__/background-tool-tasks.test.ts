import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { Agent, type AgentContext } from '../../agent/agent'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import {
  type BackgroundToolCompletionEvent,
  BackgroundToolTaskManager,
} from '../background-tool-tasks'
import { Session, type SessionDeps } from '../session'
import {
  createTestModelRouter,
  createTestProjectRoot,
  setSessionAgentForTest,
} from './test-helpers'

const testProject = createTestProjectRoot('zero-background-tools-')

afterAll(() => {
  testProject.cleanup()
})

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createLogger(): ToolContext['logger'] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function createTextResponse(id: string, text: string): CompletionResponse {
  return {
    id,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'fake-background-test',
  }
}

function createToolResponse(id: string, toolName = 'slow_tool'): CompletionResponse {
  return {
    id,
    content: [{ type: 'tool_use', id: 'call_slow_1', name: toolName, input: { query: 'slow' } }],
    stopReason: 'tool_use',
    usage: { input: 1, output: 1 },
    model: 'fake-background-test',
  }
}

class SlowTool extends BaseTool {
  name = 'slow_tool'
  description = 'Slow test tool'
  parameters = { type: 'object', properties: {} }

  constructor(private readonly result: Promise<ToolResult>) {
    super()
  }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return this.result
  }
}

class CapturingBashTool extends BaseTool {
  name = 'bash'
  description = 'Capturing bash test tool'
  parameters = { type: 'object', properties: {} }
  seenInput: unknown

  constructor(private readonly result: Promise<ToolResult>) {
    super()
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    this.seenInput = input
    return this.result
  }
}

class BackgroundToolAdapter implements ProviderAdapter {
  readonly apiType = 'fake-background-tool'
  readonly requests: CompletionRequest[] = []

  constructor(private readonly toolName = 'slow_tool') {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      return createToolResponse('resp_tool', this.toolName)
    }
    return createTextResponse('resp_done', 'background handoff done')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class TextOnlyAdapter implements ProviderAdapter {
  readonly apiType = 'fake-background-text'

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    return createTextResponse('resp_control', 'noted background completion')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createContext(registry: ToolRegistry): AgentContext {
  return {
    systemPrompt: 'Use tools when requested.',
    conversationHistory: [],
    tools: registry.getDefinitions(),
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for test condition')
}

describe('BackgroundToolTaskManager', () => {
  test('returns fast tool results without creating a background event', async () => {
    const completions: BackgroundToolCompletionEvent[] = []
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-fast',
      thresholdMs: 20,
      logger: createLogger(),
      onComplete: (event) => {
        completions.push(event)
      },
    })

    const result = await manager.run({
      toolName: 'fast_tool',
      toolUseId: 'call_fast',
      inputSummary: '{}',
      execute: async () => ({ success: true, output: 'fast', outputSummary: 'fast done' }),
    })

    expect(result).toEqual({ success: true, output: 'fast', outputSummary: 'fast done' })
    expect(completions).toEqual([])
  })

  test('returns a background placeholder and later emits completion XML', async () => {
    const completions: BackgroundToolCompletionEvent[] = []
    const deferred = createDeferred<ToolResult>()
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-slow',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: (event) => {
        completions.push(event)
      },
    })

    const foreground = await manager.run({
      toolName: 'slow_tool',
      toolUseId: 'call_slow',
      inputSummary: '{"query":"slow"}',
      execute: () => deferred.promise,
    })
    expect(foreground.output).toContain('background_tool.started')
    expect(foreground.output).toContain('Do not manually poll with sleep, ps, pgrep, lsof')
    expect(foreground.output).toContain('wait for the background_tool.completed system event')

    deferred.resolve({ success: true, output: 'slow output', outputSummary: 'slow done' })
    const completion = await waitFor(() => completions[0])
    expect(completion.task.status).toBe('success')
    expect(completion.xml).toContain('<system_event type="background_tool.completed">')
    expect(completion.xml).toContain('<output_summary>slow done</output_summary>')
  })

  test('waitForCompletion resolves when the background task finishes', async () => {
    const deferred = createDeferred<ToolResult>()
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-wait',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: () => {},
    })

    const foreground = await manager.run({
      toolName: 'slow_tool',
      toolUseId: 'call_wait',
      inputSummary: '{}',
      execute: () => deferred.promise,
    })
    expect(foreground.backgroundTaskId).toBeDefined()

    let resolved = false
    const waiter = manager
      .waitForCompletion(foreground.backgroundTaskId as string)
      .then((result) => {
        resolved = true
        return result
      })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(resolved).toBe(false)

    deferred.resolve({ success: true, output: 'waited output', outputSummary: 'waited done' })
    const completed = await waiter
    expect(completed.success).toBe(true)
    expect(completed.output).toBe('waited output')
    expect(completed.outputSummary).toBe('waited done')
  })

  test('waitForCompletion returns immediately for already-completed tasks', async () => {
    const deferred = createDeferred<ToolResult>()
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-wait-immediate',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: () => {},
    })

    const foreground = await manager.run({
      toolName: 'slow_tool',
      toolUseId: 'call_wait2',
      inputSummary: '{}',
      execute: () => deferred.promise,
    })
    deferred.resolve({ success: true, output: 'done already', outputSummary: 'done' })
    const completed = await manager.waitForCompletion(foreground.backgroundTaskId as string)
    expect(completed.success).toBe(true)
    expect(completed.output).toBe('done already')
  })

  test('uses the latest channel binding when emitting background completion events', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const completions: BackgroundToolCompletionEvent[] = []
    const deferred = createDeferred<ToolResult>()
    const channelState: {
      binding?: {
        source: string
        channelName: string
        channelId: string
        participantId?: string
        deliveryChannelId?: string
      }
    } = {}
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-channel',
      thresholdMs: 5,
      logger: createLogger(),
      getChannelBinding: () => channelState.binding,
      emitBusEvent: (topic, data) => {
        events.push({ topic, data })
      },
      onComplete: (event) => {
        completions.push(event)
      },
    })

    await manager.run({
      toolName: 'slow_tool',
      toolUseId: 'call_channel',
      inputSummary: '{"query":"slow"}',
      execute: () => deferred.promise,
    })

    expect(events[0]).toMatchObject({
      topic: 'background_tool:started',
      data: { sessionId: 'sess-channel' },
    })
    expect(events[0]?.data.channelName).toBeUndefined()

    channelState.binding = {
      source: 'feishu',
      channelName: 'nanoclaw',
      channelId: 'oc_feishu',
      participantId: 'ou_user',
    }
    deferred.resolve({ success: true, output: 'slow output', outputSummary: 'slow done' })

    const completion = await waitFor(() =>
      events.find((event) => event.topic === 'background_tool:completed'),
    )
    expect(completion.data).toMatchObject({
      sessionId: 'sess-channel',
      source: 'feishu',
      channelName: 'nanoclaw',
      channelId: 'oc_feishu',
      deliveryChannelId: 'oc_feishu',
      participantId: 'ou_user',
    })
    expect(completions[0]?.channelBinding).toEqual({
      source: 'feishu',
      channelName: 'nanoclaw',
      channelId: 'oc_feishu',
      deliveryChannelId: 'oc_feishu',
      participantId: 'ou_user',
    })
  })
})

describe('Agent background tool execution', () => {
  test('slow tools return a foreground background-started result and complete later', async () => {
    const completions: BackgroundToolCompletionEvent[] = []
    const deferred = createDeferred<ToolResult>()
    const registry = new ToolRegistry()
    registry.register(new SlowTool(deferred.promise))
    const adapter = new BackgroundToolAdapter()
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-agent',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: (event) => {
        completions.push(event)
      },
    })
    const agent = new Agent(
      { name: 'background-agent', agentInstruction: 'test', promptMode: 'minimal' },
      adapter,
      registry,
      {
        sessionId: 'sess-agent',
        workDir: join(testProject.projectRoot, '.zero', 'workspace', 'background-agent'),
        logger: createLogger(),
        backgroundToolTasks: manager,
      },
    )

    const run = await agent.run(createContext(registry), 'run slow tool')
    expect(run.at(-1)?.role).toBe('assistant')

    const secondRequestText = adapter.requests[1]?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.content)
      .join('\n')
    expect(secondRequestText).toContain('background_tool.started')

    deferred.resolve({ success: true, output: 'finished later', outputSummary: 'later done' })
    const completion = await waitFor(() => completions[0])
    expect(completion.xml).toContain('status="success"')
    expect(completion.xml).toContain('later done')
  })

  test('background bash calls without explicit timeout use a long runtime timeout', async () => {    const completions: BackgroundToolCompletionEvent[] = []
    const deferred = createDeferred<ToolResult>()
    const registry = new ToolRegistry()
    const bash = new CapturingBashTool(deferred.promise)
    registry.register(bash)
    const adapter = new BackgroundToolAdapter('bash')
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-bash',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: (event) => {
        completions.push(event)
      },
    })
    const agent = new Agent(
      { name: 'background-bash-agent', agentInstruction: 'test', promptMode: 'minimal' },
      adapter,
      registry,
      {
        sessionId: 'sess-bash',
        workDir: join(testProject.projectRoot, '.zero', 'workspace', 'background-bash-agent'),
        logger: createLogger(),
        backgroundToolTasks: manager,
      },
    )

    await agent.run(createContext(registry), 'run slow bash')
    expect(bash.seenInput).toMatchObject({ timeout: 60 * 60 * 1000 })

    deferred.resolve({ success: true, output: 'finished later', outputSummary: 'later done' })
    await waitFor(() => completions[0])
  })

  test('backgroundTaskWait mode holds the turn until the background task completes', async () => {
    const completions: BackgroundToolCompletionEvent[] = []
    const deferred = createDeferred<ToolResult>()
    const registry = new ToolRegistry()
    registry.register(new SlowTool(deferred.promise))
    const adapter = new BackgroundToolAdapter()
    const manager = new BackgroundToolTaskManager({
      sessionId: 'sess-wait-mode',
      thresholdMs: 5,
      logger: createLogger(),
      onComplete: (event) => {
        completions.push(event)
      },
    })
    const agent = new Agent(
      { name: 'background-wait-agent', agentInstruction: 'test', promptMode: 'minimal' },
      adapter,
      registry,
      {
        sessionId: 'sess-wait-mode',
        workDir: join(testProject.projectRoot, '.zero', 'workspace', 'background-wait-agent'),
        logger: createLogger(),
        backgroundToolTasks: manager,
        backgroundTaskWait: true,
      },
    )

    let runSettled = false
    const runPromise = agent.run(createContext(registry), 'run slow tool').then(() => {
      runSettled = true
    })

    // The turn must not end while the background task is still pending.
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(runSettled).toBe(false)

    deferred.resolve({ success: true, output: 'waited in place', outputSummary: 'waited done' })
    await runPromise
    expect(runSettled).toBe(true)

    // The model's second request must carry the completed result, not the
    // background_tool.started placeholder.
    const secondRequestText = adapter.requests[1]?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.content)
      .join('\n')
    expect(secondRequestText).toContain('waited in place')
    expect(secondRequestText).not.toContain('background_tool.started')
  })
})

describe('Session background completion injection', () => {
  test('idle completion event is injected as a user control message', async () => {
    const session = createSessionWithTextAgent('idle')

    await (
      session as unknown as {
        handleBackgroundToolCompletion(event: BackgroundToolCompletionEvent): Promise<void>
      }
    ).handleBackgroundToolCompletion({
      task: {
        id: 'task_idle',
        sessionId: session.data.id,
        toolName: 'slow_tool',
        toolUseId: 'call_idle',
        inputSummary: '{}',
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 10,
        outputSummary: 'done',
        output: 'done',
      },
      xml: '<system_event type="background_tool.completed"><background_task id="task_idle" /></system_event>',
    })

    const first = session.getMessages()[0]
    expect(first).toMatchObject({
      role: 'user',
      messageType: 'control',
      controlKind: 'background_tool_completed',
    })
  })

  test('active completion event is queued with control metadata', async () => {
    const session = createSessionWithTextAgent('active')
    const turnRuntime = (
      session as unknown as {
        turnRuntime: { acquireTurn(): Promise<string>; releaseTurn(id: string): void }
      }
    ).turnRuntime
    const lockId = await turnRuntime.acquireTurn()

    await (
      session as unknown as {
        handleBackgroundToolCompletion(event: BackgroundToolCompletionEvent): Promise<void>
      }
    ).handleBackgroundToolCompletion({
      task: {
        id: 'task_active',
        sessionId: session.data.id,
        toolName: 'slow_tool',
        toolUseId: 'call_active',
        inputSummary: '{}',
        status: 'success',
        startedAt: new Date().toISOString(),
      },
      xml: '<system_event type="background_tool.completed"><background_task id="task_active" /></system_event>',
    })

    turnRuntime.releaseTurn(lockId)

    const queued = session.getMessages()[0]
    expect(queued).toMatchObject({
      role: 'user',
      messageType: 'control',
      controlKind: 'background_tool_completed',
    })
  })

  test('delegates completion injection to a configured background handler', async () => {
    const progressTexts: string[] = []
    const session = createSessionWithTextAgent('handler', {
      backgroundToolCompletionHandler: async (event, run) => {
        expect(event.channelBinding?.channelName).toBe('feishu')
        await run({
          onProgress: (message) => {
            if (message.role !== 'assistant') return
            progressTexts.push(
              message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n'),
            )
          },
        })
        return true
      },
    })

    await (
      session as unknown as {
        handleBackgroundToolCompletion(event: BackgroundToolCompletionEvent): Promise<void>
      }
    ).handleBackgroundToolCompletion({
      task: {
        id: 'task_handler',
        sessionId: session.data.id,
        toolName: 'slow_tool',
        toolUseId: 'call_handler',
        inputSummary: '{}',
        status: 'success',
        startedAt: new Date().toISOString(),
      },
      xml: '<system_event type="background_tool.completed"><background_task id="task_handler" /></system_event>',
      channelBinding: {
        source: 'feishu',
        channelName: 'feishu',
        channelId: 'chat_handler',
        deliveryChannelId: 'chat_handler',
      },
    })

    expect(progressTexts).toEqual(['noted background completion'])
  })
})

function createSessionWithTextAgent(label: string, deps: SessionDeps = {}): Session {
  const registry = new ToolRegistry()
  const session = new Session('web', createTestModelRouter(), registry, {
    ...deps,
    projectRoot: deps.projectRoot ?? testProject.projectRoot,
  })
  session.initAgent({ name: `background-${label}`, agentInstruction: 'background test' })
  setSessionAgentForTest(
    session,
    new Agent(
      { name: `background-${label}`, agentInstruction: 'background test', promptMode: 'minimal' },
      new TextOnlyAdapter(),
      registry,
      {
        sessionId: session.data.id,
        workDir: join(testProject.projectRoot, '.zero', 'workspace', `background-${label}`),
        logger: createLogger(),
      },
    ),
  )
  return session
}
