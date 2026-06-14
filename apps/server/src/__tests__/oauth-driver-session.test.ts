import { describe, expect, test } from 'bun:test'
import type { Vault } from '@zero-os/secrets'
import { createOAuthDriverSession } from '../oauth/provider/driver-session'

interface TestSession {
  value: string
  expired?: boolean
}

describe('createOAuthDriverSession', () => {
  test('threads token ref and provider identity through session operations', async () => {
    const calls: string[] = []
    const vault = {
      get: (key: string) => (key === 'token_ref' ? '{"value":"stored"}' : undefined),
    } as unknown as Vault
    const session = createOAuthDriverSession<TestSession>({
      providerName: 'provider',
      tokenRef: 'token_ref',
      readSession: (vault, tokenRef) => {
        calls.push(`read:${tokenRef}`)
        return JSON.parse(vault.get(tokenRef) ?? 'null') as TestSession | null
      },
      serializeSession: (value) => JSON.stringify(value),
      isSessionExpiring: (value) => value.expired === true,
      createSessionRefresher: (_vault, context) => ({
        ensureFreshSession: async () => {
          calls.push(`fresh:${context.providerName}:${context.tokenRef}`)
        },
        refreshSession: async (reason) => {
          calls.push(`refresh:${reason}:${context.providerName}:${context.tokenRef}`)
        },
      }),
    })

    expect(session.read(vault, session.tokenRef)).toEqual({ value: 'stored' })
    expect(session.serialize({ value: 'next' })).toBe('{"value":"next"}')
    expect(session.isExpiring({ value: 'old', expired: true })).toBe(true)
    await session.createSessionRefresher(vault).ensureFreshSession()
    await session.createSessionRefresher(vault).refreshSession('unauthorized')

    expect(calls).toEqual([
      'read:token_ref',
      'fresh:provider:token_ref',
      'refresh:unauthorized:provider:token_ref',
    ])
  })
})
