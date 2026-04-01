import type { Vault } from '@zero-os/secrets'
import { ChatGptOAuthDriver } from './chatgpt-oauth'
import { ensureChatgptProviderConfig, getChatgptOAuthTokenRef } from './chatgpt-provider'
import { ClaudeOAuthDriver } from './claude-oauth'
import {
  ensureClaudeProviderConfig,
  getClaudeOAuthSessionRef,
  getClaudeProviderLabel,
} from './claude-provider'
import { ManagedOAuthCoordinator, type ManagedOAuthProvider } from './oauth-coordinator'

const MANAGED_OAUTH_TOKEN_REFS = new Set([getChatgptOAuthTokenRef(), getClaudeOAuthSessionRef()])

export function isManagedOAuthProvider(provider: string): provider is ManagedOAuthProvider {
  return provider === 'chatgpt' || provider === 'anthropic'
}

export function createManagedOAuthCoordinator(vault: Vault) {
  return new ManagedOAuthCoordinator(vault, [new ChatGptOAuthDriver(), new ClaudeOAuthDriver()])
}

export function prepareManagedOAuthProvider(provider: ManagedOAuthProvider) {
  switch (provider) {
    case 'chatgpt':
      return ensureChatgptProviderConfig()
    case 'anthropic':
      return ensureClaudeProviderConfig()
  }
}

export function isManagedOAuthTokenRef(ref: string) {
  return MANAGED_OAUTH_TOKEN_REFS.has(ref)
}

export function getManagedOAuthProviderLabel(provider: ManagedOAuthProvider) {
  switch (provider) {
    case 'chatgpt':
      return 'ChatGPT'
    case 'anthropic':
      return getClaudeProviderLabel()
  }
}
