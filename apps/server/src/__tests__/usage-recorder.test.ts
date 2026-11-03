import { describe, expect, spyOn, test } from 'bun:test'
import type { CodexWorkerUsageRecord } from '@zero-os/core'
import { MetricsDB } from '@zero-os/observe'
import { createCodexWorkerUsageRecorder, createUsageRecorder } from '../runtime/observability'

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

describe('createCodexWorkerUsageRecorder', () => {
  test.each(['reported', 'partial', 'unreported'] as const)(
    'records %s turn usage in the calling session with a stable ID and explicit pricing status',
    (usageStatus) => {
      const metrics = MetricsDB.createInMemory()
      const write = spyOn(metrics, 'recordUsage')
      try {
        const record = createCodexWorkerUsageRecorder(metrics)
        const usage =
          usageStatus === 'unreported'
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
            : { input: 30, output: 12, cacheRead: 70, cacheWrite: 0, reasoning: 4 }
        const entry: CodexWorkerUsageRecord = {
          sessionId: 'worker-session',
          toolUseId: 'worker-tool-use',
          threadId: 'worker-thread',
          turnId: 'worker-turn',
          provider: 'openai',
          model: 'test-model',
          usage,
          usageStatus,
          createdAt: new Date().toISOString(),
          durationMs: 100,
        }
        record(entry)
        record(entry)
        const row = write.mock.calls[0]?.[0]
        expect(row).toMatchObject({
          id: 'worker:codex:worker-thread:worker-turn',
          sessionId: entry.sessionId,
          category: 'aggregated',
          purpose: 'codex_worker',
          provider: entry.provider,
          model: entry.model,
          cost: 0,
          durationMs: entry.durationMs,
          createdAt: entry.createdAt,
        })
        expect(JSON.parse(row?.metadata ?? '{}')).toEqual({
          toolUseId: entry.toolUseId,
          threadId: entry.threadId,
          turnId: entry.turnId,
          usageStatus,
          costStatus: 'token_only',
        })
        expect(metrics.sessionStats(entry.sessionId)).toMatchObject({
          requestCount: 1,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          reasoningTokens: usage.reasoning,
        })
      } finally {
        write.mockRestore()
        metrics.close()
      }
    },
  )
})
