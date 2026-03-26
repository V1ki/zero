import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import {
  ensureChatgptProviderConfig,
  getChatgptOAuthTokenRef,
  getConfigPath,
} from '../chatgpt-provider'

const previousZeroDataDir = process.env.ZERO_DATA_DIR

function withTempConfig(contents: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-chatgpt-provider-'))
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

describe('ensureChatgptProviderConfig', () => {
  test('removes deprecated ChatGPT medium models and migrates stale references', () => {
    const dataDir = withTempConfig(`providers:
  openai-codex:
    api_type: openai_chat_completions
    base_url: https://example.com/v1
    auth:
      type: api_key
      api_key_ref: openai_codex_api_key
    models:
      gpt-5.4-medium:
        model_id: gpt-5.4-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
  chatgpt:
    auth:
      type: api_key
      api_key_ref: should_be_removed
    models:
      gpt-5.4:
        model_id: gpt-5.4
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
      gpt-5.4-medium:
        model_id: gpt-5.4-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
      chatgpt/gpt-5.3-codex-medium:
        model_id: gpt-5.3-codex-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
default_model: chatgpt/gpt-5.4-medium
fallback_chain:
  - openai-codex/gpt-5.4-medium
  - chatgpt/gpt-5.3-codex-medium
  - chatgpt/gpt-5.4-medium
  - chatgpt/gpt-5.4
task_closure_model: chatgpt/gpt-5.3-codex-medium
schedules: []
fuse_list: []
`)

    try {
      const result = ensureChatgptProviderConfig()

      expect(result.changed).toBe(true)
      expect(result.config.defaultModel).toBe('chatgpt/gpt-5.4')
      expect(result.config.fallbackChain).toEqual([
        'openai-codex/gpt-5.4-medium',
        'chatgpt/gpt-5.4',
      ])
      expect(result.config.taskClosureModel).toBe('chatgpt/gpt-5.4')

      expect(result.config.providers['openai-codex'].models['gpt-5.4-medium']).toBeDefined()

      const chatgpt = result.config.providers.chatgpt
      expect(chatgpt.apiType).toBe('openai_responses')
      expect(chatgpt.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
      expect(chatgpt.auth.type).toBe('oauth2')
      expect(chatgpt.auth.oauthTokenRef).toBe(getChatgptOAuthTokenRef())
      expect(chatgpt.auth.apiKeyRef).toBeUndefined()
      expect(chatgpt.models['gpt-5.4']).toBeDefined()
      expect(chatgpt.models['gpt-5.3-codex-medium']).toBeUndefined()
      expect(chatgpt.models['gpt-5.4-medium']).toBeUndefined()

      const raw = readYaml<Record<string, unknown>>(getConfigPath())
      const rawProviders = raw.providers as Record<string, Record<string, unknown>>
      const rawChatgptAuth = rawProviders.chatgpt.auth as Record<string, unknown>
      const rawChatgptModels = rawProviders.chatgpt.models as Record<string, unknown>

      expect(raw.default_model).toBe('chatgpt/gpt-5.4')
      expect(raw.fallback_chain).toEqual(['openai-codex/gpt-5.4-medium', 'chatgpt/gpt-5.4'])
      expect(raw.task_closure_model).toBe('chatgpt/gpt-5.4')
      expect('api_key_ref' in rawChatgptAuth).toBe(false)
      expect(rawChatgptModels['gpt-5.4']).toBeDefined()
      expect(rawChatgptModels['gpt-5.4-medium']).toBeUndefined()
      expect(rawChatgptModels['chatgpt/gpt-5.3-codex-medium']).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('initializes ChatGPT provider infrastructure without recreating removed models', () => {
    const dataDir = withTempConfig(`providers:
  openai-codex:
    api_type: openai_chat_completions
    base_url: https://example.com/v1
    auth:
      type: api_key
      api_key_ref: openai_codex_api_key
    models:
      gpt-5.4-medium:
        model_id: gpt-5.4-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
default_model: openai-codex/gpt-5.4-medium
fallback_chain:
  - openai-codex/gpt-5.4-medium
schedules: []
fuse_list: []
`)

    try {
      const result = ensureChatgptProviderConfig()

      expect(result.changed).toBe(true)
      expect(result.config.defaultModel).toBe('openai-codex/gpt-5.4-medium')
      expect(result.config.fallbackChain).toEqual(['openai-codex/gpt-5.4-medium'])
      expect(result.config.providers.chatgpt).toEqual({
        apiType: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: {
          type: 'oauth2',
          oauthTokenRef: getChatgptOAuthTokenRef(),
          apiKeyRef: undefined,
        },
        models: {},
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('migrates bare removed ChatGPT references before removing deprecated models', () => {
    const dataDir = withTempConfig(`providers:
  chatgpt:
    auth:
      type: api_key
      api_key_ref: should_be_removed
    models:
      gpt-5.4:
        model_id: gpt-5.4
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
      gpt-5.3-codex-medium:
        model_id: gpt-5.3-codex-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
      gpt-5.4-medium:
        model_id: gpt-5.4-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - coding
default_model: gpt-5.4-medium
fallback_chain:
  - gpt-5.3-codex-medium
  - gpt-5.4-medium
  - chatgpt/gpt-5.4
task_closure_model: gpt-5.3-codex-medium
schedules: []
fuse_list: []
`)

    try {
      const result = ensureChatgptProviderConfig()

      expect(result.changed).toBe(true)
      expect(result.config.defaultModel).toBe('chatgpt/gpt-5.4')
      expect(result.config.fallbackChain).toEqual(['chatgpt/gpt-5.4'])
      expect(result.config.taskClosureModel).toBe('chatgpt/gpt-5.4')
      expect(result.config.providers.chatgpt.models['gpt-5.3-codex-medium']).toBeUndefined()
      expect(result.config.providers.chatgpt.models['gpt-5.4-medium']).toBeUndefined()

      const raw = readYaml<Record<string, unknown>>(getConfigPath())
      const rawProviders = raw.providers as Record<string, Record<string, unknown>>
      const rawChatgptAuth = rawProviders.chatgpt.auth as Record<string, unknown>
      const rawChatgptModels = rawProviders.chatgpt.models as Record<string, unknown>

      expect(raw.default_model).toBe('chatgpt/gpt-5.4')
      expect(raw.fallback_chain).toEqual(['chatgpt/gpt-5.4'])
      expect(raw.task_closure_model).toBe('chatgpt/gpt-5.4')
      expect('api_key_ref' in rawChatgptAuth).toBe(false)
      expect(rawChatgptModels['gpt-5.4']).toBeDefined()
      expect(rawChatgptModels['gpt-5.3-codex-medium']).toBeUndefined()
      expect(rawChatgptModels['gpt-5.4-medium']).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
