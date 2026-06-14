import type { SystemConfig } from '@zero-os/shared'
import { ensureOAuthProviderConfig } from '../../oauth/provider/provider-config'
import {
  type OAuthProviderInstanceOptions,
  resolveOAuthProviderInstance,
} from '../../oauth/provider/provider-instance'

const CHATGPT_PROVIDER = 'chatgpt'
const CHATGPT_OAUTH_TOKEN_REF = 'chatgpt_oauth_token'
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CHATGPT_DEFAULT_MODEL = 'chatgpt/gpt-5.4'
const REMOVED_CHATGPT_MODEL_NAMES = new Set(['gpt-5.3-codex-medium', 'gpt-5.4-medium'])
const REMOVED_CHATGPT_MODEL_REFS = new Set(
  [...REMOVED_CHATGPT_MODEL_NAMES].map((modelName) => `${CHATGPT_PROVIDER}/${modelName}`),
)

export type ChatgptProviderInstanceOptions = OAuthProviderInstanceOptions

export function resolveChatgptProviderInstance(options: ChatgptProviderInstanceOptions = {}) {
  return resolveOAuthProviderInstance(options, {
    providerName: CHATGPT_PROVIDER,
    oauthTokenRef: CHATGPT_OAUTH_TOKEN_REF,
    namedTokenRefPrefix: 'chatgpt_oauth',
  })
}

export function getChatgptOAuthTokenRef() {
  return CHATGPT_OAUTH_TOKEN_REF
}

export function ensureChatgptProviderConfig(options: ChatgptProviderInstanceOptions = {}): {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
} {
  const instance = resolveChatgptProviderInstance(options)
  return ensureOAuthProviderConfig({
    instance,
    managedProviderName: CHATGPT_PROVIDER,
    apiType: 'openai_responses',
    baseUrl: CHATGPT_BASE_URL,
    applyModels: ({ raw, providers, provider }) =>
      ensureChatgptModels({
        raw,
        providers,
        provider,
        providerName: instance.providerName,
      }),
  })
}

function ensureChatgptModels({
  raw,
  providers,
  provider,
  providerName,
}: {
  raw: Record<string, unknown>
  providers: Record<string, unknown>
  provider: Record<string, unknown>
  providerName: string
}): boolean {
  let changed = false

  if (!provider.models || typeof provider.models !== 'object') {
    const defaultChatgptProvider = providers[CHATGPT_PROVIDER]
    provider.models =
      providerName === CHATGPT_PROVIDER || !isRecord(defaultChatgptProvider)
        ? {}
        : cloneRecord(defaultChatgptProvider.models)
    changed = true
  }

  return (
    applyChatGptRemovedModelCleanup({
      raw,
      providers,
      provider,
      defaultModel: CHATGPT_DEFAULT_MODEL,
    }) || changed
  )
}

function applyChatGptRemovedModelCleanup(options: {
  raw: Record<string, unknown>
  providers: Record<string, unknown>
  provider: Record<string, unknown>
  defaultModel: string
}): boolean {
  const { raw, providers, provider, defaultModel } = options
  let changed = false
  const bareRemovedReferences = collectBareRemovedChatgptReferences(providers)
  const models = provider.models as Record<string, unknown>
  const nextModels = Object.fromEntries(
    Object.entries(models).filter(([modelName, model]) => {
      return !isRemovedChatgptModelEntry(modelName, model)
    }),
  )
  if (Object.keys(nextModels).length !== Object.keys(models).length) {
    provider.models = nextModels
    changed = true
  }

  if (isRemovedChatgptReference(raw.default_model, bareRemovedReferences)) {
    raw.default_model = defaultModel
    changed = true
  }

  if (Array.isArray(raw.fallback_chain)) {
    const nextFallback = raw.fallback_chain.filter(
      (value) => !isRemovedChatgptReference(value, bareRemovedReferences),
    )
    if (JSON.stringify(nextFallback) !== JSON.stringify(raw.fallback_chain)) {
      raw.fallback_chain = nextFallback
      changed = true
    }
  }

  if (isRemovedChatgptReference(raw.task_closure_model, bareRemovedReferences)) {
    raw.task_closure_model = defaultModel
    changed = true
  }

  return changed
}

export function isRemovedChatgptModelEntry(name: string, value: unknown): boolean {
  if (REMOVED_CHATGPT_MODEL_NAMES.has(name) || REMOVED_CHATGPT_MODEL_REFS.has(name)) {
    return true
  }

  if (!isRecord(value)) {
    return false
  }

  const modelId = value.model_id
  return (
    (typeof modelId === 'string' && REMOVED_CHATGPT_MODEL_NAMES.has(modelId)) ||
    isRemovedChatgptModelRef(modelId)
  )
}

export function collectBareRemovedChatgptReferences(
  providers: Record<string, unknown>,
): Set<string> {
  const bareReferences = new Set<string>()

  for (const modelName of REMOVED_CHATGPT_MODEL_NAMES) {
    const chatgptHasModel = hasNamedModel(providers[CHATGPT_PROVIDER], modelName)
    const otherProviderHasModel = Object.entries(providers).some(([providerName, provider]) => {
      return providerName !== CHATGPT_PROVIDER && hasNamedModel(provider, modelName)
    })

    if (chatgptHasModel && !otherProviderHasModel) {
      bareReferences.add(modelName)
    }
  }

  return bareReferences
}

export function isRemovedChatgptReference(
  value: unknown,
  bareRemovedReferences: Set<string>,
): value is string {
  if (isRemovedChatgptModelRef(value)) {
    return true
  }

  if (typeof value !== 'string') {
    return false
  }

  return bareRemovedReferences.has(value)
}

function isRemovedChatgptModelRef(value: unknown): value is string {
  return typeof value === 'string' && REMOVED_CHATGPT_MODEL_REFS.has(value)
}

function hasNamedModel(provider: unknown, modelName: string): boolean {
  if (!isRecord(provider) || !isRecord(provider.models)) {
    return false
  }

  return Object.entries(provider.models).some(([name, model]) => {
    if (name === modelName) {
      return true
    }

    return isRecord(model) && model.model_id === modelName
  })
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
