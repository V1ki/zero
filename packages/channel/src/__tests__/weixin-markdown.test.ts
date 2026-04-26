import { describe, expect, test } from 'bun:test'
import {
  normalizeMarkdownForWeixin,
  splitForWeixinDelivery,
} from '../weixin/markdown'

describe('normalizeMarkdownForWeixin', () => {
  test('H1 becomes 【Title】 and H2+ become bold', () => {
    expect(normalizeMarkdownForWeixin('# Hi\n## Sub')).toBe('【Hi】\n**Sub**')
  })

  test('inline markdown links become "text (url)"', () => {
    expect(normalizeMarkdownForWeixin('see [docs](https://x)')).toBe('see docs (https://x)')
  })

  test('tables collapse to - key: value list', () => {
    const table = ['| name | value |', '|------|-------|', '| a | 1 |', '| b | 2 |'].join('\n')
    const out = normalizeMarkdownForWeixin(table)
    expect(out).toContain('- name: a')
    expect(out).toContain('  value: 1')
    expect(out).toContain('- name: b')
  })

  test('code blocks are preserved verbatim', () => {
    const src = '```py\n# comment\nprint(1)\n```'
    expect(normalizeMarkdownForWeixin(src)).toBe(src)
  })
})

describe('splitForWeixinDelivery', () => {
  test('returns single bubble when under limit', () => {
    expect(splitForWeixinDelivery('hi')).toEqual(['hi'])
  })

  test('empty content returns empty array', () => {
    expect(splitForWeixinDelivery('')).toEqual([])
  })

  test('splits oversized block at block boundary (compact mode)', () => {
    const long = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000)
    const parts = splitForWeixinDelivery(long)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts.every((p) => p.length <= 4000)).toBe(true)
  })

  test('short chatty multi-line blocks split into bubbles', () => {
    const src = 'hi\nhow are you\njust checking in'
    const out = splitForWeixinDelivery(src)
    expect(out.length).toBe(3)
  })

  test('per_line legacy mode splits on top-level newlines', () => {
    const src = 'line one\nline two'
    const out = splitForWeixinDelivery(src, { splitMultilineMessages: true })
    expect(out).toEqual(['line one', 'line two'])
  })

  test('hard-truncates single oversized line', () => {
    const src = 'x'.repeat(12_000)
    const out = splitForWeixinDelivery(src, { maxLength: 4000 })
    expect(out.length).toBe(3)
    expect(out.every((p) => p.length <= 4000)).toBe(true)
  })
})
