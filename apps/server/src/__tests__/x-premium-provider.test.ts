import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import { getProviderConfigPath } from '../oauth/provider/provider-config'
import {
  ensureXPremiumProviderConfig,
  getXPremiumBaseUrl,
  getXPremiumOAuthSessionRef,
} from '../providers/x-premium'

const previousZeroDataDir = process.env.ZERO_DATA_DIR

function withTempConfig(contents: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-x-premium-provider-'))
  process.env.ZERO_DATA_DIR = dataDir
  writeFileSync(join(dataDir, 'config.yaml'), contents)
  return dataDir
}

afterEach(() => {
  if (previousZeroDataDir === undefined) {
    process.env.ZERO_DATA_DIR = undefined
  } else {
    process.env.ZERO_DATA_DIR = previousZeroDataDir
  }
})

describe('ensureXPremiumProviderConfig', () => {
  test('initializes x-premium provider with OAuth auth and Grok models', () => {
    const dataDir = withTempConfig(`providers:
  openai-codex:
    api_type: openai_chat_completions
    base_url: https://example.com/v1
    auth:
      type: api_key
      api_key_ref: openai_codex_api_key
    models:
      gpt-5.4:
        model_id: gpt-5.4
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
default_model: openai-codex/gpt-5.4
fallback_chain:
  - openai-codex/gpt-5.4
schedules: []
fuse_list: []
`)

    try {
      const result = ensureXPremiumProviderConfig()

      expect(result.changed).toBe(true)
      const provider = result.config.providers['x-premium']
      expect(provider.apiType).toBe('x_responses')
      expect(provider.baseUrl).toBe(getXPremiumBaseUrl())
      expect(provider.auth.type).toBe('oauth2')
      expect(provider.auth.oauthTokenRef).toBe(getXPremiumOAuthSessionRef())
      expect(provider.auth.apiKeyRef).toBeUndefined()
      expect(provider.models['grok-4.3']).toBeDefined()
      expect(provider.models['grok-4.20-reasoning']).toBeDefined()

      const raw = readYaml<Record<string, unknown>>(getProviderConfigPath())
      const rawProvider = (raw.providers as Record<string, Record<string, unknown>>)['x-premium']
      const rawAuth = rawProvider.auth as Record<string, unknown>
      expect(rawProvider.api_type).toBe('x_responses')
      expect(rawProvider.base_url).toBe(getXPremiumBaseUrl())
      expect(rawAuth.oauth_token_ref).toBe(getXPremiumOAuthSessionRef())
      expect('api_key_ref' in rawAuth).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('preserves existing custom models and removes api_key_ref', () => {
    const dataDir = withTempConfig(`providers:
  x-premium:
    api_type: x_responses
    base_url: https://api.x.ai/v1
    auth:
      type: api_key
      api_key_ref: stale_xai_key
    models:
      grok-custom:
        model_id: grok-custom
        max_context: 128000
        max_output: 4096
        capabilities:
          - tools
        tags:
          - custom
default_model: x-premium/grok-custom
fallback_chain:
  - x-premium/grok-custom
schedules: []
fuse_list: []
`)

    try {
      const result = ensureXPremiumProviderConfig()
      const provider = result.config.providers['x-premium']

      expect(provider.auth.type).toBe('oauth2')
      expect(provider.auth.apiKeyRef).toBeUndefined()
      expect(provider.models['grok-custom']).toBeDefined()
      expect(provider.models['grok-4.3']).toBeDefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
