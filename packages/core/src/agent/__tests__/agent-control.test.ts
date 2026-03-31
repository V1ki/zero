import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message, ToolLogger, ToolTracer } from '@zero-os/shared'
import { AgentControl } from '../agent-control'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assistantMessage(text: string): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_test',
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
  }
}

function createAgent(options?: {
  text?: string
  delayMs?: number
  error?: string
  onRun?: (instruction: string) => void
}) {
  return {
    async run(_context: unknown, instruction: string): Promise<Message[]> {
      options?.onRun?.(instruction)
      if (options?.delayMs) {
        await sleep(options.delayMs)
      }
      if (options?.error) {
        throw new Error(options.error)
      }
      return [assistantMessage(options?.text ?? 'done')]
    },
  }
}

function createQueuedAwareAgent(options?: {
  delayMs?: number
  onInterruptCheck?: (value: boolean) => void
  onQueuedMessages?: (messages: string[]) => void
}) {
  return {
    async run(
      _context: unknown,
      instruction: string,
      _userImages?: unknown,
      _onNewMessage?: unknown,
      _onTextDelta?: unknown,
      shouldInterrupt?: () => boolean,
      getQueuedMessages?: () => Array<{ content: string }>,
    ): Promise<Message[]> {
      if (options?.delayMs) {
        await sleep(options.delayMs)
      }

      const interrupted = shouldInterrupt?.() ?? false
      const queued = getQueuedMessages?.() ?? []
      const queuedTexts = queued.map((message) => message.content)

      options?.onInterruptCheck?.(interrupted)
      options?.onQueuedMessages?.(queuedTexts)

      return [
        assistantMessage(
          JSON.stringify({
            instruction,
            interrupted,
            queued: queuedTexts,
          }),
        ),
      ]
    },
  }
}

function createInteractiveAgent(options?: {
  consumeQueuedMessages?: boolean
  delayMsByRun?: Record<number, number>
  onRun?: (details: {
    context: { conversationHistory: Message[] }
    instruction: string
    interrupted: boolean
    queuedMessages: string[]
    runCount: number
  }) => void
}) {
  let runCount = 0

  return {
    async run(
      context: { conversationHistory: Message[] },
      instruction: string,
      _userImages?: unknown,
      _onNewMessage?: unknown,
      _onTextDelta?: unknown,
      shouldInterrupt?: () => boolean,
      getQueuedMessages?: () => Array<{ content: string }>,
    ): Promise<Message[]> {
      runCount++
      const delayMs = options?.delayMsByRun?.[runCount]
      if (delayMs) {
        await sleep(delayMs)
      }

      const interrupted = shouldInterrupt?.() ?? false
      const queuedMessages = options?.consumeQueuedMessages
        ? (getQueuedMessages?.() ?? []).map((message) => message.content)
        : []

      options?.onRun?.({
        context,
        instruction,
        interrupted,
        queuedMessages,
        runCount,
      })

      return [assistantMessage(`reply:${instruction}`)]
    },
  }
}

const agentContext = {
  systemPrompt: 'test',
  conversationHistory: [],
  tools: [],
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createObservabilityMocks(): {
  tracer: ToolTracer
  logger: ToolLogger
  updates: Array<{ spanId: string; update: Record<string, unknown> }>
  endings: Array<{
    spanId: string
    status?: 'success' | 'error'
    metadata?: Record<string, unknown>
  }>
  infos: Array<{ event: string; data?: Record<string, unknown> }>
  warns: Array<{ event: string; data?: Record<string, unknown> }>
  errors: Array<{ event: string; data?: Record<string, unknown> }>
} {
  const updates: Array<{ spanId: string; update: Record<string, unknown> }> = []
  const endings: Array<{
    spanId: string
    status?: 'success' | 'error'
    metadata?: Record<string, unknown>
  }> = []
  const infos: Array<{ event: string; data?: Record<string, unknown> }> = []
  const warns: Array<{ event: string; data?: Record<string, unknown> }> = []
  const errors: Array<{ event: string; data?: Record<string, unknown> }> = []

  return {
    tracer: {
      startSpan(sessionId, name, parentId, options) {
        return {
          id: `span_${Math.random().toString(36).slice(2)}`,
          sessionId,
          parentId,
          kind: options?.kind ?? 'turn',
          name,
          agentName: options?.agentName,
          startTime: new Date().toISOString(),
          status: 'running',
          data: options?.data,
          metadata: options?.metadata,
          children: [],
        }
      },
      updateSpan(spanId, update) {
        updates.push({ spanId, update })
      },
      endSpan(spanId, status, metadata) {
        endings.push({ spanId, status, metadata })
      },
      getSpan() {
        return undefined
      },
    },
    logger: {
      info(event, data) {
        infos.push({ event, data })
      },
      warn(event, data) {
        warns.push({ event, data })
      },
      error(event, data) {
        errors.push({ event, data })
      },
    },
    updates,
    endings,
    infos,
    warns,
    errors,
  }
}

describe('AgentControl', () => {
  beforeEach(() => {
    agentContext.conversationHistory = []
  })

  test('spawn returns agent id and label', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent(), agentContext, 'do work', { label: 'worker-1' })

    expect('agentId' in result).toBe(true)
    if (!('agentId' in result)) {
      throw new Error('expected spawn success')
    }
    expect(result.agentId).toMatch(/^agent_/)
    expect(result.label).toBe('worker-1')
  })

  test('activeAgentCount increments for running agents', () => {
    const control = new AgentControl()
    control.spawn(createAgent({ delayMs: 20 }), agentContext, 'do work')
    expect(control.activeAgentCount).toBe(1)
  })

  test('spawn rejects invalid agent instances', () => {
    const control = new AgentControl()
    const result = control.spawn({} as never, agentContext, 'do work')

    expect(result).toEqual({ error: 'Invalid agent instance.' })
  })

  test('spawn rejects empty instruction', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent(), agentContext, '   ')

    expect(result).toEqual({ error: 'Instruction is required.' })
  })

  test('completed agents transition to completed state', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ text: 'complete' }), agentContext, 'finish')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getStatus(result.agentId)?.state).toBe('completed')
  })

  test('getOutput returns assistant text after completion', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ text: 'final output' }), agentContext, 'finish')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getOutput(result.agentId)).toBe('final output')
  })

  test('getOutput is undefined while agent is still running', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 20 }), agentContext, 'finish')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    expect(control.getOutput(result.agentId)).toBeUndefined()
  })

  test('getSnapshot returns empty array when no agents', () => {
    const control = new AgentControl()

    expect(control.getSnapshot()).toEqual([])
  })

  test('getSnapshot returns completed agent with output and originalInstruction', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ text: 'snapshot output' }), agentContext, 'inspect')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getSnapshot()).toEqual([
      {
        id: result.agentId,
        label: result.label,
        role: undefined,
        state: 'completed',
        instruction: 'inspect',
        output: 'snapshot output',
        error: undefined,
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      },
    ])
  })

  test('getSnapshot returns failed agent with error', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ error: 'snapshot boom' }), agentContext, 'inspect')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getSnapshot()).toEqual([
      {
        id: result.agentId,
        label: result.label,
        role: undefined,
        state: 'failed',
        instruction: 'inspect',
        output: undefined,
        error: 'snapshot boom',
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      },
    ])
  })

  test('getSnapshot returns running agent state', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 40 }), agentContext, 'long task')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    expect(control.getSnapshot()).toEqual([
      {
        id: result.agentId,
        label: result.label,
        role: undefined,
        state: 'running',
        instruction: 'long task',
        output: undefined,
        error: undefined,
        startedAt: expect.any(Number),
        endedAt: undefined,
      },
    ])

    control.close(result.agentId)
    await sleep(50)
  })

  test('getSnapshot preserves originalInstruction even after agent completes', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ text: 'done' }), agentContext, 'preserve this')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    const internal = control as unknown as {
      entries: Map<string, { instruction: string; originalInstruction: string }>
    }
    const entry = internal.entries.get(result.agentId)

    expect(entry?.instruction).toBe('')
    expect(entry?.originalInstruction).toBe('preserve this')
    expect(control.getSnapshot()[0]?.instruction).toBe('preserve this')
  })

  test('failed agents expose failed status and error', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ error: 'boom' }), agentContext, 'fail')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getStatus(result.agentId)?.state).toBe('failed')
    expect(control.getStatus(result.agentId)?.error).toBe('boom')
  })

  test('getAgentInfo returns label role and status', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent(), agentContext, 'finish', {
      label: 'researcher',
      role: 'explorer',
    })
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getAgentInfo(result.agentId)).toEqual({
      label: 'researcher',
      role: 'explorer',
      status: { state: 'completed' },
    })
  })

  test('listAgents includes depth and elapsedMs', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 5 }), agentContext, 'finish', {
      label: 'worker',
      depth: 3,
    })
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.listAgents()).toEqual([
      {
        id: result.agentId,
        label: 'worker',
        role: undefined,
        status: { state: 'completed' },
        depth: 3,
        elapsedMs: expect.any(Number),
      },
    ])
  })

  test('restoreSnapshot restores completed agents', () => {
    const control = new AgentControl()
    control.restoreSnapshot([
      {
        id: 'agent_completed',
        label: 'worker',
        role: 'explorer',
        state: 'completed',
        instruction: 'inspect repository',
        output: 'all good',
        startedAt: 10,
        endedAt: 20,
      },
    ])

    expect(control.getStatus('agent_completed')).toEqual({
      state: 'completed',
      label: 'worker',
      role: 'explorer',
      depth: 1,
      elapsedMs: 10,
      output: 'all good',
    })
    expect(control.getOutput('agent_completed')).toBe('all good')
  })

  test('restoreSnapshot marks running agents as failed', () => {
    const control = new AgentControl()
    control.restoreSnapshot([
      {
        id: 'agent_running',
        label: 'worker',
        state: 'running',
        instruction: 'still working',
        startedAt: Date.now() - 50,
      },
    ])

    expect(control.getStatus('agent_running')).toEqual({
      state: 'failed',
      label: 'worker',
      depth: 1,
      elapsedMs: expect.any(Number),
      error: 'Process restarted while agent was running',
    })
    expect(control.getOutput('agent_running')).toBeUndefined()
  })

  test('restoreSnapshot preserves failed agents as-is', () => {
    const control = new AgentControl()
    control.restoreSnapshot([
      {
        id: 'agent_failed',
        label: 'worker',
        state: 'failed',
        instruction: 'bad task',
        error: 'boom',
        startedAt: 10,
        endedAt: 30,
      },
    ])

    expect(control.getStatus('agent_failed')).toEqual({
      state: 'failed',
      label: 'worker',
      depth: 1,
      elapsedMs: 20,
      error: 'boom',
    })
  })

  test('waitAny and waitAll work with restored agents', async () => {
    const control = new AgentControl()
    control.restoreSnapshot([
      {
        id: 'agent_done',
        label: 'done',
        state: 'completed',
        instruction: 'complete',
        output: 'done output',
        startedAt: 10,
        endedAt: 20,
      },
      {
        id: 'agent_lost',
        label: 'lost',
        state: 'running',
        instruction: 'still running',
        startedAt: 10,
      },
    ])

    await expect(control.waitAny(['agent_done', 'agent_lost'], 1)).resolves.toEqual({
      statuses: {
        agent_done: {
          state: 'completed',
          label: 'done',
          depth: 1,
          elapsedMs: 10,
          output: 'done output',
        },
        agent_lost: {
          state: 'failed',
          label: 'lost',
          depth: 1,
          elapsedMs: expect.any(Number),
          error: 'Process restarted while agent was running',
        },
      },
      timedOut: false,
    })

    await expect(control.waitAll(['agent_done', 'agent_lost'], 1)).resolves.toEqual({
      statuses: {
        agent_done: {
          state: 'completed',
          label: 'done',
          depth: 1,
          elapsedMs: 10,
          output: 'done output',
        },
        agent_lost: {
          state: 'failed',
          label: 'lost',
          depth: 1,
          elapsedMs: expect.any(Number),
          error: 'Process restarted while agent was running',
        },
      },
      timedOut: false,
    })
  })

  test('listAgents includes restored agents', () => {
    const control = new AgentControl()
    control.restoreSnapshot([
      {
        id: 'agent_restored',
        label: 'worker',
        role: 'explorer',
        state: 'completed',
        instruction: 'inspect',
        output: 'done',
        startedAt: 10,
        endedAt: 15,
      },
    ])

    expect(control.listAgents()).toEqual([
      {
        id: 'agent_restored',
        label: 'worker',
        role: 'explorer',
        status: { state: 'completed' },
        depth: 1,
        elapsedMs: 5,
      },
    ])
  })

  test('waitAny resolves when one agent finishes', async () => {
    const control = new AgentControl()
    const fast = control.spawn(createAgent({ delayMs: 5, text: 'fast' }), agentContext, 'fast')
    const slow = control.spawn(createAgent({ delayMs: 50, text: 'slow' }), agentContext, 'slow')
    if (!('agentId' in fast) || !('agentId' in slow)) throw new Error('expected spawn success')

    const result = await control.waitAny([fast.agentId, slow.agentId], 100)

    expect(result.timedOut).toBe(false)
    expect(result.statuses[fast.agentId]?.state).toBe('completed')
  })

  test('waitAll waits for all requested agents', async () => {
    const control = new AgentControl()
    const a = control.spawn(createAgent({ delayMs: 5 }), agentContext, 'a')
    const b = control.spawn(createAgent({ delayMs: 10 }), agentContext, 'b')
    if (!('agentId' in a) || !('agentId' in b)) throw new Error('expected spawn success')

    const result = await control.waitAll([a.agentId, b.agentId], 100)

    expect(result.timedOut).toBe(false)
    expect(result.statuses[a.agentId]?.state).toBe('completed')
    expect(result.statuses[b.agentId]?.state).toBe('completed')
  })

  test('waitAny reports timeout when nothing finishes in time', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 50 }), agentContext, 'wait')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    const waitResult = await control.waitAny([result.agentId], 5)

    expect(waitResult.timedOut).toBe(true)
    expect(waitResult.statuses[result.agentId]?.state).toBe('running')
  })

  test('waitAll reports timeout when not all agents finish in time', async () => {
    const control = new AgentControl()
    const fast = control.spawn(createAgent({ delayMs: 5 }), agentContext, 'fast')
    const slow = control.spawn(createAgent({ delayMs: 50 }), agentContext, 'slow')
    if (!('agentId' in fast) || !('agentId' in slow)) throw new Error('expected spawn success')

    const result = await control.waitAll([fast.agentId, slow.agentId], 10)

    expect(result.timedOut).toBe(true)
    expect(result.statuses[fast.agentId]?.state).toBe('completed')
    expect(result.statuses[slow.agentId]?.state).toBe('running')
  })

  test('wait responses include not_found for unknown ids', async () => {
    const control = new AgentControl()
    const result = await control.waitAny(['missing-agent'], 1)

    expect(result.timedOut).toBe(false)
    expect(result.statuses['missing-agent']).toEqual({ state: 'not_found' })
  })

  test('close marks an agent closed', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 30 }), agentContext, 'close me')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    const status = control.close(result.agentId)
    expect(status?.state).toBe('closed')
  })

  test('close decreases activeAgentCount', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 30 }), agentContext, 'close me')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    control.close(result.agentId)

    expect(control.activeAgentCount).toBe(0)
  })

  test('close returns undefined for unknown ids', () => {
    const control = new AgentControl()
    expect(control.close('missing-agent')).toBeUndefined()
  })

  test('closed agents are not overwritten by later completion', async () => {
    const control = new AgentControl()
    const result = control.spawn(
      createAgent({ delayMs: 20, text: 'late output' }),
      agentContext,
      'work',
    )
    if (!('agentId' in result)) throw new Error('expected spawn success')

    control.close(result.agentId)
    await sleep(30)

    expect(control.getStatus(result.agentId)?.state).toBe('closed')
    expect(control.getOutput(result.agentId)).toBeUndefined()
  })

  test('spawn passes instruction through to the controlled agent', async () => {
    const control = new AgentControl()
    let seenInstruction = ''
    const result = control.spawn(
      createAgent({
        onRun: (instruction) => {
          seenInstruction = instruction
        },
      }),
      agentContext,
      'inspect repository',
    )
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(seenInstruction).toBe('inspect repository')
  })

  test('sendInput to a running agent succeeds', () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ delayMs: 20 }), agentContext, 'work')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    expect(control.sendInput(result.agentId, 'status update')).toEqual({ success: true })
  })

  test('sendInput to a completed agent fails', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ text: 'done' }), agentContext, 'work')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.sendInput(result.agentId, 'follow up')).toEqual({
      success: false,
      error: `Sub-agent "${result.agentId}" is already in terminal state "completed".`,
    })
  })

  test('sendInput to a failed agent fails', async () => {
    const control = new AgentControl()
    const result = control.spawn(createAgent({ error: 'boom' }), agentContext, 'work')
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.sendInput(result.agentId, 'follow up')).toEqual({
      success: false,
      error: `Sub-agent "${result.agentId}" is already in terminal state "failed".`,
    })
  })

  test('sendInput to unknown agent fails', () => {
    const control = new AgentControl()
    expect(control.sendInput('missing-agent', 'hello')).toEqual({
      success: false,
      error: 'Sub-agent "missing-agent" was not found.',
    })
  })

  test('queued messages are delivered to the agent', async () => {
    const control = new AgentControl()
    let queuedMessages: string[] = []
    const result = control.spawn(
      createQueuedAwareAgent({
        delayMs: 20,
        onQueuedMessages: (messages) => {
          queuedMessages = messages
        },
      }),
      agentContext,
      'work',
    )
    if (!('agentId' in result)) throw new Error('expected spawn success')

    expect(control.sendInput(result.agentId, 'first update')).toEqual({ success: true })
    expect(control.sendInput(result.agentId, 'second update')).toEqual({ success: true })

    await control.waitAll([result.agentId], 100)

    expect(queuedMessages).toEqual(['first update', 'second update'])
  })

  test('interrupt flag is set when interrupt=true', async () => {
    const control = new AgentControl()
    let interrupted = false
    const result = control.spawn(
      createQueuedAwareAgent({
        delayMs: 20,
        onInterruptCheck: (value) => {
          interrupted = value
        },
      }),
      agentContext,
      'work',
    )
    if (!('agentId' in result)) throw new Error('expected spawn success')

    expect(control.sendInput(result.agentId, 'urgent update', { interrupt: true })).toEqual({
      success: true,
    })

    await control.waitAll([result.agentId], 100)

    expect(interrupted).toBe(true)
  })

  describe('interactive mode', () => {
    test('interactive agents enter waiting state after initial instruction', async () => {
      const control = new AgentControl()
      const result = control.spawn(createInteractiveAgent(), agentContext, 'start', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      const ready = await control.waitReady([result.agentId], 100)

      expect(ready.timedOut).toBe(false)
      expect(control.getStatus(result.agentId)).toEqual({
        state: 'waiting',
        label: result.label,
        depth: 1,
        elapsedMs: expect.any(Number),
        mode: 'interactive',
        output: 'reply:start',
      })
      expect(control.activeAgentCount).toBe(1)

      control.close(result.agentId)
    })

    test('sendInput wakes a waiting interactive agent and updates output', async () => {
      const control = new AgentControl()
      const seenInstructions: string[] = []
      const result = control.spawn(
        createInteractiveAgent({
          delayMsByRun: { 2: 15 },
          onRun: ({ instruction }) => {
            seenInstructions.push(instruction)
          },
        }),
        agentContext,
        'start',
        { mode: 'interactive' },
      )
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)
      expect(control.sendInput(result.agentId, 'follow up')).toEqual({ success: true })
      await control.waitReady([result.agentId], 100)

      expect(seenInstructions).toEqual(['start', 'follow up'])
      expect(control.getOutput(result.agentId)).toBe('reply:follow up')

      control.close(result.agentId)
    })

    test('messages queued while running are processed without waiting for another sendInput', async () => {
      const control = new AgentControl()
      const seenInstructions: string[] = []
      const result = control.spawn(
        createInteractiveAgent({
          consumeQueuedMessages: false,
          delayMsByRun: { 1: 20 },
          onRun: ({ instruction }) => {
            seenInstructions.push(instruction)
          },
        }),
        agentContext,
        'initial',
        { mode: 'interactive' },
      )
      if (!('agentId' in result)) throw new Error('expected spawn success')

      expect(control.sendInput(result.agentId, 'queued while running')).toEqual({ success: true })
      await control.waitReady([result.agentId], 100)

      expect(seenInstructions).toEqual(['initial', 'queued while running'])
      expect(control.getStatus(result.agentId)?.state).toBe('waiting')

      control.close(result.agentId)
    })

    test('waitReady resolves for interactive waiting state and standard completion', async () => {
      const control = new AgentControl()
      const interactive = control.spawn(createInteractiveAgent(), agentContext, 'ready', {
        mode: 'interactive',
      })
      const standard = control.spawn(createAgent({ text: 'done' }), agentContext, 'finish')
      if (!('agentId' in interactive) || !('agentId' in standard)) {
        throw new Error('expected spawn success')
      }

      const interactiveReady = await control.waitReady([interactive.agentId], 100)
      const standardReady = await control.waitReady([standard.agentId], 100)

      expect(interactiveReady.statuses[interactive.agentId]?.state).toBe('waiting')
      expect(standardReady.statuses[standard.agentId]?.state).toBe('completed')

      control.close(interactive.agentId)
    })

    test('waitReady honors waitAll for multiple interactive agents', async () => {
      const control = new AgentControl()
      const fast = control.spawn(createInteractiveAgent(), agentContext, 'fast', {
        mode: 'interactive',
      })
      const slow = control.spawn(
        createInteractiveAgent({
          delayMsByRun: { 1: 25 },
        }),
        agentContext,
        'slow',
        { mode: 'interactive' },
      )
      if (!('agentId' in fast) || !('agentId' in slow)) {
        throw new Error('expected spawn success')
      }

      const ready = await control.waitReady([fast.agentId, slow.agentId], 100, true)

      expect(ready.timedOut).toBe(false)
      expect(ready.statuses[fast.agentId]?.state).toBe('waiting')
      expect(ready.statuses[slow.agentId]?.state).toBe('waiting')

      control.close(fast.agentId)
      control.close(slow.agentId)
    })

    test('interactive conversation history accumulates across turns', async () => {
      const control = new AgentControl()
      const historyLengths: number[] = []
      const result = control.spawn(
        createInteractiveAgent({
          onRun: ({ context }) => {
            historyLengths.push(context.conversationHistory.length)
          },
        }),
        agentContext,
        'first',
        { mode: 'interactive' },
      )
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)
      expect(control.sendInput(result.agentId, 'second')).toEqual({ success: true })
      await control.waitReady([result.agentId], 100)

      expect(historyLengths).toEqual([0, 1])

      control.close(result.agentId)
    })

    test('multiple sendInput cycles keep the same interactive agent alive', async () => {
      const control = new AgentControl()
      const outputs: string[] = []
      const result = control.spawn(createInteractiveAgent(), agentContext, 'first', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)
      outputs.push(control.getOutput(result.agentId) ?? '')

      expect(control.sendInput(result.agentId, 'second')).toEqual({ success: true })
      await control.waitReady([result.agentId], 100)
      outputs.push(control.getOutput(result.agentId) ?? '')

      expect(control.sendInput(result.agentId, 'third')).toEqual({ success: true })
      await control.waitReady([result.agentId], 100)
      outputs.push(control.getOutput(result.agentId) ?? '')

      expect(control.getStatus(result.agentId)?.state).toBe('waiting')
      expect(outputs).toEqual(['reply:first', 'reply:second', 'reply:third'])

      control.close(result.agentId)
    })

    test('sendInput before waitForInput consumes the signal does not lose the queued message', async () => {
      const control = new AgentControl()
      const releaseFirstTurn = createDeferred<void>()
      const seenInstructions: string[] = []

      const deferredAgent = {
        async run(
          _context: unknown,
          instruction: string,
          _userImages?: unknown,
          _onNewMessage?: unknown,
          _onTextDelta?: unknown,
          _shouldInterrupt?: () => boolean,
          _getQueuedMessages?: () => Array<{ content: string }>,
        ): Promise<Message[]> {
          seenInstructions.push(instruction)
          if (seenInstructions.length === 1) {
            await releaseFirstTurn.promise
          }
          return [assistantMessage(`reply:${instruction}`)]
        },
      }

      const result = control.spawn(deferredAgent, agentContext, 'first', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      expect(control.sendInput(result.agentId, 'second')).toEqual({ success: true })
      releaseFirstTurn.resolve()

      await control.waitReady([result.agentId], 100)

      expect(seenInstructions).toEqual(['first', 'second'])
      expect(control.getOutput(result.agentId)).toBe('reply:second')

      control.close(result.agentId)
    })

    test('interactive agents fail cleanly when a later turn throws', async () => {
      const control = new AgentControl()
      let runCount = 0
      const flakyAgent = {
        async run(): Promise<Message[]> {
          runCount++
          if (runCount === 2) {
            throw new Error('second turn boom')
          }
          return [assistantMessage('reply:first')]
        },
      }

      const result = control.spawn(flakyAgent, agentContext, 'first', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)
      expect(control.sendInput(result.agentId, 'second')).toEqual({ success: true })
      await control.waitAll([result.agentId], 100)

      const internal = control as unknown as {
        entries: Map<string, { inputSignal?: unknown }>
      }
      expect(control.getStatus(result.agentId)).toEqual({
        state: 'failed',
        label: result.label,
        depth: 1,
        elapsedMs: expect.any(Number),
        mode: 'interactive',
        output: 'reply:first',
        error: 'second turn boom',
      })
      expect(control.activeAgentCount).toBe(0)
      expect(internal.entries.get(result.agentId)?.inputSignal).toBeUndefined()
    })

    test('waitReady times out while the first interactive turn is still running', async () => {
      const control = new AgentControl()
      const releaseFirstTurn = createDeferred<void>()
      const slowStartAgent = {
        async run(): Promise<Message[]> {
          await releaseFirstTurn.promise
          return [assistantMessage('reply:slow start')]
        },
      }

      const result = control.spawn(slowStartAgent, agentContext, 'slow start', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      const timedOut = await control.waitReady([result.agentId], 5)

      expect(timedOut.timedOut).toBe(true)
      expect(timedOut.statuses[result.agentId]?.state).toBe('running')
      expect(control.getOutput(result.agentId)).toBeUndefined()

      releaseFirstTurn.resolve()
      await control.waitReady([result.agentId], 100)
      control.close(result.agentId)
    })

    test('interactive snapshots include mode and waiting restores as failed', async () => {
      const control = new AgentControl()
      const result = control.spawn(createInteractiveAgent(), agentContext, 'snapshot me', {
        mode: 'interactive',
        label: 'interactive-agent',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)

      expect(control.getSnapshot()).toEqual([
        {
          id: result.agentId,
          label: 'interactive-agent',
          role: undefined,
          mode: 'interactive',
          state: 'waiting',
          instruction: 'snapshot me',
          output: 'reply:snapshot me',
          error: undefined,
          startedAt: expect.any(Number),
          endedAt: undefined,
        },
      ])

      const restored = new AgentControl()
      restored.restoreSnapshot(control.getSnapshot())

      expect(restored.getStatus(result.agentId)).toEqual({
        state: 'failed',
        label: 'interactive-agent',
        depth: 1,
        elapsedMs: expect.any(Number),
        mode: 'interactive',
        output: 'reply:snapshot me',
        error: 'Process restarted while agent was waiting',
      })

      control.close(result.agentId)
    })

    test('close clears waiting interactive agents and activeAgentCount', async () => {
      const control = new AgentControl()
      const result = control.spawn(createInteractiveAgent(), agentContext, 'close me', {
        mode: 'interactive',
      })
      if (!('agentId' in result)) throw new Error('expected spawn success')

      await control.waitReady([result.agentId], 100)
      const internal = control as unknown as {
        entries: Map<string, { inputSignal?: unknown }>
      }
      expect(internal.entries.get(result.agentId)?.inputSignal).toBeDefined()

      control.close(result.agentId)

      expect(control.getStatus(result.agentId)?.state).toBe('closed')
      expect(control.activeAgentCount).toBe(0)
      expect(internal.entries.get(result.agentId)?.inputSignal).toBeUndefined()
    })
  })

  test('completing an agent updates and ends the linked sub-agent span', async () => {
    const { tracer, logger, updates, endings, infos } = createObservabilityMocks()
    const control = new AgentControl({ tracer, logger })
    const result = control.spawn(createAgent({ text: 'final output' }), agentContext, 'finish', {
      label: 'worker-1',
      role: 'explorer',
      traceSpanId: 'span_subagent_1',
      sessionId: 'sess_test',
    })
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(updates).toContainEqual({
      spanId: 'span_subagent_1',
      update: {
        data: {
          success: true,
          durationMs: expect.any(Number),
          output: 'final output',
          outputSummary: 'final output',
        },
      },
    })
    expect(endings).toContainEqual({
      spanId: 'span_subagent_1',
      status: 'success',
      metadata: undefined,
    })
    expect(infos).toContainEqual({
      event: 'subagent_spawned',
      data: {
        agentId: result.agentId,
        sessionId: 'sess_test',
        label: 'worker-1',
        role: 'explorer',
        mode: 'standard',
        depth: 1,
        traceSpanId: 'span_subagent_1',
      },
    })
    expect(infos).toContainEqual({
      event: 'subagent_completed',
      data: {
        agentId: result.agentId,
        sessionId: 'sess_test',
        label: 'worker-1',
        role: 'explorer',
        durationMs: expect.any(Number),
        traceSpanId: 'span_subagent_1',
        outputSummary: 'final output',
      },
    })
  })

  test('failing an agent filters secrets and ends the linked sub-agent span with error', async () => {
    const { tracer, logger, updates, endings, errors } = createObservabilityMocks()
    const control = new AgentControl({ tracer, logger })
    const result = control.spawn(createAgent({ error: 'secret boom' }), agentContext, 'finish', {
      label: 'worker-2',
      traceSpanId: 'span_subagent_2',
      secretFilter: {
        filter(text: string) {
          return text.replaceAll('secret', '[REDACTED]')
        },
        addSecret() {},
        removeSecret() {},
      },
      sessionId: 'sess_test',
    })
    if (!('agentId' in result)) throw new Error('expected spawn success')

    await control.waitAll([result.agentId], 100)

    expect(control.getStatus(result.agentId)?.error).toBe('[REDACTED] boom')
    expect(updates).toContainEqual({
      spanId: 'span_subagent_2',
      update: {
        data: {
          success: false,
          durationMs: expect.any(Number),
          error: '[REDACTED] boom',
        },
      },
    })
    expect(endings).toContainEqual({
      spanId: 'span_subagent_2',
      status: 'error',
      metadata: {
        error: '[REDACTED] boom',
      },
    })
    expect(errors).toContainEqual({
      event: 'subagent_failed',
      data: {
        agentId: result.agentId,
        sessionId: 'sess_test',
        label: 'worker-2',
        role: undefined,
        durationMs: expect.any(Number),
        traceSpanId: 'span_subagent_2',
        error: '[REDACTED] boom',
      },
    })
  })

  test('closing a running agent ends the linked sub-agent span and logs the close', () => {
    const { tracer, logger, updates, endings, infos } = createObservabilityMocks()
    const control = new AgentControl({ tracer, logger })
    const result = control.spawn(createAgent({ delayMs: 30 }), agentContext, 'close me', {
      label: 'worker-3',
      traceSpanId: 'span_subagent_3',
      sessionId: 'sess_test',
    })
    if (!('agentId' in result)) throw new Error('expected spawn success')

    control.close(result.agentId)

    expect(updates).toContainEqual({
      spanId: 'span_subagent_3',
      update: {
        data: {
          success: false,
          closedByParent: true,
          durationMs: expect.any(Number),
        },
      },
    })
    expect(endings).toContainEqual({
      spanId: 'span_subagent_3',
      status: 'error',
      metadata: {
        error: 'Closed by parent',
      },
    })
    expect(infos).toContainEqual({
      event: 'subagent_closed',
      data: {
        agentId: result.agentId,
        sessionId: 'sess_test',
        label: 'worker-3',
        role: undefined,
        previousState: 'running',
        durationMs: expect.any(Number),
        traceSpanId: 'span_subagent_3',
      },
    })
  })
})
