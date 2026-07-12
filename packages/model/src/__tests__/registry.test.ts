import { describe, expect, test } from 'bun:test'
import type { SystemConfig } from '@zero-os/shared'
import type { ModelCatalogEntry } from '../catalog/types'
import { ModelRegistry } from '../registry'

const config: SystemConfig = {
  providers: {
    'openai-codex': {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://www.right.codes/codex',
      auth: { type: 'api_key', apiKeyRef: 'api_key' },
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
    'test-anthropic': {
      apiType: 'anthropic_messages',
      baseUrl: 'https://api.anthropic.com',
      auth: { type: 'api_key', apiKeyRef: 'anthropic_key' },
      models: {
        'claude-sonnet': {
          modelId: 'claude-sonnet-4-5-20250929',
          maxContext: 200000,
          maxOutput: 8192,
          capabilities: ['tools', 'vision'],
          tags: ['fast', 'balanced'],
        },
        'claude-sonnet-4-6': {
          modelId: 'claude-sonnet-4-6',
          maxContext: 200000,
          maxOutput: 8192,
          capabilities: ['tools', 'vision'],
          tags: ['fast', 'balanced'],
        },
      },
    },
  },
  defaultModel: 'gpt-5.3-codex-medium',
  fallbackChain: ['gpt-5.3-codex-medium'],
  schedules: [],
  fuseList: [],
}

const secrets = new Map([
  ['api_key', 'sk-test-key'],
  ['anthropic_key', 'sk-ant-test'],
])

function createCatalogEntry(
  providerName: string,
  modelId: string,
  status: ModelCatalogEntry['status'] = 'verified',
): ModelCatalogEntry {
  return {
    providerName,
    providerKind: 'chatgpt',
    accountFingerprint: `account-${providerName}`,
    transport: 'openai_responses:https://chatgpt.com/backend-api/codex',
    apiType: 'openai_responses',
    modelName: modelId,
    modelId,
    family: 'gpt',
    version: '5.6',
    lane: 'sol',
    modelConfig: {
      modelId,
      maxContext: 372000,
      maxOutput: 128000,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['codex', 'frontier'],
    },
    status,
    source: 'provider',
    provenance: {},
    metadataHash: `${providerName}-${modelId}`,
    discoveredAt: '2026-07-10T00:00:00.000Z',
    verifiedAt: '2026-07-10T00:00:01.000Z',
    lastSeenAt: '2026-07-10T00:00:01.000Z',
  }
}

function createSubscriptionConfig(modelId?: string): SystemConfig {
  const model = modelId
    ? {
        [modelId]: {
          modelId,
          maxContext: 372000,
          maxOutput: 128000,
          capabilities: ['tools', 'vision', 'reasoning'],
          tags: ['codex'],
        },
      }
    : {}
  return {
    providers: {
      chatgpt: {
        apiType: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth' },
        models: structuredClone(model),
      },
      'chatgpt-personal': {
        apiType: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_personal_oauth' },
        models: structuredClone(model),
      },
    },
    defaultModel: modelId ? `chatgpt/${modelId}` : 'pool/gpt-5.6-sol',
    fallbackChain: [],
    schedules: [],
    fuseList: [],
  }
}

describe('ModelRegistry', () => {
  test('resolve finds exact model', () => {
    const registry = new ModelRegistry(config, secrets)
    const resolved = registry.resolve('gpt-5.3-codex-medium')
    expect(resolved).toBeDefined()
    expect(resolved?.modelName).toBe('gpt-5.3-codex-medium')
    expect(resolved?.providerName).toBe('openai-codex')
  })

  test('resolve by model_id', () => {
    const registry = new ModelRegistry(config, secrets)
    const resolved = registry.resolve('claude-sonnet-4-5-20250929')
    expect(resolved).toBeDefined()
    expect(resolved?.modelName).toBe('claude-sonnet')
  })

  test('fuzzySearch by tag', () => {
    const registry = new ModelRegistry(config, secrets)
    const results = registry.fuzzySearch('fast')
    expect(results.length).toBe(2)
    expect(results.map((r) => r.modelName)).toEqual(['claude-sonnet', 'claude-sonnet-4-6'])
  })

  test('fuzzySearch by partial name', () => {
    const registry = new ModelRegistry(config, secrets)
    const results = registry.fuzzySearch('codex')
    expect(results.length).toBe(1)
    expect(results[0].modelName).toBe('gpt-5.3-codex-medium')
  })

  test('listModels returns all registered models', () => {
    const registry = new ModelRegistry(config, secrets)
    const models = registry.listModels()
    expect(models.length).toBe(3)
  })

  test('listModelPools returns pool membership ordered by priority', () => {
    const registry = new ModelRegistry(
      {
        ...config,
        modelPools: {
          'pooled/gpt-5.5': {
            strategy: 'sticky_quota_aware_failover',
            members: [
              { model: 'openai-codex/gpt-5.3-codex-medium', priority: 10 },
              { model: 'claude-sonnet', priority: 1 },
            ],
          },
        },
      },
      secrets,
    )

    expect(registry.listModelPools()).toEqual([
      {
        providerName: 'pooled',
        modelName: 'gpt-5.5',
        name: 'pooled/gpt-5.5',
        source: 'configured',
        strategy: 'sticky_quota_aware_failover',
        members: [
          { model: 'test-anthropic/claude-sonnet', priority: 1 },
          { model: 'openai-codex/gpt-5.3-codex-medium', priority: 10 },
        ],
      },
    ])
  })

  test('synthesizes a canonical pool from matching models discovered by subscriptions', () => {
    const catalogEntries = [
      createCatalogEntry('chatgpt-personal', 'gpt-5.6-sol'),
      createCatalogEntry('chatgpt', 'gpt-5.6-sol'),
    ]
    const registry = new ModelRegistry(createSubscriptionConfig(), new Map(), { catalogEntries })

    expect(registry.listModelPools()).toEqual([
      {
        providerName: 'pool',
        modelName: 'gpt-5.6-sol',
        name: 'pool/gpt-5.6-sol',
        source: 'catalog',
        strategy: 'sticky_quota_aware_failover',
        members: [
          { model: 'chatgpt/gpt-5.6-sol', priority: 0 },
          { model: 'chatgpt-personal/gpt-5.6-sol', priority: 1 },
        ],
      },
    ])
    expect(registry.resolve('pool/gpt-5.6-sol')).toMatchObject({
      providerName: 'pool',
      modelName: 'gpt-5.6-sol',
    })
    expect(registry.resolve('gpt-5.6-sol')).toMatchObject({
      providerName: 'pool',
      modelName: 'gpt-5.6-sol',
    })
    expect(registry.resolve('chatgpt/gpt-5.6-sol')).toMatchObject({
      providerName: 'chatgpt',
      modelName: 'gpt-5.6-sol',
    })
  })

  test('excludes unavailable subscriptions from synthesized catalog pools', () => {
    const registry = new ModelRegistry(createSubscriptionConfig(), new Map(), {
      catalogEntries: [
        createCatalogEntry('chatgpt', 'gpt-5.6-sol'),
        createCatalogEntry('chatgpt-personal', 'gpt-5.6-sol', 'unavailable'),
      ],
    })

    expect(registry.listModelPools()[0]).toMatchObject({
      name: 'pool/gpt-5.6-sol',
      source: 'catalog',
      members: [{ model: 'chatgpt/gpt-5.6-sol', priority: 0 }],
    })
  })

  test('keeps an explicit canonical pool as the policy override', () => {
    const subscriptionConfig = createSubscriptionConfig('gpt-5.6-sol')
    subscriptionConfig.modelPools = {
      'pool/gpt-5.6-sol': {
        strategy: 'priority_failover',
        members: [{ model: 'chatgpt-personal/gpt-5.6-sol', priority: 9 }],
      },
    }
    const registry = new ModelRegistry(subscriptionConfig, new Map(), {
      catalogEntries: [
        createCatalogEntry('chatgpt', 'gpt-5.6-sol'),
        createCatalogEntry('chatgpt-personal', 'gpt-5.6-sol'),
      ],
    })

    expect(registry.listModelPools()).toEqual([
      {
        providerName: 'pool',
        modelName: 'gpt-5.6-sol',
        name: 'pool/gpt-5.6-sol',
        source: 'configured',
        strategy: 'priority_failover',
        members: [{ model: 'chatgpt-personal/gpt-5.6-sol', priority: 9 }],
      },
    ])
  })

  test('maps a legacy homogeneous subscription pool to its canonical runtime identity', () => {
    const subscriptionConfig = createSubscriptionConfig('gpt-5.5')
    subscriptionConfig.modelPools = {
      'chatgpt/gpt-5.5': {
        strategy: 'sticky_quota_aware_failover',
        members: [{ model: 'chatgpt/gpt-5.5' }, { model: 'chatgpt-personal/gpt-5.5' }],
      },
    }
    const registry = new ModelRegistry(subscriptionConfig, new Map())

    expect(registry.listModelPools()).toEqual([
      {
        providerName: 'pool',
        modelName: 'gpt-5.5',
        name: 'pool/gpt-5.5',
        source: 'configured',
        strategy: 'sticky_quota_aware_failover',
        members: [
          { model: 'chatgpt/gpt-5.5', priority: 0 },
          { model: 'chatgpt-personal/gpt-5.5', priority: 1 },
        ],
      },
    ])
    expect(registry.resolve('chatgpt/gpt-5.5')).toMatchObject({
      providerName: 'pool',
      modelName: 'gpt-5.5',
    })
    expect(registry.resolve('chatgpt-personal/gpt-5.5')).toMatchObject({
      providerName: 'chatgpt-personal',
      modelName: 'gpt-5.5',
    })
  })

  test('uses conservative metadata for heterogeneous model pools', () => {
    const registry = new ModelRegistry(
      {
        ...config,
        modelPools: {
          'pool/coding': {
            strategy: 'priority_failover',
            members: [
              { model: 'openai-codex/gpt-5.3-codex-medium' },
              { model: 'test-anthropic/claude-sonnet' },
            ],
          },
        },
      },
      secrets,
    )

    const pool = registry.resolve('pool/coding')

    expect(pool?.modelConfig).toMatchObject({
      modelId: 'pool/coding',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision'],
    })
  })

  test('resolve finds newly added anthropic/claude-sonnet-4-6', () => {
    const registry = new ModelRegistry(config, secrets)
    const resolved =
      registry.resolve('anthropic/claude-sonnet-4-6') ??
      registry.resolve('test-anthropic/claude-sonnet-4-6') ??
      registry.resolve('claude-sonnet-4-6')
    expect(resolved).toBeDefined()
    expect(resolved?.modelName).toBe('claude-sonnet-4-6')
    expect(resolved?.modelConfig.modelId).toBe('claude-sonnet-4-6')
  })

  test('resolve returns undefined for unknown model', () => {
    const registry = new ModelRegistry(config, secrets)
    expect(registry.resolve('nonexistent')).toBeUndefined()
  })

  test('injects oauth refresher for anthropic providers using the provider name key', () => {
    const oauthConfig: SystemConfig = {
      providers: {
        anthropic: {
          apiType: 'anthropic_messages',
          baseUrl: 'https://api.anthropic.com',
          auth: { type: 'oauth2', oauthTokenRef: 'claude_oauth_session' },
          models: {
            'claude-sonnet-4-6': {
              modelId: 'claude-sonnet-4-6',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools', 'vision'],
              tags: ['balanced'],
            },
          },
        },
      },
      defaultModel: 'anthropic/claude-sonnet-4-6',
      fallbackChain: ['anthropic/claude-sonnet-4-6'],
      schedules: [],
      fuseList: [],
    }
    const oauthSecrets = new Map([
      [
        'claude_oauth_session',
        JSON.stringify({
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: Date.now() + 3600_000,
          tokenType: 'Bearer',
          scopes: ['user:profile', 'user:inference'],
        }),
      ],
    ])
    const refresher = async () => {}
    const registry = new ModelRegistry(oauthConfig, oauthSecrets, {
      oauthRefreshers: {
        anthropic: refresher,
      },
    })

    const resolved = registry.resolve('anthropic/claude-sonnet-4-6')
    const adapter = resolved?.adapter as
      | {
          oauthTokenRefresher?: unknown
        }
      | undefined

    expect(adapter?.oauthTokenRefresher).toBe(refresher)
  })

  test('injects oauth refresher for x-premium providers using the provider name key', () => {
    const oauthConfig: SystemConfig = {
      providers: {
        'x-premium': {
          apiType: 'x_responses',
          baseUrl: 'https://api.x.ai/v1',
          auth: { type: 'oauth2', oauthTokenRef: 'x_premium_oauth_session' },
          models: {
            'grok-4.3': {
              modelId: 'grok-4.3',
              maxContext: 256000,
              maxOutput: 8192,
              capabilities: ['tools', 'reasoning'],
              tags: ['grok'],
            },
          },
        },
      },
      defaultModel: 'x-premium/grok-4.3',
      fallbackChain: ['x-premium/grok-4.3'],
      schedules: [],
      fuseList: [],
    }
    const oauthSecrets = new Map([
      [
        'x_premium_oauth_session',
        JSON.stringify({
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: Date.now() + 3600_000,
          tokenType: 'Bearer',
          scopes: ['openid', 'profile'],
        }),
      ],
    ])
    const refresher = async () => {}
    const registry = new ModelRegistry(oauthConfig, oauthSecrets, {
      oauthRefreshers: {
        'x-premium': refresher,
      },
    })

    const resolved = registry.resolve('x-premium/grok-4.3')
    const adapter = resolved?.adapter as
      | {
          transport?: {
            options?: {
              oauthTokenRefresher?: unknown
            }
          }
        }
      | undefined

    expect(adapter?.transport?.options?.oauthTokenRefresher).toBe(refresher)
    expect(resolved?.adapter.apiType).toBe('x_responses')
  })

  test('creates AnthropicDeepSeekAdapter for anthropic-deepseek providers', () => {
    const deepseekConfig: SystemConfig = {
      providers: {
        deepseek: {
          apiType: 'anthropic-deepseek',
          baseUrl: 'https://api.deepseek.com/anthropic',
          auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
          models: {
            'deepseek-v4-pro': {
              modelId: 'deepseek-v4-pro',
              maxContext: 1000000,
              maxOutput: 384000,
              capabilities: ['tools', 'reasoning'],
              tags: ['deepseek'],
              pricing: {
                input: 1.74,
                output: 3.48,
                cacheWrite: 1.74,
                cacheRead: 0.145,
              },
            },
            'deepseek-v4-flash': {
              modelId: 'deepseek-v4-flash',
              maxContext: 1000000,
              maxOutput: 128000,
              capabilities: ['tools'],
              tags: ['deepseek', 'fast', 'compaction'],
            },
          },
        },
      },
      defaultModel: 'deepseek/deepseek-v4-pro',
      fallbackChain: ['deepseek/deepseek-v4-pro'],
      schedules: [],
      fuseList: [],
    }
    const registry = new ModelRegistry(
      deepseekConfig,
      new Map([['deepseek_api_key', 'sk-test-placeholder']]),
    )

    const resolved = registry.resolve('deepseek/deepseek-v4-pro')

    expect(resolved?.adapter.apiType).toBe('anthropic-deepseek')
    expect(resolved?.modelConfig.maxContext).toBe(1000000)
    expect(resolved?.modelConfig.maxOutput).toBe(384000)
    expect(resolved?.modelConfig.pricing).toEqual({
      input: 1.74,
      output: 3.48,
      cacheWrite: 1.74,
      cacheRead: 0.145,
    })

    const flash = registry.resolve('deepseek/deepseek-v4-flash')
    expect(flash?.adapter.apiType).toBe('anthropic-deepseek')
    expect(flash?.modelConfig.tags).toContain('compaction')
  })
})
