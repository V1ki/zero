import { describe, expect, test } from 'bun:test'
import { resolveOAuthCallbackRequest } from '../oauth/callback'

const attempt = {
  id: 'oauth_attempt_test',
  provider: 'chatgpt' as const,
  state: 'state-test',
  callbackPath: '/callback',
}

const callbackConfig = {
  protocol: 'http:' as const,
  listenHost: 'localhost',
  listenPort: 0,
  callbackPath: '/callback',
}

describe('resolveOAuthCallbackRequest', () => {
  test('ignores requests outside the configured callback path', () => {
    expect(
      resolveOAuthCallbackRequest({
        attempt,
        callbackConfig,
        requestPath: '/not-callback?state=state-test&code=code-test',
      }),
    ).toEqual({ kind: 'not_found', statusCode: 404, body: 'Not found' })
  })

  test('rejects callback requests with mismatched state', () => {
    const result = resolveOAuthCallbackRequest({
      attempt,
      callbackConfig,
      requestPath: '/callback?state=wrong&code=code-test',
    })

    expect(result.kind).toBe('error')
    expect(result.statusCode).toBe(400)
    if (result.kind === 'error') {
      expect(result.body).toBe('State mismatch')
      expect(result.status.state).toBe('error')
      expect(result.status.error).toBe('State validation failed.')
    }
  })

  test('extracts a valid authorization code and authorizing status', () => {
    const result = resolveOAuthCallbackRequest({
      attempt,
      callbackConfig,
      requestPath: '/callback?state=state-test&code=code-test',
    })

    expect(result.kind).toBe('success')
    expect(result.statusCode).toBe(200)
    if (result.kind === 'success') {
      expect(result.code).toBe('code-test')
      expect(result.status.state).toBe('authorizing')
      expect(result.status.attemptId).toBe('oauth_attempt_test')
    }
  })
})
