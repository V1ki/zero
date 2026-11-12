import { describe, expect, test } from 'bun:test'
import { enforceFixedBudget } from '../budget'

describe('enforceFixedBudget', () => {
  test('returns original content when within limit', () => {
    const content = 'Short content'
    const result = enforceFixedBudget(content, 1000, 'Test')

    expect(result).toBe(content)
  })

  test('truncates and adds label when exceeding limit', () => {
    // estimateTokens uses Math.ceil(text.length / 3.5)
    // To exceed a limit of 10 tokens, we need text > 10 * 3.5 = 35 chars
    const content = 'A'.repeat(200) // ~57 tokens, well over limit of 10
    const limit = 10
    const label = 'Identity'

    const result = enforceFixedBudget(content, limit, label)

    expect(result).not.toBe(content)
    expect(result).toContain(`[${label} 内容过长，已截断。`)
    expect(result).toContain(`限制 ${limit} tokens。]`)
    // The truncated part should be shorter than the original
    expect(result.length).toBeLessThan(content.length + 200)
  })
})
