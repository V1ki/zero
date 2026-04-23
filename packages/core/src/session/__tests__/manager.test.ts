import { afterAll, describe, expect, test } from 'bun:test'
import { ModelRouter } from '@zero-os/model'
import type { ProviderAdapter } from '@zero-os/model'
import type { Message, SystemConfig } from '@zero-os/shared'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { createTestProjectRoot } from './test-helpers'
import { SessionManager } from '../manager'

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
        'gpt-5.4-medium': {
          modelId: 'gpt-5.4-medium',
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
const testProject = createTestProjectRoot('zero-session-manager-')

function createRouter() {
  const router = new ModelRouter(config, secrets)
  router.init()
  return router
}

function createToolRegistry() {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

function createManager() {
  return new SessionManager(createRouter(), createToolRegistry(), {
    projectRoot: testProject.projectRoot,
  })
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeMessage(
  role: Message['role'],
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `msg_${role}_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_manager_test',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function seedMeaningfulSession(session: unknown): void {
  const typedSession = session as { messages: Message[] }
  typedSession.messages.push(
    makeMessage(
      'user',
      '请帮我把这次部署失败的问题排查清楚，我需要知道根因、修复步骤和回归验证方式，还希望你把这次处理里用到的关键判断依据、检查命令和复盘结论都整理出来。',
    ),
    {
      id: 'assistant_tool',
      sessionId: 'sess_manager_test',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'tool_1', name: 'bash', input: { cmd: 'bun run check' } }],
      createdAt: new Date().toISOString(),
    },
    makeMessage(
      'assistant',
      '我已经检查了迁移脚本、环境变量和部署日志，问题来源于旧 schema 没有完成升级，同时整理了修复和验证步骤，并把失败链路、需要复核的配置、回滚风险和后续部署时的注意事项也梳理出来了。',
    ),
    makeMessage(
      'user',
      '那就把这次处理过程总结清楚，后面我还会回头看这次排障和修复是怎么做的。我希望这次会话本身就能留下足够多的信息，后续别人接手也能快速理解问题背景和处理结果。',
    ),
    makeMessage(
      'assistant',
      '已经完成修复并验证通过，也把关键原因、修改点和回归检查项总结出来，后续可以直接复用这次会话里的结论。这已经不只是一次短问答，而是一整次完整的排障、修复和验证过程。',
    ),
  )
}

describe('SessionManager', () => {
  afterAll(() => {
    testProject.cleanup()
  })

  test('create assigns unique ID', () => {
    const manager = createManager()
    const s1 = manager.create('web')
    const s2 = manager.create('web')

    expect(s1.data.id).not.toBe(s2.data.id)
    expect(s1.data.id).toMatch(/^sess_/)
    expect(s2.data.id).toMatch(/^sess_/)
  })

  test('listCurrent returns only binding-backed sessions', () => {
    const manager = createManager()
    const detached = manager.create('web')
    const current = manager.getOrCreateForChannel('web', 'default', 'web').session

    expect(manager.listCurrent().map((session) => session.data.id)).toEqual([current.data.id])
    expect(manager.listAll().map((session) => session.data.id)).toEqual(
      expect.arrayContaining([detached.data.id, current.data.id]),
    )
    expect(manager.getPlacement(detached.data.id)).toBe('background')
    expect(manager.getPlacement(current.data.id)).toBe('current')
  })

  test('get non-existent returns undefined', () => {
    const manager = createManager()
    expect(manager.get('nonexistent-id')).toBeUndefined()
  })

  test('getOrCreateForChannel: new channel creates new current session', () => {
    const manager = createManager()
    const result = manager.getOrCreateForChannel('telegram', 'channel-1')

    expect(result.isNew).toBe(true)
    expect(result.session.data.source).toBe('telegram')
    expect(result.session.data.channelId).toBe('channel-1')
    expect(manager.isCurrentSessionForChannel('telegram', 'channel-1', undefined, result.session.data.id)).toBe(
      true,
    )
  })

  test('getOrCreateForChannel: same channel reuses current binding', () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('telegram', 'channel-2')
    const second = manager.getOrCreateForChannel('telegram', 'channel-2')

    expect(first.isNew).toBe(true)
    expect(second.isNew).toBe(false)
    expect(second.session.data.id).toBe(first.session.data.id)
  })

  test('getOrCreateForChannel: same source and channelId stay isolated by channelName', () => {
    const manager = createManager()
    const ops = manager.getOrCreateForChannel('feishu', 'shared-room', 'feishu:ops')
    const hr = manager.getOrCreateForChannel('feishu', 'shared-room', 'feishu:hr')

    expect(ops.session.data.id).not.toBe(hr.session.data.id)
    expect(ops.session.data.channelName).toBe('feishu:ops')
    expect(hr.session.data.channelName).toBe('feishu:hr')
    expect(manager.listCurrent().map((session) => session.data.id).sort()).toEqual(
      [ops.session.data.id, hr.session.data.id].sort(),
    )
  })

  test('startNewForChannel rotates binding and backgrounds previous session', () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('feishu', 'channel-rotate')
    const firstId = first.session.data.id

    const rotated = manager.startNewForChannel('feishu', 'channel-rotate')
    const secondId = rotated.session.data.id

    expect(rotated.previousSessionId).toBe(firstId)
    expect(secondId).not.toBe(firstId)
    expect(manager.getPlacement(firstId)).toBe('background')
    expect(manager.getPlacement(secondId)).toBe('current')
    expect(manager.getCurrentBinding('feishu', 'channel-rotate')?.sessionId).toBe(secondId)

    const current = manager.getOrCreateForChannel('feishu', 'channel-rotate')
    expect(current.isNew).toBe(false)
    expect(current.session.data.id).toBe(secondId)
  })

  test('startNewForChannel rotates only the targeted channelName binding', () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('feishu', 'room-1', 'feishu:ops')
    const second = manager.getOrCreateForChannel('feishu', 'room-1', 'feishu:hr')

    const rotated = manager.startNewForChannel('feishu', 'room-1', { channelName: 'feishu:ops' })

    expect(rotated.previousSessionId).toBe(first.session.data.id)
    expect(manager.getPlacement(first.session.data.id)).toBe('background')
    expect(manager.getPlacement(second.session.data.id)).toBe('current')
    expect(manager.getCurrentBinding('feishu', 'room-1', 'feishu:hr')?.sessionId).toBe(
      second.session.data.id,
    )
  })

  test('switchCurrentSessionForChannel can restore an older background session as current', () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('web', 'default', 'web')
    const rotated = manager.startNewForChannel('web', 'default', 'web')

    const switched = manager.switchCurrentSessionForChannel(
      'web',
      'default',
      first.session.data.id,
      'web',
    )

    expect(rotated.previousSessionId).toBe(first.session.data.id)
    expect(switched?.session.data.id).toBe(first.session.data.id)
    expect(switched?.previousSessionId).toBe(rotated.session.data.id)
    expect(manager.getPlacement(first.session.data.id)).toBe('current')
    expect(manager.getPlacement(rotated.session.data.id)).toBe('background')
  })

  test('startNewForChannel: skips session memory evaluation for short sessions', async () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('web', 'short-session')
    first.session.initAgent({
      name: 'manager-short-session',
      agentInstruction: 'Test session memory rotation.',
    })

    let evaluationCalled = false
    ;(
      first.session as unknown as {
        evaluateSessionMemory: (prompt: string) => Promise<void>
      }
    ).evaluateSessionMemory = async () => {
      evaluationCalled = true
    }

    manager.startNewForChannel('web', 'short-session')

    await Promise.resolve()
    expect(evaluationCalled).toBe(false)
    expect(manager.getPlacement(first.session.data.id)).toBe('background')
  })

  test('startNewForChannel: evaluates meaningful backgrounded sessions', async () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('web', 'meaningful-session')
    first.session.initAgent({
      name: 'manager-meaningful-session',
      agentInstruction: 'Test session memory rotation.',
    })
    seedMeaningfulSession(first.session)

    const gate = createDeferred<void>()
    let receivedPrompt: string | undefined
    ;(
      first.session as unknown as {
        evaluateSessionMemory: (prompt: string) => Promise<void>
      }
    ).evaluateSessionMemory = async (prompt) => {
      receivedPrompt = prompt
      await gate.promise
    }

    manager.startNewForChannel('web', 'meaningful-session')

    expect(receivedPrompt).toContain('session 类型的记忆')
    expect(manager.getPlacement(first.session.data.id)).toBe('background')

    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(manager.getPlacement(first.session.data.id)).toBe('background')
  })

  test('startNewForChannel: keeps backgrounding even when evaluation fails', async () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('web', 'failed-eval-session')
    first.session.initAgent({
      name: 'manager-failed-eval-session',
      agentInstruction: 'Test session memory rotation.',
    })
    seedMeaningfulSession(first.session)

    ;(
      first.session as unknown as {
        evaluateSessionMemory: () => Promise<void>
      }
    ).evaluateSessionMemory = async () => {
      throw new Error('boom')
    }

    const originalWarn = console.warn
    console.warn = () => {}

    try {
      manager.startNewForChannel('web', 'failed-eval-session')
      expect(manager.getPlacement(first.session.data.id)).toBe('background')

      await Promise.resolve()
      await Promise.resolve()

      expect(manager.getPlacement(first.session.data.id)).toBe('background')
    } finally {
      console.warn = originalWarn
    }
  })

  test('startNewForChannel: waits for in-flight turn before session memory evaluation', async () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('web', 'busy-session')
    first.session.initAgent({
      name: 'manager-busy-session',
      agentInstruction: 'Test session memory rotation.',
    })
    seedMeaningfulSession(first.session)

    const waitGate = createDeferred<void>()
    let waited = false
    let evaluationCalled = false

    ;(
      first.session as unknown as {
        isTurnInProgress: () => boolean
        waitForTurnComplete: () => Promise<void>
        evaluateSessionMemory: () => Promise<void>
      }
    ).isTurnInProgress = () => true
    ;(
      first.session as unknown as {
        waitForTurnComplete: () => Promise<void>
      }
    ).waitForTurnComplete = async () => {
      waited = true
      await waitGate.promise
    }
    ;(
      first.session as unknown as {
        evaluateSessionMemory: () => Promise<void>
      }
    ).evaluateSessionMemory = async () => {
      expect(manager.getPlacement(first.session.data.id)).toBe('background')
      evaluationCalled = true
    }

    manager.startNewForChannel('web', 'busy-session')

    await Promise.resolve()
    expect(waited).toBe(true)
    expect(evaluationCalled).toBe(false)
    expect(manager.getPlacement(first.session.data.id)).toBe('background')

    waitGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(evaluationCalled).toBe(true)
  })

  test('remove cleans up channel binding', () => {
    const manager = createManager()
    const { session } = manager.getOrCreateForChannel('feishu', 'channel-4')
    const sessionId = session.data.id

    expect(manager.get(sessionId)).toBeDefined()

    manager.remove(sessionId)

    expect(manager.get(sessionId)).toBeUndefined()
    expect(manager.getCurrentBinding('feishu', 'channel-4')).toBeUndefined()

    const result = manager.getOrCreateForChannel('feishu', 'channel-4')
    expect(result.isNew).toBe(true)
    expect(result.session.data.id).not.toBe(sessionId)
  })

  test('channel model preference stays isolated per channel scope', async () => {
    const manager = createManager()
    const ops = manager.getOrCreateForChannel('feishu', 'room-1', 'feishu:ops')
    const hr = manager.getOrCreateForChannel('feishu', 'room-2', 'feishu:hr')

    await ops.session.switchModel('gpt-5.4-medium')

    expect(ops.session.data.currentModel).toBe('openai-codex/gpt-5.4-medium')
    expect(hr.session.data.currentModel).toBe('openai-codex/gpt-5.3-codex-medium')
    expect(manager.getPreferredModel('feishu', 'room-1', 'feishu:ops')).toBe(
      'openai-codex/gpt-5.4-medium',
    )
    expect(manager.getPreferredModel('feishu', 'room-2', 'feishu:hr')).toBe(
      'openai-codex/gpt-5.3-codex-medium',
    )
  })

  test('startNewForChannel inherits the scope model preference', async () => {
    const manager = createManager()
    const first = manager.getOrCreateForChannel('telegram', 'room-scope')

    await first.session.switchModel('gpt-5.4-medium')

    const rotated = manager.startNewForChannel('telegram', 'room-scope')
    expect(rotated.session.data.currentModel).toBe('openai-codex/gpt-5.4-medium')
  })

  test('setTaskClosureModel updates existing sessions and future sessions', () => {
    const router = createRouter()
    const manager = new SessionManager(router, createToolRegistry(), {
      taskClosureModel: 'openai-codex/gpt-5.3-codex-medium',
      projectRoot: testProject.projectRoot,
    })
    const current = manager.create('web')
    current.initAgent({
      name: 'manager-test-agent',
      agentInstruction: 'Test closure model updates.',
    })

    const currentAgent = (
      current as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(currentAgent?.closureAdapter).toBe(
      router.resolveModel('openai-codex/gpt-5.3-codex-medium')?.adapter,
    )

    manager.setTaskClosureModel('openai-codex/gpt-5.4-medium')

    const refreshedAgent = (
      current as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(refreshedAgent?.closureAdapter).toBe(
      router.resolveModel('openai-codex/gpt-5.4-medium')?.adapter,
    )

    const future = manager.create('web')
    future.initAgent({
      name: 'manager-test-agent-next',
      agentInstruction: 'Test future closure model updates.',
    })
    const futureAgent = (
      future as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(futureAgent?.closureAdapter).toBe(
      router.resolveModel('openai-codex/gpt-5.4-medium')?.adapter,
    )
  })
})
