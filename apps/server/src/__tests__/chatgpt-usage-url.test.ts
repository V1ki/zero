import { describe, expect, test } from 'bun:test'
import { normalizeChatGptUsageBaseUrl } from '../providers/chatgpt/usage'

describe('normalizeChatGptUsageBaseUrl', () => {
  test('normalizes ChatGPT origins to backend API usage base', () => {
    expect(normalizeChatGptUsageBaseUrl('https://chatgpt.com')).toBe(
      'https://chatgpt.com/backend-api',
    )
    expect(normalizeChatGptUsageBaseUrl('https://chat.openai.com/')).toBe(
      'https://chat.openai.com/backend-api',
    )
  })

  test('removes codex suffix from backend API base URL', () => {
    expect(normalizeChatGptUsageBaseUrl('https://chatgpt.com/backend-api/codex')).toBe(
      'https://chatgpt.com/backend-api',
    )
  })

  test('preserves custom backend API base URLs without trailing slashes', () => {
    expect(normalizeChatGptUsageBaseUrl('https://proxy.example/backend-api///')).toBe(
      'https://proxy.example/backend-api',
    )
  })
})
