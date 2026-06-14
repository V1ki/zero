import { describe, expect, test } from 'bun:test'
import {
  type ProviderLoginOAuthClient,
  completeProviderLoginFromInput,
  completeProviderLoginViaBrowser,
} from '../cli/provider-login'
import type { ManagedOAuthStatus } from '../oauth/status'

function connectedStatus(provider = 'chatgpt'): ManagedOAuthStatus {
  return {
    provider,
    state: 'connected',
    authorized: true,
    requiresRestart: true,
  }
}

describe('provider login completion', () => {
  test('completes browser callback login and reloads the running server', async () => {
    const calls: string[] = []
    const oauth: ProviderLoginOAuthClient = {
      start: async () => ({ url: 'https://auth.example/start' }),
      waitForCompletion: async (_providerName, timeoutMs) => {
        calls.push(`wait:${timeoutMs}`)
        return connectedStatus()
      },
      completeFromInput: async () => {
        throw new Error('unexpected manual completion')
      },
    }

    const completed = await completeProviderLoginViaBrowser({
      oauth,
      providerName: 'chatgpt',
      label: 'ChatGPT',
      timeoutMs: 1000,
      deps: {
        openBrowser: (url) => calls.push(`open:${url}`),
        reloadServer: async (providerName) => {
          calls.push(`reload:${providerName}`)
        },
        log: (message) => calls.push(message),
      },
    })

    expect(completed).toBe(true)
    expect(calls).toContain('open:https://auth.example/start')
    expect(calls).toContain('wait:1000')
    expect(calls).toContain('reload:chatgpt')
    expect(calls).toContain('[ZeRo OS] ChatGPT OAuth configured.')
  })

  test('suppresses timeout noise and lets callers fall back to pasted input', async () => {
    const logs: string[] = []
    const oauth: ProviderLoginOAuthClient = {
      start: async () => ({ url: 'https://auth.example/start' }),
      waitForCompletion: async () => {
        throw new Error('timed out waiting for callback')
      },
      completeFromInput: async () => {
        throw new Error('unexpected manual completion')
      },
    }

    const completed = await completeProviderLoginViaBrowser({
      oauth,
      providerName: 'chatgpt',
      label: 'ChatGPT',
      deps: {
        openBrowser: () => {},
        reloadServer: async () => {},
        log: (message) => logs.push(message),
      },
    })

    expect(completed).toBe(false)
    expect(logs.some((message) => message.includes('not completed automatically'))).toBe(false)
  })

  test('manual input completion rejects non-connected statuses', async () => {
    const oauth: ProviderLoginOAuthClient = {
      start: async () => ({ url: 'https://auth.example/start' }),
      waitForCompletion: async () => connectedStatus(),
      completeFromInput: async () => ({
        provider: 'chatgpt',
        state: 'error',
        authorized: false,
        error: 'bad code',
        requiresRestart: false,
      }),
    }

    await expect(
      completeProviderLoginFromInput({
        oauth,
        providerName: 'chatgpt',
        label: 'ChatGPT',
        input: 'bad-code',
        deps: {
          reloadServer: async () => {},
          openBrowser: () => {},
          log: () => {},
        },
      }),
    ).rejects.toThrow('bad code')
  })
})
