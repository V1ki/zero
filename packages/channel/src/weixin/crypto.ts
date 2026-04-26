/**
 * AES-128-ECB envelope helpers for the Weixin CDN.
 *
 * Key insight from the Hermes implementation: the service expects the
 * `aes_key` field in JSON payloads to be the base64 of the HEX string of the
 * random key, NOT base64 of the raw 16 bytes. Mixing those up causes images to
 * render as grey boxes on the receiver side.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const BLOCK_SIZE = 16

export function pkcs7Pad(data: Buffer, blockSize = BLOCK_SIZE): Buffer {
  const padLen = blockSize - (data.length % blockSize)
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)])
}

export function pkcs7Unpad(data: Buffer, blockSize = BLOCK_SIZE): Buffer {
  if (data.length === 0) return data
  const padLen = data[data.length - 1]
  if (padLen >= 1 && padLen <= blockSize) {
    const pad = Buffer.alloc(padLen, padLen)
    if (data.slice(data.length - padLen).equals(pad)) {
      return data.slice(0, data.length - padLen)
    }
  }
  return data
}

export function aesPaddedSize(size: number): number {
  return Math.floor((size + 1 + 15) / 16) * 16
}

export function aesEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(pkcs7Pad(plaintext)), cipher.final()])
}

export function aesDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return pkcs7Unpad(raw)
}

/**
 * Parse an `aes_key` field from an iLink media item. Accepts:
 *   - base64 of 16 raw bytes
 *   - base64 of a 32-character hex string (decoded as hex)
 */
export function parseAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32) {
    const text = decoded.toString('ascii')
    if (/^[0-9a-fA-F]{32}$/.test(text)) {
      return Buffer.from(text, 'hex')
    }
  }
  throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`)
}

/**
 * Encode an AES key for iLink outbound payloads.
 *
 * Returns `base64(hex_string_ascii_bytes)` — the counterintuitive encoding
 * that the service requires.
 */
export function encodeAesKeyForApi(rawKey: Buffer): string {
  return Buffer.from(rawKey.toString('hex'), 'ascii').toString('base64')
}

export function randomAesKey(): Buffer {
  return randomBytes(16)
}

export function randomFileKey(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Build the random X-WECHAT-UIN header value:
 *   base64(str(rand_uint32))
 */
export function randomWechatUin(): string {
  const buf = randomBytes(4)
  const value = buf.readUInt32BE(0)
  return Buffer.from(String(value), 'utf-8').toString('base64')
}
