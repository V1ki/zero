import { describe, expect, test } from 'bun:test'
import {
  CHANNEL_VERSION,
  ILINK_APP_CLIENT_VERSION,
  MAX_MESSAGE_LENGTH,
  SESSION_EXPIRED_ERRCODE,
  WEIXIN_PROTOCOL_VERSION,
  buildClientVersion,
} from '../weixin/constants'

describe('constants', () => {
  test('CHANNEL_VERSION matches expected iLink schema', () => {
    expect(WEIXIN_PROTOCOL_VERSION).toBe('2.1.10')
    expect(CHANNEL_VERSION).toBe('2.1.10')
  })

  test('ILINK_APP_CLIENT_VERSION uses official version packing', () => {
    expect(buildClientVersion('2.1.10')).toBe(0x02010a)
    expect(buildClientVersion('258.257.266')).toBe(0x02010a)
    expect(ILINK_APP_CLIENT_VERSION).toBe(131338)
  })

  test('basic limits and error codes', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4000)
    expect(SESSION_EXPIRED_ERRCODE).toBe(-14)
  })
})
