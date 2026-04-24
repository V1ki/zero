import { describe, expect, test } from 'bun:test'
import type { ModelPricing, TokenUsage } from '@zero-os/shared'
import { computeCost } from '../cost'

describe('computeCost', () => {
  test('returns 0 when no pricing is provided', () => {
    const usage: TokenUsage = { input: 5000, output: 1000 }
    expect(computeCost(usage)).toBe(0)
    expect(computeCost(usage, undefined)).toBe(0)
  })

  test('computes input-only cost correctly', () => {
    const usage: TokenUsage = { input: 1000, output: 0 }
    const pricing: ModelPricing = { input: 3, output: 15 }
    // 1000 * 3 / 1_000_000 = 0.003
    expect(computeCost(usage, pricing)).toBe(0.003)
  })

  test('computes output-only cost correctly', () => {
    const usage: TokenUsage = { input: 0, output: 2000 }
    const pricing: ModelPricing = { input: 3, output: 15 }
    // 2000 * 15 / 1_000_000 = 0.03
    expect(computeCost(usage, pricing)).toBe(0.03)
  })

  test('computes combined input + output cost', () => {
    const usage: TokenUsage = { input: 1000, output: 500 }
    const pricing: ModelPricing = { input: 3, output: 15 }
    // (1000 * 3 + 500 * 15) / 1_000_000 = 0.003 + 0.0075 = 0.0105
    expect(computeCost(usage, pricing)).toBeCloseTo(0.0105, 10)
  })

  test('includes cacheWrite cost when both usage and pricing have it', () => {
    const usage: TokenUsage = { input: 0, output: 0, cacheWrite: 10_000 }
    const pricing: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75 }
    // 10000 * 3.75 / 1_000_000 = 0.0375
    expect(computeCost(usage, pricing)).toBe(0.0375)
  })

  test('includes cacheRead cost when both usage and pricing have it', () => {
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 20_000 }
    const pricing: ModelPricing = { input: 3, output: 15, cacheRead: 0.3 }
    // 20000 * 0.3 / 1_000_000 = 0.006
    expect(computeCost(usage, pricing)).toBe(0.006)
  })

  test('bills reasoning tokens at output rate', () => {
    const usage: TokenUsage = { input: 0, output: 0, reasoning: 5000 }
    const pricing: ModelPricing = { input: 3, output: 15 }
    // 5000 * 15 / 1_000_000 = 0.075
    expect(computeCost(usage, pricing)).toBe(0.075)
  })

  test('returns 0 when all token counts are zero', () => {
    const usage: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 }
    const pricing: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
    expect(computeCost(usage, pricing)).toBe(0)
  })

  test('computes DeepSeek v4 pro cache-hit, cache-miss, and output costs', () => {
    const usage: TokenUsage = {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
    }
    const pricing: ModelPricing = { input: 1.74, output: 3.48, cacheWrite: 1.74, cacheRead: 0.145 }
    expect(computeCost(usage, pricing)).toBeCloseTo(7.105, 10)
  })
})
