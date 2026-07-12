import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadFuseList } from '../loader'

describe('loadConfig', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loader-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('throws error when file not found', () => {
    const badPath = join(tmpDir, 'nonexistent.yaml')
    expect(() => loadConfig(badPath)).toThrow(`Config file not found: ${badPath}`)
  })

  test('valid config.yaml parses to SystemConfig', () => {
    const configPath = join(tmpDir, 'valid.yaml')
    writeFileSync(
      configPath,
      `
providers:
  openai:
    api_type: openai_chat_completions
    base_url: https://api.openai.com/v1
    auth:
      type: api_key
      api_key_ref: openai-key
    models:
      gpt4:
        model_id: gpt-4
        max_context: 128000
        max_output: 4096
        capabilities:
          - chat
          - tools
        tags:
          - primary
default_model: openai/gpt4
fallback_chain:
  - openai/gpt4
`,
    )

    const config = loadConfig(configPath)

    expect(config.defaultModel).toBe('openai/gpt4')
    expect(config.fallbackChain).toEqual(['openai/gpt4'])
    expect(config.providers.openai).toBeDefined()
    expect(config.providers.openai.models.gpt4).toBeDefined()
    expect(config.providers.openai.models.gpt4.modelId).toBe('gpt-4')
  })

  test('snake_case fields map to camelCase', () => {
    const configPath = join(tmpDir, 'snake.yaml')
    writeFileSync(
      configPath,
      `
providers:
  test:
    api_type: anthropic_messages
    base_url: https://api.anthropic.com
    auth:
      type: api_key
      api_key_ref: ant-key
    models:
      claude:
        model_id: claude-3
        max_context: 200000
        max_output: 16384
        reasoning_effort: max
        thinking_tokens: 2048
        extra_body:
          chat_template_kwargs:
            enable_thinking: false
        pricing:
          input: 1.74
          output: 3.48
          cache_read: 0.145
          cache_write: 1.74
        capabilities: []
        tags: []
default_model: test/claude
`,
    )

    const config = loadConfig(configPath)
    const provider = config.providers.test

    expect(provider.apiType).toBe('anthropic_messages')
    expect(provider.baseUrl).toBe('https://api.anthropic.com')
    expect(provider.auth.apiKeyRef).toBe('ant-key')

    const model = provider.models.claude
    expect(model.modelId).toBe('claude-3')
    expect(model.maxContext).toBe(200000)
    expect(model.maxOutput).toBe(16384)
    expect(model.reasoningEffort).toBe('xhigh')
    expect(model.thinkingTokens).toBe(2048)
    expect(model.extraBody).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
      },
    })
    expect(model.pricing).toEqual({
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
      cacheWrite: 1.74,
    })
  })

  test('model pools and managed OAuth provider parse from config', () => {
    const configPath = join(tmpDir, 'model-pools.yaml')
    writeFileSync(
      configPath,
      `
providers:
  chatgpt-personal:
    api_type: openai_responses
    base_url: https://chatgpt.com/backend-api/codex
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_personal
      managed_oauth_provider: chatgpt
    models:
      gpt-5.5:
        model_id: gpt-5.5
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - chatgpt
  chatgpt-work:
    api_type: openai_responses
    base_url: https://chatgpt.com/backend-api/codex
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_work
      managed_oauth_provider: chatgpt
    models:
      gpt-5.5:
        model_id: gpt-5.5
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
        tags:
          - chatgpt
model_pools:
  chatgpt/gpt-5.5:
    strategy: sticky_quota_aware_failover
    members:
      - chatgpt-personal/gpt-5.5
      - model: chatgpt-work/gpt-5.5
        priority: 2
default_model: chatgpt/gpt-5.5
fallback_chain:
  - chatgpt/gpt-5.5
`,
    )

    const config = loadConfig(configPath)

    expect(config.providers['chatgpt-personal'].auth.managedOAuthProvider).toBe('chatgpt')
    expect(config.modelPools?.['chatgpt/gpt-5.5']).toEqual({
      strategy: 'sticky_quota_aware_failover',
      members: [
        { model: 'chatgpt-personal/gpt-5.5' },
        { model: 'chatgpt-work/gpt-5.5', priority: 2 },
      ],
    })
    expect(config.defaultModel).toBe('chatgpt/gpt-5.5')
  })

  test('missing optional fields get defaults', () => {
    const configPath = join(tmpDir, 'minimal.yaml')
    writeFileSync(
      configPath,
      `
providers:
  p:
    api_type: openai_chat_completions
    models:
      m: {}
`,
    )

    const config = loadConfig(configPath)

    expect(config.defaultModel).toBe('')
    expect(config.fallbackChain).toEqual([])
    expect(config.schedules).toEqual([])
    expect(config.fuseList).toEqual([])

    const model = config.providers.p.models.m
    expect(model.maxContext).toBe(128000)
    expect(model.maxOutput).toBe(8192)
    expect(model.capabilities).toEqual([])
    expect(model.tags).toEqual([])
  })

  test('parses channel configs with snake_case refs', () => {
    const configPath = join(tmpDir, 'channels.yaml')
    writeFileSync(
      configPath,
      `
providers: {}
channels:
  - name: feishu:ops
    type: feishu
    app_id_ref: feishu_ops_app_id
    app_secret_ref: feishu_ops_app_secret
    encrypt_key_ref: feishu_ops_encrypt_key
    verification_token_ref: feishu_ops_verification_token
    receive_notifications: true
  - name: telegram:alerts
    type: telegram
    bot_token_ref: telegram_alerts_bot_token
    streaming: false
  - name: dingtalk:ops
    type: dingtalk
    client_id_ref: dingtalk_ops_client_id
    client_secret_ref: dingtalk_ops_client_secret
    robot_code_ref: dingtalk_ops_robot_code
    keep_alive: false
  - name: weixin:personal
    type: weixin
    account_id_ref: weixin_personal_account_id
    token_ref: weixin_personal_token
    base_url_ref: weixin_personal_base_url
    cdn_base_url_ref: weixin_personal_cdn_base_url
    bot_agent: Zero/0.1 (config test)
    dm_policy: allowlist
    group_policy: disabled
    allow_from:
      - wxid_friend
    group_allow_from:
      - room@chatroom
`,
    )

    const config = loadConfig(configPath)

    expect(config.channels).toHaveLength(4)
    expect(config.channels?.[0]).toEqual({
      name: 'feishu:ops',
      type: 'feishu',
      enabled: true,
      receiveNotifications: true,
      appIdRef: 'feishu_ops_app_id',
      appSecretRef: 'feishu_ops_app_secret',
      encryptKeyRef: 'feishu_ops_encrypt_key',
      verificationTokenRef: 'feishu_ops_verification_token',
    })
    expect(config.channels?.[1]).toEqual({
      name: 'telegram:alerts',
      type: 'telegram',
      enabled: true,
      receiveNotifications: false,
      botTokenRef: 'telegram_alerts_bot_token',
      streaming: false,
    })
    expect(config.channels?.[2]).toEqual({
      name: 'dingtalk:ops',
      type: 'dingtalk',
      enabled: true,
      receiveNotifications: false,
      clientIdRef: 'dingtalk_ops_client_id',
      clientSecretRef: 'dingtalk_ops_client_secret',
      robotCodeRef: 'dingtalk_ops_robot_code',
      debug: undefined,
      keepAlive: false,
    })
    expect(config.channels?.[3]).toEqual({
      name: 'weixin:personal',
      type: 'weixin',
      enabled: true,
      receiveNotifications: false,
      accountIdRef: 'weixin_personal_account_id',
      tokenRef: 'weixin_personal_token',
      baseUrlRef: 'weixin_personal_base_url',
      cdnBaseUrlRef: 'weixin_personal_cdn_base_url',
      botAgent: 'Zero/0.1 (config test)',
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: ['wxid_friend'],
      groupAllowFrom: ['room@chatroom'],
    })
  })

  test('parses embedding config with snake_case keys', () => {
    const configPath = join(tmpDir, 'embedding.yaml')
    writeFileSync(
      configPath,
      `
providers: {}
embedding:
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  api_key_ref: dashscope_api_key
  model: text-embedding-v4
  dimensions: 1024
`,
    )

    const config = loadConfig(configPath)

    expect(config.embedding).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyRef: 'dashscope_api_key',
      model: 'text-embedding-v4',
      dimensions: 1024,
    })
  })

  test('normalizes task closure model from snake_case config', () => {
    const configPath = join(tmpDir, 'task-closure.yaml')
    writeFileSync(
      configPath,
      `
providers:
  openai:
    api_type: openai_chat_completions
    base_url: https://api.openai.com/v1
    auth:
      type: api_key
      api_key_ref: openai-key
    models:
      primary:
        model_id: gpt-5.4-medium
        max_context: 128000
        max_output: 4096
        capabilities: []
        tags: []
      closure:
        model_id: gpt-5.3-codex-medium
        max_context: 128000
        max_output: 4096
        capabilities: []
        tags: []
default_model: primary
task_closure_model: closure
`,
    )

    const config = loadConfig(configPath)

    expect(config.defaultModel).toBe('openai/primary')
    expect(config.taskClosureModel).toBe('openai/closure')
  })

  test('normalizes context compaction model from snake_case config', () => {
    const configPath = join(tmpDir, 'context-compaction.yaml')
    writeFileSync(
      configPath,
      `
providers:
  deepseek:
    api_type: anthropic-deepseek
    base_url: https://api.deepseek.com/anthropic
    auth:
      type: api_key
      api_key_ref: deepseek-key
    models:
      deepseek-v4-flash:
        model_id: deepseek-v4-flash
        max_context: 1000000
        max_output: 128000
        capabilities: []
        tags: []
      deepseek-v4-pro:
        model_id: deepseek-v4-pro
        max_context: 1000000
        max_output: 384000
        capabilities: []
        tags: []
default_model: deepseek-v4-pro
context_compaction_model: deepseek-v4-flash
`,
    )

    const config = loadConfig(configPath)

    expect(config.defaultModel).toBe('deepseek/deepseek-v4-pro')
    expect(config.contextCompactionModel).toBe('deepseek/deepseek-v4-flash')
  })

  test('parses model discovery, supported reasoning levels, and logical routes', () => {
    const configPath = join(tmpDir, 'model-catalog.yaml')
    writeFileSync(
      configPath,
      `
providers:
  chatgpt:
    api_type: openai_responses
    base_url: https://chatgpt.com/backend-api/codex
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_token
    discovery:
      enabled: true
      refresh_interval_ms: 21600000
      timeout_ms: 30000
      client_version: 2026.7.0
      allow:
        - gpt-5.*
      deny:
        - '*-preview'
    models:
      pinned:
        model_id: gpt-5.5
        max_context: 400000
        max_output: 128000
        reasoning_effort: high
        supported_reasoning_efforts:
          - low
          - high
          - max
        capabilities:
          - tools
          - reasoning
        tags:
          - coding
model_routes:
  coding-latest:
    providers:
      - chatgpt
    family: gpt
    lanes:
      - sol
      - terra
    requires:
      - tools
      - reasoning
    min_context: 200000
    prefer: quality
    reasoning_effort: auto
default_model: route/coding-latest
fallback_chain:
  - chatgpt/pinned
`,
    )

    const config = loadConfig(configPath)

    expect(config.providers.chatgpt.discovery).toEqual({
      enabled: true,
      refreshIntervalMs: 21600000,
      timeoutMs: 30000,
      clientVersion: '2026.7.0',
      allow: ['gpt-5.*'],
      deny: ['*-preview'],
    })
    expect(config.providers.chatgpt.models.pinned.supportedReasoningEfforts).toEqual([
      'low',
      'high',
      'xhigh',
    ])
    expect(config.modelRoutes?.['coding-latest']).toEqual({
      providers: ['chatgpt'],
      family: 'gpt',
      lanes: ['sol', 'terra'],
      requires: ['tools', 'reasoning'],
      minContext: 200000,
      prefer: 'quality',
      reasoningEffort: 'auto',
    })
    expect(config.defaultModel).toBe('route/coding-latest')
  })
})

describe('loadFuseList', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fuse-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('empty rules returns empty array', () => {
    const fusePath = join(tmpDir, 'empty.yaml')
    writeFileSync(fusePath, 'rules: []\n')

    const rules = loadFuseList(fusePath)
    expect(rules).toEqual([])
  })

  test('parses rules correctly', () => {
    const fusePath = join(tmpDir, 'rules.yaml')
    writeFileSync(
      fusePath,
      `
rules:
  - pattern: "rm -rf /"
    description: "Prevent destructive commands"
  - pattern: "DROP TABLE"
    description: "Block SQL drops"
`,
    )

    const rules = loadFuseList(fusePath)
    expect(rules).toHaveLength(2)
    expect(rules[0].pattern).toBe('rm -rf /')
    expect(rules[0].description).toBe('Prevent destructive commands')
    expect(rules[1].pattern).toBe('DROP TABLE')
    expect(rules[1].description).toBe('Block SQL drops')
  })
})
