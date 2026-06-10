import { describe, expect, test } from 'bun:test'
import { truncateToTokens } from '../utils/tokens'

// 对抗R7回归：truncateToTokens 不切裂代理对（星平面字符不被损坏）。
describe('truncateToTokens surrogate safety', () => {
  test('drops a trailing lone high surrogate instead of splitting an astral char', () => {
    // maxTokens=64 → maxChars=224。前 223 个 BMP 字符 + 1 个星平面字符(U+1D54F,占2码元)
    const astral = String.fromCodePoint(0x1d54f) // 𝕏
    const text = `${'x'.repeat(223)}${astral}tail`
    const out = truncateToTokens(text, 64)
    // 切在码元 224 会留半个高位代理；修复后应丢弃它，末位不是落单高代理
    const last = out.charCodeAt(out.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    // UTF-8 往返不损坏
    expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out)
  })

  test('keeps a complete astral char when it fits within budget', () => {
    const astral = String.fromCodePoint(0x1f600) // 😀
    const out = truncateToTokens(`${astral}hello`, 64)
    expect(out).toBe(`${astral}hello`)
  })
})
