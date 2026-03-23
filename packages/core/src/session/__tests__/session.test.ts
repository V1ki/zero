import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { ObservabilityStore } from '@zero-os/observe'
import type { SystemConfig } from '@zero-os/shared'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'

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
const loggerDir = join(import.meta.dir, '__fixtures__/session-logs')

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

describe('Session', () => {
  afterAll(() => {
    rmSync(join(import.meta.dir, '__fixtures__'), { recursive: true, force: true })
  })

  test('creates with correct initial state', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry)

    expect(session.data.id).toMatch(/^sess_/)
    expect(session.data.source).toBe('web')
    expect(session.data.status).toBe('active')
    expect(session.data.currentModel).toBe('openai-codex/gpt-5.3-codex-medium')
  })

  test('active sessions maintain _active symlink lifecycle', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const observability = new ObservabilityStore(loggerDir)
    const sessionId = 'sess_20260313_1423_fei_a1b2'

    const session = new Session('feishu', router, registry, { observability }, undefined, sessionId)
    const activeLink = join(loggerDir, 'sessions', '_active', sessionId)

    expect(existsSync(activeLink)).toBe(true)

    session.setStatus('completed')
    expect(existsSync(activeLink)).toBe(false)
  })

  test('listModels returns all registered models', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry)
    const models = session.listModels()

    expect(models).toContain('openai-codex/gpt-5.3-codex-medium')
    expect(models).toContain('openai-codex/gpt-5.4-medium')
  })

  test('switchModel updates the session model label', async () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry)

    const result = await session.switchModel('gpt-5.4-medium')

    expect(result.success).toBe(true)
    expect(session.data.currentModel).toBe('openai-codex/gpt-5.4-medium')
    expect(session.data.modelHistory.at(-1)?.model).toBe('openai-codex/gpt-5.4-medium')
  })

  test('handles real conversation with AI (real API)', async () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry)
    session.initAgent({
      name: 'test-agent',
      agentInstruction: 'You are a helpful assistant. Reply briefly.',
    })

    const messages = await session.handleMessage('Say exactly "ZeRo OS running" and nothing else.')

    expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant
    const lastMsg = messages[messages.length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content.length).toBeGreaterThan(0)
  }, 30000)
})

describe('SessionManager', () => {
  test('creates and lists sessions', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const manager = new SessionManager(router, registry)

    const s1 = manager.create('web')
    const s2 = manager.create('feishu')

    expect(manager.listActive()).toHaveLength(2)
    expect(manager.get(s1.data.id)).toBeDefined()
    expect(manager.get(s2.data.id)).toBeDefined()
  })

  test('remove session', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const manager = new SessionManager(router, registry)

    const s1 = manager.create('web')
    manager.remove(s1.data.id)
    expect(manager.get(s1.data.id)).toBeUndefined()
  })
})
