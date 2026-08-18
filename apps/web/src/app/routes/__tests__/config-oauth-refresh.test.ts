import { describe, expect, test } from 'bun:test'
import { refreshExpiredOAuthProviders } from '../config-oauth-refresh'
import type { ProviderView } from '../config-shared'

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    apiType: 'x_responses',
    baseUrl: 'https://api.x.ai/v1',
    authType: 'oauth2',
    models: {},
    ...overrides,
  }
}

describe('expired OAuth provider refresh', () => {
  test('soft-refreshes expired managed providers without touching healthy providers', async () => {
    const requestedProviders: string[] = []
    const patches = await refreshExpiredOAuthProviders(
      {
        'x-premium': provider({ oauthState: 'expired', authorized: false }),
        chatgpt: provider({
          apiType: 'openai_responses',
          oauthState: 'connected',
          authorized: true,
        }),
        custom: provider({
          apiType: 'openai_responses',
          oauthState: 'expired',
          authorized: false,
        }),
      },
      async (providerName) => {
        requestedProviders.push(providerName)
        return {
          state: 'connected',
          authorized: true,
          requiresRestart: false,
        }
      },
    )

    expect(requestedProviders).toEqual(['x-premium'])
    expect(patches).toEqual({
      'x-premium': {
        authorized: true,
        oauthState: 'connected',
        oauthError: undefined,
        requiresRestart: false,
      },
    })
  })

  test('preserves refresh failure details for the reconnect UI', async () => {
    const patches = await refreshExpiredOAuthProviders(
      {
        'x-premium': provider({ oauthState: 'expired', authorized: false }),
      },
      async () => ({
        state: 'error',
        authorized: false,
        error: 'X Premium OAuth session can no longer be refreshed.',
        requiresRestart: false,
      }),
    )

    expect(patches['x-premium']).toEqual({
      authorized: false,
      oauthState: 'error',
      oauthError: 'X Premium OAuth session can no longer be refreshed.',
      requiresRestart: false,
    })
  })
})
