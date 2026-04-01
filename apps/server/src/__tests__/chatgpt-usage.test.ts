import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeChatGptOAuthSession } from '@zero-os/model'
import { Vault } from '@zero-os/secrets'
import { getChatgptOAuthTokenRef } from '../chatgpt-provider'
import { ChatGptUsageService } from '../chatgpt-usage'

const originalFetch = globalThis.fetch
const previousZeroDataDir = process.env.ZERO_DATA_DIR

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-chatgpt-usage-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

function writeConfig(dataDir: string, baseUrl = 'https://chatgpt.com/backend-api/codex') {
  writeFileSync(
    join(dataDir, 'config.yaml'),
    `providers:
  chatgpt:
    api_type: openai_responses
    base_url: ${baseUrl}
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_token
    models: {}
default_model: chatgpt/gpt-5.4
fallback_chain: []
schedules: []
fuse_list: []
`,
  )
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (previousZeroDataDir === undefined) {
    process.env.ZERO_DATA_DIR = undefined
  } else {
    process.env.ZERO_DATA_DIR = previousZeroDataDir
  }
})

describe('ChatGptUsageService', () => {
  test('fetches usage with ChatGPT OAuth access token and account id header', async () => {
    const { dir, vault } = createVault()
    process.env.ZERO_DATA_DIR = dir
    writeConfig(dir)
    vault.set(
      getChatgptOAuthTokenRef(),
      serializeChatGptOAuthSession({
        accessToken: 'chatgpt-access-token',
        refreshToken: 'chatgpt-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'bearer',
        accountId: 'account-123',
      }),
    )

    let callCount = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1
      expect(String(input)).toBe('https://chatgpt.com/backend-api/wham/usage')
      expect(init?.method).toBe('GET')
      expect(init?.headers).toEqual({
        Authorization: 'Bearer chatgpt-access-token',
        'chatgpt-account-id': 'account-123',
        'Content-Type': 'application/json',
        'User-Agent': 'zero-os/0.1.0 (external, cli)',
      })

      return new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 42,
              limit_window_seconds: 3600,
              reset_at: 1743508800,
            },
            secondary_window: {
              used_percent: 5,
              limit_window_seconds: 86400,
              reset_at: 1743591600,
            },
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: '12.5',
          },
          additional_rate_limits: [
            {
              limit_name: 'codex_other',
              metered_feature: 'codex_other',
              rate_limit: {
                primary_window: {
                  used_percent: 88,
                  limit_window_seconds: 1800,
                  reset_at: 1743507000,
                },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const service = new ChatGptUsageService(vault)

    try {
      const usage = await service.fetchUsage()
      expect(callCount).toBe(1)
      expect(usage).toEqual({
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          primary: {
            usedPercent: 42,
            windowDurationMins: 60,
            resetsAt: 1743508800,
          },
          secondary: {
            usedPercent: 5,
            windowDurationMins: 1440,
            resetsAt: 1743591600,
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: '12.5',
          },
          planType: 'pro',
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: null,
            primary: {
              usedPercent: 42,
              windowDurationMins: 60,
              resetsAt: 1743508800,
            },
            secondary: {
              usedPercent: 5,
              windowDurationMins: 1440,
              resetsAt: 1743591600,
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: '12.5',
            },
            planType: 'pro',
          },
          codex_other: {
            limitId: 'codex_other',
            limitName: 'codex_other',
            primary: {
              usedPercent: 88,
              windowDurationMins: 30,
              resetsAt: 1743507000,
            },
            secondary: null,
            credits: null,
            planType: 'pro',
          },
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
