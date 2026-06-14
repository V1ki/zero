import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { SystemConfig } from '@zero-os/shared'
import type { OAuthProviderInstance } from './provider-instance'

interface OAuthProviderModelDefaultsContext {
  raw: Record<string, unknown>
  providers: Record<string, unknown>
  provider: Record<string, unknown>
  instance: OAuthProviderInstance
}

export interface OAuthProviderConfigOptions {
  instance: OAuthProviderInstance
  managedProviderName: string
  apiType: string
  baseUrl: string
  applyModels(context: OAuthProviderModelDefaultsContext): boolean
}

export interface OAuthProviderConfigResult {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
}

interface OAuthProviderConnectionOptions {
  instance: OAuthProviderInstance
  managedProviderName: string
  apiType: string
  baseUrl: string
}

interface OAuthProviderAuthOptions {
  instance: OAuthProviderInstance
  managedProviderName: string
}

interface OAuthProviderRecord {
  providers: Record<string, unknown>
  provider: Record<string, unknown>
  changed: boolean
}

export function ensureOAuthProviderConfig({
  instance,
  managedProviderName,
  apiType,
  baseUrl,
  applyModels,
}: OAuthProviderConfigOptions): OAuthProviderConfigResult {
  const configPath = getProviderConfigPath()
  const raw = loadRawProviderConfig()
  const {
    providers,
    provider,
    changed: recordChanged,
  } = ensureOAuthProviderRecord(raw, instance.providerName)
  let changed =
    applyOAuthProviderConnection(provider, {
      instance,
      managedProviderName,
      apiType,
      baseUrl,
    }) || recordChanged

  changed =
    applyModels({
      raw,
      providers,
      provider,
      instance,
    }) || changed

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

export function getProviderConfigPath() {
  return join(getZeroDir(), 'config.yaml')
}

export function loadRawProviderConfig(): Record<string, unknown> {
  const configPath = getProviderConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  return readYaml<Record<string, unknown>>(configPath)
}

function ensureOAuthProviderRecord(
  raw: Record<string, unknown>,
  providerName: string,
): OAuthProviderRecord {
  let changed = false

  if (!isRecord(raw.providers)) {
    raw.providers = {}
    changed = true
  }

  const providers = raw.providers as Record<string, unknown>
  if (!isRecord(providers[providerName])) {
    providers[providerName] = {}
    changed = true
  }

  return {
    providers,
    provider: providers[providerName] as Record<string, unknown>,
    changed,
  }
}

function applyOAuthProviderConnection(
  provider: Record<string, unknown>,
  { instance, managedProviderName, apiType, baseUrl }: OAuthProviderConnectionOptions,
): boolean {
  let changed = false

  if (provider.api_type !== apiType) {
    provider.api_type = apiType
    changed = true
  }

  if (provider.base_url !== baseUrl) {
    provider.base_url = baseUrl
    changed = true
  }

  changed = applyOAuthProviderAuth(provider, { instance, managedProviderName }) || changed

  return changed
}

function applyOAuthProviderAuth(
  provider: Record<string, unknown>,
  { instance, managedProviderName }: OAuthProviderAuthOptions,
): boolean {
  const authResult = ensureOAuthProviderAuth(provider)
  const auth = authResult.auth
  let changed = authResult.changed

  if (auth.type !== 'oauth2') {
    auth.type = 'oauth2'
    changed = true
  }

  if (auth.oauth_token_ref !== instance.oauthTokenRef) {
    auth.oauth_token_ref = instance.oauthTokenRef
    changed = true
  }

  if (
    instance.providerName !== managedProviderName &&
    auth.managed_oauth_provider !== managedProviderName
  ) {
    auth.managed_oauth_provider = managedProviderName
    changed = true
  }

  if ('api_key_ref' in auth) {
    const { api_key_ref: _apiKeyRef, ...nextAuth } = auth
    provider.auth = nextAuth
    changed = true
  }

  return changed
}

function ensureOAuthProviderAuth(provider: Record<string, unknown>): {
  auth: Record<string, unknown>
  changed: boolean
} {
  if (isRecord(provider.auth)) {
    return {
      auth: provider.auth,
      changed: false,
    }
  }

  provider.auth = {}
  const auth = provider.auth as Record<string, unknown>
  return {
    auth,
    changed: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getZeroDir() {
  return process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
}
