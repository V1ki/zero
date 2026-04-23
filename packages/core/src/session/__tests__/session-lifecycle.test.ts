import { afterAll, describe, expect, test } from 'bun:test'
import { ModelRouter } from '@zero-os/model'
import type { Message, SystemConfig } from '@zero-os/shared'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { createTestProjectRoot } from './test-helpers'
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
      },
    },
  },
  defaultModel: 'gpt-5.3-codex-medium',
  fallbackChain: ['gpt-5.3-codex-medium'],
  schedules: [],
  fuseList: [],
}

const secrets = new Map([['openai_codex_api_key', API_KEY]])
const testProject = createTestProjectRoot('zero-session-lifecycle-')

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

describe('Session Lifecycle', () => {
  afterAll(() => {
    testProject.cleanup()
  })

  test('complete lifecycle: create → init → message → get messages (real API)', async () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    session.initAgent({
      name: 'lifecycle-test',
      agentInstruction: 'You are a helpful assistant. Reply briefly.',
    })

    let messages: Message[]
    try {
      messages = await session.handleMessage('Say exactly "lifecycle test" and nothing else.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('403')) {
        console.warn('[test] real API unavailable for session lifecycle test, skipping assertions')
        return
      }
      throw error
    }
    expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    const allMessages = session.getMessages()
    expect(allMessages.length).toBeGreaterThanOrEqual(2)

    const lastMsg = allMessages[allMessages.length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content.length).toBeGreaterThan(0)
  }, 30000)

  test('session starts without routing metadata', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })
    expect(session.data.source).toBe('web')
    expect(session.data.channelId).toBeUndefined()
    expect(session.data.channelName).toBeUndefined()
  })

  test('ensureChannelContext updates routing metadata', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })
    session.ensureChannelContext('default', 'web')
    expect(session.data.channelId).toBe('default')
    expect(session.data.channelName).toBe('web')
  })

  test('session data has correct initial fields', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('feishu', router, registry, {
      projectRoot: testProject.projectRoot,
    })
    expect(session.data.id).toMatch(/^sess_/)
    expect(session.data.source).toBe('feishu')
    expect(session.data.currentModel).toBe('openai-codex/gpt-5.3-codex-medium')
    expect(session.data.createdAt).toBeDefined()
    expect(session.data.updatedAt).toBeDefined()
  })

  test('getMessages returns empty before any message', () => {
    const router = createRouter()
    const registry = createToolRegistry()
    const session = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })
    expect(session.getMessages()).toEqual([])
  })
})
