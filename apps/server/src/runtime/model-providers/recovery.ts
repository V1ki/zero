import type { ProviderRecoveryHint, ProviderRecoveryResolver } from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import type { ManagedOAuthProviderKind, ProviderConfig, SystemConfig } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import type { OAuthSessionRefresher } from '../../oauth/provider/driver-session'
import type { OAuthRefreshReason } from '../../oauth/provider/token-manager'
import { ChatGptTokenManager } from '../../providers/chatgpt/oauth'
import { ChatGptUsageService, type ChatGptUsageSnapshot } from '../../providers/chatgpt/usage'
import { ClaudeTokenManager } from '../../providers/claude/oauth'
import { ClaudeUsageService, type ClaudeUsageSnapshot } from '../../providers/claude/usage'
import { getManagedOAuthKindForProvider } from '../../providers/managed-oauth'
import { XPremiumTokenManager } from '../../providers/x-premium'

export function createProviderRecoveryResolver(
  getConfig: () => SystemConfig,
  vault: Vault,
): ProviderRecoveryResolver {
  return async ({ providerName, modelName, reason }) => {
    const config = getConfig()
    const provider = config.providers[providerName]
    const kind = provider
      ? getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
      : undefined
    const tokenRef = provider?.auth.oauthTokenRef
    if (!kind || !tokenRef) return undefined

    if (reason === 'auth_error') {
      return recoverProviderAuth({ kind, providerName, tokenRef, vault })
    }

    if (reason === 'quota_limited') {
      return recoverProviderQuota({ kind, providerName, modelName, tokenRef, provider, vault })
    }

    return undefined
  }
}

export function createOAuthRefreshers(config: SystemConfig, vault: Vault) {
  const refreshers: Record<string, (reason: OAuthRefreshReason) => Promise<void>> = {}

  for (const [providerName, provider] of Object.entries(config.providers)) {
    const kind = getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
    const tokenRef = provider.auth.oauthTokenRef
    if (!kind || !tokenRef) continue

    if (kind === 'chatgpt') {
      refreshers[providerName] = createRefresher(
        new ChatGptTokenManager(vault, { providerName, tokenRef }),
      )
    } else if (kind === 'anthropic') {
      refreshers[providerName] = createRefresher(
        new ClaudeTokenManager(vault, { providerName, tokenRef }),
      )
    } else if (kind === 'x-premium') {
      refreshers[providerName] = createRefresher(
        new XPremiumTokenManager(vault, { providerName, tokenRef }),
      )
    }
  }

  return refreshers
}

export function quotaHintFromChatGptUsage(
  usage: ChatGptUsageSnapshot,
  now = Date.now(),
): ProviderRecoveryHint {
  const windows = [usage.rateLimits.primary, usage.rateLimits.secondary].filter(Boolean)
  const exhaustedResets = windows
    .filter((window) => typeof window?.usedPercent === 'number' && window.usedPercent >= 95)
    .map((window) => (typeof window?.resetsAt === 'number' ? window.resetsAt * 1000 : undefined))
    .filter((value): value is number => typeof value === 'number' && value > now)

  if (exhaustedResets.length === 0) {
    return { state: 'healthy', evidence: { source: 'chatgpt_usage' } }
  }

  return {
    state: 'quota_limited',
    cooldownUntil: Math.max(...exhaustedResets),
    evidence: { source: 'chatgpt_usage' },
  }
}

export function quotaHintFromClaudeUsage(
  usage: ClaudeUsageSnapshot | null,
  modelName?: string,
  now = Date.now(),
): ProviderRecoveryHint | undefined {
  if (!usage) return undefined
  const windows = [
    usage.five_hour,
    usage.seven_day,
    usage.seven_day_oauth_apps,
    modelName?.includes('opus') ? usage.seven_day_opus : undefined,
    modelName?.includes('sonnet') ? usage.seven_day_sonnet : undefined,
  ].filter(Boolean)
  const exhaustedResets = windows
    .filter((window) => isClaudeUsageExhausted(window?.utilization))
    .map((window) => parseResetMs(window?.resets_at))
    .filter((value): value is number => typeof value === 'number' && value > now)

  if (usage.extra_usage && isClaudeUsageExhausted(usage.extra_usage.utilization)) {
    return {
      state: 'quota_limited',
      cooldownUntil: exhaustedResets.length > 0 ? Math.max(...exhaustedResets) : now + 60 * 60_000,
      evidence: { source: 'claude_usage', extraUsage: true },
    }
  }

  if (exhaustedResets.length === 0) {
    return { state: 'healthy', evidence: { source: 'claude_usage' } }
  }

  return {
    state: 'quota_limited',
    cooldownUntil: Math.max(...exhaustedResets),
    evidence: { source: 'claude_usage' },
  }
}

export function conservativeQuotaCooldownHint(now = Date.now()): ProviderRecoveryHint {
  return {
    state: 'quota_limited',
    cooldownUntil: now + 60 * 60_000,
    reason: 'x-premium usage reset is not available; using conservative cooldown',
  }
}

async function recoverProviderAuth(options: {
  kind: ManagedOAuthProviderKind
  providerName: string
  tokenRef: string
  vault: Vault
}): Promise<ProviderRecoveryHint> {
  const { kind, providerName, tokenRef, vault } = options

  try {
    if (kind === 'chatgpt') {
      await new ChatGptTokenManager(vault, { providerName, tokenRef }).refreshSession(
        'unauthorized',
      )
    } else if (kind === 'anthropic') {
      await new ClaudeTokenManager(vault, { providerName, tokenRef }).refreshSession('unauthorized')
    } else {
      await new XPremiumTokenManager(vault, { providerName, tokenRef }).refreshSession(
        'unauthorized',
      )
    }
    return { state: 'healthy', evidence: { source: 'oauth_refresh' } }
  } catch (error) {
    return {
      state: 'auth_error',
      cooldownUntil: Date.now() + 60_000,
      reason: toErrorMessage(error),
      evidence: { source: 'oauth_refresh' },
    }
  }
}

async function recoverProviderQuota(options: {
  kind: ManagedOAuthProviderKind
  providerName: string
  modelName?: string
  tokenRef: string
  provider: ProviderConfig
  vault: Vault
}): Promise<ProviderRecoveryHint | undefined> {
  const { kind, providerName, modelName, tokenRef, provider, vault } = options

  if (kind === 'chatgpt') {
    const usage = await new ChatGptUsageService(vault, {
      providerName,
      tokenRef,
      baseUrl: provider.baseUrl,
    }).fetchUsage()
    return quotaHintFromChatGptUsage(usage)
  }

  if (kind === 'anthropic') {
    const usage = await new ClaudeUsageService(vault, { providerName, tokenRef }).fetchUsage()
    return quotaHintFromClaudeUsage(usage, modelName)
  }

  return conservativeQuotaCooldownHint()
}

function createRefresher(sessionRefresher: OAuthSessionRefresher) {
  return async (reason: OAuthRefreshReason) => {
    if (reason === 'expiring') {
      await sessionRefresher.ensureFreshSession()
      return
    }

    await sessionRefresher.refreshSession(reason)
  }
}

function isClaudeUsageExhausted(value: number | null | undefined): boolean {
  if (typeof value !== 'number') return false
  return value >= 95 || (value <= 1 && value >= 0.95)
}

function parseResetMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
