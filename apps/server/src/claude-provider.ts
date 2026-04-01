import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { SystemConfig } from '@zero-os/shared'

const CLAUDE_PROVIDER = 'claude'
const CLAUDE_OAUTH_SESSION_REF = 'claude_oauth_session'

function getZeroDir() {
  return process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
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

export function ensureClaudeProviderConfig(): { changed: boolean; config: SystemConfig } {
  const configPath = getConfigPath()
  const raw = loadRawConfig()
  let changed = false

  if (!raw.providers || typeof raw.providers !== 'object') {
    raw.providers = {}
    changed = true
  }

  const providers = raw.providers as Record<string, unknown>
  if (!providers[CLAUDE_PROVIDER] || typeof providers[CLAUDE_PROVIDER] !== 'object') {
    providers[CLAUDE_PROVIDER] = {}
    changed = true
  }

  const provider = providers[CLAUDE_PROVIDER] as Record<string, unknown>

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

  if (auth.oauth_token_ref !== CLAUDE_OAUTH_SESSION_REF) {
    auth.oauth_token_ref = CLAUDE_OAUTH_SESSION_REF
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
  }
}
