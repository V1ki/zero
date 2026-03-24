import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptSecrets } from '@zero-os/secrets'
import { startZeroOS } from '../apps/server/src/main'

const E2E_PORT = '3211'
const TEST_MASTER_KEY = Buffer.alloc(32, 11)

function createE2EDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-e2e-'))
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
      gpt-5.3-codex-medium:
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
  anthropic:
    api_type: anthropic_messages
    base_url: https://example.com/anthropic
    auth:
      type: api_key
      api_key_ref: anthropic_api_key
    models:
      claude-opus-4-6:
        model_id: claude-opus-4-6
        max_context: 200000
        max_output: 8192
        capabilities:
          - tools
          - reasoning
        tags:
          - analysis
        pricing:
          input: 5
          output: 25
          cacheWrite: 6.25
          cacheRead: 0.5
default_model: openai-codex/gpt-5.4-medium
fallback_chain:
  - openai-codex/gpt-5.4-medium
schedules: []
fuse_list: []
`,
  )
  writeFileSync(join(dataDir, 'fuse_list.yaml'), 'rules: []\n')
  encryptSecrets(
    {
      openai_codex_api_key: 'sk-test-placeholder',
    },
    TEST_MASTER_KEY,
    join(dataDir, 'secrets.enc'),
  )

  return dataDir
}

const dataDir = createE2EDataDir()
process.env.ZERO_DATA_DIR = dataDir
process.env.PORT = E2E_PORT
process.env.ZERO_MASTER_KEY_BASE64 = TEST_MASTER_KEY.toString('base64')

const zero = await startZeroOS({
  dataDir,
  skipProcessExit: true,
  onCoreReady: async (runtime) => {
    const { startWebServer } = await import('../apps/web/src/server')
    const web = startWebServer(runtime)
    console.log(`[ZeRo OS E2E] Web UI: http://127.0.0.1:${web.port}`)
    console.log(`[ZeRo OS E2E] ZERO_DATA_DIR: ${dataDir}`)
  },
})

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[ZeRo OS E2E] Shutting down on ${signal}...`)
  try {
    await zero.shutdown()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
