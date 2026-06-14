import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import type { SystemConfig } from '@zero-os/shared'
import type { AgentControl } from '../../agent/agent-control'
import type { Session } from '../session'

export interface TestProjectRoot {
  projectRoot: string
  zeroDir: string
  cleanup: () => void
}

export function createTestProjectRoot(prefix = 'zero-test-project-'): TestProjectRoot {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix))
  const zeroDir = join(projectRoot, '.zero')

  mkdirSync(zeroDir, { recursive: true })

  return {
    projectRoot,
    zeroDir,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  }
}

export const TEST_API_KEY = 'sk-test-placeholder'

export const TEST_SYSTEM_CONFIG: SystemConfig = {
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
      },
    },
  },
  defaultModel: 'gpt-5.3-codex-medium',
  fallbackChain: ['gpt-5.3-codex-medium'],
  schedules: [],
  fuseList: [],
}

export function createTestModelRouter(
  options: {
    config?: SystemConfig
    secrets?: Map<string, string>
  } = {},
): ModelRouter {
  const router = new ModelRouter(
    options.config ?? TEST_SYSTEM_CONFIG,
    options.secrets ?? new Map([['openai_codex_api_key', TEST_API_KEY]]),
  )
  router.init()
  return router
}

export function setSessionAgentForTest<TAgent>(session: Session, agent: TAgent): void {
  ;(session as unknown as { agentRuntime: { agent: TAgent } }).agentRuntime.agent = agent
}

export function getSessionAgentForTest<TAgent>(session: Session): TAgent | null {
  return (session as unknown as { agentRuntime: { agent: TAgent | null } }).agentRuntime.agent
}

export function getSessionAgentControlForTest(session: Session): AgentControl {
  return (session as unknown as { agentRuntime: { agentControl: AgentControl } }).agentRuntime
    .agentControl
}

export function setSessionAgentControlForTest<TControl>(
  session: Session,
  agentControl: TControl,
): void {
  ;(session as unknown as { agentRuntime: { agentControl: TControl } }).agentRuntime.agentControl =
    agentControl
}
