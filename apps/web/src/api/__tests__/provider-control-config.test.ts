import { describe, expect, test } from 'bun:test'
import {
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
          taskClosureModel: null,
          contextCompactionModel: 'openai/compact',
        },
      ),
    ).toEqual({
      default_model: 'openai/new',
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
})
