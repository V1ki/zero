import { describe, expect, test } from 'bun:test'
import {
  ProviderControlService,
  applyProviderConfigUpdate,
  normalizeModelPoolsForWrite,
  normalizeRecoveredProviders,
} from '../provider-control'

describe('provider control config writes', () => {
  test('normalizes model pools for config.yaml writes', () => {
    expect(
      normalizeModelPoolsForWrite({
        ' pooled/gpt ': {
          strategy: 'sticky_priority_failover',
          members: [' openai/gpt ', { model: ' anthropic/claude ', priority: 9 }, { model: '' }],
        },
      }),
    ).toEqual({
      'pooled/gpt': {
        strategy: 'sticky_priority_failover',
        members: [
          { model: 'openai/gpt', priority: 0 },
          { model: 'anthropic/claude', priority: 9 },
        ],
      },
    })
  })

  test('rejects model pools with no usable members', () => {
    expect(() =>
      normalizeModelPoolsForWrite({
        'pooled/empty': {
          members: [{ model: '' }],
        },
      }),
    ).toThrow('Model pool pooled/empty must include at least one member')
  })

  test('maps API config fields back to yaml keys', () => {
    expect(
      applyProviderConfigUpdate(
        {
          default_model: 'openai/old',
          model_pools: { old: {} },
          task_closure_model: 'openai/task',
        },
        {
          defaultModel: 'openai/new',
          modelPools: {},
          runtimeModelPools: {
            'pool/gpt-5.6-sol': {
              source: 'catalog',
              strategy: 'sticky_quota_aware_failover',
              members: [{ model: 'chatgpt/gpt-5.6-sol' }],
            },
          },
          modelRoutes: { latest: { prefer: 'newest' } },
          taskClosureModel: null,
          contextCompactionModel: 'openai/compact',
        },
      ),
    ).toEqual({
      default_model: 'openai/new',
      model_routes: { latest: { prefer: 'newest' } },
      context_compaction_model: 'openai/compact',
    })
  })

  test('normalizes recovered providers from reload requests', () => {
    expect(normalizeRecoveredProviders([' openai ', '', 'openai', 'anthropic'])).toEqual([
      'openai',
      'anthropic',
    ])
    expect(normalizeRecoveredProviders(' x-premium ')).toEqual(['x-premium'])
  })

  test('catalog responses expose normalized metadata without account scope secrets', () => {
    const control = new ProviderControlService({
      modelRouter: {
        getCatalogSnapshot: () => ({
          version: 1,
          generation: 3,
          updatedAt: '2026-07-10T00:00:00.000Z',
          entries: [],
        }),
        getCatalogEntries: () => [
          {
            providerName: 'chatgpt',
            providerKind: 'chatgpt',
            accountFingerprint: 'private-account-fingerprint',
            transport: 'openai_responses:https://chatgpt.com/backend-api/codex',
            apiType: 'openai_responses',
            modelName: 'gpt-5.6-sol',
            modelId: 'gpt-5.6-sol',
            family: 'gpt',
            version: '5.6',
            lane: 'sol',
            modelConfig: {
              modelId: 'gpt-5.6-sol',
              maxContext: 372000,
              maxOutput: 8192,
              capabilities: ['tools', 'reasoning'],
              tags: ['codex'],
              supportedReasoningEfforts: ['low', 'medium', 'high'],
            },
            status: 'verified',
            source: 'provider',
            provenance: {},
            metadataHash: 'hash',
            discoveredAt: '2026-07-10T00:00:00.000Z',
            verifiedAt: '2026-07-10T00:00:01.000Z',
            lastSeenAt: '2026-07-10T00:00:01.000Z',
          },
        ],
      },
    } as never)

    const catalog = control.getModelCatalog()

    expect(catalog).toMatchObject({
      generation: 3,
      entries: [
        {
          providerName: 'chatgpt',
          modelName: 'gpt-5.6-sol',
          status: 'verified',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
      ],
    })
    expect(JSON.stringify(catalog)).not.toContain('private-account-fingerprint')
    expect(catalog.entries[0]).not.toHaveProperty('transport')
  })
})
