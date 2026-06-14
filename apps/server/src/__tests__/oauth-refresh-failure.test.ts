import { describe, expect, test } from 'bun:test'
import { buildOAuthRefreshFailureError, extractOAuthRefreshErrorDetail } from '../oauth/refresh'

describe('buildOAuthRefreshFailureError', () => {
  test('builds contextual re-authentication errors by default', () => {
    const error = buildOAuthRefreshFailureError({
      providerLabel: 'Claude',
      status: 401,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh token expired',
      }),
      reauthMessage: 'Please re-authenticate.',
      reauthCodes: ['invalid_grant'],
    })

    expect(error.message).toBe('Please re-authenticate. [status=401, code=invalid_grant]')
  })

  test('can preserve providers that use plain re-authentication copy', () => {
    const error = buildOAuthRefreshFailureError({
      providerLabel: 'ChatGPT',
      status: 401,
      body: JSON.stringify({
        error: { code: 'refresh_token_invalidated', message: 'revoked' },
      }),
      reauthMessage: 'Please login again.',
      reauthCodes: ['refresh_token_invalidated'],
      includeReauthContext: false,
    })

    expect(error.message).toBe('Please login again.')
  })

  test('builds non re-authentication refresh failure errors', () => {
    const error = buildOAuthRefreshFailureError({
      providerLabel: 'X Premium',
      status: 500,
      statusText: 'Internal Server Error',
      body: JSON.stringify({ message: 'temporarily unavailable' }),
      reauthMessage: 'Please re-authenticate.',
      reauthCodes: ['invalid_grant'],
    })

    expect(error.message).toBe('X Premium OAuth token refresh failed: 500 temporarily unavailable')
  })
})

describe('extractOAuthRefreshErrorDetail', () => {
  test('parses nested provider error details', () => {
    expect(
      extractOAuthRefreshErrorDetail(
        JSON.stringify({
          error: { code: 'refresh_token_invalidated', message: 'revoked by user' },
        }),
      ),
    ).toEqual({
      code: 'refresh_token_invalidated',
      message: 'revoked by user',
    })
  })

  test('falls back to trimmed non-JSON response body', () => {
    expect(extractOAuthRefreshErrorDetail(' temporarily unavailable ')).toEqual({
      message: 'temporarily unavailable',
    })
  })
})
