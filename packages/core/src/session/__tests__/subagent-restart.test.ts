import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { SessionDB } from '@zero-os/observe'
import type { Message } from '@zero-os/shared'
import { loadConfig } from '../../config/loader'
import { AgentControl } from '../../agent/agent-control'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assistantMessage(text: string): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_restart_test',
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
  }
}

function createAgent(options?: { text?: string; delayMs?: number; error?: string }) {
  return {
    async run(): Promise<Message[]> {
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

const config = loadConfig(join(process.cwd(), '.zero', 'config.yaml'))
const secrets = new Map<string, string>([['openai_codex_api_key', 'sk-test-placeholder']])

describe('sub-agent restart recovery', () => {
  let sessionDb: SessionDB

  afterAll(() => {
    sessionDb?.close()
  })

  test('drain snapshot can restore completed agents and fail interrupted running agents', async () => {
    sessionDb = SessionDB.createInMemory()
    const modelRouter = new ModelRouter(config, secrets)
    modelRouter.init()
    const toolRegistry = new ToolRegistry()

    const manager = new SessionManager(modelRouter, toolRegistry, { sessionDb }, sessionDb)
    const session = manager.create('telegram', {
      channelId: 'chat_restart',
      channelName: 'telegram',
    })
    const internal = session as unknown as {
      agentControl: AgentControl
      mutex: { acquire(ownerId: string): Promise<void>; release(ownerId: string): void }
    }

    const completed = internal.agentControl.spawn(
      createAgent({ text: 'completed output', delayMs: 5 }),
      { systemPrompt: 'test', conversationHistory: [], tools: [] },
      'complete task',
      { label: 'completed-agent' },
    )
    const failed = internal.agentControl.spawn(
      createAgent({ error: 'agent failed', delayMs: 5 }),
      { systemPrompt: 'test', conversationHistory: [], tools: [] },
      'fail task',
      { label: 'failed-agent' },
    )
    const running = internal.agentControl.spawn(
      createAgent({ text: 'slow output', delayMs: 100 }),
      { systemPrompt: 'test', conversationHistory: [], tools: [] },
      'slow task',
      { label: 'running-agent' },
    )
    if (!('agentId' in completed) || !('agentId' in failed) || !('agentId' in running)) {
      throw new Error('expected spawn success')
    }

    await internal.mutex.acquire('restart-test')
    await sleep(20)

    const interrupted = await manager.drainAndCollectInterrupted(10)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]).toMatchObject({
      sessionId: session.data.id,
      source: 'telegram',
      channelId: 'chat_restart',
      channelName: 'telegram',
    })
    expect(interrupted[0]?.subAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: completed.agentId,
          label: 'completed-agent',
          state: 'completed',
          instruction: 'complete task',
          output: 'completed output',
        }),
        expect.objectContaining({
          id: failed.agentId,
          label: 'failed-agent',
          state: 'failed',
          instruction: 'fail task',
          error: 'agent failed',
        }),
        expect.objectContaining({
          id: running.agentId,
          label: 'running-agent',
          state: 'running',
          instruction: 'slow task',
        }),
      ]),
    )

    internal.agentControl.close(running.agentId)
    internal.mutex.release('restart-test')

    const restoredManager = new SessionManager(modelRouter, toolRegistry, { sessionDb }, sessionDb)
    restoredManager.restoreFromDB()

    const restoredSession = restoredManager.get(session.data.id)
    expect(restoredSession).toBeDefined()
    restoredSession?.restoreSubAgentSnapshot(interrupted[0]?.subAgents ?? [])

    const restoredControl = (restoredSession as unknown as { agentControl: AgentControl })
      .agentControl

    expect(restoredControl.getStatus(completed.agentId)).toEqual({
      state: 'completed',
      label: 'completed-agent',
      depth: 1,
      elapsedMs: expect.any(Number),
      output: 'completed output',
    })
    expect(restoredControl.getOutput(completed.agentId)).toBe('completed output')
    expect(restoredControl.getStatus(failed.agentId)).toEqual({
      state: 'failed',
      label: 'failed-agent',
      depth: 1,
      elapsedMs: expect.any(Number),
      error: 'agent failed',
    })
    expect(restoredControl.getStatus(running.agentId)).toEqual({
      state: 'failed',
      label: 'running-agent',
      depth: 1,
      elapsedMs: expect.any(Number),
      error: 'Process restarted while agent was running',
    })

    await expect(
      restoredControl.waitAll([completed.agentId, failed.agentId, running.agentId], 1),
    ).resolves.toEqual({
      statuses: {
        [completed.agentId]: {
          state: 'completed',
          label: 'completed-agent',
          depth: 1,
          elapsedMs: expect.any(Number),
          output: 'completed output',
        },
        [failed.agentId]: {
          state: 'failed',
          label: 'failed-agent',
          depth: 1,
          elapsedMs: expect.any(Number),
          error: 'agent failed',
        },
        [running.agentId]: {
          state: 'failed',
          label: 'running-agent',
          depth: 1,
          elapsedMs: expect.any(Number),
          error: 'Process restarted while agent was running',
        },
      },
      timedOut: false,
    })
  })

  test('drain snapshot marks waiting interactive agents as failed on restore', async () => {
    sessionDb = SessionDB.createInMemory()
    const modelRouter = new ModelRouter(config, secrets)
    modelRouter.init()
    const toolRegistry = new ToolRegistry()

    const manager = new SessionManager(modelRouter, toolRegistry, { sessionDb }, sessionDb)
    const session = manager.create('telegram', {
      channelId: 'chat_restart_waiting',
      channelName: 'telegram',
    })
    const internal = session as unknown as {
      agentControl: AgentControl
      mutex: { acquire(ownerId: string): Promise<void>; release(ownerId: string): void }
    }

    const waiting = internal.agentControl.spawn(
      createAgent({ text: 'interactive ready' }),
      { systemPrompt: 'test', conversationHistory: [], tools: [] },
      'interactive task',
      { label: 'waiting-agent', mode: 'interactive' },
    )
    if (!('agentId' in waiting)) {
      throw new Error('expected spawn success')
    }

    await internal.agentControl.waitReady([waiting.agentId], 100)
    await internal.mutex.acquire('restart-test-waiting')

    const interrupted = await manager.drainAndCollectInterrupted(10)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.subAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: waiting.agentId,
          label: 'waiting-agent',
          mode: 'interactive',
          state: 'waiting',
          instruction: 'interactive task',
          output: 'interactive ready',
        }),
      ]),
    )

    internal.agentControl.close(waiting.agentId)
    internal.mutex.release('restart-test-waiting')

    const restoredManager = new SessionManager(modelRouter, toolRegistry, { sessionDb }, sessionDb)
    restoredManager.restoreFromDB()
    const restoredSession = restoredManager.get(session.data.id)
    restoredSession?.restoreSubAgentSnapshot(interrupted[0]?.subAgents ?? [])

    const restoredControl = (restoredSession as unknown as { agentControl: AgentControl })
      .agentControl

    expect(restoredControl.getStatus(waiting.agentId)).toEqual({
      state: 'failed',
      label: 'waiting-agent',
      depth: 1,
      elapsedMs: expect.any(Number),
      mode: 'interactive',
      output: 'interactive ready',
      error: 'Process restarted while agent was waiting',
    })
  })
})
