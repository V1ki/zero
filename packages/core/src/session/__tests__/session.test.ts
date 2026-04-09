import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { ObservabilityStore } from '@zero-os/observe'
import type { SystemConfig } from '@zero-os/shared'
import { BashTool } from '../../tool/bash'
import { MemoryReadTool } from '../../tool/memory-read'
import { MemorySearchTool } from '../../tool/memory-search'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { createTestProjectRoot } from './test-helpers'
import { SessionManager } from '../manager'
import { Session } from '../session'

const API_KEY = 'sk-c6c02cbd0c25473f97f9be0da6070f6d'
const CLAUDE_OAUTH_JSON = JSON.stringify({
  accessToken: 'claude-access-token',
  refreshToken: 'claude-refresh-token',
  expiresAt: Date.now() + 3600_000,
  tokenType: 'Bearer',
  scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
})

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
const anthropicSecrets = new Map([['claude_oauth_session', CLAUDE_OAUTH_JSON]])
const loggerDir = join(import.meta.dir, '__fixtures__/session-logs')
const testProject = createTestProjectRoot('zero-session-test-')

function createRouter() {
  const router = new ModelRouter(config, secrets)
  router.init()
  return router
}

function createAnthropicRouter() {
  const anthropicConfig: SystemConfig = {
    providers: {
      anthropic: {
        apiType: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        auth: { type: 'oauth2', oauthTokenRef: 'claude_oauth_session' },
        models: {
          'claude-opus-4-6': {
            modelId: 'claude-opus-4-6',
            maxContext: 200000,
            maxOutput: 32000,
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['powerful'],
          },
        },
      },
    },
    defaultModel: 'claude-opus-4-6',
    fallbackChain: ['claude-opus-4-6'],
    schedules: [],
    fuseList: [],
  }
  const router = new ModelRouter(anthropicConfig, anthropicSecrets)
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
    testProject.cleanup()
  })

  test('creates with correct initial state', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

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

    const session = new Session(
      'feishu',
      router,
      registry,
      { observability, projectRoot: testProject.projectRoot },
      undefined,
      sessionId,
    )
    const activeLink = join(loggerDir, 'sessions', '_active', sessionId)

    expect(existsSync(activeLink)).toBe(true)

    session.setStatus('completed')
    expect(existsSync(activeLink)).toBe(false)
  })

  test('listModels returns all registered models', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })
    const models = session.listModels()

    expect(models).toContain('openai-codex/gpt-5.3-codex-medium')
    expect(models).toContain('openai-codex/gpt-5.4-medium')
  })

  test('switchModel updates the session model label', async () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const result = await session.switchModel('gpt-5.4-medium')

    expect(result.success).toBe(true)
    expect(session.data.currentModel).toBe('openai-codex/gpt-5.4-medium')
    expect(session.data.modelHistory.at(-1)?.model).toBe('openai-codex/gpt-5.4-medium')
  })

  test('initAgent resolves dedicated closure adapter when taskClosureModel is configured', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      taskClosureModel: 'openai-codex/gpt-5.4-medium',
      projectRoot: testProject.projectRoot,
    })

    session.initAgent({
      name: 'test-agent',
      agentInstruction: 'You are a helpful assistant. Reply briefly.',
    })

    const agent = (
      session as unknown as {
        agent: {
          closureAdapter: unknown
          obs?: {
            closureModelLabel?: string
            closureProviderName?: string
          }
        } | null
      }
    ).agent
    expect(agent).toBeDefined()
    expect(agent?.closureAdapter).toBe(router.resolveModel('openai-codex/gpt-5.4-medium')?.adapter)
    expect(agent?.obs?.closureModelLabel).toBe('openai-codex/gpt-5.4-medium')
    expect(agent?.obs?.closureProviderName).toBe('openai-codex')
  })

  test('uses injected projectRoot for workspace and prompt paths', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const agentName = `project-root-agent-${Date.now()}`
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    session.initAgent({
      name: agentName,
      agentInstruction: 'Use the injected project root.',
    })

    const workspacePath = join(testProject.projectRoot, '.zero', 'workspace', agentName)
    const leakedWorkspacePath = join(process.cwd(), '.zero', 'workspace', agentName)
    const staticContext = (
      session as unknown as {
        ensureStaticContext: () => {
          projectRoot: string
          workspacePath: string
          systemPrompt: string
        }
      }
    ).ensureStaticContext()

    expect(existsSync(workspacePath)).toBe(true)
    expect(existsSync(leakedWorkspacePath)).toBe(false)
    expect(staticContext.projectRoot).toBe(testProject.projectRoot)
    expect(staticContext.workspacePath).toBe(workspacePath)
    expect(staticContext.systemPrompt).toContain(workspacePath)
  })

  test('uses memory_read in tool context when memory_search is present', () => {
    const router = createAnthropicRouter()
    const registry = new ToolRegistry()
    registry.register(new ReadTool())
    registry.register(new MemorySearchTool())
    registry.register(new MemoryReadTool())

    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const staticContext = (
      session as unknown as {
        ensureStaticContext: () => {
          tools: Array<{ name: string }>
        }
      }
    ).ensureStaticContext()

    expect(staticContext.tools.map((tool) => tool.name)).toContain('memory_search')
    expect(staticContext.tools.map((tool) => tool.name)).toContain('memory_read')
  })

  test('handles real conversation with AI (real API)', async () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })
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
    const manager = new SessionManager(router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const s1 = manager.create('web')
    const s2 = manager.create('feishu')

    expect(manager.listActive()).toHaveLength(2)
    expect(manager.get(s1.data.id)).toBeDefined()
    expect(manager.get(s2.data.id)).toBeDefined()
  })

  test('remove session', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const manager = new SessionManager(router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const s1 = manager.create('web')
    manager.remove(s1.data.id)
    expect(manager.get(s1.data.id)).toBeUndefined()
  })
})
