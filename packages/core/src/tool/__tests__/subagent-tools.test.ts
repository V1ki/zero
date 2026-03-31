import { describe, expect, test } from 'bun:test'
import type { AgentControlHandle } from '@zero-os/shared'
import { CloseAgentTool } from '../close-agent'
import { WaitAgentTool } from '../wait-agent'

const ctx = {
  sessionId: 'test_subagent_tools_session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

describe('WaitAgentTool', () => {
  test('accepts wait_all alias', async () => {
    let called: 'waitAny' | 'waitAll' | 'waitReady' | undefined
    const tool = new WaitAgentTool()
    const agentControl = {
      waitAny: async () => {
        called = 'waitAny'
        return { statuses: {}, timedOut: false }
      },
      waitAll: async () => {
        called = 'waitAll'
        return { statuses: {}, timedOut: false }
      },
      waitReady: async () => {
        called = 'waitReady'
        return { statuses: {}, timedOut: false }
      },
      getTraceSpanId: () => undefined,
    } as unknown as AgentControlHandle

    const result = await tool.run(
      {
        ...ctx,
        agentControl,
      },
      { ids: ['agent_123'], wait_all: true },
    )

    expect(result.success).toBe(true)
    expect(called).toBe('waitAll')
  })

  test('routes resolveOn=ready to waitReady', async () => {
    let called: 'waitAny' | 'waitAll' | 'waitReady' | undefined
    let waitReadyArgs: { ids: string[]; timeoutMs?: number; waitAll?: boolean } | undefined
    const tool = new WaitAgentTool()
    const agentControl = {
      waitAny: async () => {
        called = 'waitAny'
        return { statuses: {}, timedOut: false }
      },
      waitAll: async () => {
        called = 'waitAll'
        return { statuses: {}, timedOut: false }
      },
      waitReady: async (ids: string[], timeoutMs?: number, waitAll?: boolean) => {
        called = 'waitReady'
        waitReadyArgs = { ids, timeoutMs, waitAll }
        return { statuses: { agent_123: { state: 'waiting' } }, timedOut: false }
      },
      getTraceSpanId: () => undefined,
    } as unknown as AgentControlHandle

    const result = await tool.run(
      {
        ...ctx,
        agentControl,
      },
      { ids: ['agent_123'], resolveOn: 'ready', waitAll: true, timeoutMs: 42 },
    )

    expect(result.success).toBe(true)
    expect(called).toBe('waitReady')
    expect(waitReadyArgs).toEqual({
      ids: ['agent_123'],
      timeoutMs: 42,
      waitAll: true,
    })
  })
})

describe('CloseAgentTool', () => {
  test('accepts agent_id alias from spawn_agent output', async () => {
    let closedId: string | undefined
    const tool = new CloseAgentTool()
    const agentControl = {
      getTraceSpanId: () => undefined,
      close: (agentId: string) => {
        closedId = agentId
        return { state: 'closed' }
      },
    } as unknown as AgentControlHandle

    const result = await tool.run(
      {
        ...ctx,
        agentControl,
      },
      { agent_id: 'agent_456' },
    )

    expect(result.success).toBe(true)
    expect(closedId).toBe('agent_456')
  })
})
