import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { encryptSecrets } from '@zero-os/secrets'

export const TEST_MASTER_KEY = Buffer.alloc(32, 7)

interface IntegrationConfigOptions {
  embeddingBaseUrl?: string
  includeClosureModel?: boolean
  includeUnconfiguredWeixin?: boolean
  taskClosureModel?: string
}

export function setIntegrationMasterKey(): void {
  process.env.ZERO_MASTER_KEY_BASE64 = TEST_MASTER_KEY.toString('base64')
}

export function writeIntegrationSecrets(
  dataDir: string,
  secrets: Record<string, string> = {
    openai_codex_api_key: 'sk-test-placeholder',
  },
): void {
  encryptSecrets(secrets, TEST_MASTER_KEY, join(dataDir, 'secrets.enc'))
}

export function writeIntegrationConfig(dataDir: string, options?: IntegrationConfigOptions): void {
  writeFileSync(
    join(dataDir, 'config.yaml'),
    `providers:
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
          - vision
          - reasoning
        tags:
          - powerful
          - coding
${
  options?.includeClosureModel
    ? `      gpt-5.3-codex-medium:
        model_id: gpt-5.3-codex-medium
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
          - vision
          - reasoning
        tags:
          - powerful
          - coding
`
    : ''
}default_model: openai-codex/gpt-5.4-medium
${
  options?.taskClosureModel
    ? `task_closure_model: ${options.taskClosureModel}
`
    : ''
}fallback_chain:
  - openai-codex/gpt-5.4-medium
schedules: []
fuse_list: []
${
  options?.includeUnconfiguredWeixin
    ? `channels:
  - type: weixin
    name: weixin:test
    accountIdRef: missing_weixin_account_id
    tokenRef: missing_weixin_token
    dmPolicy: open
    groupPolicy: disabled
`
    : ''
}${
  options?.embeddingBaseUrl
    ? `embedding:
  base_url: ${options.embeddingBaseUrl}
  api_key_ref: embedding_api_key
  model: text-embedding-test
`
    : ''
}`,
  )
  writeFileSync(join(dataDir, 'fuse_list.yaml'), 'rules: []\n')
}

export async function createEmbeddingApiServer(options?: {
  usage?: {
    promptTokens: number
    totalTokens: number
  }
}) {
  const state = {
    failOnText: undefined as string | undefined,
  }

  const embedText = (text: string): number[] => {
    const normalized = text.toLowerCase()
    return [
      Number(normalized.includes('deploy')) + Number(normalized.includes('gateway')),
      Number(normalized.includes('database')) + Number(normalized.includes('timeout')),
    ]
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/embeddings') {
      res.statusCode = 404
      res.end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
      input?: string[] | string
    }
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? '']

    if (state.failOnText && inputs.some((text) => String(text).includes(state.failOnText ?? ''))) {
      res.statusCode = 503
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'embedding unavailable for selected text' }))
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: inputs.map((text) => ({
          embedding: embedText(String(text)),
        })),
        ...(options?.usage
          ? {
              usage: {
                prompt_tokens: options.usage.promptTokens,
                total_tokens: options.usage.totalTokens,
              },
            }
          : {}),
      }),
    )
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected embedding server to bind to a TCP port')
  }

  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}
