import type { SystemConfig } from '@zero-os/shared'
import { ensureOAuthProviderConfig } from '../../oauth/provider/provider-config'
import {
  type OAuthProviderInstanceOptions,
  resolveOAuthProviderInstance,
} from '../../oauth/provider/provider-instance'

const CLAUDE_PROVIDER = 'anthropic'
const CLAUDE_OAUTH_SESSION_REF = 'claude_oauth_session'
const CLAUDE_BASE_URL = 'https://api.anthropic.com'

export type ClaudeProviderInstanceOptions = OAuthProviderInstanceOptions

export function resolveClaudeProviderInstance(options: ClaudeProviderInstanceOptions = {}) {
  return resolveOAuthProviderInstance(options, {
    providerName: CLAUDE_PROVIDER,
    oauthTokenRef: CLAUDE_OAUTH_SESSION_REF,
    namedTokenRefPrefix: 'claude_oauth',
  })
}

export function getClaudeOAuthSessionRef() {
  return CLAUDE_OAUTH_SESSION_REF
}

export function getClaudeProviderName() {
  return CLAUDE_PROVIDER
}

export function getClaudeProviderLabel() {
  return 'Claude'
}

export function ensureClaudeProviderConfig(options: ClaudeProviderInstanceOptions = {}): {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
} {
  const instance = resolveClaudeProviderInstance(options)
  return ensureOAuthProviderConfig({
    instance,
    managedProviderName: CLAUDE_PROVIDER,
    apiType: 'anthropic_messages',
    baseUrl: CLAUDE_BASE_URL,
    applyModels: ({ provider }) => ensureClaudeDefaultModels(provider),
  })
}

function getDefaultClaudeModels() {
  return {
    'claude-sonnet-4-6': {
      model_id: 'claude-sonnet-4-6',
      max_context: 200000,
      max_output: 8192,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['coding', 'balanced', 'oauth'],
    },
  }
}

function ensureClaudeDefaultModels(provider: Record<string, unknown>): boolean {
  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = getDefaultClaudeModels()
    return true
  }

  const models = provider.models as Record<string, unknown>
  if (Object.keys(models).length > 0) return false

  provider.models = getDefaultClaudeModels()
  return true
}
