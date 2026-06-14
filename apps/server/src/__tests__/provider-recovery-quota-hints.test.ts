import { describe, expect, test } from 'bun:test'
import {
  conservativeQuotaCooldownHint,
  quotaHintFromChatGptUsage,
  quotaHintFromClaudeUsage,
} from '../runtime/model-providers/recovery'

describe('provider recovery quota hints', () => {
  test('reports ChatGPT healthy when active windows are below quota threshold', () => {
    const hint = quotaHintFromChatGptUsage(
      {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: {
            usedPercent: 40,
            windowDurationMins: null,
            resetsAt: 10,
          },
          secondary: null,
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: null,
      },
      1_000,
    )

    expect(hint).toEqual({
      state: 'healthy',
      evidence: { source: 'chatgpt_usage' },
    })
  })

  test('uses the latest exhausted ChatGPT reset as quota cooldown', () => {
    const hint = quotaHintFromChatGptUsage(
      {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: {
            usedPercent: 95,
            windowDurationMins: null,
            resetsAt: 10,
          },
          secondary: {
            usedPercent: 99,
            windowDurationMins: null,
            resetsAt: 20,
          },
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: null,
      },
      1_000,
    )

    expect(hint).toEqual({
      state: 'quota_limited',
      cooldownUntil: 20_000,
      evidence: { source: 'chatgpt_usage' },
    })
  })

  test('uses Claude model-specific usage windows when present', () => {
    const hint = quotaHintFromClaudeUsage(
      {
        five_hour: { utilization: 20, resets_at: null },
        seven_day_sonnet: {
          utilization: 0.96,
          resets_at: '1970-01-01T00:00:10.000Z',
        },
      },
      'claude-sonnet-4-6',
      1_000,
    )

    expect(hint).toEqual({
      state: 'quota_limited',
      cooldownUntil: 10_000,
      evidence: { source: 'claude_usage' },
    })
  })

  test('falls back to a conservative cooldown when usage reset is unavailable', () => {
    expect(conservativeQuotaCooldownHint(1_000)).toEqual({
      state: 'quota_limited',
      cooldownUntil: 3_601_000,
      reason: 'x-premium usage reset is not available; using conservative cooldown',
    })
  })
})
