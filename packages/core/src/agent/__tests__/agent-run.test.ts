import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolLogger,
  ToolUseBlock,
} from '@zero-os/shared'
import { type AgentLoopRunOptions, AgentLoopStoppedError, runAgentLoop } from '../agent-run'

class ScriptedAdapter implements ProviderAdapter {
  readonly apiType = 'fake-agent-run'
  requests = 0

  constructor(
    private readonly respond: (
      request: CompletionRequest,
      index: number,
    ) => CompletionResponse | Promise<CompletionResponse>,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.respond(request, this.requests++)
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: { finishReason: 'end_turn' } }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

const logger: ToolLogger = { info: () => {}, warn: () => {}, error: () => {} }

const lookup = { name: 'lookup', description: 'Look something up', parameters: { type: 'object' } }

const use = (id: string, input: Record<string, unknown> = {}): ToolUseBlock => ({
  type: 'tool_use',
  id,
  name: 'lookup',
  input,
})

const toolRound = (...calls: ToolUseBlock[]): CompletionResponse => ({
  id: 'resp_tools',
  content: [{ type: 'text', text: 'checking' }, ...calls],
  stopReason: 'tool_use',
  usage: { input: 3, output: 1 },
  model: 'fake',
})

const answer = (text: string): CompletionResponse => ({
  id: 'resp_answer',
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { input: 5, output: 2 },
  model: 'fake',
})

function options(
  adapter: ProviderAdapter,
  overrides: Partial<AgentLoopRunOptions> = {},
): AgentLoopRunOptions {
  return {
    adapter,
    sessionId: 'sess-agent-run',
    meta: { sessionId: 'sess-agent-run', purpose: 'agent_loop' },
    system: 'test system',
    prompt: 'question',
    tools: [lookup],
    toolExecutor: {
      has: (name) => name === 'lookup',
      execute: async (_name, _id, input) => ({
        success: true,
        output: `found ${String(input.q)}`,
        outputSummary: 'found',
      }),
    },
    maxIterations: 4,
    stream: false,
    logger,
    ...overrides,
  }
}

describe('runAgentLoop', () => {
  test('sums usage across steps, records tool calls in order and returns the final text', async () => {
    const adapter = new ScriptedAdapter((_request, index) =>
      index === 0 ? toolRound(use('a', { q: 1 }), use('b', { q: 2 })) : answer('done'),
    )

    const run = await runAgentLoop(options(adapter))

    expect(run.usage).toEqual({ input: 8, output: 3 })
    expect(run.toolCalls).toEqual([
      { name: 'lookup', input: { q: 1 }, output: 'found 1' },
      { name: 'lookup', input: { q: 2 }, output: 'found 2' },
    ])
    expect(run.finalText).toBe('done')
    expect(run.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('final text comes from the last assistant message even when tool results follow it', async () => {
    const adapter = new ScriptedAdapter(() => toolRound(use('a')))

    const run = await runAgentLoop(options(adapter, { maxIterations: 1 }))

    expect(run.messages.at(-1)?.role).toBe('user')
    expect(run.finalText).toBe('checking')
  })

  test('a timeout stops the run while the completion is still pending', async () => {
    const adapter = new ScriptedAdapter(() => new Promise<CompletionResponse>(() => {}))

    const error = await runAgentLoop(options(adapter, { timeoutMs: 10 })).catch((e) => e)

    expect(error).toBeInstanceOf(AgentLoopStoppedError)
    expect(error.reason).toBe('timeout')
  })

  test('an already aborted caller signal stops the run before any request', async () => {
    const adapter = new ScriptedAdapter(() => answer('never'))
    const controller = new AbortController()
    controller.abort()

    const error = await runAgentLoop(options(adapter, { signal: controller.signal })).catch(
      (e) => e,
    )

    expect(error).toBeInstanceOf(AgentLoopStoppedError)
    expect(error.reason).toBe('cancelled')
    expect(adapter.requests).toBe(0)
  })

  test('a completion that lands after the caller aborts is never returned', async () => {
    const pending = Promise.withResolvers<CompletionResponse>()
    const adapter = new ScriptedAdapter(() => pending.promise)
    const controller = new AbortController()
    const executed: string[] = []

    const running = runAgentLoop(
      options(adapter, {
        signal: controller.signal,
        timeoutMs: 60_000,
        toolExecutor: {
          has: () => true,
          execute: async (_name, id) => {
            executed.push(id)
            return { success: true, output: 'ok', outputSummary: 'ok' }
          },
        },
      }),
    )
    await Bun.sleep(0)
    controller.abort()

    // The run settles on the abort itself, before the provider answers.
    const error = await running.catch((e) => e)
    expect(error).toBeInstanceOf(AgentLoopStoppedError)
    expect(error.reason).toBe('cancelled')
    pending.resolve(toolRound(use('late')))
    await Bun.sleep(0)
    expect(executed).toEqual([])
  })

  test('the stop signal reaches tool executors and late tool results are not recorded', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<void>()
    const controller = new AbortController()
    const ended: string[] = []
    const adapter = new ScriptedAdapter(() => toolRound(use('a'), use('b')))

    const running = runAgentLoop(
      options(adapter, {
        signal: controller.signal,
        toolExecutor: {
          has: () => true,
          execute: async (_name, _id, _input, signal) => {
            entered.resolve(signal)
            await released.promise
            return { success: true, output: 'late', outputSummary: 'late' }
          },
        },
        hooks: { onToolCallEnd: (_name, id) => ended.push(id) },
      }),
    )
    const toolSignal = await entered.promise
    controller.abort()
    expect(toolSignal.aborted).toBe(true)
    await expect(running).rejects.toBeInstanceOf(AgentLoopStoppedError)
    released.resolve()
    await Bun.sleep(0)
    expect(ended).toEqual([])
    expect(adapter.requests).toBe(1)
  })

  test('a batch over the tool-call budget is rejected before its first call executes', async () => {
    const executed: string[] = []
    const adapter = new ScriptedAdapter((_request, index) =>
      index === 0 ? toolRound(use('a'), use('b')) : toolRound(use('c'), use('d')),
    )

    const error = await runAgentLoop(
      options(adapter, {
        maxToolCalls: 3,
        toolExecutor: {
          has: () => true,
          execute: async (_name, id) => {
            executed.push(id)
            return { success: true, output: 'ok', outputSummary: 'ok' }
          },
        },
      }),
    ).catch((e) => e)

    expect(error).toBeInstanceOf(AgentLoopStoppedError)
    expect(error.reason).toBe('tool_budget')
    expect(executed).toEqual(['a', 'b'])
  })

  test('with a tool-call budget, a batch on the last allowed step is rejected', async () => {
    const executed: string[] = []
    const adapter = new ScriptedAdapter((_request, index) => toolRound(use(`call-${index}`)))

    const error = await runAgentLoop(
      options(adapter, {
        maxIterations: 2,
        maxToolCalls: 10,
        toolExecutor: {
          has: () => true,
          execute: async (_name, id) => {
            executed.push(id)
            return { success: true, output: 'ok', outputSummary: 'ok' }
          },
        },
      }),
    ).catch((e) => e)

    expect(error).toBeInstanceOf(AgentLoopStoppedError)
    expect(error.reason).toBe('tool_budget')
    expect(executed).toEqual(['call-0'])
  })

  test('caller hooks run alongside the base bookkeeping', async () => {
    const seen: string[] = []
    const adapter = new ScriptedAdapter((_request, index) =>
      index === 0 ? toolRound(use('a', { q: 1 })) : answer('done'),
    )

    const run = await runAgentLoop(
      options(adapter, {
        hooks: {
          onCompletionEnd: (_request, response) => {
            seen.push(`completion:${response.usage.input}`)
          },
          onToolCallStart: (_name, id) => {
            seen.push(`start:${id}`)
          },
          onToolCallEnd: (_name, id, _input, result) => {
            seen.push(`end:${id}:${result.success}`)
          },
          shouldAbort: () => false,
        },
      }),
    )

    expect(seen).toEqual(['completion:3', 'start:a', 'end:a:true', 'completion:5'])
    expect(run.usage).toEqual({ input: 8, output: 3 })
    expect(run.toolCalls).toEqual([{ name: 'lookup', input: { q: 1 }, output: 'found 1' }])
  })

  test('a caller shouldAbort ends the loop', async () => {
    const adapter = new ScriptedAdapter(() => toolRound(use('a')))

    const run = await runAgentLoop(options(adapter, { hooks: { shouldAbort: () => true } }))

    expect(run.toolCalls).toEqual([])
    expect(run.messages.map((message) => message.role)).toEqual(['user'])
  })
})
