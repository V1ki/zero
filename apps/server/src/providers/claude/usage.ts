import type { ClaudeOAuthSession } from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { ClaudeTokenManager } from './oauth'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const ZERO_OS_USER_AGENT = 'zero-os/0.1.0 (external, cli)'

export interface ClaudeRateLimitWindow {
  utilization: number | null
  resets_at: string | null
}

export interface ClaudeExtraUsageWindow {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export interface ClaudeUsageSnapshot {
  five_hour?: ClaudeRateLimitWindow | null
  seven_day?: ClaudeRateLimitWindow | null
  seven_day_oauth_apps?: ClaudeRateLimitWindow | null
  seven_day_opus?: ClaudeRateLimitWindow | null
  seven_day_sonnet?: ClaudeRateLimitWindow | null
  extra_usage?: ClaudeExtraUsageWindow | null
}

export class ClaudeUsageService {
  private tokenManager: ClaudeTokenManager

  constructor(vault: Vault, options: { providerName?: string; tokenRef?: string } = {}) {
    this.tokenManager = new ClaudeTokenManager(vault, {
      providerName: options.providerName,
      tokenRef: options.tokenRef,
    })
  }

  async fetchUsage(): Promise<ClaudeUsageSnapshot | null> {
    const session = this.tokenManager.readSession()
    if (!session) {
      throw new Error(
        'Claude OAuth credentials not found. Please run `bun zero provider login anthropic`.',
      )
    }

    if (!canFetchClaudeUsage(session)) {
      return {}
    }

    const freshSession = await this.tokenManager.ensureFreshSession()
    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${freshSession.accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': ZERO_OS_USER_AGENT,
        'x-app': 'cli',
      },
    })

    if (!response.ok) {
      throw new Error(`Claude usage fetch failed: ${response.status} ${await response.text()}`)
    }

    return (await response.json()) as ClaudeUsageSnapshot
  }
}

export function canFetchClaudeUsage(
  session: Pick<ClaudeOAuthSession, 'scopes' | 'subscriptionType'>,
): boolean {
  return hasClaudeProfileScope(session.scopes) && isClaudeSubscriber(session.subscriptionType)
}

function hasClaudeProfileScope(scopes: string[]): boolean {
  return scopes.includes('user:profile')
}

function isClaudeSubscriber(subscriptionType: string | null | undefined): boolean {
  return Boolean(subscriptionType)
}
