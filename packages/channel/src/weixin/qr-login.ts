/**
 * Interactive QR login flow for the Weixin iLink Bot API.
 *
 * The terminal rendering is left to the caller via `onQrCode`; this module
 * only owns the polling state machine.
 */

import { ILINK_BASE_URL } from './constants'
import { getBotQrCode, getQrCodeStatus, type ApiOptions, type FetchImpl } from './api'
import type { ILinkCredentials } from './types'

export interface QrLoginOptions {
  botType?: string
  pollIntervalMs?: number
  timeoutMs?: number
  maxRefresh?: number
  fetchImpl?: FetchImpl
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called whenever a new QR code is issued (initial + refreshes). */
  onQrCode?: (qr: { value: string; imageContent: string }) => void
  /** Called when scan status transitions (useful for CLI progress output). */
  onStatus?: (status: string) => void
}

export interface QrLoginResult {
  credentials: ILinkCredentials
}

export async function runQrLogin(options: QrLoginOptions = {}): Promise<QrLoginResult | null> {
  const fetchImpl = options.fetchImpl
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 480_000
  const maxRefresh = options.maxRefresh ?? 3
  const botType = options.botType ?? '3'
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? (() => Date.now())
  const apiOpts: ApiOptions = fetchImpl ? { fetchImpl } : {}

  let qr = await getBotQrCode({ botType }, apiOpts)
  if (!qr.qrcode) return null
  options.onQrCode?.({
    value: qr.qrcode,
    imageContent: qr.qrcode_img_content ?? '',
  })

  let currentBaseUrl = ILINK_BASE_URL
  let refreshCount = 0
  const deadline = now() + timeoutMs

  while (now() < deadline) {
    let status: Awaited<ReturnType<typeof getQrCodeStatus>>
    try {
      status = await getQrCodeStatus({ baseUrl: currentBaseUrl, qrcode: qr.qrcode }, apiOpts)
    } catch {
      await sleep(pollIntervalMs)
      continue
    }

    const state = status.status ?? 'wait'
    options.onStatus?.(state)

    if (state === 'wait' || state === 'scaned') {
      await sleep(pollIntervalMs)
      continue
    }

    if (state === 'scaned_but_redirect') {
      const host = status.redirect_host ?? ''
      if (host) currentBaseUrl = `https://${host}`
      await sleep(pollIntervalMs)
      continue
    }

    if (state === 'expired') {
      refreshCount += 1
      if (refreshCount > maxRefresh) return null
      try {
        qr = await getBotQrCode({ botType }, apiOpts)
      } catch {
        return null
      }
      if (!qr.qrcode) return null
      options.onQrCode?.({
        value: qr.qrcode,
        imageContent: qr.qrcode_img_content ?? '',
      })
      await sleep(pollIntervalMs)
      continue
    }

    if (state === 'confirmed') {
      const accountId = String(status.ilink_bot_id ?? '')
      const token = String(status.bot_token ?? '')
      if (!accountId || !token) return null
      return {
        credentials: {
          accountId,
          token,
          baseUrl: String(status.baseurl ?? ILINK_BASE_URL),
          userId: status.ilink_user_id ? String(status.ilink_user_id) : undefined,
          savedAt: new Date().toISOString(),
        },
      }
    }

    await sleep(pollIntervalMs)
  }
  return null
}
