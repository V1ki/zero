import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { ModelConfig, ProviderConfig, SystemConfig } from '@zero-os/shared'

const CHATGPT_PROVIDER = 'chatgpt'
const CHATGPT_OAUTH_TOKEN_REF = 'chatgpt_oauth_token'

const CHATGPT_MODELS = ['gpt-5.3-codex-medium', 'gpt-5.4-medium'] as const

const DEFAULT_MODEL_TEMPLATES: Record<(typeof CHATGPT_MODELS)[number], ModelConfig> = {
  'gpt-5.3-codex-medium': {
    modelId: 'gpt-5.3-codex-medium',
    maxContext: 400000,
    maxOutput: 128000,
    capabilities: ['tools', 'vision', 'reasoning'],
    tags: ['powerful', 'coding'],
    pricing: {
      input: 1.75,
      output: 14.0,
      cacheRead: 0.175,
    },
  },
  'gpt-5.4-medium': {
    modelId: 'gpt-5.4-medium',
    maxContext: 400000,
    maxOutput: 128000,
    capabilities: ['tools', 'vision', 'reasoning'],
    tags: ['powerful', 'coding'],
    pricing: {
      input: 1.75,
      output: 14.0,
      cacheRead: 0.175,
    },
  },
}

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

function modelToYaml(model: ModelConfig): Record<string, unknown> {
  return {
    model_id: model.modelId,
    max_context: model.maxContext,
    max_output: model.maxOutput,
    capabilities: [...model.capabilities],
    tags: [...model.tags],
    ...(model.pricing
      ? {
          pricing: {
            input: model.pricing.input,
            output: model.pricing.output,
            ...(model.pricing.cacheWrite !== undefined
              ? { cache_write: model.pricing.cacheWrite }
              : {}),
            ...(model.pricing.cacheRead !== undefined
              ? { cache_read: model.pricing.cacheRead }
              : {}),
          },
        }
      : {}),
  }
}

function deriveModelTemplate(
  config: SystemConfig,
  modelName: keyof typeof DEFAULT_MODEL_TEMPLATES,
): ModelConfig {
  const bareModelId = DEFAULT_MODEL_TEMPLATES[modelName].modelId

  for (const provider of Object.values(config.providers)) {
    for (const model of Object.values(provider.models)) {
      if (model.modelId === bareModelId) {
        return {
          modelId: model.modelId,
          maxContext: model.maxContext,
          maxOutput: model.maxOutput,
          capabilities: [...model.capabilities],
          tags: [...model.tags],
          ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
        }
      }
    }
  }

  const fallback = DEFAULT_MODEL_TEMPLATES[modelName]
  return {
    modelId: fallback.modelId,
    maxContext: fallback.maxContext,
    maxOutput: fallback.maxOutput,
    capabilities: [...fallback.capabilities],
    tags: [...fallback.tags],
    ...(fallback.pricing ? { pricing: { ...fallback.pricing } } : {}),
  }
}

export function getChatgptProviderName() {
  return CHATGPT_PROVIDER
}

export function getChatgptOAuthTokenRef() {
  return CHATGPT_OAUTH_TOKEN_REF
}

export function getConfigPath() {
  return join(getZeroDir(), 'config.yaml')
}

export function ensureChatgptProviderConfig(): { changed: boolean; config: SystemConfig } {
  const configPath = getConfigPath()
  const existingConfig = loadConfig(configPath)
  const raw = loadRawConfig()
  let changed = false
  if (!raw.providers || typeof raw.providers !== 'object') {
    raw.providers = {}
    changed = true
  }
  const providers = raw.providers as Record<string, unknown>

  const hadProvider = !!providers[CHATGPT_PROVIDER]
  if (!providers[CHATGPT_PROVIDER] || typeof providers[CHATGPT_PROVIDER] !== 'object') {
    providers[CHATGPT_PROVIDER] = {}
    changed = true
  }
  const provider = providers[CHATGPT_PROVIDER] as Record<string, unknown>
  if (!hadProvider) {
    changed = true
  }

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
    auth.api_key_ref = undefined
    changed = true
  }

  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = {}
    changed = true
  }
  const models = provider.models as Record<string, unknown>
  const renamePairs = [
    ['chatgpt/gpt-5.3-codex-medium', 'gpt-5.3-codex-medium'],
    ['chatgpt/gpt-5.4-medium', 'gpt-5.4-medium'],
  ] as const
  for (const [oldName, newName] of renamePairs) {
    if (models[oldName] && !models[newName]) {
      models[newName] = models[oldName]
      delete models[oldName]
      changed = true
    } else if (models[oldName]) {
      delete models[oldName]
      changed = true
    }

    if (raw.default_model === newName) {
      raw.default_model = oldName
      changed = true
    }

    if (Array.isArray(raw.fallback_chain)) {
      const nextFallback = raw.fallback_chain.map((value) => (value === newName ? oldName : value))
      if (JSON.stringify(nextFallback) !== JSON.stringify(raw.fallback_chain)) {
        raw.fallback_chain = nextFallback
        changed = true
      }
    }
  }

  for (const modelName of CHATGPT_MODELS) {
    if (models[modelName]) continue
    models[modelName] = modelToYaml(deriveModelTemplate(existingConfig, modelName))
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

export function getChatgptModelNames(): string[] {
  return [...CHATGPT_MODELS]
}

export function getChatgptProviderSummary(config: SystemConfig): ProviderConfig | undefined {
  return config.providers[CHATGPT_PROVIDER]
}
