import { existsSync } from 'node:fs'
import { normalizeReasoningEffort, readYaml, readYamlOrDefault } from '@zero-os/shared'
import type {
  ChannelInstanceConfig,
  FuseRule,
  ModelPricing,
  SystemConfig,
} from '@zero-os/shared'
import { readString } from '../utils/yaml'

/**
 * Load ZeRo OS system configuration from .zero/config.yaml.
 */
export function loadConfig(configPath: string): SystemConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  const raw = readYaml<Record<string, unknown>>(configPath)
  return normalizeConfig(raw)
}

/**
 * Normalize raw YAML config into SystemConfig type.
 */
function normalizeConfig(raw: Record<string, unknown>): SystemConfig {
  const providers: SystemConfig['providers'] = {}

  const rawProviders = (raw.providers ?? {}) as Record<string, Record<string, unknown>>
  for (const [name, p] of Object.entries(rawProviders)) {
    const rawAuth = (p.auth ?? {}) as Record<string, unknown>
    const rawModels = (p.models ?? {}) as Record<string, Record<string, unknown>>
    const models: SystemConfig['providers'][string]['models'] = {}

    for (const [mName, m] of Object.entries(rawModels)) {
      models[mName] = {
        modelId: (m.model_id as string) ?? mName,
        maxContext: (m.max_context as number) ?? 128000,
        maxOutput: (m.max_output as number) ?? 8192,
        reasoningEffort: normalizeReasoningEffort(m.reasoning_effort as string | undefined),
        thinkingTokens: m.thinking_tokens as number | undefined,
        capabilities: (m.capabilities as string[]) ?? [],
        tags: (m.tags as string[]) ?? [],
        pricing: normalizeModelPricing(m.pricing),
      }
    }

    providers[name] = {
      apiType: p.api_type as string as SystemConfig['providers'][string]['apiType'],
      baseUrl: (p.base_url as string) ?? '',
      auth: {
        type: rawAuth.type as string as 'api_key' | 'oauth2',
        apiKeyRef: rawAuth.api_key_ref as string | undefined,
        oauthTokenRef: rawAuth.oauth_token_ref as string | undefined,
      },
      models,
    }
  }

  const rawChannels = Array.isArray(raw.channels)
    ? (raw.channels as Array<Record<string, unknown>>)
    : []
  const channels = rawChannels
    .map(normalizeChannelConfig)
    .filter((channel): channel is ChannelInstanceConfig => channel !== null)

  const defaultModel = normalizeModelReference((raw.default_model as string) ?? '', providers)
  const fallbackChain = ((raw.fallback_chain as string[]) ?? []).map((model) =>
    normalizeModelReference(model, providers),
  )
  const taskClosureModel = raw.task_closure_model
    ? normalizeModelReference(raw.task_closure_model as string, providers)
    : undefined

  return {
    providers,
    defaultModel,
    fallbackChain,
    schedules: (raw.schedules as SystemConfig['schedules']) ?? [],
    fuseList: (raw.fuse_list as FuseRule[]) ?? [],
    ...(raw.channels !== undefined ? { channels } : {}),
    ...(taskClosureModel ? { taskClosureModel } : {}),
    ...(raw.embedding !== undefined
      ? { embedding: normalizeEmbeddingConfig(raw.embedding as Record<string, unknown>) }
      : {}),
  }
}

function normalizeModelReference(value: string, providers: SystemConfig['providers']): string {
  if (!value) return value
  if (value.includes('/')) {
    return value
  }

  const matches = Object.entries(providers).flatMap(([providerName, provider]) =>
    Object.entries(provider.models)
      .filter(([modelName, model]) => modelName === value || model.modelId === value)
      .map(([modelName]) => `${providerName}/${modelName}`),
  )

  return matches.length === 1 ? matches[0] : value
}

function normalizeChannelConfig(raw: Record<string, unknown>): ChannelInstanceConfig | null {
  const type = readString(raw, 'type')
  const name = readString(raw, 'name')

  if (!type || !name) return null

  const base = {
    name,
    type,
    enabled: readBoolean(raw, 'enabled') ?? true,
    receiveNotifications:
      readBoolean(raw, 'receiveNotifications', 'receive_notifications') ?? false,
  }

  if (type === 'feishu') {
    const appIdRef = readString(raw, 'appIdRef', 'app_id_ref')
    const appSecretRef = readString(raw, 'appSecretRef', 'app_secret_ref')
    if (!appIdRef || !appSecretRef) return null
    return {
      ...base,
      type,
      appIdRef,
      appSecretRef,
      encryptKeyRef: readString(raw, 'encryptKeyRef', 'encrypt_key_ref'),
      verificationTokenRef: readString(raw, 'verificationTokenRef', 'verification_token_ref'),
    }
  }

  if (type === 'telegram') {
    const botTokenRef = readString(raw, 'botTokenRef', 'bot_token_ref')
    if (!botTokenRef) return null
    return {
      ...base,
      type,
      botTokenRef,
    }
  }

  if (type === 'weixin') {
    const accountIdRef = readString(raw, 'accountIdRef', 'account_id_ref')
    const tokenRef = readString(raw, 'tokenRef', 'token_ref')
    if (!accountIdRef || !tokenRef) return null
    return {
      ...base,
      type,
      accountIdRef,
      tokenRef,
      baseUrlRef: readString(raw, 'baseUrlRef', 'base_url_ref'),
      cdnBaseUrlRef: readString(raw, 'cdnBaseUrlRef', 'cdn_base_url_ref'),
      dmPolicy: readPolicy(raw, 'dmPolicy', 'dm_policy'),
      groupPolicy: readPolicy(raw, 'groupPolicy', 'group_policy'),
      allowFrom: readStringArray(raw, 'allowFrom', 'allow_from'),
      groupAllowFrom: readStringArray(raw, 'groupAllowFrom', 'group_allow_from'),
    }
  }

  if (type === 'web') {
    return {
      ...base,
      type,
    }
  }

  return null
}

function normalizeEmbeddingConfig(
  raw: Record<string, unknown>,
): NonNullable<SystemConfig['embedding']> {
  return {
    baseUrl: readString(raw, 'baseUrl', 'base_url') ?? '',
    apiKeyRef: readString(raw, 'apiKeyRef', 'api_key_ref') ?? '',
    model: readString(raw, 'model') ?? '',
    dimensions: readNumber(raw, 'dimensions'),
  }
}

function readBoolean(raw: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function readStringArray(raw: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string')
    }
  }
  return undefined
}

function readPolicy(
  raw: Record<string, unknown>,
  ...keys: string[]
): 'open' | 'allowlist' | 'disabled' | undefined {
  const value = readString(raw, ...keys)
  if (value === 'open' || value === 'allowlist' || value === 'disabled') return value
  return undefined
}

function readNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function normalizeModelPricing(raw: unknown): ModelPricing | undefined {
  if (!isRecord(raw)) return undefined

  const input = readNumber(raw, 'input')
  const output = readNumber(raw, 'output')
  if (input === undefined || output === undefined) return undefined

  const pricing: ModelPricing = { input, output }
  const cacheWrite = readNumber(raw, 'cacheWrite', 'cache_write')
  const cacheRead = readNumber(raw, 'cacheRead', 'cache_read')

  if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite
  if (cacheRead !== undefined) pricing.cacheRead = cacheRead

  return pricing
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Load fuse list from .zero/fuse_list.yaml.
 */
export function loadFuseList(fusePath: string): FuseRule[] {
  const raw = readYamlOrDefault<{ rules?: FuseRule[] }>(fusePath, { rules: [] })
  return raw.rules ?? []
}
