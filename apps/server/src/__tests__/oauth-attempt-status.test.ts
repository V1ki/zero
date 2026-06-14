import { describe, expect, test } from 'bun:test'
import { createPendingOAuthAttempt } from '../oauth/attempt'
import { buildAuthorizingOAuthAttemptStatus, buildOAuthAttemptErrorStatus } from '../oauth/attempt'

function createAttempt() {
  return createPendingOAuthAttempt('chatgpt', '/auth/callback').attempt
}

describe('OAuth attempt status', () => {
  test('builds authorizing status for an attempt', () => {
    const attempt = createAttempt()

    expect(buildAuthorizingOAuthAttemptStatus(attempt)).toEqual({
      provider: 'chatgpt',
      state: 'authorizing',
      authorized: false,
      attemptId: attempt.id,
      requiresRestart: false,
    })
  })

  test('builds error status for an attempt', () => {
    const attempt = createAttempt()

    expect(buildOAuthAttemptErrorStatus(attempt, 'State validation failed.')).toEqual({
      provider: 'chatgpt',
      state: 'error',
      authorized: false,
      error: 'State validation failed.',
      attemptId: attempt.id,
      requiresRestart: false,
    })
  })
})
