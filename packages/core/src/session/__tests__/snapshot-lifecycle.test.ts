import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { ObservabilityStore, Tracer } from '@zero-os/observe'
import type { Message, SystemConfig, ToolContext, ToolResult } from '@zero-os/shared'
import { generateId, getSessionLogRelativeDir, now } from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { Session } from '../session'
import { createTestProjectRoot, setSessionAgentForTest } from './test-helpers'

const API_KEY = 'sk-test-placeholder'
const tempDirs: string[] = []
const testProject = createTestProjectRoot('zero-session-snapshot-')

const config: SystemConfig = {
  providers: {
    'openai-codex': {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://example.invalid',
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

class ExtraTool extends BaseTool {
  name = 'extra'
  description = 'Extra tool for snapshot tests'
  parameters = { type: 'object', properties: {} }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

function createRouter(): ModelRouter {
  const router = new ModelRouter(config, new Map([['openai_codex_api_key', API_KEY]]))
  router.init()
  return router
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

function createTempObservability(): {
  dir: string
  observability: ObservabilityStore
  tracer: Tracer
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-snapshot-session-'))
  tempDirs.push(dir)
  return {
    dir,
    observability: new ObservabilityStore(dir),
    tracer: new Tracer(dir),
  }
}

function makeMessage(sessionId: string, role: 'user' | 'assistant', text: string): Message {
  return {
    id: generateId(),
    sessionId,
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

function installFakeAgent(session: Session): void {
  setSessionAgentForTest(session, {
    run: async (
      _context: unknown,
      userMessage: string,
      _images: unknown,
      onNewMessage?: (message: Message) => void,
    ) => {
      const user = makeMessage(session.data.id, 'user', userMessage)
      const assistant = makeMessage(session.data.id, 'assistant', 'ok')
      onNewMessage?.(user)
      onNewMessage?.(assistant)
      return [user, assistant]
    },
  })
}

function installTurnCapturingAgent(session: Session, turnIndexes: number[]): void {
  setSessionAgentForTest(session, {
    run: async (
      _context: unknown,
      userMessage: string,
      _images: unknown,
      onNewMessage?: (message: Message) => void,
      _onTextDelta?: unknown,
      _shouldInterrupt?: unknown,
      _getQueuedMessages?: unknown,
      requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
    ) => {
      turnIndexes.push(requestLogMeta?.turnIndex ?? -1)
      const user = makeMessage(session.data.id, 'user', userMessage)
      const assistant = makeMessage(session.data.id, 'assistant', 'ok')
      onNewMessage?.(user)
      onNewMessage?.(assistant)
      return [user, assistant]
    },
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  testProject.cleanup()
})

describe('Session snapshot lifecycle', () => {
  test('first handled message writes a complete session_start snapshot', async () => {
    const { observability, tracer } = createTempObservability()
    const session = new Session('web', createRouter(), createRegistry(), {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')

    const snapshots = observability.readSessionSnapshots(session.data.id)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].trigger).toBe('session_start')
    expect(snapshots[0].model).toBe('openai-codex/gpt-5.3-codex-medium')
    expect(snapshots[0].systemPrompt).toBeTruthy()
    expect(snapshots[0].tools).toEqual(['read', 'bash'])
    expect(snapshots[0].parentSnapshot).toBeUndefined()
  })

  test('tool registry changes write a tools_changed snapshot with parent linkage', async () => {
    const { observability, tracer } = createTempObservability()
    const registry = createRegistry()
    const session = new Session('web', createRouter(), registry, {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')
    registry.register(new ExtraTool())
    installFakeAgent(session)
    await session.handleMessage('hello again')

    const snapshots = observability.readSessionSnapshots(session.data.id)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].trigger).toBe('tools_changed')
    expect(snapshots[1].parentSnapshot).toBe(snapshots[0].id)
    expect(snapshots[1].tools).toEqual(['read', 'bash', 'extra'])
    expect(snapshots[1].systemPrompt).toBeTruthy()
  })

  test('prompt-only changes write a context_updated snapshot', async () => {
    const { observability, tracer } = createTempObservability()
    const session = new Session('web', createRouter(), createRegistry(), {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'First prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')

    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Updated prompt' })
    installFakeAgent(session)
    await session.handleMessage('hello again')

    const snapshots = observability.readSessionSnapshots(session.data.id)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].trigger).toBe('context_updated')
    expect(snapshots[1].parentSnapshot).toBe(snapshots[0].id)
    expect(snapshots[1].tools).toEqual(['read', 'bash'])
    expect(snapshots[1].systemPrompt).toBeTruthy()
    expect(snapshots[1].systemPrompt).not.toBe(snapshots[0].systemPrompt)
  })

  test('switchModel writes a complete model_switch snapshot', async () => {
    const { observability, tracer } = createTempObservability()
    const session = new Session('web', createRouter(), createRegistry(), {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')
    const result = await session.switchModel('gpt-5.4-medium')

    expect(result.success).toBe(true)

    const snapshots = observability.readSessionSnapshots(session.data.id)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].trigger).toBe('model_switch')
    expect(snapshots[1].parentSnapshot).toBe(snapshots[0].id)
    expect(snapshots[1].model).toBe('openai-codex/gpt-5.4-medium')
    expect(snapshots[1].systemPrompt).toBeTruthy()
  })

  test('restored session reuses the latest complete snapshot state', async () => {
    const { observability, tracer } = createTempObservability()
    const router = createRouter()
    const registry = createRegistry()
    const session = new Session('web', router, registry, {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')
    const existingSnapshotId = observability.readSessionSnapshots(session.data.id)[0]?.id

    const restored = Session.restore(
      session.data,
      session.getMessages(),
      router,
      registry,
      { observability, tracer, projectRoot: testProject.projectRoot },
      session.getSystemPrompt(),
    )
    restored.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(restored)

    await restored.handleMessage('follow up')

    const snapshots = observability.readSessionSnapshots(session.data.id)
    expect(snapshots).toHaveLength(1)
    const restoredSession = restored as unknown as { currentSnapshotId?: string }
    expect(restoredSession.currentSnapshotId).toBe(existingSnapshotId)
  })

  test('restored sessions continue turnIndex from prior request logs', async () => {
    const { observability, tracer } = createTempObservability()
    const router = createRouter()
    const registry = createRegistry()
    const session = new Session('web', router, registry, {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })

    const initialTurns: number[] = []
    installTurnCapturingAgent(session, initialTurns)
    await session.handleMessage('hello')
    await session.handleMessage('hello again')

    expect(initialTurns).toEqual([1, 2])

    const restored = Session.restore(
      session.data,
      session.getMessages(),
      router,
      registry,
      { observability, tracer, projectRoot: testProject.projectRoot },
      session.getSystemPrompt(),
    )
    restored.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })

    const restoredTurns: number[] = []
    installTurnCapturingAgent(restored, restoredTurns)
    await restored.handleMessage('follow up')

    expect(restoredTurns).toEqual([3])
  })

  test('uses trace-only snapshot persistence when tracer is available', async () => {
    const { dir, observability, tracer } = createTempObservability()
    const session = new Session('web', createRouter(), createRegistry(), {
      observability,
      tracer,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'snapshot-agent', agentInstruction: 'Test snapshot prompt' })
    installFakeAgent(session)

    await session.handleMessage('hello')

    const sessionDir = join(dir, getSessionLogRelativeDir(session.data.id))
    expect(existsSync(join(sessionDir, 'trace.jsonl'))).toBe(true)
    expect(existsSync(join(sessionDir, 'snapshots.jsonl'))).toBe(false)
    expect(observability.readSessionSnapshots(session.data.id)).toHaveLength(1)
  })
})
