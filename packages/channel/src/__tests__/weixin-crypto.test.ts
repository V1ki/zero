import { describe, expect, test } from 'bun:test'
import {
  aesDecrypt,
  aesEncrypt,
  aesPaddedSize,
  encodeAesKeyForApi,
  parseAesKey,
  pkcs7Pad,
  pkcs7Unpad,
  randomAesKey,
  randomFileKey,
  randomWechatUin,
} from '../weixin/crypto'

describe('pkcs7', () => {
  test('pad + unpad round-trips for arbitrary lengths', () => {
    for (let len = 0; len < 48; len += 1) {
      const src = Buffer.alloc(len, 0xab)
      const padded = pkcs7Pad(src)
      expect(padded.length % 16).toBe(0)
      expect(pkcs7Unpad(padded).equals(src)).toBe(true)
    }
  })

  test('aesPaddedSize matches Hermes formula', () => {
    expect(aesPaddedSize(0)).toBe(16)
    expect(aesPaddedSize(15)).toBe(16)
    expect(aesPaddedSize(16)).toBe(32)
    expect(aesPaddedSize(31)).toBe(32)
    expect(aesPaddedSize(32)).toBe(48)
  })
})

describe('aesEncrypt/Decrypt', () => {
  test('round-trips arbitrary payloads', () => {
    const key = randomAesKey()
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf-8')
    const cipher = aesEncrypt(payload, key)
    expect(cipher.length).toBe(aesPaddedSize(payload.length))
    expect(aesDecrypt(cipher, key).toString('utf-8')).toBe(payload.toString('utf-8'))
  })

  test('rejects wrong-length key', () => {
    expect(() => aesEncrypt(Buffer.alloc(10), Buffer.alloc(15))).toThrow()
    expect(() => aesDecrypt(Buffer.alloc(16), Buffer.alloc(24))).toThrow()
  })
})

describe('parseAesKey', () => {
  test('accepts base64 of 16 raw bytes', () => {
    const raw = Buffer.alloc(16, 0x2a)
    expect(parseAesKey(raw.toString('base64')).equals(raw)).toBe(true)
  })

  test('accepts base64 of 32-char hex', () => {
    const raw = Buffer.alloc(16, 0x2a)
    const hexAsAscii = Buffer.from(raw.toString('hex'), 'ascii').toString('base64')
    expect(parseAesKey(hexAsAscii).equals(raw)).toBe(true)
  })

  test('throws on invalid length', () => {
    expect(() => parseAesKey(Buffer.alloc(24).toString('base64'))).toThrow()
  })
})

describe('encodeAesKeyForApi', () => {
  test('returns base64 of hex-string ASCII bytes (not raw bytes)', () => {
    const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
    const encoded = encodeAesKeyForApi(key)
    const decoded = Buffer.from(encoded, 'base64').toString('ascii')
    expect(decoded).toBe('0102030405060708090a0b0c0d0e0f10')
  })

  test('is different from base64 of raw key bytes', () => {
    const key = randomAesKey()
    expect(encodeAesKeyForApi(key)).not.toBe(key.toString('base64'))
  })
})

describe('random helpers', () => {
  test('randomFileKey returns 32 hex chars', () => {
    const k = randomFileKey()
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })

  test('randomWechatUin returns base64 of stringified uint32', () => {
    const uin = randomWechatUin()
    const decoded = Buffer.from(uin, 'base64').toString('utf-8')
    expect(/^\d+$/.test(decoded)).toBe(true)
    expect(Number(decoded)).toBeGreaterThanOrEqual(0)
    expect(Number(decoded)).toBeLessThanOrEqual(0xffffffff)
  })
})
