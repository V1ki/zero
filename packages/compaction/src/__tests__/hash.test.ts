import { describe, expect, test } from 'bun:test'
import { stableDigest, stableJson } from '../hash'

describe('stable hash serialization', () => {
  test('sorts keys by fixed code-unit order instead of host locale', () => {
    const first = { ä: 1, a: 2, Z: 3, A: 4, '😀': 5 }
    const second = { '😀': 5, A: 4, Z: 3, a: 2, ä: 1 }

    expect(stableJson(first)).toBe('{"A":4,"Z":3,"a":2,"ä":1,"😀":5}')
    expect(stableJson(second)).toBe(stableJson(first))
    expect(stableDigest(second)).toBe(stableDigest(first))
  })
})
