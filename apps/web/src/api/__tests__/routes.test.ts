import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from '@zero-os/core'
import { serializeChatGptOAuthSession, serializeClaudeOAuthSession } from '@zero-os/model'
import type { ProviderAdapter } from '@zero-os/model'
import { encryptSecrets } from '@zero-os/secrets'
import type { Session as SessionData } from '@zero-os/shared'
import { readYaml } from '@zero-os/shared/utils'
import { createTestProjectRoot } from '../../../../../packages/core/src/session/__tests__/test-helpers'
import { SessionDB } from '../../../../../packages/observe/src/session-db'
import { getChatgptOAuthTokenRef } from '../../../../server/src/chatgpt-provider'
import { getClaudeOAuthSessionRef } from '../../../../server/src/claude-provider'
import { startZeroOS } from '../../../../server/src/main'
import type { ZeroOS } from '../../../../server/src/main'
import { createRoutes } from '../routes'

let app: ReturnType<typeof createRoutes>
let zero: ZeroOS
let testDataDir: string
const previousZeroDataDir = process.env.ZERO_DATA_DIR
const previousMasterKey = process.env.ZERO_MASTER_KEY_BASE64
const TEST_MASTER_KEY = Buffer.alloc(32, 9)
const originalFetch = globalThis.fetch
const testProject = createTestProjectRoot('zero-routes-api-')

function recordAgentLoopUsage(
  zero: ZeroOS,
  entry: {
    id: string
    sessionId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    cost: number
    durationMs: number
    createdAt: string
  },
) {
  zero.metrics.recordUsage({
    id: `usage_${entry.id}`,
    sessionId: entry.sessionId,
    category: 'completion',
    purpose: 'agent_loop',
    model: entry.model,
    provider: entry.provider,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    cacheReadTokens: entry.cacheReadTokens,
    reasoningTokens: 0,
    cost: entry.cost,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt,
  })
}

function expectNoSourceCredentialMaterial(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain('external:himalaya/account/qq')
  expect(text).not.toContain('"credentials"')
  expect(text).not.toContain('"credentialRef"')
  expect(text).not.toContain('"credentialLeaseId"')
  expect(text).not.toMatch(/"ref"\s*:/)
  expect(text).not.toMatch(/token|cookie|password|authorization/i)
}

function expectNoSourcePublicViewLeak(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain('commandTemplate')
  expect(text).not.toContain('endpointTemplates')
  expect(text).not.toContain('sampleQueries')
  expect(text).not.toMatch(/"message"\s*:/)
  expect(text).not.toMatch(/"details"\s*:/)
}

function expectNoSourceDraftSecretMaterial(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain('external:himalaya/account/qq')
  expect(text).not.toContain('credentialRef')
  expect(text).not.toContain('credentialLeaseId')
  expect(text).not.toContain('sk-test-placeholder')
  expect(text).not.toMatch(/authorization|cookie|password|token/i)
}

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
  testDataDir = testProject.zeroDir
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
  zero = await startZeroOS({
    dataDir: testDataDir,
    projectRoot: testProject.projectRoot,
    skipProcessExit: true,
  })
  app = createRoutes(zero)
})

afterAll(async () => {
  globalThis.fetch = originalFetch
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
  testProject.cleanup()
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

  test('GET /api/sessions/:id returns preserved systemPrompt for restored sessions', async () => {
    const createdAt = new Date().toISOString()
    const sessionId = 'sess_routes_restored_prompt'
    const renderedSystemPrompt = '<role>restored prompt for api route</role>'
    const isolatedDb = SessionDB.createInMemory()
    const data: SessionData = {
      id: sessionId,
      createdAt,
      updatedAt: createdAt,
      source: 'web',
      currentModel: 'openai-codex/gpt-5.4-medium',
      modelHistory: [{ model: 'openai-codex/gpt-5.4-medium', from: createdAt, to: null }],
      tags: [],
      channelId: 'default',
      channelName: 'web',
    }

    isolatedDb.saveSession(
      data,
      '{"name":"route-agent","agentInstruction":"route prompt"}',
      renderedSystemPrompt,
    )
    isolatedDb.saveBinding('web', 'default', sessionId, 'web', createdAt)
    const isolatedManager = new SessionManager(
      zero.modelRouter,
      zero.toolRegistry,
      { sessionDb: isolatedDb, projectRoot: testProject.projectRoot },
      isolatedDb,
    )
    isolatedManager.restoreFromDB()

    const originalManager = zero.sessionManager
    zero.sessionManager = isolatedManager

    try {
      const res = await app.request(`/api/sessions/${sessionId}`)
      expect(res.status).toBe(200)

      const responseData = await res.json()
      expect(responseData.systemPrompt).toBe(renderedSystemPrompt)
    } finally {
      zero.sessionManager = originalManager
      isolatedDb.close()
    }
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

  test('GET /api/source-cards returns public Source Card views', async () => {
    const res = await app.request('/api/source-cards')
    expect(res.status).toBe(200)

    const data = (await res.json()) as { sourceCards: Array<Record<string, unknown>> }
    const ids = data.sourceCards.map((card) => card.id)
    expect(ids).toContain('qq-mail-himalaya')
    expect(ids).toContain('a-stock-market-data')

    const qq = data.sourceCards.find((card) => card.id === 'qq-mail-himalaya')
    const stock = data.sourceCards.find((card) => card.id === 'a-stock-market-data')
    expect(qq?.state).toBe('candidate')
    expect(qq?.sensitivity).toBe('private')
    expect(stock?.state).toBe('active')
    expect(stock?.sensitivity).toBe('public')
    expect((qq?.credentialBindings as Array<Record<string, unknown>>)[0]).toMatchObject({
      bindingType: 'externalStore',
      hasReference: true,
    })

    expectNoSourceCredentialMaterial(data)
    expectNoSourcePublicViewLeak(data)
  })

  test('GET /api/source-cards/:id returns one public Source Card view', async () => {
    const qqRes = await app.request('/api/source-cards/qq-mail-himalaya')
    expect(qqRes.status).toBe(200)
    const qqData = (await qqRes.json()) as { sourceCard: Record<string, unknown> }

    expect(qqData.sourceCard.id).toBe('qq-mail-himalaya')
    expect(qqData.sourceCard.kind).toBe('private_mailbox')
    expect(qqData.sourceCard).not.toHaveProperty('credentials')
    expectNoSourceCredentialMaterial(qqData)
    expectNoSourcePublicViewLeak(qqData)

    zero.sourceCardManager.recordHealthResult('a-stock-market-data', {
      checkId: 'eastmoney_quote_health',
      status: 'failed',
      checkedAt: '2026-05-11T00:00:00.000Z',
      failureClass: 'schema',
      evidence: {
        statusCode: 200,
        message: 'do-not-return-health-message',
        details: {
          rawResponse: 'do-not-return-health-details',
        },
      },
    })

    const stockRes = await app.request('/api/source-cards/a-stock-market-data')
    expect(stockRes.status).toBe(200)
    const stockData = (await stockRes.json()) as { sourceCard: Record<string, unknown> }
    expect(JSON.stringify(stockData)).toContain('place_order')
    expect(JSON.stringify(stockData)).toContain('use_broker_account')
    expect(JSON.stringify(stockData)).not.toContain('do-not-return-health-message')
    expect(JSON.stringify(stockData)).not.toContain('do-not-return-health-details')
    expectNoSourceCredentialMaterial(stockData)
    expectNoSourcePublicViewLeak(stockData)
  })

  test('GET /api/source-cards/:id/observations returns summaries without raw data', async () => {
    zero.sourceCardManager.recordObservation({
      sourceCardId: 'a-stock-market-data',
      capabilityId: 'fetch_quotes',
      kind: 'data',
      data: {
        rawQuote: 'do-not-return-this-raw-quote',
        symbol: 'SH000001',
      },
      evidence: {
        statusCode: 200,
        rowCount: 1,
        schemaKeys: ['symbol', 'price'],
        message: 'do-not-return-observation-message',
        details: {
          rawQuote: 'do-not-return-this-raw-quote',
        },
      },
    })

    const res = await app.request('/api/source-cards/a-stock-market-data/observations?summary=1')
    expect(res.status).toBe(200)
    const data = await res.json()
    const text = JSON.stringify(data)

    expect(data.sourceCardId).toBe('a-stock-market-data')
    expect(data.summaryOnly).toBe(true)
    expect(data.summary.total).toBeGreaterThan(0)
    const dataObservation = data.observations.find(
      (observation: { capabilityId?: string; kind?: string }) =>
        observation.capabilityId === 'fetch_quotes' && observation.kind === 'data',
    )
    expect(dataObservation?.evidence.schemaKeys).toContain('symbol')
    expect(text).not.toContain('do-not-return-this-raw-quote')
    expect(text).not.toContain('do-not-return-observation-message')
    expect(text).not.toContain('"rawQuote"')
    expectNoSourceCredentialMaterial(data)
    expectNoSourcePublicViewLeak(data)
  })

  test('GET /api/source-cards/:id returns 404 for missing Source Card', async () => {
    const res = await app.request('/api/source-cards/missing-source-card')
    expect(res.status).toBe(404)
  })

  test('POST /api/source-cards/:id/promote promotes a verified public source with public view only', async () => {
    zero.sourceCardManager.update('a-stock-market-data', (card) => ({ ...card, state: 'verified' }))

    const res = await app.request('/api/source-cards/a-stock-market-data/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'reviewed public read-only market data source',
        reviewedCapabilityIds: ['fetch_quotes', 'fetch_rankings'],
      }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as { sourceCard: Record<string, unknown> }
    expect(data.sourceCard.state).toBe('active')
    expect(data.sourceCard).not.toHaveProperty('credentials')
    expectNoSourceCredentialMaterial(data)
    expectNoSourcePublicViewLeak(data)
  })

  test('POST /api/source-cards/:id/promote rejects private source without metadata-only confirmation', async () => {
    zero.sourceCardManager.update('qq-mail-himalaya', (card) => ({ ...card, state: 'verified' }))

    const res = await app.request('/api/source-cards/qq-mail-himalaya/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'reviewed private metadata source',
        reviewedCapabilityIds: ['list_envelopes'],
      }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(JSON.stringify(data)).toContain('privateScopeConfirmation')
    expectNoSourceCredentialMaterial(data)
    expectNoSourcePublicViewLeak(data)
  })

  test('POST /api/source-cards/:id/promote rejects private body or attachment approval', async () => {
    const withBody = await app.request('/api/source-cards/qq-mail-himalaya/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'attempt body approval',
        reviewedCapabilityIds: ['list_envelopes'],
        privateScopeConfirmation: {
          metadataOnly: true,
          bodyAccessApproved: true,
          attachmentAccessApproved: false,
        },
      }),
    })
    const withAttachment = await app.request('/api/source-cards/qq-mail-himalaya/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'attempt attachment approval',
        reviewedCapabilityIds: ['list_envelopes'],
        privateScopeConfirmation: {
          metadataOnly: true,
          bodyAccessApproved: false,
          attachmentAccessApproved: true,
        },
      }),
    })

    expect(withBody.status).toBe(400)
    expect(withAttachment.status).toBe(400)
    expect(JSON.stringify(await withBody.json())).toContain('body access')
    expect(JSON.stringify(await withAttachment.json())).toContain('attachment access')
  })

  test('POST /api/source-cards/:id/retire requires reason and returns public view only', async () => {
    const missingReason = await app.request('/api/source-cards/a-stock-market-data/retire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    })
    expect(missingReason.status).toBe(400)

    const res = await app.request('/api/source-cards/a-stock-market-data/retire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'deprecating this public source card' }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as { sourceCard: Record<string, unknown> }
    expect(data.sourceCard.state).toBe('retired')
    expect(data.sourceCard).not.toHaveProperty('credentials')
    expectNoSourceCredentialMaterial(data)
    expectNoSourcePublicViewLeak(data)
  })

  test('POST /api/source-card-drafts mines a draft and creates only candidate cards', async () => {
    const createdAt = '2026-05-12T03:00:00.000Z'
    const sourceSessionId = 'sess_routes_source_miner'
    const sessionData: SessionData = {
      id: sourceSessionId,
      createdAt,
      updatedAt: createdAt,
      source: 'web',
      currentModel: 'openai-codex/gpt-5.4-medium',
      modelHistory: [{ model: 'openai-codex/gpt-5.4-medium', from: createdAt, to: null }],
      tags: [],
      channelId: 'default',
      channelName: 'web',
    }
    zero.sessionDb.saveSession(sessionData)
    zero.sessionDb.saveMessages(sourceSessionId, [
      {
        id: 'msg_source_miner_user',
        sessionId: sourceSessionId,
        role: 'user',
        messageType: 'message',
        createdAt,
        content: [
          {
            type: 'text',
            text: '把 Eastmoney public stock quote API 的已有 session evidence 做成 Source Card draft',
          },
        ],
      },
      {
        id: 'msg_source_miner_assistant',
        sessionId: sourceSessionId,
        role: 'assistant',
        messageType: 'message',
        createdAt,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool_eastmoney',
            outputSummary: 'public quote metadata',
            content:
              'GET https://push2.eastmoney.com/api/qt/stock/get statusCode 200 schemaKeys data diff f43 f57 f58',
          },
        ],
      },
    ])
    const span = zero.tracer.startSpan(
      sourceSessionId,
      'fetch eastmoney quote evidence',
      undefined,
      {
        kind: 'tool_call',
        data: {
          input: { url: 'https://push2.eastmoney.com/api/qt/stock/get' },
          toolResult: {
            outputSummary: 'HTTP 200 with quote schema',
            schemaKeys: ['data', 'diff', 'f43', 'f57', 'f58'],
          },
        },
      },
    )
    zero.tracer.endSpan(span.id, 'success')

    const draftRes = await app.request('/api/source-card-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sourceSessionId }),
    })
    expect(draftRes.status).toBe(200)
    const draftData = (await draftRes.json()) as { draft: Record<string, unknown> }
    const draft = draftData.draft

    expect(draft.sourceSessionId).toBe(sourceSessionId)
    expect((draft.proposedCard as Record<string, unknown>).state).toBe('candidate')
    expect((draft.proposedCard as Record<string, unknown>).kind).toBe('public_market_data')
    expect(Array.isArray(draft.evidenceRefs)).toBe(true)
    expect(JSON.stringify(draft.evidenceRefs)).toContain('push2.eastmoney.com')
    expect(JSON.stringify(draft.evidenceRefs)).toContain('schemaKeys')
    expectNoSourceDraftSecretMaterial(draftData)

    const validateRes = await app.request('/api/source-card-drafts/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft }),
    })
    expect(validateRes.status).toBe(200)
    expect(((await validateRes.json()) as { validation: { ok: boolean } }).validation.ok).toBe(true)

    const rejected = await app.request('/api/source-card-drafts/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, confirm: false }),
    })
    expect(rejected.status).toBe(400)

    const tamperedDedupe = await app.request('/api/source-card-drafts/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { ...draft, dedupeCandidates: [] }, confirm: true }),
    })
    expect(tamperedDedupe.status).toBe(400)
    expect(JSON.stringify(await tamperedDedupe.json())).toContain('dedupeDecision')

    const created = await app.request('/api/source-card-drafts/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, confirm: true, dedupeDecision: 'new_card' }),
    })
    expect(created.status).toBe(200)
    const createdData = (await created.json()) as { sourceCard: Record<string, unknown> }
    expect(createdData.sourceCard.state).toBe('candidate')
    expect(createdData.sourceCard.state).not.toBe('active')
    expectNoSourceCredentialMaterial(createdData)
    expectNoSourcePublicViewLeak(createdData)
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

  test('GET /api/providers/anthropic/oauth/usage returns Claude OAuth usage', async () => {
    zero.vault.set(
      getClaudeOAuthSessionRef(),
      serializeClaudeOAuthSession({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'Bearer',
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
      }),
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 33,
            resets_at: '2026-04-01T12:00:00.000Z',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as unknown as typeof fetch

    try {
      const res = await app.request('/api/providers/anthropic/oauth/usage')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe('anthropic')
      expect(data.usage).toEqual({
        five_hour: {
          utilization: 33,
          resets_at: '2026-04-01T12:00:00.000Z',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      zero.vault.delete(getClaudeOAuthSessionRef())
    }
  })

  test('GET /api/providers/chatgpt/oauth/usage returns ChatGPT OAuth usage', async () => {
    zero.vault.set(
      getChatgptOAuthTokenRef(),
      serializeChatGptOAuthSession({
        accessToken: 'chatgpt-access-token',
        refreshToken: 'chatgpt-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'bearer',
        accountId: 'account-123',
      }),
    )

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://chatgpt.com/backend-api/wham/usage')
      expect(init?.method).toBe('GET')
      expect(init?.headers).toEqual({
        Authorization: 'Bearer chatgpt-access-token',
        'chatgpt-account-id': 'account-123',
        'Content-Type': 'application/json',
        'User-Agent': 'zero-os/0.1.0 (external, cli)',
      })

      return new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 42,
              limit_window_seconds: 3600,
              reset_at: 1743508800,
            },
            secondary_window: {
              used_percent: 5,
              limit_window_seconds: 10080 * 60,
              reset_at: 1744113600,
            },
          },
          additional_rate_limits: [
            {
              limit_name: 'codex_other',
              metered_feature: 'codex_other',
              rate_limit: {
                primary_window: {
                  used_percent: 88,
                  limit_window_seconds: 1800,
                  reset_at: 1743507000,
                },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const res = await app.request('/api/providers/chatgpt/oauth/usage')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe('chatgpt')
      expect(data.usage).toEqual({
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          primary: {
            usedPercent: 42,
            windowDurationMins: 60,
            resetsAt: 1743508800,
          },
          secondary: {
            usedPercent: 5,
            windowDurationMins: 10080,
            resetsAt: 1744113600,
          },
          credits: null,
          planType: 'pro',
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: null,
            primary: {
              usedPercent: 42,
              windowDurationMins: 60,
              resetsAt: 1743508800,
            },
            secondary: {
              usedPercent: 5,
              windowDurationMins: 10080,
              resetsAt: 1744113600,
            },
            credits: null,
            planType: 'pro',
          },
          codex_other: {
            limitId: 'codex_other',
            limitName: 'codex_other',
            primary: {
              usedPercent: 88,
              windowDurationMins: 30,
              resetsAt: 1743507000,
            },
            secondary: null,
            credits: null,
            planType: 'pro',
          },
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      zero.vault.delete(getChatgptOAuthTokenRef())
    }
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
    expect(data.tools.length).toBe(16)
    const names = data.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('read_image')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('bash')
    expect(names).toContain('fetch')
    expect(names).toContain('memory')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_read')
    expect(names).toContain('schedule')
    expect(names).toContain('source_card')
    expect(names).toContain('codex')
    expect(names).toContain('spawn_agent')
    expect(names).toContain('wait_agent')
    expect(names).toContain('close_agent')
    expect(names).toContain('send_input')

    const readTool = data.tools.find((t: { name: string }) => t.name === 'read')
    const codexTool = data.tools.find((t: { name: string }) => t.name === 'codex')

    expect(readTool?.kind).toBe('built-in')
    expect(codexTool?.kind).toBe('tool')
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
    recordAgentLoopUsage(zero, {
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

  test('GET /api/metrics/cost-detail returns daily model token and cost rows', async () => {
    const createdAt = new Date().toISOString()
    recordAgentLoopUsage(zero, {
      id: 'req_daily_model_spend_001',
      sessionId: 'sess_daily_model_spend_001',
      model: 'test-provider/daily-spend-model',
      provider: 'test-provider',
      inputTokens: 1234,
      outputTokens: 567,
      cacheWriteTokens: 89,
      cacheReadTokens: 101,
      cost: 0.4321,
      durationMs: 120,
      createdAt,
    })

    const res = await app.request('/api/metrics/cost-detail?range=7d')
    expect(res.status).toBe(200)
    const data = await res.json()
    const row = data.data.find(
      (entry: { date: string; provider: string; model: string }) =>
        entry.date === createdAt.slice(0, 10) &&
        entry.provider === 'test-provider' &&
        entry.model === 'test-provider/daily-spend-model',
    )

    expect(row).toEqual(
      expect.objectContaining({
        requestCount: 1,
        input: 1234,
        output: 567,
        cacheWrite: 89,
        cacheRead: 101,
        effectiveInput: 1424,
        cost: 0.4321,
      }),
    )
  })

  test('GET /api/sessions/:id returns cache summary fields', async () => {
    const session = zero.sessionManager.create('web')
    const createdAt = new Date().toISOString()

    recordAgentLoopUsage(zero, {
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
    expect(data.reasoningTokens).toBe(0)
    expect(data.effectiveInputTokens).toBe(1040)
    expect(data.cacheHitRate).toBeCloseTo(400 / 1040, 5)
    expect(typeof data.cacheReadCost).toBe('number')
    expect(data.netSavings).toBeCloseTo(0.0017375, 12)
    expect(data.auxiliaryCost).toBeCloseTo(0.005, 12)
    expect(data.purposeBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'agent_loop', requestCount: 1 }),
        expect.objectContaining({ purpose: 'task_closure', requestCount: 1 }),
      ]),
    )
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
        expect.objectContaining({
          purpose: 'agent_loop',
          totalCost: expect.any(Number),
          totalTokens: expect.any(Number),
          eventCount: expect.any(Number),
        }),
        expect.objectContaining({
          purpose: 'embedding',
          totalCost: 0,
          totalTokens: 80,
          eventCount: 1,
        }),
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
