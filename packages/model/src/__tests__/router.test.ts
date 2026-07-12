import { describe, expect, test } from 'bun:test'
import type { SystemConfig } from '@zero-os/shared'
import type { ModelCatalogEntry } from '../catalog/types'
import { ProviderHealthRegistry } from '../provider-health'
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

describe('ModelRouter logical routes', () => {
  const routeConfig: SystemConfig = {
    providers: {
      chatgpt: {
        apiType: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
        models: {
          'gpt-5.6-sol': {
            modelId: 'gpt-5.6-sol',
            maxContext: 372000,
            maxOutput: 128000,
            reasoningEffort: 'low',
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['frontier', 'coding'],
          },
          'gpt-5.6-terra': {
            modelId: 'gpt-5.6-terra',
            maxContext: 372000,
            maxOutput: 128000,
            reasoningEffort: 'medium',
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['balanced', 'coding'],
          },
          'gpt-5.6-luna': {
            modelId: 'gpt-5.6-luna',
            maxContext: 372000,
            maxOutput: 64000,
            reasoningEffort: 'low',
            supportedReasoningEfforts: ['low', 'medium'],
            capabilities: ['tools', 'reasoning'],
            tags: ['fast', 'coding'],
          },
        },
      },
    },
    modelRoutes: {
      'coding-quality': {
        providers: ['chatgpt'],
        family: 'gpt',
        requires: ['tools', 'reasoning'],
        minContext: 200000,
        prefer: 'quality',
        reasoningEffort: 'high',
      },
      'coding-fast': {
        providers: ['chatgpt'],
        family: 'gpt',
        requires: ['tools'],
        prefer: 'fast',
      },
      'coding-alias': {
        models: ['gpt-5.6-terra'],
        prefer: 'priority',
      },
    },
    defaultModel: 'route/coding-quality',
    fallbackChain: ['route/coding-fast'],
    schedules: [],
    fuseList: [],
  }

  test('resolves a stable logical route to a physical model', () => {
    const router = new ModelRouter(routeConfig, new Map())
    const result = router.init()

    expect(result.success).toBe(true)
    expect(result.model?.modelName).toBe('gpt-5.6-sol')
    expect(result.model?.modelConfig.reasoningEffort).toBe('high')
    expect(router.getDefaultModelLabel()).toBe('chatgpt/gpt-5.6-sol')
  })

  test('selects fast and exact physical models independently', () => {
    const router = new ModelRouter(routeConfig, new Map())

    expect(router.selectModel('route/coding-fast').model?.modelName).toBe('gpt-5.6-luna')
    expect(router.selectModel('chatgpt/gpt-5.6-terra').model?.modelName).toBe('gpt-5.6-terra')
    expect(router.selectModel('route/coding-alias').model?.modelName).toBe('gpt-5.6-terra')
  })

  test('preserves route-backed defaults and router options across reloads', () => {
    const providerHealth = new ProviderHealthRegistry()
    const router = new ModelRouter(routeConfig, new Map(), { providerHealth })
    expect(router.init().model?.modelName).toBe('gpt-5.6-sol')

    router.reload(routeConfig, new Map())

    expect(router.getCurrentModel()?.modelName).toBe('gpt-5.6-sol')
    expect(router.getDefaultModel()?.modelName).toBe('gpt-5.6-sol')
    expect(router.getRegistry().getProviderHealth()).toBe(providerHealth)
  })

  test('keeps explicit route candidates physical when a catalog pool owns the bare model id', () => {
    const catalogEntry: ModelCatalogEntry = {
      providerName: 'chatgpt',
      providerKind: 'chatgpt',
      accountFingerprint: 'account-chatgpt',
      transport: 'openai_responses:https://chatgpt.com/backend-api/codex',
      apiType: 'openai_responses',
      modelName: 'gpt-5.6-terra',
      modelId: 'gpt-5.6-terra',
      family: 'gpt',
      version: '5.6',
      lane: 'terra',
      modelConfig: routeConfig.providers.chatgpt.models['gpt-5.6-terra'],
      status: 'verified',
      source: 'provider',
      provenance: {},
      metadataHash: 'gpt-5.6-terra',
      discoveredAt: '2026-07-10T00:00:00.000Z',
      verifiedAt: '2026-07-10T00:00:01.000Z',
      lastSeenAt: '2026-07-10T00:00:01.000Z',
    }
    const router = new ModelRouter(routeConfig, new Map(), { catalogEntries: [catalogEntry] })

    expect(router.resolveModel('gpt-5.6-terra')).toMatchObject({
      providerName: 'pool',
      modelName: 'gpt-5.6-terra',
    })
    expect(router.resolveModel('route/coding-alias')).toMatchObject({
      providerName: 'chatgpt',
      modelName: 'gpt-5.6-terra',
    })

    const poolDefault = new ModelRouter(
      { ...routeConfig, defaultModel: 'gpt-5.6-terra' },
      new Map(),
      { catalogEntries: [catalogEntry] },
    )
    expect(poolDefault.init().model?.providerName).toBe('pool')
    expect(poolDefault.getDefaultModelLabel()).toBe('pool/gpt-5.6-terra')
  })
})
