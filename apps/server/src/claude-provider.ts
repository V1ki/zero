import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { SystemConfig } from '@zero-os/shared'

const CLAUDE_PROVIDER = 'anthropic'
const CLAUDE_OAUTH_SESSION_REF = 'claude_oauth_session'

function getZeroDir() {
  return process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
}

export interface ClaudeProviderInstanceOptions {
  name?: string
  providerName?: string
  oauthTokenRef?: string
}

function toInstanceSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error('OAuth provider instance name must contain at least one letter or number.')
  }
  return slug
}

export function resolveClaudeProviderInstance(options: ClaudeProviderInstanceOptions = {}) {
  if (options.providerName || options.oauthTokenRef) {
    return {
      providerName: options.providerName ?? CLAUDE_PROVIDER,
      oauthTokenRef: options.oauthTokenRef ?? CLAUDE_OAUTH_SESSION_REF,
    }
  }

  if (!options.name) {
    return {
      providerName: CLAUDE_PROVIDER,
      oauthTokenRef: CLAUDE_OAUTH_SESSION_REF,
    }
  }

  const slug = toInstanceSlug(options.name)
  return {
    providerName: `${CLAUDE_PROVIDER}-${slug}`,
    oauthTokenRef: `claude_oauth_${slug.replace(/-/g, '_')}`,
  }
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

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  return readYaml<Record<string, unknown>>(configPath)
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

export function getConfigPath() {
  return join(getZeroDir(), 'config.yaml')
}

export function ensureClaudeProviderConfig(options: ClaudeProviderInstanceOptions = {}): {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
} {
  const instance = resolveClaudeProviderInstance(options)
  const configPath = getConfigPath()
  const raw = loadRawConfig()
  let changed = false

  if (!raw.providers || typeof raw.providers !== 'object') {
    raw.providers = {}
    changed = true
  }

  const providers = raw.providers as Record<string, unknown>
  if (!providers[instance.providerName] || typeof providers[instance.providerName] !== 'object') {
    providers[instance.providerName] = {}
    changed = true
  }

  const provider = providers[instance.providerName] as Record<string, unknown>

  if (provider.api_type !== 'anthropic_messages') {
    provider.api_type = 'anthropic_messages'
    changed = true
  }

  if (provider.base_url !== 'https://api.anthropic.com') {
    provider.base_url = 'https://api.anthropic.com'
    changed = true
  }

  if (!provider.auth || typeof provider.auth !== 'object') {
    provider.auth = {}
    changed = true
  }

  const auth = provider.auth as Record<string, unknown>
  if (auth.type !== 'oauth2') {
    auth.type = 'oauth2'
    changed = true
  }

  if (auth.oauth_token_ref !== instance.oauthTokenRef) {
    auth.oauth_token_ref = instance.oauthTokenRef
    changed = true
  }

  if (
    instance.providerName !== CLAUDE_PROVIDER &&
    auth.managed_oauth_provider !== CLAUDE_PROVIDER
  ) {
    auth.managed_oauth_provider = CLAUDE_PROVIDER
    changed = true
  }

  if ('api_key_ref' in auth) {
    const { api_key_ref: _apiKeyRef, ...nextAuth } = auth
    provider.auth = nextAuth
    changed = true
  }

  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = getDefaultClaudeModels()
    changed = true
  } else {
    const models = provider.models as Record<string, unknown>
    if (Object.keys(models).length === 0) {
      provider.models = getDefaultClaudeModels()
      changed = true
    }
  }

  if (changed) {
    writeYaml(configPath, raw)
  }

  return {
    changed,
    config: loadConfig(configPath),
    providerName: instance.providerName,
    oauthTokenRef: instance.oauthTokenRef,
  }
}
