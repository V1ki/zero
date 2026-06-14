import { describe, expect, test } from 'bun:test'
import {
  collectBareRemovedChatgptReferences,
  isRemovedChatgptModelEntry,
  isRemovedChatgptReference,
} from '../providers/chatgpt/config'

describe('ChatGPT removed model rules', () => {
  test('detects removed models by name, ref, or model_id', () => {
    expect(isRemovedChatgptModelEntry('gpt-5.4-medium', {})).toBe(true)
    expect(isRemovedChatgptModelEntry('chatgpt/gpt-5.3-codex-medium', {})).toBe(true)
    expect(isRemovedChatgptModelEntry('alias', { model_id: 'gpt-5.4-medium' })).toBe(true)
    expect(isRemovedChatgptModelEntry('gpt-5.4', { model_id: 'gpt-5.4' })).toBe(false)
  })

  test('treats bare removed references as ChatGPT-only when no other provider owns them', () => {
    const providers = {
      chatgpt: {
        models: {
          'gpt-5.4-medium': { model_id: 'gpt-5.4-medium' },
          'gpt-5.3-codex-medium': { model_id: 'gpt-5.3-codex-medium' },
        },
      },
      'openai-codex': {
        models: {
          'gpt-5.4-medium': { model_id: 'gpt-5.4-medium' },
        },
      },
    }

    const bareReferences = collectBareRemovedChatgptReferences(providers)

    expect(bareReferences.has('gpt-5.3-codex-medium')).toBe(true)
    expect(bareReferences.has('gpt-5.4-medium')).toBe(false)
  })

  test('matches provider-qualified and collected bare removed references', () => {
    const bareReferences = new Set(['gpt-5.4-medium'])

    expect(isRemovedChatgptReference('chatgpt/gpt-5.3-codex-medium', bareReferences)).toBe(true)
    expect(isRemovedChatgptReference('gpt-5.4-medium', bareReferences)).toBe(true)
    expect(isRemovedChatgptReference('openai-codex/gpt-5.4-medium', bareReferences)).toBe(false)
  })
})
