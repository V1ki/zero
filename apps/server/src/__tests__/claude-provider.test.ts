import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import {
  ensureClaudeProviderConfig,
  getClaudeOAuthSessionRef,
  getConfigPath,
} from '../claude-provider'

const previousZeroDataDir = process.env.ZERO_DATA_DIR

function withTempConfig(contents: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-claude-provider-'))
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

describe('ensureClaudeProviderConfig', () => {
  test('initializes Claude OAuth provider with a default Claude model', () => {
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
      const result = ensureClaudeProviderConfig()
      const claude = result.config.providers.claude

      expect(result.changed).toBe(true)
      expect(claude.apiType).toBe('anthropic_messages')
      expect(claude.baseUrl).toBe('https://api.anthropic.com')
      expect(claude.auth.type).toBe('oauth2')
      expect(claude.auth.oauthTokenRef).toBe(getClaudeOAuthSessionRef())
      expect(claude.auth.apiKeyRef).toBeUndefined()
      expect(claude.models['claude-sonnet-4-6']).toBeDefined()

      const raw = readYaml<Record<string, unknown>>(getConfigPath())
      const rawProviders = raw.providers as Record<string, Record<string, unknown>>
      const rawClaude = rawProviders.claude
      const rawAuth = rawClaude.auth as Record<string, unknown>
      const rawModels = rawClaude.models as Record<string, unknown>

      expect(rawClaude.api_type).toBe('anthropic_messages')
      expect(rawClaude.base_url).toBe('https://api.anthropic.com')
      expect(rawAuth.type).toBe('oauth2')
      expect(rawAuth.oauth_token_ref).toBe(getClaudeOAuthSessionRef())
      expect('api_key_ref' in rawAuth).toBe(false)
      expect(rawModels['claude-sonnet-4-6']).toBeDefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
