import type { Vault } from '@zero-os/secrets'
import type { ManagedOAuthProviderKind, SystemConfig } from '@zero-os/shared'
import { ChatGptOAuthDriver } from './chatgpt-oauth'
import {
  ensureChatgptProviderConfig,
  getChatgptOAuthTokenRef,
  resolveChatgptProviderInstance,
} from './chatgpt-provider'
import { ClaudeOAuthDriver } from './claude-oauth'
import {
  ensureClaudeProviderConfig,
  getClaudeOAuthSessionRef,
  getClaudeProviderLabel,
  resolveClaudeProviderInstance,
} from './claude-provider'
import { ManagedOAuthCoordinator, type ManagedOAuthProvider } from './oauth-coordinator'
import { XPremiumOAuthDriver } from './x-premium-oauth'
import {
  ensureXPremiumProviderConfig,
  getXPremiumOAuthSessionRef,
  getXPremiumProviderLabel,
  resolveXPremiumProviderInstance,
} from './x-premium-provider'

const MANAGED_OAUTH_TOKEN_REFS = new Set([
  getChatgptOAuthTokenRef(),
  getClaudeOAuthSessionRef(),
  getXPremiumOAuthSessionRef(),
])

export function isManagedOAuthProvider(provider: string): provider is ManagedOAuthProviderKind {
  return provider === 'chatgpt' || provider === 'anthropic' || provider === 'x-premium'
}

export function isManagedOAuthProviderKind(provider: string): provider is ManagedOAuthProviderKind {
  return provider === 'chatgpt' || provider === 'anthropic' || provider === 'x-premium'
}

export function createManagedOAuthCoordinator(vault: Vault, config?: SystemConfig) {
  const coordinator = new ManagedOAuthCoordinator(vault, [
    new ChatGptOAuthDriver(),
    new ClaudeOAuthDriver(),
    new XPremiumOAuthDriver(),
  ])
  if (config) {
    syncManagedOAuthCoordinator(coordinator, config)
  }
  return coordinator
}

export function syncManagedOAuthCoordinator(
  coordinator: ManagedOAuthCoordinator,
  config: SystemConfig,
) {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const kind = getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
    const tokenRef = provider.auth.oauthTokenRef
    if (!kind || !tokenRef) continue
    coordinator.registerDriver(createManagedOAuthDriver(providerName, kind, tokenRef))
  }
}

export function prepareManagedOAuthProvider(
  provider: ManagedOAuthProviderKind,
  options: { name?: string } = {},
) {
  switch (provider) {
    case 'chatgpt':
      return ensureChatgptProviderConfig(options)
    case 'anthropic':
      return ensureClaudeProviderConfig(options)
    case 'x-premium':
      return ensureXPremiumProviderConfig(options)
  }
}

export function isManagedOAuthTokenRef(ref: string, config?: SystemConfig) {
  if (MANAGED_OAUTH_TOKEN_REFS.has(ref)) return true
  return Object.values(config?.providers ?? {}).some((provider) => {
    return provider.auth.type === 'oauth2' && provider.auth.oauthTokenRef === ref
  })
}

export function getManagedOAuthProviderLabel(
  provider: ManagedOAuthProvider | ManagedOAuthProviderKind,
) {
  switch (provider) {
    case 'chatgpt':
      return 'ChatGPT'
    case 'anthropic':
      return getClaudeProviderLabel()
    case 'x-premium':
      return getXPremiumProviderLabel()
    default:
      return provider
  }
}

export function getManagedOAuthKindForProvider(
  providerName: string,
  configuredKind?: string,
): ManagedOAuthProviderKind | undefined {
  if (isManagedOAuthProviderKind(configuredKind ?? '')) {
    return configuredKind as ManagedOAuthProviderKind
  }
  if (providerName === 'chatgpt' || providerName.startsWith('chatgpt-')) return 'chatgpt'
  if (providerName === 'anthropic' || providerName.startsWith('anthropic-')) return 'anthropic'
  if (providerName === 'x-premium' || providerName.startsWith('x-premium-')) return 'x-premium'
  return undefined
}

export function getManagedOAuthTokenRefForKind(kind: ManagedOAuthProviderKind, name?: string) {
  switch (kind) {
    case 'chatgpt':
      return resolveChatgptProviderInstance({ name }).oauthTokenRef
    case 'anthropic':
      return resolveClaudeProviderInstance({ name }).oauthTokenRef
    case 'x-premium':
      return resolveXPremiumProviderInstance({ name }).oauthTokenRef
  }
}

function createManagedOAuthDriver(
  providerName: string,
  kind: ManagedOAuthProviderKind,
  tokenRef: string,
) {
  switch (kind) {
    case 'chatgpt':
      return new ChatGptOAuthDriver({ providerName, tokenRef })
    case 'anthropic':
      return new ClaudeOAuthDriver({ providerName, tokenRef })
    case 'x-premium':
      return new XPremiumOAuthDriver({ providerName, tokenRef })
  }
}
