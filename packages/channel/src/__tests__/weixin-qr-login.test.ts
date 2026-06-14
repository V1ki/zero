import { describe, expect, test } from 'bun:test'
import type { FetchImpl } from '../weixin/api-transport'
import { runQrLogin } from '../weixin/qr-login'

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('runQrLogin', () => {
  test('returns credentials on confirmed', async () => {
    let step = 0
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url)
      if (u.includes('get_bot_qrcode')) {
        return okJson({ qrcode: 'q1', qrcode_img_content: 'https://img' })
      }
      step += 1
      if (step === 1) return okJson({ status: 'wait' })
      if (step === 2) return okJson({ status: 'scaned' })
      return okJson({
        status: 'confirmed',
        ilink_bot_id: 'bot1',
        bot_token: 'tok1',
        baseurl: 'https://api',
        ilink_user_id: 'u1',
      })
    }
    const result = await runQrLogin({ fetchImpl, pollIntervalMs: 0, sleep: async () => {} })
    expect(result?.credentials.accountId).toBe('bot1')
    expect(result?.credentials.token).toBe('tok1')
    expect(result?.credentials.userId).toBe('u1')
  })

  test('follows redirect_host and keeps polling', async () => {
    const hosts: string[] = []
    let phase = 0
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url)
      if (u.includes('get_bot_qrcode')) {
        return okJson({ qrcode: 'q', qrcode_img_content: 'x' })
      }
      hosts.push(new URL(u).host)
      phase += 1
      if (phase === 1) {
        return okJson({
          status: 'scaned_but_redirect',
          redirect_host: 'api2.example',
        })
      }
      return okJson({
        status: 'confirmed',
        ilink_bot_id: 'b',
        bot_token: 't',
        baseurl: 'https://api2.example',
      })
    }
    const result = await runQrLogin({ fetchImpl, pollIntervalMs: 0, sleep: async () => {} })
    expect(result?.credentials.accountId).toBe('b')
    expect(hosts).toContain('api2.example')
  })

  test('refreshes QR on expired up to maxRefresh', async () => {
    let issued = 0
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url)
      if (u.includes('get_bot_qrcode')) {
        issued += 1
        return okJson({ qrcode: `q${issued}`, qrcode_img_content: '' })
      }
      return okJson({ status: 'expired' })
    }
    const codes: string[] = []
    const result = await runQrLogin({
      fetchImpl,
      pollIntervalMs: 0,
      sleep: async () => {},
      maxRefresh: 2,
      onQrCode: ({ value }) => codes.push(value),
    })
    expect(result).toBeNull()
    expect(issued).toBeGreaterThanOrEqual(3)
    expect(codes.length).toBeGreaterThanOrEqual(3)
  })

  test('times out when deadline passes', async () => {
    let currentNow = 0
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url)
      if (u.includes('get_bot_qrcode')) {
        return okJson({ qrcode: 'q', qrcode_img_content: '' })
      }
      return okJson({ status: 'wait' })
    }
    const result = await runQrLogin({
      fetchImpl,
      pollIntervalMs: 10,
      timeoutMs: 50,
      sleep: async (ms) => {
        currentNow += ms
      },
      now: () => currentNow,
    })
    expect(result).toBeNull()
  })
})
