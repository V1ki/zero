import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import { ensureOAuthProviderConfig } from '../oauth/provider/provider-config'
import { getProviderConfigPath } from '../oauth/provider/provider-config'

const previousZeroDataDir = process.env.ZERO_DATA_DIR

function withTempConfig(contents: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-oauth-provider-config-'))
  process.env.ZERO_DATA_DIR = dataDir
  writeFileSync(join(dataDir, 'config.yaml'), contents)
  return dataDir
}

function ensureTestOAuthProviderConfig(
  options: {
    providerName?: string
    oauthTokenRef?: string
  } = {},
) {
  return ensureOAuthProviderConfig({
    instance: {
      providerName: options.providerName ?? 'chatgpt',
      oauthTokenRef: options.oauthTokenRef ?? 'chatgpt_oauth_token',
    },
    managedProviderName: 'chatgpt',
    apiType: 'openai_responses',
    baseUrl: 'https://example.test/v1',
    applyModels: () => false,
  })
}

afterEach(() => {
  if (previousZeroDataDir === undefined) {
    process.env.ZERO_DATA_DIR = undefined
  } else {
    process.env.ZERO_DATA_DIR = previousZeroDataDir
  }
})

describe('ensureOAuthProviderConfig', () => {
  test('creates missing providers and provider records through the config entrypoint', () => {
    const dataDir = withTempConfig(`default_model: ""
fallback_chain: []
schedules: []
fuse_list: []
`)

    try {
      const result = ensureTestOAuthProviderConfig()

      expect(result.changed).toBe(true)
      const raw = readYaml<Record<string, unknown>>(getProviderConfigPath())
      const provider = (raw.providers as Record<string, Record<string, unknown>>).chatgpt

      expect(provider.api_type).toBe('openai_responses')
      expect(provider.auth).toEqual({
        type: 'oauth2',
        oauth_token_ref: 'chatgpt_oauth_token',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('creates OAuth auth and removes stale api key auth', () => {
    const dataDir = withTempConfig(`providers:
  chatgpt:
    auth:
      type: api_key
      api_key_ref: stale_key
default_model: ""
fallback_chain: []
schedules: []
fuse_list: []
`)

    try {
      const result = ensureTestOAuthProviderConfig()

      expect(result.changed).toBe(true)
      const raw = readYaml<Record<string, unknown>>(getProviderConfigPath())
      const provider = (raw.providers as Record<string, Record<string, unknown>>).chatgpt

      expect(provider.api_type).toBe('openai_responses')
      expect(provider.base_url).toBe('https://example.test/v1')
      expect(provider.auth).toEqual({
        type: 'oauth2',
        oauth_token_ref: 'chatgpt_oauth_token',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('sets managed OAuth provider for named instances', () => {
    const dataDir = withTempConfig(`providers: {}
default_model: ""
fallback_chain: []
schedules: []
fuse_list: []
`)

    try {
      const result = ensureTestOAuthProviderConfig({
        providerName: 'chatgpt-work',
        oauthTokenRef: 'chatgpt_oauth_work',
      })

      expect(result.changed).toBe(true)
      const raw = readYaml<Record<string, unknown>>(getProviderConfigPath())
      const provider = (raw.providers as Record<string, Record<string, unknown>>)['chatgpt-work']

      expect(provider.auth).toEqual({
        type: 'oauth2',
        oauth_token_ref: 'chatgpt_oauth_work',
        managed_oauth_provider: 'chatgpt',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('does not change already-normalized connection and auth', () => {
    const dataDir = withTempConfig(`providers:
  chatgpt:
    api_type: openai_responses
    base_url: https://example.test/v1
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_token
default_model: ""
fallback_chain: []
schedules: []
fuse_list: []
`)

    try {
      const result = ensureTestOAuthProviderConfig()

      expect(result.changed).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
