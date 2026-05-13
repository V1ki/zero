import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBenchmarkConfig, parseCliOptions } from '../config'

let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('zero-runtime benchmark config', () => {
  test('merges benchmark-only model overlay without changing base defaults', () => {
    tmp = mkdtempSync(join(tmpdir(), 'zero-runtime-bench-'))
    const basePath = join(tmp, 'base.yaml')
    const overlayPath = join(tmp, 'models.yaml')

    writeFileSync(
      basePath,
      `
providers:
  chatgpt:
    api_type: openai_responses
    base_url: https://chatgpt.example.test
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_token
    models:
      gpt-5.5:
        model_id: gpt-5.5
        max_context: 400000
        max_output: 128000
default_model: chatgpt/gpt-5.5
fallback_chain:
  - chatgpt/gpt-5.5
`,
    )

    writeFileSync(
      overlayPath,
      `
providers:
  qwen-local:
    api_type: openai_chat_completions
    base_url: http://172.18.8.200:8100/v1
    auth:
      type: api_key
    models:
      qwen3.6-27b:
        model_id: qwen3.6-27b
        max_context: 131072
        max_output: 32768
        extra_body:
          chat_template_kwargs:
            enable_thinking: false
  dashscope-token-plan:
    api_type: openai_chat_completions
    base_url: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    auth:
      type: api_key
      api_key_ref: qwen_token_plan_api_key
    models:
      qwen3.6-plus:
        model_id: qwen3.6-plus
        max_context: 1000000
        max_output: 32768
`,
    )

    const config = loadBenchmarkConfig({ configPath: basePath, modelConfigPath: overlayPath })

    expect(Object.keys(config.providers).sort()).toEqual([
      'chatgpt',
      'dashscope-token-plan',
      'qwen-local',
    ])
    expect(config.defaultModel).toBe('chatgpt/gpt-5.5')
    expect(config.fallbackChain).toEqual(['chatgpt/gpt-5.5'])
    expect(config.providers['qwen-local']?.baseUrl).toBe('http://172.18.8.200:8100/v1')
    expect(config.providers['qwen-local']?.models['qwen3.6-27b']?.maxContext).toBe(131072)
    expect(config.providers['qwen-local']?.models['qwen3.6-27b']?.extraBody).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
      },
    })
    expect(config.providers['dashscope-token-plan']?.auth.apiKeyRef).toBe('qwen_token_plan_api_key')
    expect(config.providers['dashscope-token-plan']?.models['qwen3.6-plus']?.modelId).toBe(
      'qwen3.6-plus',
    )
  })

  test('supports disabling the benchmark model overlay from the CLI', () => {
    const options = parseCliOptions(['plan', '--model-config', 'none'])

    expect(options.modelConfigPath).toBeUndefined()
  })

  test('defaults to GPT plus benchmark Qwen targets', () => {
    const options = parseCliOptions(['plan'])

    expect(options.models.map((model) => model.model)).toEqual([
      'chatgpt/gpt-5.5',
      'qwen-local/qwen3.6-27b',
      'dashscope-token-plan/qwen3.6-plus',
    ])
  })
})
