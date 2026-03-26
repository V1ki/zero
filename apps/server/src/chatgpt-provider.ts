import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { SystemConfig } from '@zero-os/shared'

const CHATGPT_PROVIDER = 'chatgpt'
const CHATGPT_OAUTH_TOKEN_REF = 'chatgpt_oauth_token'
const CHATGPT_DEFAULT_MODEL = 'chatgpt/gpt-5.4'
const REMOVED_CHATGPT_MODEL_NAMES = new Set(['gpt-5.3-codex-medium', 'gpt-5.4-medium'])
const REMOVED_CHATGPT_MODEL_REFS = new Set(
  [...REMOVED_CHATGPT_MODEL_NAMES].map((modelName) => `${CHATGPT_PROVIDER}/${modelName}`),
)

function getZeroDir() {
  return process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  return readYaml<Record<string, unknown>>(configPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRemovedChatgptModelRef(value: unknown): value is string {
  return typeof value === 'string' && REMOVED_CHATGPT_MODEL_REFS.has(value)
}

function isRemovedChatgptModelEntry(name: string, value: unknown): boolean {
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

function collectBareRemovedChatgptReferences(providers: Record<string, unknown>): Set<string> {
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

function isRemovedChatgptReference(
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

export function getChatgptOAuthTokenRef() {
  return CHATGPT_OAUTH_TOKEN_REF
}

export function getConfigPath() {
  return join(getZeroDir(), 'config.yaml')
}

export function ensureChatgptProviderConfig(): { changed: boolean; config: SystemConfig } {
  const configPath = getConfigPath()
  const raw = loadRawConfig()
  let changed = false
  if (!raw.providers || typeof raw.providers !== 'object') {
    raw.providers = {}
    changed = true
  }
  const providers = raw.providers as Record<string, unknown>

  if (!providers[CHATGPT_PROVIDER] || typeof providers[CHATGPT_PROVIDER] !== 'object') {
    providers[CHATGPT_PROVIDER] = {}
    changed = true
  }
  const provider = providers[CHATGPT_PROVIDER] as Record<string, unknown>

  if (provider.api_type !== 'openai_responses') {
    provider.api_type = 'openai_responses'
    changed = true
  }

  if (provider.base_url !== 'https://chatgpt.com/backend-api/codex') {
    provider.base_url = 'https://chatgpt.com/backend-api/codex'
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

  if (auth.oauth_token_ref !== CHATGPT_OAUTH_TOKEN_REF) {
    auth.oauth_token_ref = CHATGPT_OAUTH_TOKEN_REF
    changed = true
  }

  if ('api_key_ref' in auth) {
    const { api_key_ref: _apiKeyRef, ...nextAuth } = auth
    provider.auth = nextAuth
    changed = true
  }

  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = {}
    changed = true
  }
  const models = provider.models as Record<string, unknown>
  const bareRemovedReferences = collectBareRemovedChatgptReferences(providers)

  for (const [modelName, model] of Object.entries(models)) {
    if (!isRemovedChatgptModelEntry(modelName, model)) {
      continue
    }

    delete models[modelName]
    changed = true
  }

  if (isRemovedChatgptReference(raw.default_model, bareRemovedReferences)) {
    raw.default_model = CHATGPT_DEFAULT_MODEL
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
    raw.task_closure_model = CHATGPT_DEFAULT_MODEL
    changed = true
  }

  if (changed) {
    writeYaml(configPath, raw)
  }

  return {
    changed,
    config: loadConfig(configPath),
  }
}
