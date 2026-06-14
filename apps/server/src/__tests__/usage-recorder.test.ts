import { describe, expect, test } from 'bun:test'
import { MetricsDB } from '@zero-os/observe'
import { createUsageRecorder } from '../main'

describe('createUsageRecorder', () => {
  test('skips invalid purposes without polluting the usage ledger', () => {
    const metrics = MetricsDB.createInMemory()
    const usageRecorder = createUsageRecorder(metrics)
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      usageRecorder.record({
        sessionId: 'sess_invalid_usage_001',
        purpose: 'invalid-purpose',
        model: 'chatgpt/gpt-5.4',
        provider: 'chatgpt',
        usage: { input: 10, output: 4 },
        cost: 0.02,
        durationMs: 50,
      })
    } finally {
      console.warn = originalWarn
    }

    expect(metrics.summary('1d').requestCount).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain('Skipping usage record with invalid purpose')

    metrics.close()
  })

  test('accepts tool IO digest usage records', () => {
    const metrics = MetricsDB.createInMemory()
    const usageRecorder = createUsageRecorder(metrics)
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      usageRecorder.record({
        sessionId: 'sess_tool_digest_usage_001',
        purpose: 'tool_io_digest',
        model: 'chatgpt/gpt-5.5',
        provider: 'chatgpt',
        usage: { input: 120, output: 40 },
        cost: 0.03,
        durationMs: 75,
      })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toHaveLength(0)
    expect(metrics.summary('1d').requestCount).toBe(1)
    expect(metrics.sessionUsageByPurpose('sess_tool_digest_usage_001')).toEqual([
      expect.objectContaining({
        purpose: 'tool_io_digest',
        requestCount: 1,
        totalCost: 0.03,
      }),
    ])

    metrics.close()
  })
})
