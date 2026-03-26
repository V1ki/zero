import { describe, expect, test } from 'bun:test'
import type { SystemConfig } from '@zero-os/shared'
import { ModelRouter } from '../router'

const API_KEY = 'sk-c6c02cbd0c25473f97f9be0da6070f6d'
const RUN_REAL_API = process.env.ZERO_RUN_MODEL_REAL_API === '1'

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

describe.skipIf(!RUN_REAL_API)('ModelRouter (Real API)', () => {
  test('init selects the default model', () => {
    const router = new ModelRouter(config, secrets)
    const result = router.init()
    expect(result.success).toBe(true)
    expect(result.model?.modelName).toBe('gpt-5.3-codex-medium')
  })

  test('exact model switch works', () => {
    const router = new ModelRouter(config, secrets)
    router.init()
    const result = router.switchModel('gpt-5.3-codex-medium')
    expect(result.success).toBe(true)
  })

  test('fuzzy search finds models', () => {
    const router = new ModelRouter(config, secrets)
    const result = router.switchModel('codex')
    expect(result.success).toBe(true)
    expect(result.model?.modelName).toBe('gpt-5.3-codex-medium')
  })

  test('unknown model returns error', () => {
    const router = new ModelRouter(config, secrets)
    const result = router.switchModel('nonexistent-model-xyz')
    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  test('provider-qualified model switch works', () => {
    const router = new ModelRouter(config, secrets)
    router.init()
    const result = router.switchModel('openai-codex/gpt-5.3-codex-medium')
    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('openai-codex')
    expect(result.model?.modelName).toBe('gpt-5.3-codex-medium')
  })

  test('getAdapter returns a working adapter', async () => {
    const router = new ModelRouter(config, secrets)
    router.init()
    const adapter = router.getAdapter()
    const healthy = await adapter.healthCheck()
    expect(healthy).toBe(true)
  }, 30000)

  test('fallback chain works', async () => {
    const router = new ModelRouter(config, secrets)
    router.init()
    const result = await router.fallback()
    expect(result.success).toBe(true)
  }, 30000)

  test('registry lists all models', () => {
    const router = new ModelRouter(config, secrets)
    const models = router.getRegistry().listModels()
    expect(models.length).toBe(1)
    expect(models[0].modelName).toBe('gpt-5.3-codex-medium')
  })

  test('unknown model list does not duplicate provider prefix', () => {
    const config: SystemConfig = {
      providers: {
        chatgpt: {
          apiType: 'openai_responses',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
          models: {
            'gpt-5.4': {
              modelId: 'gpt-5.4',
              maxContext: 400000,
              maxOutput: 128000,
              capabilities: ['tools'],
              tags: ['coding'],
            },
          },
        },
      },
      defaultModel: 'gpt-5.4',
      fallbackChain: ['gpt-5.4'],
      schedules: [],
      fuseList: [],
    }

    const router = new ModelRouter(config, new Map())
    router.init()

    const result = router.switchModel('missing-model')
    expect(result.success).toBe(false)
    expect(result.message).toContain('  - chatgpt/gpt-5.4')
    expect(result.message).not.toContain('chatgpt/chatgpt/gpt-5.4')
  })
})
