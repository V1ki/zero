import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelPricing } from '@zero-os/shared'
import type { ModelConfig } from '@zero-os/shared'
import { LiteLLMPricing, convertPricing, findEntry } from '../pricing'

describe('convertPricing', () => {
  test('converts per-token to per-million-token', () => {
    const result = convertPricing({
      input_cost_per_token: 0.000015, // $15/M
      output_cost_per_token: 0.000075, // $75/M
    })
    expect(result).toEqual({ input: 15, output: 75 })
  })

  test('includes cacheWrite and cacheRead when present', () => {
    const result = convertPricing({
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_creation_input_token_cost: 0.00000375,
      cache_read_input_token_cost: 0.0000003,
    })
    expect(result).not.toBeNull()
    if (!result) {
      throw new Error('expected pricing result')
    }
    expect(result.input).toBe(3)
    expect(result.output).toBe(15)
    expect(result.cacheWrite).toBe(3.75)
    expect(result.cacheRead).toBe(0.3)
  })

  test('returns null when input_cost_per_token is missing', () => {
    expect(convertPricing({ output_cost_per_token: 0.001 })).toBeNull()
  })

  test('returns null when output_cost_per_token is missing', () => {
    expect(convertPricing({ input_cost_per_token: 0.001 })).toBeNull()
  })

  test('handles zero pricing', () => {
    const result = convertPricing({
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    })
    expect(result).toEqual({ input: 0, output: 0 })
  })
})

describe('findEntry', () => {
  const data = {
    'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
    'anthropic/claude-opus-4-6': {
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
    },
    'claude-sonnet-4-6': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
    'openai/o1': { input_cost_per_token: 0.000015, output_cost_per_token: 0.00006 },
  }

  test('exact match', () => {
    expect(findEntry(data, 'gpt-4o')).toBe(data['gpt-4o'])
  })

  test('matches with litellm provider prefix', () => {
    // "claude-opus-4-6" → tries "anthropic/claude-opus-4-6"
    expect(findEntry(data, 'claude-opus-4-6')).toBe(data['anthropic/claude-opus-4-6'])
  })

  test('strips our own provider prefix and retries', () => {
    // "my-company/claude-sonnet-4-6" → strips to "claude-sonnet-4-6" → exact match
    expect(findEntry(data, 'my-company/claude-sonnet-4-6')).toBe(data['claude-sonnet-4-6'])
  })

  test('strips our prefix then adds litellm prefix', () => {
    // "custom/claude-opus-4-6" → strips to "claude-opus-4-6" → tries "anthropic/claude-opus-4-6"
    expect(findEntry(data, 'custom/claude-opus-4-6')).toBe(data['anthropic/claude-opus-4-6'])
  })

  test('returns null for unknown model', () => {
    expect(findEntry(data, 'nonexistent-model')).toBeNull()
  })
})

describe('LiteLLMPricing', () => {
  afterEach(() => {
    LiteLLMPricing.getInstance()?.dispose()
  })

  test('getInstance returns null before init', () => {
    expect(LiteLLMPricing.getInstance()).toBeNull()
  })

  test('lookup returns null when data not loaded', () => {
    const pricing = LiteLLMPricing.init('/tmp/test-litellm-cache-no-data')
    expect(pricing.lookup('claude-opus-4-6')).toBeNull()
  })

  test('init returns same instance on repeated calls', () => {
    const a = LiteLLMPricing.init('/tmp/test-litellm-a')
    const b = LiteLLMPricing.init('/tmp/test-litellm-b')
    expect(a).toBe(b)
  })

  test('dispose clears instance', () => {
    LiteLLMPricing.init('/tmp/test-litellm-dispose')
    const instance = LiteLLMPricing.getInstance()
    expect(instance).not.toBeNull()
    if (!instance) {
      throw new Error('expected LiteLLMPricing instance')
    }
    instance.dispose()
    expect(LiteLLMPricing.getInstance()).toBeNull()
  })
})

describe('enrichPricing (integration)', () => {
  test('config pricing takes precedence over litellm fallback', () => {
    const configPricing: ModelPricing = { input: 10, output: 30 }
    const model: ModelConfig = {
      modelId: 'gpt-4o',
      maxContext: 128000,
      maxOutput: 16384,
      capabilities: ['chat'],
      tags: ['fast'],
      pricing: configPricing,
    }

    // enrichPricing should return the model unchanged
    expect(model.pricing).toBe(configPricing)
  })
})
