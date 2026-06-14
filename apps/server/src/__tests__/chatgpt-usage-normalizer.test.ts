import { describe, expect, test } from 'bun:test'
import {
  normalizeChatGptRateLimitSnapshot,
  normalizeChatGptUsagePayload,
} from '../providers/chatgpt/usage'

describe('normalizeChatGptRateLimitSnapshot', () => {
  test('normalizes windows, credits, and plan metadata', () => {
    expect(
      normalizeChatGptRateLimitSnapshot({
        limitId: 'codex',
        limitName: 'Codex',
        planType: 'pro',
        rateLimit: {
          primary_window: {
            used_percent: 12.5,
            limit_window_seconds: 1800,
            reset_at: 1743507000,
          },
          secondary_window: {
            used_percent: 99,
          },
        },
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '7.25',
        },
      }),
    ).toEqual({
      limitId: 'codex',
      limitName: 'Codex',
      primary: {
        usedPercent: 12.5,
        windowDurationMins: 30,
        resetsAt: 1743507000,
      },
      secondary: {
        usedPercent: 99,
        windowDurationMins: null,
        resetsAt: null,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '7.25',
      },
      planType: 'pro',
    })
  })

  test('drops unusable windows and missing credits', () => {
    expect(
      normalizeChatGptRateLimitSnapshot({
        limitId: 'codex',
        limitName: null,
        planType: null,
        rateLimit: {
          primary_window: {
            limit_window_seconds: 3600,
          },
        },
        credits: null,
      }),
    ).toEqual({
      limitId: 'codex',
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
    })
  })
})

describe('normalizeChatGptUsagePayload', () => {
  test('keeps the root codex limit and skips unnamed additional limits', () => {
    const snapshot = normalizeChatGptUsagePayload({
      plan_type: 'team',
      rate_limit: {
        primary_window: {
          used_percent: 25,
        },
      },
      additional_rate_limits: [
        {
          metered_feature: '',
          limit_name: 'empty',
        },
        {
          metered_feature: 'codex_other',
          limit_name: 'Other',
          rate_limit: {
            primary_window: {
              used_percent: 80,
              limit_window_seconds: 600,
            },
          },
        },
      ],
    })

    expect(Object.keys(snapshot.rateLimitsByLimitId ?? {})).toEqual(['codex', 'codex_other'])
    expect(snapshot.rateLimits.primary?.usedPercent).toBe(25)
    expect(snapshot.rateLimitsByLimitId?.codex_other?.primary).toEqual({
      usedPercent: 80,
      windowDurationMins: 10,
      resetsAt: null,
    })
  })
})
