import { describe, expect, test } from 'bun:test'
import { ProviderHealthRegistry } from '../provider-health'

describe('ProviderHealthRegistry', () => {
  test('clears auth errors for a recovered provider', async () => {
    const health = new ProviderHealthRegistry()
    health.markAuthError({
      providerName: 'chatgpt-personal',
      reason: 'refresh token expired',
    })
    health.markAuthError({
      providerName: 'chatgpt-personal',
      modelName: 'gpt-5.5',
      reason: 'refresh token expired',
    })

    expect(await health.isAvailable('chatgpt-personal', 'gpt-5.5')).toBe(false)

    const cleared = health.markAuthRecovered('chatgpt-personal', {
      source: 'oauth_login_reload',
    })

    expect(cleared).toBe(2)
    expect(await health.isAvailable('chatgpt-personal', 'gpt-5.5')).toBe(true)
    expect(
      health
        .list()
        .some(
          (record) => record.providerName === 'chatgpt-personal' && record.state === 'auth_error',
        ),
    ).toBe(false)
    expect(health.get('chatgpt-personal')?.state).toBe('healthy')
  })

  test('does not clear quota cooldowns when auth recovers', async () => {
    const health = new ProviderHealthRegistry()
    await health.markQuotaLimited({
      providerName: 'chatgpt-personal',
      modelName: 'gpt-5.5',
      reason: 'usage limit reached',
    })

    const cleared = health.markAuthRecovered('chatgpt-personal')

    expect(cleared).toBe(0)
    expect(await health.isAvailable('chatgpt-personal', 'gpt-5.5')).toBe(false)
    expect(health.get('chatgpt-personal', 'gpt-5.5')?.state).toBe('quota_limited')
  })

  test('rechecks auth errors after cooldown', async () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      const health = new ProviderHealthRegistry({
        recoveryResolver: async () => ({
          state: 'healthy',
          evidence: { source: 'test_probe' },
        }),
      })
      health.markAuthError({
        providerName: 'chatgpt',
        modelName: 'gpt-5.5',
        reason: 'refresh token expired',
      })

      expect(await health.isAvailable('chatgpt', 'gpt-5.5')).toBe(false)

      now += 60_001

      expect(await health.isAvailable('chatgpt', 'gpt-5.5')).toBe(true)
      expect(health.get('chatgpt', 'gpt-5.5')?.state).toBe('healthy')
    } finally {
      Date.now = originalNow
    }
  })
})
