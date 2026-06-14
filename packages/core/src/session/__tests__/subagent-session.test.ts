import { describe, expect, test } from 'bun:test'
import { ModelRouter } from '@zero-os/model'
import type { SystemConfig } from '@zero-os/shared'
import type { AgentSnapshot } from '../../agent/agent-control'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
import { ToolRegistry } from '../../tool/registry'
import { Session } from '../session'
import { setSessionAgentControlForTest } from './test-helpers'

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

const secrets = new Map([['openai_codex_api_key', 'sk-test-placeholder']])

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

describe('Session sub-agent snapshot helpers', () => {
  test('getSubAgentSnapshot delegates to agentControl', () => {
    const session = new Session('web', createRouter(), createToolRegistry())
    const snapshot: AgentSnapshot[] = [
      {
        id: 'agent_1',
        label: 'worker',
        state: 'completed',
        instruction: 'inspect',
        output: 'done',
        startedAt: 1,
        endedAt: 2,
      },
    ]
    setSessionAgentControlForTest(session, {
      getSnapshot: () => snapshot,
    })

    expect(session.getSubAgentSnapshot()).toEqual(snapshot)
  })

  test('restoreSubAgentSnapshot delegates to agentControl', () => {
    const session = new Session('web', createRouter(), createToolRegistry())
    const snapshot: AgentSnapshot[] = [
      {
        id: 'agent_2',
        label: 'worker',
        state: 'failed',
        instruction: 'inspect',
        error: 'boom',
        startedAt: 1,
        endedAt: 2,
      },
    ]

    let restored: AgentSnapshot[] | undefined
    setSessionAgentControlForTest(session, {
      restoreSnapshot: (entries: AgentSnapshot[]) => {
        restored = entries
      },
    })

    session.restoreSubAgentSnapshot(snapshot)

    expect(restored).toEqual(snapshot)
  })
})
