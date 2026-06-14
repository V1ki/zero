import { describe, expect, test } from 'bun:test'
import { canFetchClaudeUsage } from '../providers/claude/usage'

describe('canFetchClaudeUsage', () => {
  test('requires subscription and user profile scope', () => {
    expect(
      canFetchClaudeUsage({
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
      }),
    ).toBe(true)

    expect(
      canFetchClaudeUsage({
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: null,
      }),
    ).toBe(false)

    expect(
      canFetchClaudeUsage({
        scopes: ['user:inference'],
        subscriptionType: 'max',
      }),
    ).toBe(false)
  })
})
