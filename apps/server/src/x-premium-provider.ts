import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { SystemConfig } from '@zero-os/shared'

const X_PREMIUM_PROVIDER = 'x-premium'
const X_PREMIUM_OAUTH_SESSION_REF = 'x_premium_oauth_session'
const X_PREMIUM_BASE_URL = 'https://api.x.ai/v1'

function getZeroDir() {
  return process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
}

export interface XPremiumProviderInstanceOptions {
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

export function resolveXPremiumProviderInstance(options: XPremiumProviderInstanceOptions = {}) {
  if (options.providerName || options.oauthTokenRef) {
    return {
      providerName: options.providerName ?? X_PREMIUM_PROVIDER,
      oauthTokenRef: options.oauthTokenRef ?? X_PREMIUM_OAUTH_SESSION_REF,
    }
  }

  if (!options.name) {
    return {
      providerName: X_PREMIUM_PROVIDER,
      oauthTokenRef: X_PREMIUM_OAUTH_SESSION_REF,
    }
  }

  const slug = toInstanceSlug(options.name)
  return {
    providerName: `${X_PREMIUM_PROVIDER}-${slug}`,
    oauthTokenRef: `x_premium_oauth_${slug.replace(/-/g, '_')}`,
  }
}

function getDefaultXPremiumModels() {
  return {
    'grok-4.3': {
      model_id: 'grok-4.3',
      max_context: 256000,
      max_output: 8192,
      capabilities: ['tools', 'reasoning'],
      tags: ['grok', 'x', 'premium', 'oauth'],
    },
    'grok-4.20-reasoning': {
      model_id: 'grok-4.20-reasoning',
      max_context: 256000,
      max_output: 8192,
      capabilities: ['tools', 'reasoning'],
      tags: ['grok', 'reasoning', 'x', 'premium', 'oauth'],
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

export function getXPremiumOAuthSessionRef() {
  return X_PREMIUM_OAUTH_SESSION_REF
}

export function getXPremiumProviderName() {
  return X_PREMIUM_PROVIDER
}

export function getXPremiumProviderLabel() {
  return 'X Premium'
}

export function getXPremiumBaseUrl() {
  return X_PREMIUM_BASE_URL
}

export function getConfigPath() {
  return join(getZeroDir(), 'config.yaml')
}

export function ensureXPremiumProviderConfig(options: XPremiumProviderInstanceOptions = {}): {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
} {
  const instance = resolveXPremiumProviderInstance(options)
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

  if (provider.api_type !== 'x_responses') {
    provider.api_type = 'x_responses'
    changed = true
  }

  if (provider.base_url !== X_PREMIUM_BASE_URL) {
    provider.base_url = X_PREMIUM_BASE_URL
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
    instance.providerName !== X_PREMIUM_PROVIDER &&
    auth.managed_oauth_provider !== X_PREMIUM_PROVIDER
  ) {
    auth.managed_oauth_provider = X_PREMIUM_PROVIDER
    changed = true
  }

  if ('api_key_ref' in auth) {
    const { api_key_ref: _apiKeyRef, ...nextAuth } = auth
    provider.auth = nextAuth
    changed = true
  }

  const defaults = getDefaultXPremiumModels()
  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = defaults
    changed = true
  } else {
    const models = provider.models as Record<string, unknown>
    for (const [modelName, model] of Object.entries(defaults)) {
      if (!models[modelName]) {
        models[modelName] = model
        changed = true
      }
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
