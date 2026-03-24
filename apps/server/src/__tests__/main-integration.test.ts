import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import { encryptSecrets } from '@zero-os/secrets'
import { startZeroOS } from '../main'
import type { ZeroOS } from '../main'

let zero: ZeroOS
let testDataDir: string
const TEST_MASTER_KEY = Buffer.alloc(32, 7)

function writeConfig(
  dataDir: string,
  options?: {
    embeddingBaseUrl?: string
    includeClosureModel?: boolean
    taskClosureModel?: string
  },
) {
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
${options?.includeClosureModel ? `      gpt-5.3-codex-medium:
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
` : ''}default_model: openai-codex/gpt-5.4-medium
${options?.taskClosureModel ? `task_closure_model: ${options.taskClosureModel}
` : ''}fallback_chain:
  - openai-codex/gpt-5.4-medium
schedules: []
fuse_list: []
${options?.embeddingBaseUrl ? `embedding:
  base_url: ${options.embeddingBaseUrl}
  api_key_ref: embedding_api_key
  model: text-embedding-test
` : ''}`,
  )
  writeFileSync(join(dataDir, 'fuse_list.yaml'), 'rules: []\n')
}

async function createEmbeddingApiServer() {
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

beforeAll(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), 'zero-test-'))
  process.env.ZERO_MASTER_KEY_BASE64 = TEST_MASTER_KEY.toString('base64')
  writeConfig(testDataDir)
  encryptSecrets(
    {
      openai_codex_api_key: 'sk-test-placeholder',
    },
    TEST_MASTER_KEY,
    join(testDataDir, 'secrets.enc'),
  )
  zero = await startZeroOS({ dataDir: testDataDir, skipProcessExit: true })
})

afterAll(async () => {
  await zero.shutdown()
  delete process.env.ZERO_MASTER_KEY_BASE64
  rmSync(testDataDir, { recursive: true, force: true })
})

describe('startZeroOS Integration', () => {
  test('runs core-ready hook before external channels start', async () => {
    const observed = {
      webRegistered: false,
      externalChannelsRegistered: false,
    }

    const hookedZero = await startZeroOS({
      dataDir: testDataDir,
      skipProcessExit: true,
      onCoreReady: (runtime) => {
        observed.webRegistered = runtime.channels.has('web')
        observed.externalChannelsRegistered = runtime.channels.size > 1
      },
    })

    expect(observed.webRegistered).toBe(true)
    expect(observed.externalChannelsRegistered).toBe(false)

    await hookedZero.shutdown()
  })

  test('returns all required components', () => {
    expect(zero.config).toBeDefined()
    expect(zero.vault).toBeDefined()
    expect(zero.secretFilter).toBeDefined()
    expect(zero.observability).toBeDefined()
    expect(zero.metrics).toBeDefined()
    expect(zero.modelRouter).toBeDefined()
    expect(zero.toolRegistry).toBeDefined()
    expect(zero.sessionManager).toBeDefined()
    expect(zero.memoryStore).toBeDefined()
    expect(zero.memoManager).toBeDefined()
    expect(zero.tracer).toBeDefined()
    expect(zero.repairEngine).toBeDefined()
    expect(zero.bus).toBeDefined()
    expect(zero.channels).toBeDefined()
    expect(zero.notifications).toBeDefined()
    expect(typeof zero.addNotification).toBe('function')
  })

  test('modelRouter has initialized adapters', () => {
    const current = zero.modelRouter.getCurrentModel()
    expect(current).toBeDefined()
    if (!current) {
      throw new Error('expected current model')
    }
    expect(current.modelName).toBe('gpt-5.4-medium')
  })

  test('passes taskClosureModel into new session agents as a dedicated closure adapter', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zero-task-closure-'))
    process.env.ZERO_MASTER_KEY_BASE64 = TEST_MASTER_KEY.toString('base64')
    writeConfig(dataDir, {
      includeClosureModel: true,
      taskClosureModel: 'openai-codex/gpt-5.3-codex-medium',
    })
    encryptSecrets(
      {
        openai_codex_api_key: 'sk-test-placeholder',
      },
      TEST_MASTER_KEY,
      join(dataDir, 'secrets.enc'),
    )

    let closureZero: ZeroOS | undefined

    try {
      closureZero = await startZeroOS({ dataDir, skipProcessExit: true })
      const session = closureZero.sessionManager.create('web')
      session.initAgent({
        name: 'closure-test-agent',
        agentInstruction: 'Test closure routing.',
      })

      const agent = (
        session as unknown as {
          agent: { adapter: ProviderAdapter; closureAdapter: ProviderAdapter } | null
        }
      ).agent
      expect(agent).toBeDefined()
      expect(agent?.adapter).toBe(closureZero.modelRouter.getDefaultModel()?.adapter)
      expect(agent?.closureAdapter).toBe(
        closureZero.modelRouter.resolveModel('openai-codex/gpt-5.3-codex-medium')?.adapter,
      )
      expect(agent?.closureAdapter).not.toBe(agent?.adapter)
    } finally {
      await closureZero?.shutdown()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('toolRegistry has 15 registered tools', () => {
    const tools = zero.toolRegistry.list()
    expect(tools.length).toBe(15)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('bash')
    expect(names).toContain('fetch')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_get')
    expect(names).toContain('memory')
    expect(names).toContain('task')
    expect(names).toContain('schedule')
    expect(names).toContain('codex')
    expect(names).toContain('spawn_agent')
    expect(names).toContain('wait_agent')
    expect(names).toContain('close_agent')
    expect(names).toContain('send_input')
  })

  test('channels map contains web, feishu, telegram', () => {
    expect(zero.channels.has('web')).toBe(true)
    expect(zero.channels.has('feishu')).toBe(true)
    expect(zero.channels.has('telegram')).toBe(true)
    // Web should be connected
    const webChannel = zero.channels.get('web')
    if (!webChannel) {
      throw new Error('expected web channel')
    }
    expect(webChannel.isConnected()).toBe(true)
  })

  test('bus can emit events without error', () => {
    expect(() => {
      zero.bus.emit('heartbeat', { key: 'value' })
    }).not.toThrow()
  })

  test('preserves existing vector search when reindex fails for persisted memory text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zero-embedding-fallback-'))
    const embeddingApi = await createEmbeddingApiServer()

    process.env.ZERO_MASTER_KEY_BASE64 = TEST_MASTER_KEY.toString('base64')
    writeConfig(dataDir, { embeddingBaseUrl: embeddingApi.baseUrl })
    encryptSecrets(
      {
        openai_codex_api_key: 'sk-test-placeholder',
        embedding_api_key: 'emb-test-placeholder',
      },
      TEST_MASTER_KEY,
      join(dataDir, 'secrets.enc'),
    )

    let initialZero: ZeroOS | undefined
    let restartedZero: ZeroOS | undefined

    try {
      initialZero = await startZeroOS({ dataDir, skipProcessExit: true })
      await initialZero.memoryStore.create(
        'note',
        'Persisted deploy memory',
        'deploy gateway rollback plan',
        {
          status: 'verified',
          confidence: 0.95,
          tags: ['deploy'],
        },
      )

      const initialResults = await initialZero.memoryRetriever.retrieveScored('deploy gateway', {
        topN: 5,
        confidenceThreshold: 0,
      })
      expect(initialResults.map((entry) => entry.memory.title)).toContain('Persisted deploy memory')

      await initialZero.shutdown()
      initialZero = undefined

      const baseStore = new MemoryStore(join(dataDir, 'memory'))
      const persistedMemory = baseStore.list('note').find((memory) => memory.title === 'Persisted deploy memory')
      if (!persistedMemory) {
        throw new Error('Expected persisted memory to exist before restart')
      }
      await baseStore.update('note', persistedMemory.id, {
        tags: ['deploy', 'stale'],
      })

      embeddingApi.state.failOnText = 'Persisted deploy memory'

      restartedZero = await startZeroOS({ dataDir, skipProcessExit: true })
      const restartedResults = await restartedZero.memoryRetriever.retrieveScored('deploy gateway', {
        topN: 5,
        confidenceThreshold: 0,
      })

      expect(restartedResults.map((entry) => entry.memory.title)).toContain('Persisted deploy memory')
    } finally {
      await initialZero?.shutdown()
      await restartedZero?.shutdown()
      await embeddingApi.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
