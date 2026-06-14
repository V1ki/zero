import { loadConfig } from '@zero-os/core'
import { getChatGptAuthorizationScheme } from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { getProviderConfigPath } from '../../oauth/provider/provider-config'
import { ChatGptTokenManager } from './oauth'

const ZERO_OS_USER_AGENT = 'zero-os/0.1.0 (external, cli)'
const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'

export interface ChatGptRawRateLimitWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

export interface ChatGptRawRateLimitStatusDetails {
  primary_window?: ChatGptRawRateLimitWindow | null
  secondary_window?: ChatGptRawRateLimitWindow | null
}

export interface ChatGptRawCreditsSnapshot {
  has_credits?: boolean
  unlimited?: boolean
  balance?: string | null
}

export interface ChatGptRawAdditionalRateLimit {
  limit_name?: string
  metered_feature?: string
  rate_limit?: ChatGptRawRateLimitStatusDetails | null
}

export interface ChatGptRawUsagePayload {
  plan_type?: string
  rate_limit?: ChatGptRawRateLimitStatusDetails | null
  credits?: ChatGptRawCreditsSnapshot | null
  additional_rate_limits?: ChatGptRawAdditionalRateLimit[] | null
}

export interface ChatGptUsageWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface ChatGptCreditsSnapshot {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface ChatGptRateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: ChatGptUsageWindow | null
  secondary: ChatGptUsageWindow | null
  credits: ChatGptCreditsSnapshot | null
  planType: string | null
}

export interface ChatGptUsageSnapshot {
  rateLimits: ChatGptRateLimitSnapshot
  rateLimitsByLimitId: Record<string, ChatGptRateLimitSnapshot> | null
}

export interface NormalizeChatGptRateLimitSnapshotParams {
  limitId: string | null
  limitName: string | null
  rateLimit: ChatGptRawRateLimitStatusDetails | null | undefined
  credits: ChatGptRawCreditsSnapshot | null | undefined
  planType: string | null
}

export class ChatGptUsageService {
  private tokenManager: ChatGptTokenManager
  private baseUrl?: string

  constructor(
    vault: Vault,
    options: { providerName?: string; tokenRef?: string; baseUrl?: string } = {},
  ) {
    this.tokenManager = new ChatGptTokenManager(vault, {
      providerName: options.providerName,
      tokenRef: options.tokenRef,
    })
    this.baseUrl = options.baseUrl
  }

  async fetchUsage(): Promise<ChatGptUsageSnapshot> {
    const session = await this.tokenManager.ensureFreshSession()
    const response = await fetch(getChatGptUsageUrl(this.baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `${getChatGptAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'Content-Type': 'application/json',
        'User-Agent': ZERO_OS_USER_AGENT,
      },
    })

    if (!response.ok) {
      throw new Error(`ChatGPT usage fetch failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as ChatGptRawUsagePayload
    return normalizeChatGptUsagePayload(payload)
  }
}

export function normalizeChatGptUsageBaseUrl(baseUrl: string | undefined): string {
  let normalized = (baseUrl ?? DEFAULT_CHATGPT_BASE_URL).trim() || DEFAULT_CHATGPT_BASE_URL
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  if (
    (normalized.startsWith('https://chatgpt.com') ||
      normalized.startsWith('https://chat.openai.com')) &&
    !normalized.includes('/backend-api')
  ) {
    normalized = `${normalized}/backend-api`
  }

  if (normalized.endsWith('/backend-api/codex')) {
    normalized = normalized.slice(0, -'/codex'.length)
  }

  return normalized
}

export function normalizeChatGptRateLimitSnapshot(
  params: NormalizeChatGptRateLimitSnapshotParams,
): ChatGptRateLimitSnapshot {
  return {
    limitId: params.limitId,
    limitName: params.limitName,
    primary: normalizeChatGptUsageWindow(params.rateLimit?.primary_window),
    secondary: normalizeChatGptUsageWindow(params.rateLimit?.secondary_window),
    credits: normalizeChatGptCredits(params.credits),
    planType: params.planType,
  }
}

export function normalizeChatGptUsagePayload(
  payload: ChatGptRawUsagePayload,
): ChatGptUsageSnapshot {
  const planType = typeof payload.plan_type === 'string' ? payload.plan_type : null
  const root = normalizeChatGptRateLimitSnapshot({
    limitId: 'codex',
    limitName: null,
    rateLimit: payload.rate_limit,
    credits: payload.credits,
    planType,
  })

  const byLimitId: Record<string, ChatGptRateLimitSnapshot> = {
    codex: root,
  }

  for (const item of payload.additional_rate_limits ?? []) {
    const limitId =
      typeof item.metered_feature === 'string' && item.metered_feature.trim()
        ? item.metered_feature
        : null
    if (!limitId) {
      continue
    }

    byLimitId[limitId] = normalizeChatGptRateLimitSnapshot({
      limitId,
      limitName: typeof item.limit_name === 'string' ? item.limit_name : null,
      rateLimit: item.rate_limit,
      credits: null,
      planType,
    })
  }

  return {
    rateLimits: root,
    rateLimitsByLimitId: Object.keys(byLimitId).length > 0 ? byLimitId : null,
  }
}

function getChatGptUsageUrl(baseUrlOverride?: string): string {
  if (baseUrlOverride) {
    return `${normalizeChatGptUsageBaseUrl(baseUrlOverride)}/wham/usage`
  }
  const config = loadConfig(getProviderConfigPath())
  const baseUrl = normalizeChatGptUsageBaseUrl(config.providers.chatgpt?.baseUrl)
  return `${baseUrl}/wham/usage`
}

function normalizeChatGptUsageWindow(
  window: ChatGptRawRateLimitWindow | null | undefined,
): ChatGptUsageWindow | null {
  if (!window || typeof window.used_percent !== 'number') {
    return null
  }

  return {
    usedPercent: window.used_percent,
    windowDurationMins:
      typeof window.limit_window_seconds === 'number'
        ? Math.round(window.limit_window_seconds / 60)
        : null,
    resetsAt: typeof window.reset_at === 'number' ? window.reset_at : null,
  }
}

function normalizeChatGptCredits(
  credits: ChatGptRawCreditsSnapshot | null | undefined,
): ChatGptCreditsSnapshot | null {
  if (!credits) {
    return null
  }

  return {
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    balance: typeof credits.balance === 'string' ? credits.balance : null,
  }
}
