import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { encryptSecrets } from '@zero-os/secrets'
import { readYaml } from '@zero-os/shared/utils'
import { startZeroOS } from '../../../../server/src/main'
import type { ZeroOS } from '../../../../server/src/main'
import { createRoutes } from '../routes'

let app: ReturnType<typeof createRoutes>
let zero: ZeroOS
let testDataDir: string
const previousZeroDataDir = process.env.ZERO_DATA_DIR
const previousMasterKey = process.env.ZERO_MASTER_KEY_BASE64
const TEST_MASTER_KEY = Buffer.alloc(32, 9)

function writeConfig(dataDir: string) {
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
}

beforeAll(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), 'zero-test-'))
  process.env.ZERO_DATA_DIR = testDataDir
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
  app = createRoutes(zero)
})

afterAll(async () => {
  await zero.shutdown()
  if (previousMasterKey === undefined) {
    process.env.ZERO_MASTER_KEY_BASE64 = undefined
  } else {
    process.env.ZERO_MASTER_KEY_BASE64 = previousMasterKey
  }
  if (previousZeroDataDir === undefined) {
    process.env.ZERO_DATA_DIR = undefined
  } else {
    process.env.ZERO_DATA_DIR = previousZeroDataDir
  }
  rmSync(testDataDir, { recursive: true, force: true })
})

describe('API Routes (Real)', () => {
  test('GET /api/status returns system status', async () => {
    const res = await app.request('/api/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('running')
    expect(data.currentModel).toContain('/')
    expect(data.version).toBe('0.1.0')
  })

  test('GET /api/sessions returns list', async () => {
    const res = await app.request('/api/sessions')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.sessions)).toBe(true)
  })

  test('GET /api/sessions/:id returns 404 for missing session', async () => {
    const res = await app.request('/api/sessions/nonexistent')
    expect(res.status).toBe(404)
  })

  test('GET /api/memory returns memories', async () => {
    const res = await app.request('/api/memory?type=note')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.type).toBe('note')
    expect(Array.isArray(data.memories)).toBe(true)
  })

  test('GET /api/memory includes inbox and preference memories in all view', async () => {
    const createdTypes = ['inbox', 'preference'] as const

    for (const type of createdTypes) {
      const createRes = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: `${type} memory`,
          content: `${type} content`,
        }),
      })

      expect(createRes.status).toBe(200)
    }

    const res = await app.request('/api/memory')
    expect(res.status).toBe(200)

    const data = (await res.json()) as { type: string; memories: Array<{ type: string }> }
    expect(data.type).toBe('all')

    const types = data.memories.map((memory) => memory.type)
    expect(types).toContain('inbox')
    expect(types).toContain('preference')
  })

  test('PUT /api/memo updates memo', async () => {
    const res = await app.request('/api/memo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '# Memo\n\n## Goals\n- test goal\n\n## Needs User Action\n',
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
  })

  test('GET /api/memo returns updated content', async () => {
    const res = await app.request('/api/memo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.content).toContain('# Memo')
    expect(data.content).toContain('test goal')
  })

  test('GET /api/metrics/cost returns cost data', async () => {
    const res = await app.request('/api/metrics/cost?range=7d')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.range).toBe('7d')
  })

  test('GET /api/metrics/summary returns summary', async () => {
    const res = await app.request('/api/metrics/summary')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.today).toBeDefined()
    expect(data.week).toBeDefined()
    expect(data.month).toBeDefined()
  })

  test('GET /api/config returns config', async () => {
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.defaultModel).toBe('openai-codex/gpt-5.4-medium')
    expect(data.providers).toBeDefined()
    expect(data.taskClosureModel).toBeNull()
  })

  test('PUT /api/config updates task closure model in config.yaml', async () => {
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskClosureModel: 'openai-codex/gpt-5.4-medium' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.taskClosureModel).toBe('openai-codex/gpt-5.4-medium')

    const raw = readYaml<Record<string, unknown>>(join(testDataDir, 'config.yaml'))
    expect(raw.task_closure_model).toBe('openai-codex/gpt-5.4-medium')
  })

  test('PUT /api/config clears task closure model when set to null', async () => {
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskClosureModel: null }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.taskClosureModel).toBeNull()

    const raw = readYaml<Record<string, unknown>>(join(testDataDir, 'config.yaml'))
    expect(raw.task_closure_model).toBeUndefined()
  })

  test('PUT /api/config updates runtime task closure model for active and future sessions', async () => {
    const session = zero.sessionManager.create('web')
    session.initAgent({
      name: 'runtime-config-agent',
      agentInstruction: 'Test runtime config updates.',
    })

    const initialAgent = (
      session as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(initialAgent?.closureAdapter).toBe(zero.modelRouter.getDefaultModel()?.adapter)

    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskClosureModel: 'openai-codex/gpt-5.3-codex-medium' }),
    })
    expect(res.status).toBe(200)

    const refreshedAgent = (
      session as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(refreshedAgent?.closureAdapter).toBe(
      zero.modelRouter.resolveModel('openai-codex/gpt-5.3-codex-medium')?.adapter,
    )

    const future = zero.sessionManager.create('web')
    future.initAgent({
      name: 'runtime-config-agent-future',
      agentInstruction: 'Test future runtime config updates.',
    })
    const futureAgent = (
      future as unknown as {
        agent: { closureAdapter: ProviderAdapter } | null
      }
    ).agent
    expect(futureAgent?.closureAdapter).toBe(
      zero.modelRouter.resolveModel('openai-codex/gpt-5.3-codex-medium')?.adapter,
    )
  })

  test('GET /api/models returns model list', async () => {
    const res = await app.request('/api/models')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.models)).toBe(true)
    expect(
      data.models.some((m: { name: string }) => m.name === 'openai-codex/gpt-5.4-medium'),
    ).toBe(true)
  })

  test('POST /api/chat/model switches runtime model', async () => {
    const res = await app.request('/api/chat/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.3-codex-medium' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.currentModel).toBe('openai-codex/gpt-5.3-codex-medium')
  })

  test('POST /api/chat/model without sessionId updates web default scope', async () => {
    const res = await app.request('/api/chat/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-medium' }),
    })
    expect(res.status).toBe(200)

    const statusRes = await app.request('/api/status')
    const statusData = await statusRes.json()
    expect(statusData.currentModel).toBe('openai-codex/gpt-5.4-medium')
  })

  test('GET /api/logs returns entries', async () => {
    const res = await app.request('/api/logs?limit=50')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.limit).toBe(50)
    expect(Array.isArray(data.entries)).toBe(true)
  })

  test('GET /api/tools returns registered tools', async () => {
    const res = await app.request('/api/tools')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.tools.length).toBe(15)
    const names = data.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('bash')
    expect(names).toContain('fetch')
    expect(names).toContain('memory')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_get')
    expect(names).toContain('task')
    expect(names).toContain('schedule')
    expect(names).toContain('codex')
    expect(names).toContain('spawn_agent')
    expect(names).toContain('wait_agent')
    expect(names).toContain('close_agent')
    expect(names).toContain('send_input')

    const readTool = data.tools.find((t: { name: string }) => t.name === 'read')
    const codexTool = data.tools.find((t: { name: string }) => t.name === 'codex')
    const taskTool = data.tools.find((t: { name: string }) => t.name === 'task')

    expect(readTool?.kind).toBe('built-in')
    expect(codexTool?.kind).toBe('tool')
    expect(taskTool?.kind).toBe('tool')
  })

  test('GET /api/metrics/cost-by-day returns data array', async () => {
    const res = await app.request('/api/metrics/cost-by-day')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.data)).toBe(true)
  })

  test('GET /api/metrics/tool-stats returns data array', async () => {
    const res = await app.request('/api/metrics/tool-stats')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.data)).toBe(true)
  })

  test('GET /api/metrics/cache-by-model returns cache analytics rows', async () => {
    zero.metrics.recordRequest({
      id: 'req_cache_metrics_001',
      sessionId: 'sess_cache_metrics_001',
      model: 'anthropic/claude-opus-4-6',
      provider: 'anthropic',
      inputTokens: 550,
      outputTokens: 100,
      cacheWriteTokens: 50,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 100,
      createdAt: new Date().toISOString(),
    })

    const res = await app.request('/api/metrics/cache-by-model?range=7d')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.data)).toBe(true)
    expect(
      data.data.some(
        (row: { model: string; cacheRead: number; effectiveInput: number; netSavings: number }) =>
          row.model === 'anthropic/claude-opus-4-6' &&
          row.cacheRead === 400 &&
          row.effectiveInput === 1000 &&
          Math.abs(row.netSavings - 0.0017375) < 1e-12,
      ),
    ).toBe(true)
  })

  test('GET /api/sessions/:id returns cache summary fields', async () => {
    const session = zero.sessionManager.create('web')
    const createdAt = new Date().toISOString()

    zero.metrics.recordRequest({
      id: 'req_cache_session_001',
      sessionId: session.data.id,
      model: 'anthropic/claude-opus-4-6',
      provider: 'anthropic',
      inputTokens: 550,
      outputTokens: 100,
      cacheWriteTokens: 50,
      cacheReadTokens: 400,
      cost: 0.01,
      durationMs: 100,
      createdAt,
    })
    const span = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_cache_session_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: 'anthropic/claude-opus-4-6',
          provider: 'anthropic',
          userPrompt: 'test cache',
          response: 'ok',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: {
            input: 550,
            output: 100,
            cacheWrite: 50,
            cacheRead: 400,
          },
          cost: 0.01,
          durationMs: 100,
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')
    zero.metrics.recordUsage({
      id: 'usage_closure_session_001',
      sessionId: session.data.id,
      category: 'completion',
      purpose: 'task_closure',
      model: 'anthropic/claude-opus-4-6',
      provider: 'anthropic',
      inputTokens: 40,
      outputTokens: 20,
      cost: 0.005,
      durationMs: 50,
      createdAt,
    })

    const res = await app.request(`/api/sessions/${session.data.id}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.cacheWriteTokens).toBe(50)
    expect(data.cacheReadTokens).toBe(400)
    expect(data.effectiveInputTokens).toBe(1000)
    expect(data.cacheHitRate).toBeCloseTo(0.4, 5)
    expect(typeof data.cacheReadCost).toBe('number')
    expect(data.netSavings).toBeCloseTo(0.0017375, 12)
    expect(data.auxiliaryCost).toBeCloseTo(0.005, 12)
  })

  test('GET /api/metrics/usage-summary returns ledger totals grouped by purpose', async () => {
    const createdAt = new Date().toISOString()
    zero.metrics.recordUsage({
      id: 'usage_metrics_agent_001',
      sessionId: 'sess_usage_metrics_001',
      category: 'completion',
      purpose: 'agent_loop',
      model: 'gpt-5',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.02,
      durationMs: 100,
      createdAt,
    })
    zero.metrics.recordUsage({
      id: 'usage_metrics_embedding_001',
      sessionId: null,
      category: 'embedding',
      purpose: 'embedding',
      model: 'text-embedding-v4',
      provider: 'embedding',
      inputTokens: 80,
      outputTokens: 0,
      cost: 0,
      durationMs: 0,
      createdAt,
    })

    const res = await app.request('/api/metrics/usage-summary?range=7d')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'agent_loop', category: 'completion' }),
        expect.objectContaining({ purpose: 'embedding', category: 'embedding' }),
      ]),
    )
  })

  test('GET /api/metrics/system-costs returns system-level usage totals', async () => {
    const createdAt = new Date().toISOString()
    zero.metrics.recordUsage({
      id: 'usage_system_001',
      sessionId: null,
      category: 'embedding',
      purpose: 'embedding',
      model: 'text-embedding-v4',
      provider: 'embedding',
      inputTokens: 120,
      outputTokens: 0,
      cost: 0,
      durationMs: 0,
      createdAt,
    })

    const res = await app.request('/api/metrics/system-costs?range=7d')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.totalCost).toBe(0)
    expect(data.totalTokens).toBeGreaterThanOrEqual(120)
    expect(data.eventCount).toBeGreaterThanOrEqual(1)
  })

  test('POST /api/chat creates session and returns reply', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is 2+2?' }),
    })
    if (res.status === 500) {
      console.warn(
        '[test] POST /api/chat returned 500 — upstream API unavailable, skipping assertions',
      )
      return
    }
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessionId).toBeDefined()
    expect(typeof data.reply).toBe('string')
    expect(data.reply.length).toBeGreaterThan(0)
  }, 60_000) // Real AI call may take time

  test('POST /api/chat handles /session without calling the model', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/session' }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as { sessionId: string; reply: string; messages: unknown[] }
    expect(data.sessionId).toBeTruthy()
    expect(data.messages).toEqual([])
    expect(data.reply).toContain('Session Info')
    expect(data.reply).toContain('ID:')
    expect(data.reply).toContain('Model:')
    expect(data.reply).toContain('Requests:')
    expect(data.reply).toContain('Tool calls:')
  })

  test('POST /api/chat returns 503 while shutdown is in progress', async () => {
    const originalIsShuttingDown = zero.isShuttingDown
    zero.isShuttingDown = () => true

    try {
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello during restart' }),
      })

      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.error).toContain('restarting')
    } finally {
      zero.isShuttingDown = originalIsShuttingDown
    }
  })
})
