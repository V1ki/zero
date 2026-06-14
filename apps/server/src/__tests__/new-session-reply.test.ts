import { describe, expect, test } from 'bun:test'
import { buildNewSessionReply } from '@zero-os/core'

describe('buildNewSessionReply', () => {
  test('shows current model when /new is used without a model argument', () => {
    expect(buildNewSessionReply('openai-codex/gpt-5.4-medium')).toBe(
      'New conversation started with model: openai-codex/gpt-5.4-medium',
    )
  })

  test('shows current model when /new switches successfully', () => {
    expect(
      buildNewSessionReply('openai-codex/gpt-5.4-medium', {
        success: true,
        message: 'Model switched to openai-codex/gpt-5.4-medium',
      }),
    ).toBe('New conversation started with model: openai-codex/gpt-5.4-medium')
  })

  test('preserves failure messaging when model switch fails', () => {
    expect(
      buildNewSessionReply('openai-codex/gpt-5.3-codex-medium', {
        success: false,
        message: 'Unknown model: gpt-does-not-exist',
      }),
    ).toBe('New conversation started. Unknown model: gpt-does-not-exist')
  })

  test('includes previous session id when provided', () => {
    expect(buildNewSessionReply('openai-codex/gpt-5.4-medium', undefined, 'sess_abc123')).toBe(
      'New conversation started with model: openai-codex/gpt-5.4-medium\nPrevious session: sess_abc123',
    )
  })

  test('includes previous session id on model switch failure', () => {
    expect(
      buildNewSessionReply(
        'openai-codex/gpt-5.3-codex-medium',
        { success: false, message: 'Unknown model: gpt-does-not-exist' },
        'sess_xyz789',
      ),
    ).toBe(
      'New conversation started. Unknown model: gpt-does-not-exist\nPrevious session: sess_xyz789',
    )
  })

  test('omits previous session line when no previous session', () => {
    expect(buildNewSessionReply('openai-codex/gpt-5.4-medium', undefined, undefined)).toBe(
      'New conversation started with model: openai-codex/gpt-5.4-medium',
    )
  })
})
