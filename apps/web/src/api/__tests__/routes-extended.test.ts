import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@zero-os/shared'
import { getSessionLogRelativeDir } from '@zero-os/shared'
import { createTestProjectRoot } from '../../../../../packages/core/src/session/__tests__/test-helpers'
import type { SessionRunningToolRegistry } from '../../../../../packages/core/src/session/running-tool-registry'
import { startZeroOS } from '../../../../server/src/main'
import type { ZeroOS } from '../../../../server/src/main'
import { createRoutes } from '../routes'

let app: ReturnType<typeof createRoutes>
let zero: ZeroOS
let testDataDir: string
const testProject = createTestProjectRoot('zero-routes-extended-')

beforeAll(async () => {
  testDataDir = testProject.zeroDir
  const prodDir = join(process.cwd(), '.zero')
  for (const file of ['secrets.enc', 'config.yaml', 'fuse_list.yaml']) {
    const src = join(prodDir, file)
    if (existsSync(src)) {
      cpSync(src, join(testDataDir, file))
    }
  }
  zero = await startZeroOS({
    dataDir: testDataDir,
    projectRoot: testProject.projectRoot,
    skipProcessExit: true,
  })
  app = createRoutes(zero)
})

afterAll(async () => {
  await zero.shutdown()
  testProject.cleanup()
})

describe('API Routes Extended', () => {
  test('POST /api/chat with existing sessionId reuses session', async () => {
    const res1 = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Say "hello" and nothing else.' }),
    })
    if (res1.status === 500) {
      console.warn(
        '[test] POST /api/chat returned 500 — upstream API unavailable, skipping assertions',
      )
      return
    }
    expect(res1.status).toBe(200)
    const data1 = await res1.json()
    const sessionId = data1.sessionId

    const res2 = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Say "world" and nothing else.', sessionId }),
    })
    if (res2.status === 500) {
      console.warn(
        '[test] POST /api/chat returned 500 — upstream API unavailable, skipping assertions',
      )
      return
    }
    expect(res2.status).toBe(200)
    const data2 = await res2.json()
    expect(data2.sessionId).toBe(sessionId)
  }, 60_000)

  test('GET /api/sessions?filter=current returns current sessions', async () => {
    zero.sessionManager.getOrCreateForChannel('feishu', 'route_filter_room', 'feishu:ops')
    zero.sessionManager.create('web')

    const res = await app.request('/api/sessions?filter=current')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.sessions)).toBe(true)
    for (const s of data.sessions) {
      expect(s.isCurrent).toBe(true)
      expect(s.placement).toBe('current')
    }
  })

  test('GET /api/sessions?q=web searches by source', async () => {
    zero.sessionManager.create('web')
    const res = await app.request('/api/sessions?q=web')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions.length).toBeGreaterThan(0)
    expect(data.sessions[0].source).toBe('web')
  })

  test('POST /api/chat/new rotates the current web binding', async () => {
    const session = zero.sessionManager.getOrCreateForChannel('web', 'default', 'web').session
    const res = await app.request('/api/chat/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.previousSessionId).toBe(session.data.id)
    expect(data.sessionId).not.toBe(session.data.id)

    const getRes = await app.request(`/api/sessions/${session.data.id}`)
    const sessionData = await getRes.json()
    expect(sessionData.isCurrent).toBe(false)
    expect(sessionData.placement).toBe('background')
  })

  test('POST /api/chat/new backgrounds meaningful web session and evaluates session memory', async () => {
    const session = zero.sessionManager.getOrCreateForChannel('web', 'default', 'web').session
    session.initAgent({
      name: 'background-eval-test',
      agentInstruction: 'Test web session background evaluation.',
    })
    ;(session as unknown as { messages: Message[] }).messages.push(
      {
        id: 'archive_user_1',
        sessionId: session.data.id,
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'text',
            text: '请把这次部署排障过程整理清楚，我后面还要回看根因、修复步骤、验证方式和这次处理里做过的关键判断。',
          },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'archive_tool_1',
        sessionId: session.data.id,
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'bash', input: { cmd: 'bun run check' } },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'archive_assistant_1',
        sessionId: session.data.id,
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'text',
            text: '我已经检查了迁移脚本、环境变量、部署日志和最近的变更，确认问题来自旧 schema 没有升级完整，同时把修复步骤、验证路径、回滚注意事项和后续部署时的检查清单都整理好了。',
          },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'archive_user_2',
        sessionId: session.data.id,
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'text',
            text: '这次会话已经不只是一个短问题了，我希望切换到新会话时也能触发总结，让后续接手的人快速知道这次排障做了什么以及最后结论是什么，尤其是根因、修复步骤和验证结果。',
          },
        ],
        createdAt: new Date().toISOString(),
      },
    )

    let evaluationCalled = false
    ;(
      session as unknown as {
        evaluateSessionMemory: (prompt: string) => Promise<void>
      }
    ).evaluateSessionMemory = async (prompt) => {
      evaluationCalled = prompt.includes('session 类型的记忆')
    }

    const res = await app.request('/api/chat/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)

    await Promise.resolve()
    await Promise.resolve()

    expect(evaluationCalled).toBe(true)
    expect(zero.sessionManager.getPlacement(session.data.id)).toBe('background')
  })

  test('POST /api/chat returns 404 when the requested web session does not exist', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'sess_missing_route' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/sessions/:id/tool-calls/:toolUseId/abort is idempotent for live bash runs', async () => {
    const session = zero.sessionManager.create('web')
    ;(session as unknown as { messages: Message[] }).messages.push({
      id: 'abort_tool_assistant_1',
      sessionId: session.data.id,
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'call_abort_live_1', name: 'bash', input: { command: 'sleep 5' } }],
      createdAt: new Date().toISOString(),
    })

    const runningToolRegistry = (
      session as unknown as { runningToolRegistry: SessionRunningToolRegistry }
    ).runningToolRegistry
    runningToolRegistry.register({
      toolUseId: 'call_abort_live_1',
      toolName: 'bash',
      abortable: true,
    })

    const first = await app.request(
      `/api/sessions/${session.data.id}/tool-calls/call_abort_live_1/abort`,
      { method: 'POST' },
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, status: 'accepted' })

    const second = await app.request(
      `/api/sessions/${session.data.id}/tool-calls/call_abort_live_1/abort`,
      { method: 'POST' },
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, status: 'already_requested' })
  })

  test('POST /api/sessions/:id/tool-calls/:toolUseId/abort returns already_finished for completed bash calls', async () => {
    const session = zero.sessionManager.create('web')
    ;(session as unknown as { messages: Message[] }).messages.push({
      id: 'abort_tool_assistant_2',
      sessionId: session.data.id,
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'call_abort_done_1', name: 'bash', input: { command: 'pwd' } }],
      createdAt: new Date().toISOString(),
    })

    const res = await app.request(
      `/api/sessions/${session.data.id}/tool-calls/call_abort_done_1/abort`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'already_finished' })
  })

  test('POST /api/sessions/:id/tool-calls/:toolUseId/abort rejects non-bash tool ids', async () => {
    const session = zero.sessionManager.create('web')
    ;(session as unknown as { messages: Message[] }).messages.push({
      id: 'abort_tool_assistant_3',
      sessionId: session.data.id,
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'call_abort_read_1', name: 'read', input: { path: '/tmp/demo' } }],
      createdAt: new Date().toISOString(),
    })

    const res = await app.request(
      `/api/sessions/${session.data.id}/tool-calls/call_abort_read_1/abort`,
      { method: 'POST' },
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Tool call is not an abortable bash run',
    })
  })

  test('POST /api/sessions/:id/tool-calls/:toolUseId/abort returns 404 for missing sessions', async () => {
    const res = await app.request('/api/sessions/nonexistent/tool-calls/call_abort_404/abort', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/sessions/:id/repair/rollback-tail dry-runs without mutating messages', async () => {
    const session = zero.sessionManager.create('web')
    const keep: Message = {
      id: 'repair_keep_1',
      sessionId: session.data.id,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'keep me' }],
      createdAt: new Date().toISOString(),
    }
    const tail: Message = {
      id: 'repair_tail_1',
      sessionId: session.data.id,
      role: 'user',
      messageType: 'control',
      controlKind: 'empty_retry',
      content: [{ type: 'text', text: 'remove me' }],
      createdAt: new Date().toISOString(),
    }
    ;(session as unknown as { messages: Message[] }).messages.push(keep, tail)

    const res = await app.request(`/api/sessions/${session.data.id}/repair/rollback-tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1 }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toMatchObject({
      ok: true,
      status: 'ok',
      dryRun: true,
      beforeCount: 2,
      afterCount: 1,
    })
    expect(data.removed[0]).toMatchObject({
      id: 'repair_tail_1',
      messageType: 'control',
      controlKind: 'empty_retry',
      preview: 'remove me',
    })
    expect(session.getMessages()).toEqual([keep, tail])
  })

  test('POST /api/sessions/:id/repair/rollback-tail removes and persists tail messages', async () => {
    const session = zero.sessionManager.create('web')
    const keep: Message = {
      id: 'repair_keep_2',
      sessionId: session.data.id,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'keep me' }],
      createdAt: new Date().toISOString(),
    }
    const tail: Message = {
      id: 'repair_tail_2',
      sessionId: session.data.id,
      role: 'user',
      messageType: 'control',
      controlKind: 'empty_retry',
      content: [{ type: 'text', text: 'remove me' }],
      createdAt: new Date().toISOString(),
    }
    ;(session as unknown as { messages: Message[] }).messages.push(keep, tail)

    const res = await app.request(`/api/sessions/${session.data.id}/repair/rollback-tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: 1,
        dryRun: false,
        reason: 'remove empty-response retry control tail',
      }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toMatchObject({
      ok: true,
      status: 'ok',
      dryRun: false,
      beforeCount: 2,
      afterCount: 1,
      reason: 'remove empty-response retry control tail',
    })
    expect(session.getMessages()).toEqual([keep])
    expect(zero.sessionManager.getMessagesFromDB(session.data.id)).toEqual([keep])
  })

  test('POST /api/sessions/:id/repair/rollback-tail rejects running sessions', async () => {
    const session = zero.sessionManager.create('web')
    ;(session as unknown as { isTurnInProgress: () => boolean }).isTurnInProgress = () => true

    const res = await app.request(`/api/sessions/${session.data.id}/repair/rollback-tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1, dryRun: false }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      ok: false,
      status: 'turn_in_progress',
    })
  })

  test('GET /api/memory/search?q=query returns results', async () => {
    const res = await app.request('/api/memory/search?q=test')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.query).toBe('test')
    expect(Array.isArray(data.results)).toBe(true)
  })

  test('GET /api/memory/search without q returns empty', async () => {
    const res = await app.request('/api/memory/search')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toEqual([])
  })

  test('GET /api/notifications returns notifications array', async () => {
    const res = await app.request('/api/notifications')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.notifications)).toBe(true)
  })

  test('events.jsonl keeps only key bus events', () => {
    const before = zero.observability.readEntries<Record<string, unknown>>('events.jsonl').length

    zero.bus.emit('session:create', {
      sessionId: 'sess_signal_create',
      source: 'web',
    })
    zero.bus.emit('tool:call', {
      sessionId: 'sess_tool_noise',
      tool: 'bash',
      toolUseId: 'call_001',
    })
    zero.bus.emit('tool:result', {
      sessionId: 'sess_tool_noise',
      tool: 'bash',
      success: true,
      outputSummary: 'ok',
    })
    zero.bus.emit('session:update', {
      sessionId: 'sess_signal',
      event: 'message_handled',
    })

    const newEntries = zero.observability
      .readEntries<Record<string, unknown>>('events.jsonl')
      .slice(before)

    expect(newEntries.some((entry) => entry.event === 'session:create')).toBe(true)
    expect(newEntries.some((entry) => entry.event === 'tool:call')).toBe(false)
    expect(newEntries.some((entry) => entry.event === 'tool:result')).toBe(false)
    expect(newEntries.some((entry) => entry.event === 'message_handled')).toBe(false)
  })

  test('session:update preserves spanId in events.jsonl', () => {
    const before = zero.observability.readEntries<Record<string, unknown>>('events.jsonl').length

    zero.bus.emit('session:update', {
      sessionId: 'sess_signal_with_span',
      spanId: 'span_signal_001',
      event: 'task_closure_decision',
      action: 'finish',
      reason: 'done',
    })

    const newEntries = zero.observability
      .readEntries<Record<string, unknown>>('events.jsonl')
      .slice(before)
    const entry = newEntries.find((item) => item.event === 'task_closure_decision')

    expect(entry).toBeDefined()
    expect(entry?.sessionId).toBe('sess_signal_with_span')
    expect(entry?.spanId).toBe('span_signal_001')
  })

  test('GET /api/channels/status returns channel statuses', async () => {
    const res = await app.request('/api/channels/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.channels)).toBe(true)
    const names = data.channels.map((c: { name: string }) => c.name)
    expect(names).toContain('web')
    expect(names).toContain('feishu')
    expect(names).toContain('telegram')
  })

  test('GET /api/channels/config returns channel configs with secrets', async () => {
    const res = await app.request('/api/channels/config')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.channels)).toBe(true)
    const webCh = data.channels.find((c: { name: string }) => c.name === 'web')
    expect(webCh).toBeDefined()
    expect(webCh.type).toBe('web')
    expect(webCh.status).toBe('online')
  })

  test('GET /api/status reflects degraded heartbeat state', async () => {
    zero.heartbeat.setHealthMetrics({
      errorCount: 3,
      channels: [],
    })
    zero.heartbeat.write()

    const res = await app.request('/api/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('degraded')
    expect(typeof data.heartbeatAge).toBe('number')
    expect(data.heartbeatAge).toBeGreaterThanOrEqual(0)
  })

  test('GET /api/metrics/health returns repair stats', async () => {
    const res = await app.request('/api/metrics/health')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.repairs).toBeDefined()
    expect(data.repairTrend).toBeDefined()
  })

  test('GET /api/metrics/cost-by-channel and related channel routes aggregate usage_ledger attribution', async () => {
    const createdAt = new Date().toISOString()
    const telegramSession = zero.sessionManager.create('telegram', {
      channelId: 'chat_ops_001',
      channelName: 'ops-bot',
    })
    const webSession = zero.sessionManager.create('web', {
      channelId: 'dashboard_001',
      channelName: 'dashboard',
    })
    zero.sessionDb.saveSession(telegramSession.data)
    zero.sessionDb.saveSession(webSession.data)

    zero.metrics.recordUsage({
      id: 'usage_attr_telegram_agent',
      sessionId: telegramSession.data.id,
      category: 'completion',
      purpose: 'agent_loop',
      model: 'chatgpt/gpt-5.4',
      provider: 'chatgpt',
      inputTokens: 120,
      outputTokens: 30,
      cost: 0.3,
      durationMs: 1200,
      createdAt,
    })
    zero.metrics.recordUsage({
      id: 'usage_attr_telegram_closure',
      sessionId: telegramSession.data.id,
      category: 'completion',
      purpose: 'task_closure',
      model: 'chatgpt/gpt-5.4',
      provider: 'chatgpt',
      inputTokens: 20,
      outputTokens: 5,
      cost: 0.05,
      durationMs: 150,
      createdAt,
    })
    zero.metrics.recordUsage({
      id: 'usage_attr_web_agent',
      sessionId: webSession.data.id,
      category: 'completion',
      purpose: 'agent_loop',
      model: 'chatgpt/gpt-5.4',
      provider: 'chatgpt',
      inputTokens: 80,
      outputTokens: 20,
      cost: 0.1,
      durationMs: 500,
      createdAt,
    })

    const channelRes = await app.request('/api/metrics/cost-by-channel?range=7d')
    expect(channelRes.status).toBe(200)
    const channelData = await channelRes.json()
    expect(channelData.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'telegram',
          channelName: 'ops-bot',
          totalCost: 0.35,
        }),
        expect.objectContaining({
          source: 'web',
          channelName: 'dashboard',
          totalCost: 0.1,
        }),
      ]),
    )

    const sourceRes = await app.request('/api/metrics/cost-by-source?range=7d')
    expect(sourceRes.status).toBe(200)
    const sourceData = await sourceRes.json()
    const telegramSource = sourceData.data.find(
      (row: { source: string }) => row.source === 'telegram',
    )
    const webSource = sourceData.data.find((row: { source: string }) => row.source === 'web')
    expect(telegramSource).toEqual(
      expect.objectContaining({
        source: 'telegram',
        totalCost: 0.35,
      }),
    )
    // Other web-scoped tests in this suite may have already written usage rows.
    // Assert that this route includes at least the usage inserted by this case.
    expect(webSource).toEqual(
      expect.objectContaining({
        source: 'web',
      }),
    )
    expect(webSource.totalCost).toBeGreaterThanOrEqual(0.1)

    const detailRes = await app.request(
      `/api/metrics/channel/${encodeURIComponent('ops-bot')}/cost-by-day?range=7d&source=telegram`,
    )
    expect(detailRes.status).toBe(200)
    const detailData = await detailRes.json()
    expect(detailData.data).toEqual([
      expect.objectContaining({
        totalCost: 0.35,
      }),
    ])

    const breakdownRes = await app.request(
      `/api/metrics/channel/${encodeURIComponent('ops-bot')}/purpose-breakdown?range=7d&source=telegram`,
    )
    expect(breakdownRes.status).toBe(200)
    const breakdownData = await breakdownRes.json()
    expect(breakdownData.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'agent_loop', totalCost: 0.3 }),
        expect.objectContaining({ purpose: 'task_closure', totalCost: 0.05 }),
      ]),
    )
  })

  test('GET /api/metrics/evaluations/* returns persisted evaluation aggregates', async () => {
    const createdAt = new Date().toISOString()
    zero.metrics.recordEvaluation({
      sessionId: 'sess_eval_metrics_001',
      model: 'judge/gpt-5.4',
      overallScore: 4,
      verdict: 'strong',
      confidence: 'high',
      summary: 'Strong result',
      dimensions: [
        {
          key: 'task_completion',
          label: 'Task Completion',
          score: 4,
          maxScore: 5,
          rationale: 'Completed the work.',
        },
      ],
      findings: [{ severity: 'warn', title: 'Duplicate search', evidence: 'Repeated once.' }],
      signals: { totalCost: 0.4, requestCount: 2 },
      generatedAt: createdAt,
      createdAt,
    })
    zero.metrics.recordEvaluation({
      sessionId: 'sess_eval_metrics_002',
      model: 'judge/gpt-5.4',
      overallScore: 2,
      verdict: 'weak',
      confidence: 'medium',
      summary: 'Weak result',
      dimensions: [
        {
          key: 'task_completion',
          label: 'Task Completion',
          score: 2,
          maxScore: 5,
          rationale: 'Missed the final step.',
        },
      ],
      findings: [{ severity: 'warn', title: 'Duplicate search', evidence: 'Repeated twice.' }],
      signals: { totalCost: 0.8, requestCount: 4 },
      generatedAt: createdAt,
      createdAt,
    })

    const trendRes = await app.request('/api/metrics/evaluations/trend?range=30d')
    expect(trendRes.status).toBe(200)
    const trendData = await trendRes.json()
    expect(trendData.data[0]).toMatchObject({
      avgScore: 3,
      evalCount: 2,
      strongCount: 1,
      weakCount: 1,
    })

    const dimensionsRes = await app.request('/api/metrics/evaluations/dimensions?range=30d')
    expect(dimensionsRes.status).toBe(200)
    const dimensionsData = await dimensionsRes.json()
    expect(dimensionsData.data).toEqual([
      expect.objectContaining({
        dimensionKey: 'task_completion',
        avgScore: 3,
        count: 2,
      }),
    ])

    const findingsRes = await app.request('/api/metrics/evaluations/top-findings?range=30d')
    expect(findingsRes.status).toBe(200)
    const findingsData = await findingsRes.json()
    expect(findingsData.data).toEqual([
      expect.objectContaining({
        title: 'Duplicate search',
        severity: 'warn',
        count: 2,
      }),
    ])
  })

  test('GET /api/sessions/:id/traces returns traces', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'task_closure_decision', undefined, {
      kind: 'closure_decision',
      data: {
        closure: {
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'trace_complete',
          classifierRequest: {
            system: 'strict classifier',
            prompt: '<instruction>prompt</instruction>',
            maxTokens: 200,
          },
        },
      },
      metadata: {
        classifierRequest: {
          system: 'strict classifier',
          prompt: '<instruction>prompt</instruction>',
          maxTokens: 200,
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request(`/api/sessions/${session.data.id}/traces`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.traces)).toBe(true)
    expect(data.traces[0].data.closure.classifierRequest).toEqual({
      prompt: '<instruction>prompt</instruction>',
      maxTokens: 200,
    })
    expect(data.traces[0].metadata.classifierRequest).toEqual({
      prompt: '<instruction>prompt</instruction>',
      maxTokens: 200,
    })
  })

  test('GET /api/sessions/:id/task-closure-events returns trace-projected closure events', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'task_closure_decision', undefined, {
      kind: 'closure_decision',
      data: {
        closure: {
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'trace_complete',
          assistantMessageId: 'msg_trace_001',
          classifierRequest: {
            system: 'strict classifier',
            prompt: '<instruction>prompt</instruction>',
            maxTokens: 200,
          },
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request(`/api/sessions/${session.data.id}/task-closure-events`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.events)).toBe(true)
    expect(data.events[0].event).toBe('task_closure_decision')
    expect(data.events[0].assistantMessageId).toBe('msg_trace_001')
    expect(data.events[0].classifierRequest).toEqual({
      prompt: '<instruction>prompt</instruction>',
      maxTokens: 200,
    })
  })

  test('GET /api/sessions/:id/task-closure-events ignores events log task closure events', async () => {
    const session = zero.sessionManager.create('web')
    zero.observability.log('info', 'task_closure_failed', {
      sessionId: session.data.id,
      reason: 'classifier_failed',
    })

    const res = await app.request(`/api/sessions/${session.data.id}/task-closure-events`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.events).toEqual([])
  })

  test('GET /api/sessions/:id/requests returns trace-projected LLM requests', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_session_route_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: 'openai-codex/gpt-5.4-medium',
          provider: 'openai-codex',
          userPrompt: 'full prompt for session route',
          response: 'full response for session route',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [{ id: 'call_route_1', name: 'read', input: { path: '/tmp/demo.txt' } }],
          toolResults: [
            {
              type: 'tool_result',
              toolUseId: 'call_route_1',
              content: 'demo file contents',
              outputSummary: 'demo file contents',
            },
          ],
          queuedInjection: {
            count: 1,
            formattedText: '<queued_message>queued follow-up</queued_message>',
            messages: [
              {
                timestamp: '2026-03-16T01:00:00.500Z',
                content: 'queued follow-up',
                imageCount: 1,
                mediaTypes: ['image/png'],
              },
            ],
          },
          memoryInjections: [
            {
              layer: 'layer1',
              source: 'retrieved_memories',
              formattedText:
                '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
            },
          ],
          tokens: { input: 10, output: 20 },
          cost: 0.42,
          durationMs: 900,
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request(`/api/sessions/${session.data.id}/requests`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessionId).toBe(session.data.id)
    expect(Array.isArray(data.requests)).toBe(true)
    expect(data.requests[0].id).toBe('req_session_route_001')
    expect(data.requests[0].durationMs).toBe(900)
    expect(data.requests[0].toolCalls).toEqual([
      { id: 'call_route_1', name: 'read', input: { path: '/tmp/demo.txt' } },
    ])
    expect(data.requests[0].toolResults).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'call_route_1',
        content: 'demo file contents',
        outputSummary: 'demo file contents',
      },
    ])
    expect(data.requests[0].queuedInjection).toEqual({
      count: 1,
      formattedText: '<queued_message>queued follow-up</queued_message>',
      messages: [
        {
          timestamp: '2026-03-16T01:00:00.500Z',
          content: 'queued follow-up',
          imageCount: 1,
          mediaTypes: ['image/png'],
        },
      ],
    })
    expect(data.requests[0].memoryInjections).toEqual([
      {
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText:
          '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
      },
    ])
  })

  test('GET /api/sessions/:id/decisions returns trace-projected decisions', async () => {
    const session = zero.sessionManager.create('web')

    const compressionSpan = zero.tracer.startSpan(
      session.data.id,
      'snapshot:context_compression',
      undefined,
      {
        kind: 'snapshot',
        data: {
          snapshot: {
            id: 'snap_route_decision_001',
            trigger: 'context_compression',
            systemPrompt: 'trace system prompt',
            decisionContext: {
              currentTokens: 14000,
              conversationBudget: 12000,
            },
            messagesBefore: 20,
            messagesAfter: 10,
            compressedRange: '4-14',
          },
        },
      },
    )
    zero.tracer.endSpan(compressionSpan.id, 'success')

    const retrievalSpan = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      metadata: {
        purpose: 'memory_retrieval_decision',
        layer: 'layer2',
      },
      data: {
        memoryRetrievalDecision: {
          need: true,
          queries: ['deployment rollback runbook'],
          searches: [
            {
              query: 'deployment rollback runbook',
              resultCount: 2,
              results: [{ title: 'Deploy rollback runbook' }],
            },
          ],
          selectedMemoryIds: ['mem_1'],
          selectedMemories: [
            {
              id: 'mem_1',
              type: 'runbook',
              title: 'Deploy rollback runbook',
              score: 0.92,
            },
          ],
          usedFallbackSelection: false,
          tokens: { input: 14, output: 9 },
          cost: 0.0042,
          response:
            'Need the rollback memory for grounding.\n{"result":[{"id":"mem_1","reason":"matches rollback request"}]}',
        },
        request: {
          ts: '2026-03-08T00:00:02.500Z',
        },
      },
    })
    zero.tracer.endSpan(retrievalSpan.id, 'success')

    const toolSpan = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_route_decision_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: 'openai-codex/gpt-5.4-medium',
          provider: 'openai-codex',
          userPrompt: 'Investigate the issue',
          response: 'Using tools now',
          stopReason: 'tool_use',
          toolUseCount: 2,
          toolNames: ['read', 'bash'],
          reasoningContent: 'Need the file contents before running a command.',
          toolCalls: [],
          toolResults: [],
          tokens: { input: 12, output: 18 },
          cost: 0.14,
        },
      },
    })
    zero.tracer.endSpan(toolSpan.id, 'success')

    const closureSpan = zero.tracer.startSpan(session.data.id, 'task_closure_decision', undefined, {
      kind: 'closure_decision',
      data: {
        closure: {
          event: 'task_closure_decision',
          action: 'continue',
          reason: 'Need one more validation step.',
          classifierRequest: {
            system: 'strict classifier',
            prompt: '<instruction>prompt</instruction>',
            maxTokens: 200,
          },
        },
      },
    })
    zero.tracer.endSpan(closureSpan.id, 'success')

    const res = await app.request(`/api/sessions/${session.data.id}/decisions`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessionId).toBe(session.data.id)
    expect(Array.isArray(data.decisions)).toBe(true)
    expect(data.decisions).toHaveLength(4)
    expect(data.decisions.map((entry: { decisionType: string }) => entry.decisionType)).toEqual(
      expect.arrayContaining([
        'context_compression',
        'memory_retrieval',
        'tool_selection',
        'task_closure',
      ]),
    )
    const compressionDecision = data.decisions.find(
      (entry: { decisionType: string }) => entry.decisionType === 'context_compression',
    )
    const memoryDecision = data.decisions.find(
      (entry: { decisionType: string }) => entry.decisionType === 'memory_retrieval',
    )
    const toolDecision = data.decisions.find(
      (entry: { decisionType: string }) => entry.decisionType === 'tool_selection',
    )
    const closureDecision = data.decisions.find(
      (entry: { decisionType: string }) => entry.decisionType === 'task_closure',
    )

    expect(compressionDecision).toMatchObject({
      decisionType: 'context_compression',
      context: {
        currentTokens: 14000,
        conversationBudget: 12000,
      },
    })
    expect(memoryDecision).toMatchObject({
      decisionType: 'memory_retrieval',
      outcome: 'injected',
      rationale: expect.stringContaining('Need the rollback memory for grounding.'),
      detail: {
        need: true,
        queries: ['deployment rollback runbook'],
        searchResultCount: 2,
        selectedMemoryIds: ['mem_1'],
        selectedMemories: [
          {
            id: 'mem_1',
            type: 'runbook',
            title: 'Deploy rollback runbook',
            score: 0.92,
          },
        ],
        usedFallbackSelection: false,
        layer: 'layer2',
        tokens: {
          input: 14,
          output: 9,
        },
        cost: 0.0042,
        searches: [
          {
            query: 'deployment rollback runbook',
            resultCount: 2,
            topResultTitle: 'Deploy rollback runbook',
          },
        ],
      },
    })
    expect(toolDecision).toMatchObject({
      decisionType: 'tool_selection',
      outcome: 'read, bash',
      rationale: 'Need the file contents before running a command.',
    })
    expect(closureDecision).toMatchObject({
      decisionType: 'task_closure',
      outcome: 'continue',
      rationale: 'Need one more validation step.',
    })
  })

  test('POST /api/sessions/:id/llm-judge returns parsed judge result and prompt signals', async () => {
    const session = zero.sessionManager.create('web')

    const requestOne = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_judge_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: session.data.currentModel,
          provider: 'openai-codex',
          userPrompt: 'Remember my deployment preference and fix the service issue.',
          response: 'I will search memory and inspect the service.',
          stopReason: 'tool_use',
          toolUseCount: 2,
          toolCalls: [
            {
              id: 'call_mem_1',
              name: 'memory_search',
              input: { query: 'deployment preference service issue' },
            },
            {
              id: 'call_bash_1',
              name: 'bash',
              input: { command: 'systemctl status api-service' },
            },
          ],
          toolResults: [
            {
              type: 'tool_result',
              toolUseId: 'call_mem_1',
              content: 'Found preference memory',
              outputSummary: 'Found preference memory',
            },
            {
              type: 'tool_result',
              toolUseId: 'call_bash_1',
              content: 'service failed',
              isError: true,
              outputSummary: 'service failed',
            },
          ],
          tokens: { input: 120, output: 80 },
          cost: 0.12,
          durationMs: 1100,
        },
      },
    })
    zero.tracer.endSpan(requestOne.id, 'success')

    const requestTwo = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_judge_002',
          turnIndex: 2,
          sessionId: session.data.id,
          model: session.data.currentModel,
          provider: 'openai-codex',
          userPrompt: 'Continue and validate the same service status.',
          response: 'Re-checking service and summarizing findings.',
          stopReason: 'end_turn',
          toolUseCount: 1,
          toolCalls: [
            {
              id: 'call_bash_2',
              name: 'bash',
              input: { command: 'systemctl status api-service' },
            },
          ],
          toolResults: [
            {
              type: 'tool_result',
              toolUseId: 'call_bash_2',
              content: 'service still failed',
              isError: true,
              outputSummary: 'service still failed',
            },
          ],
          tokens: { input: 100, output: 70 },
          cost: 0.15,
          durationMs: 900,
        },
      },
    })
    zero.tracer.endSpan(requestTwo.id, 'success')

    const closure = zero.tracer.startSpan(session.data.id, 'task_closure_decision', undefined, {
      kind: 'closure_decision',
      data: {
        closure: {
          event: 'task_closure_decision',
          action: 'block',
          reason: 'missing production access',
          classifierRequest: {
            system: 'strict classifier',
            prompt: '<instruction>prompt</instruction>',
            maxTokens: 200,
          },
        },
      },
    })
    zero.tracer.endSpan(closure.id, 'success')

    const resolved = zero.modelRouter.resolveModel(session.data.currentModel)
    expect(resolved).toBeDefined()
    if (!resolved) {
      throw new Error('Expected resolved model for llm judge test')
    }

    let capturedPrompt = ''
    const originalComplete = resolved.adapter.complete
    ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete = async (
      request,
    ) => {
      expect(request.model).toBeUndefined()
      const firstBlock = request.messages[0]?.content[0]
      capturedPrompt = firstBlock && firstBlock.type === 'text' ? firstBlock.text : ''
      return {
        id: 'judge_resp_001',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              overallScore: 82,
              verdict: 'mixed',
              confidence: 'high',
              summary: 'Memory usage was appropriate, but duplicate bash checks added cost.',
              dimensions: [
                {
                  key: 'task_completion',
                  label: 'Task Completion',
                  score: 4,
                  maxScore: 5,
                  rationale: 'The session ended in a justified block.',
                },
                {
                  key: 'context_management',
                  label: 'Context Management',
                  score: 4,
                  maxScore: 5,
                  rationale: 'The agent kept the issue and blocker consistent.',
                },
                {
                  key: 'memory_usage',
                  label: 'Memory Usage',
                  score: 5,
                  maxScore: 5,
                  rationale: 'The agent searched memory before continuing.',
                },
                {
                  key: 'evidence_grounding',
                  label: 'Evidence Grounding',
                  score: 4,
                  maxScore: 5,
                  rationale: 'The conclusion followed the tool results.',
                },
                {
                  key: 'tool_efficiency',
                  label: 'Tool Efficiency',
                  score: 2,
                  maxScore: 5,
                  rationale: 'The same bash command was repeated without new input.',
                },
                {
                  key: 'cost_efficiency',
                  label: 'Cost Efficiency',
                  score: 3,
                  maxScore: 5,
                  rationale: 'The duplicate check increased cost slightly.',
                },
                {
                  key: 'human_intervention',
                  label: 'Human Intervention Judgment',
                  score: 4,
                  maxScore: 5,
                  rationale: 'The agent blocked only after a real access dependency appeared.',
                },
                {
                  key: 'recovery_honesty',
                  label: 'Recovery & Honesty',
                  score: 5,
                  maxScore: 5,
                  rationale: 'The agent honestly reported the blocker.',
                },
              ],
              findings: [
                {
                  severity: 'warn',
                  title: 'Duplicate bash call',
                  evidence: 'systemctl status api-service was executed twice with the same input.',
                },
              ],
            }),
          },
        ],
        stopReason: 'end_turn',
        usage: { input: 10, output: 20 },
        model: session.data.currentModel,
      }
    }

    try {
      const res = await app.request(`/api/sessions/${session.data.id}/llm-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.result.overallScore).toBe(82)
      expect(data.result.verdict).toBe('mixed')
      expect(data.result.signals.memorySearchCount).toBe(1)
      expect(data.result.signals.duplicateToolCallCount).toBe(1)
      expect(
        data.result.dimensions.some(
          (dimension: { key: string }) => dimension.key === 'human_intervention',
        ),
      ).toBe(true)
      expect(capturedPrompt).toContain('memory_search')
      expect(capturedPrompt).toContain('duplicateCalls')
      expect(capturedPrompt).toContain('totalCost')
      expect(capturedPrompt).toContain('interventionSignals')
      expect(capturedPrompt).toContain('blockDecisionCount')

      const judgeFile = join(
        testDataDir,
        'logs',
        getSessionLogRelativeDir(session.data.id),
        'llm-judge.jsonl',
      )
      expect(existsSync(judgeFile)).toBe(true)
      const persisted = readFileSync(judgeFile, 'utf-8')
      expect(persisted).toContain('You are a strict evaluator for agent execution traces.')
      expect(persisted).toContain('Evaluate this ZeRo OS session package.')
      expect(persisted).toContain('judge_resp_001')
      expect(persisted).toContain(
        'Memory usage was appropriate, but duplicate bash checks added cost.',
      )

      const historyRes = await app.request(`/api/sessions/${session.data.id}/llm-judge`)
      expect(historyRes.status).toBe(200)
      const historyData = await historyRes.json()
      expect(historyData.history).toHaveLength(1)
      expect(historyData.history[0].run.result.overallScore).toBe(82)
      expect(historyData.history[0].artifacts.primary.request.systemPrompt).toContain(
        'strict evaluator',
      )
      expect(historyData.history[0].artifacts.primary.request.userPrompt).toContain(
        'Evaluate this ZeRo OS session package.',
      )
      expect(historyData.history[0].artifacts.primary.response.rawText).toContain(
        'duplicate bash checks added cost',
      )
      expect(zero.metrics.evaluationsBySession(session.data.id)).toEqual([
        expect.objectContaining({
          sessionId: session.data.id,
          model: data.model,
          verdict: data.result.verdict,
        }),
      ])
    } finally {
      ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete =
        originalComplete
    }
  })

  test('POST /api/sessions/:id/llm-judge repairs truncated JSON output', async () => {
    const session = zero.sessionManager.create('web')

    const request = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_judge_truncated_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: session.data.currentModel,
          provider: 'openai-codex',
          userPrompt: 'Check whether the deploy finished.',
          response: 'I checked the logs and found a blocker.',
          stopReason: 'end_turn',
          toolUseCount: 1,
          toolCalls: [
            {
              id: 'call_bash_truncated_1',
              name: 'bash',
              input: { command: 'tail -n 50 deploy.log' },
            },
          ],
          toolResults: [
            {
              type: 'tool_result',
              toolUseId: 'call_bash_truncated_1',
              content: 'deploy failed',
              isError: true,
              outputSummary: 'deploy failed',
            },
          ],
          tokens: { input: 50, output: 30 },
          cost: 0.05,
          durationMs: 600,
        },
      },
    })
    zero.tracer.endSpan(request.id, 'success')

    const resolved = zero.modelRouter.resolveModel(session.data.currentModel)
    expect(resolved).toBeDefined()
    if (!resolved) {
      throw new Error('Expected resolved model for llm judge truncation test')
    }

    const originalComplete = resolved.adapter.complete
    ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete = async () => ({
      id: 'judge_resp_truncated_001',
      content: [
        {
          type: 'text',
          text: `{
  "overallScore": 74,
  "verdict": "mixed",
  "confidence": "medium",
  "summary": "The agent found the blocker but repeated a check.",
  "dimensions": [
    {
      "key": "task_completion",
      "label": "Task Completion",
      "score": 4,
      "maxScore": 5,
      "rationale": "The agent identified a real blocker."
    }
  ],
  "findings": [
    {
      "severity": "warn",
      "title": "Repeated bash usage",
      "evidence": "The same log check was repeated without new evidence."
    }
  `,
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 10, output: 20 },
      model: session.data.currentModel,
    })

    try {
      const res = await app.request(`/api/sessions/${session.data.id}/llm-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.result.overallScore).toBe(74)
      expect(data.result.findings).toEqual([
        {
          severity: 'warn',
          title: 'Repeated bash usage',
          evidence: 'The same log check was repeated without new evidence.',
        },
      ])
    } finally {
      ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete =
        originalComplete
    }
  })

  test('POST /api/sessions/:id/llm-judge normalizes 0-5 overall scores and missing maxScore', async () => {
    const session = zero.sessionManager.create('web')

    const resolved = zero.modelRouter.resolveModel(session.data.currentModel)
    expect(resolved).toBeDefined()
    if (!resolved) {
      throw new Error('Expected resolved model for llm judge normalization test')
    }

    const originalComplete = resolved.adapter.complete
    ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete = async () => ({
      id: 'judge_resp_normalized_001',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            overallScore: 3,
            verdict: 'mixed',
            confidence: 'medium',
            summary: 'Needs a normalized overall score.',
            dimensions: [
              {
                key: 'task_completion',
                label: 'Task Completion',
                score: 3,
                rationale: 'Done with some gaps.',
              },
            ],
            findings: [],
          }),
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 8, output: 12 },
      model: session.data.currentModel,
    })

    try {
      const res = await app.request(`/api/sessions/${session.data.id}/llm-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.result.overallScore).toBe(60)
      expect(data.result.dimensions[0].maxScore).toBe(5)
      expect(
        data.result.dimensions.some(
          (dimension: { key: string }) => dimension.key === 'human_intervention',
        ),
      ).toBe(true)
    } finally {
      ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete =
        originalComplete
    }
  })

  test('POST /api/sessions/:id/llm-judge repairs extra closing braces in JSON output', async () => {
    const session = zero.sessionManager.create('web')

    const resolved = zero.modelRouter.resolveModel(session.data.currentModel)
    expect(resolved).toBeDefined()
    if (!resolved) {
      throw new Error('Expected resolved model for llm judge extra brace test')
    }

    const originalComplete = resolved.adapter.complete
    ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete = async () => ({
      id: 'judge_resp_extra_brace_001',
      content: [
        {
          type: 'text',
          text: '{"overallScore":3,"verdict":"mixed","confidence":"medium","summary":"ok","dimensions":[{"key":"task_completion","label":"Task Completion","score":3,"maxScore":5,"rationale":"ok"}],"findings":[]}}',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 8, output: 12 },
      model: session.data.currentModel,
    })

    try {
      const res = await app.request(`/api/sessions/${session.data.id}/llm-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.result.overallScore).toBe(60)
      expect(data.result.summary).toBe('ok')
    } finally {
      ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete =
        originalComplete
    }
  })

  test('POST /api/sessions/:id/llm-judge repairs malformed JSON with a retry pass', async () => {
    const session = zero.sessionManager.create('web')

    const resolved = zero.modelRouter.resolveModel(session.data.currentModel)
    expect(resolved).toBeDefined()
    if (!resolved) {
      throw new Error('Expected resolved model for llm judge repair retry test')
    }

    let callCount = 0
    const originalComplete = resolved.adapter.complete
    ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete = async (
      request,
    ) => {
      callCount++
      if (callCount === 1) {
        return {
          id: 'judge_resp_retry_raw_001',
          content: [
            {
              type: 'text',
              text: '{"overallScore" 3, "verdict": "mixed", "confidence": "medium"}',
            },
          ],
          stopReason: 'end_turn',
          usage: { input: 8, output: 12 },
          model: session.data.currentModel,
        }
      }

      const firstBlock = request.messages[0]?.content[0]
      const repairPrompt = firstBlock && firstBlock.type === 'text' ? firstBlock.text : ''
      expect(repairPrompt).toContain('Parse error:')
      expect(repairPrompt).toContain('overallScore')

      return {
        id: 'judge_resp_retry_fixed_001',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              overallScore: 3,
              verdict: 'mixed',
              confidence: 'medium',
              summary: 'Recovered by repair pass.',
              dimensions: [
                {
                  key: 'task_completion',
                  label: 'Task Completion',
                  score: 3,
                  maxScore: 5,
                  rationale: 'Recovered output.',
                },
                {
                  key: 'human_intervention',
                  label: 'Human Intervention Judgment',
                  score: 4,
                  maxScore: 5,
                  rationale: 'The stop point was appropriate.',
                },
              ],
              findings: [],
            }),
          },
        ],
        stopReason: 'end_turn',
        usage: { input: 8, output: 12 },
        model: session.data.currentModel,
      }
    }

    try {
      const res = await app.request(`/api/sessions/${session.data.id}/llm-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(callCount).toBe(2)
      expect(data.result.overallScore).toBe(60)
      expect(data.result.summary).toBe('Recovered by repair pass.')
      expect(
        data.result.dimensions.some(
          (dimension: { key: string }) => dimension.key === 'human_intervention',
        ),
      ).toBe(true)

      const historyRes = await app.request(`/api/sessions/${session.data.id}/llm-judge`)
      expect(historyRes.status).toBe(200)
      const historyData = await historyRes.json()
      expect(historyData.history).toHaveLength(1)
      expect(historyData.history[0].artifacts.primary.response.completion.id).toBe(
        'judge_resp_retry_raw_001',
      )
      expect(historyData.history[0].artifacts.repair.request.userPrompt).toContain('Parse error:')
      expect(historyData.history[0].artifacts.repair.response.completion.id).toBe(
        'judge_resp_retry_fixed_001',
      )
      expect(historyData.history[0].artifacts.repair.response.rawText).toContain(
        'Recovered by repair pass.',
      )
      expect(zero.metrics.evaluationsBySession(session.data.id)).toEqual([
        expect.objectContaining({
          sessionId: session.data.id,
          summary: 'Recovered by repair pass.',
          verdict: 'mixed',
        }),
      ])
    } finally {
      ;(resolved.adapter as { complete: typeof resolved.adapter.complete }).complete =
        originalComplete
    }
  })

  test('GET /api/sessions/:id/llm-judge returns saved history for log-only sessions', async () => {
    const sessionId = 'oc_history_only_session'
    zero.observability.appendSessionJudge(sessionId, {
      version: 1,
      savedAt: '2026-03-16T09:00:00.000Z',
      sessionId,
      run: {
        sessionId,
        model: 'openai/gpt-test',
        generatedAt: '2026-03-16T09:00:00.000Z',
        result: {
          overallScore: 91,
          verdict: 'strong',
          confidence: 'high',
          summary: 'persisted history',
          dimensions: [],
          findings: [],
          signals: {
            totalCost: 0.01,
            requestCount: 1,
            toolCallCount: 0,
            duplicateToolCallCount: 0,
            memorySearchCount: 0,
            memoryReadCount: 0,
            memoryWriteCount: 0,
            closureCount: 1,
          },
        },
      },
      artifacts: {
        primary: {
          request: {
            systemPrompt: 'judge system',
            userPrompt: 'judge user',
            stream: false,
          },
          response: {
            completion: {
              id: 'judge_history_001',
              content: [{ type: 'text', text: '{"ok":true}' }],
              stopReason: 'end_turn',
              usage: { input: 1, output: 1 },
              model: 'gpt-test',
            },
            rawText: '{"ok":true}',
          },
        },
      },
    })

    const res = await app.request(`/api/sessions/${sessionId}/llm-judge`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.history).toHaveLength(1)
    expect(data.history[0].run.result.overallScore).toBe(91)
    expect(data.history[0].artifacts.primary.request.userPrompt).toBe('judge user')
  })

  test('GET /api/logs?type=requests reads merged request sources', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_logs_route_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: 'openai-codex/gpt-5.4-medium',
          provider: 'openai-codex',
          userPrompt: 'request visible in logs',
          response: 'response visible in logs',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: { input: 5, output: 6 },
          cost: 0.2,
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request('/api/logs?type=requests&limit=20')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.entries.some((entry: { id: string }) => entry.id === 'req_logs_route_001')).toBe(
      true,
    )
  })

  test('GET /api/logs?type=requests includes trace-only session requests', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'llm_request', undefined, {
      kind: 'llm_request',
      data: {
        request: {
          id: 'req_logs_trace_001',
          turnIndex: 1,
          sessionId: session.data.id,
          model: 'openai-codex/gpt-5.4-medium',
          provider: 'openai-codex',
          userPrompt: 'trace log prompt',
          response: 'trace log response',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: { input: 3, output: 4 },
          cost: 0.12,
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request('/api/logs?type=requests&limit=20')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.entries.some((entry: { id: string }) => entry.id === 'req_logs_trace_001')).toBe(
      true,
    )
  })

  test('GET /api/logs?type=snapshots includes trace-only session snapshots', async () => {
    const session = zero.sessionManager.create('web')
    const span = zero.tracer.startSpan(session.data.id, 'snapshot:session_start', undefined, {
      kind: 'snapshot',
      data: {
        snapshot: {
          id: 'snap_logs_trace_001',
          trigger: 'session_start',
          model: 'openai-codex/gpt-5.4-medium',
          systemPrompt: 'trace snapshot prompt',
          tools: ['read', 'bash'],
        },
      },
    })
    zero.tracer.endSpan(span.id, 'success')

    const res = await app.request('/api/logs?type=snapshots&limit=20')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.entries.some((entry: { id: string }) => entry.id === 'snap_logs_trace_001')).toBe(
      true,
    )
  })

  test('GET /api/logs?type=trace scans persisted trace files and flattens child spans', async () => {
    const sessionId = 'sess_20260316_2325_trace_api_abcd'
    const root = zero.tracer.startSpan(sessionId, 'turn:trace-api', undefined, {
      kind: 'turn',
    })
    const child = zero.tracer.startSpan(sessionId, 'tool:bash', root.id, {
      kind: 'tool_call',
    })
    zero.tracer.endSpan(child.id, 'success')
    zero.tracer.endSpan(root.id, 'success')

    const res = await app.request('/api/logs?type=trace&limit=20')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(
      data.entries.some(
        (entry: { spanId: string; sessionId: string; name: string; kind: string }) =>
          entry.spanId === root.id &&
          entry.sessionId === sessionId &&
          entry.name === 'turn:trace-api' &&
          entry.kind === 'turn',
      ),
    ).toBe(true)
    expect(
      data.entries.some(
        (entry: { spanId: string; sessionId: string; name: string; kind: string }) =>
          entry.spanId === child.id &&
          entry.sessionId === sessionId &&
          entry.name === 'tool:bash' &&
          entry.kind === 'tool_call',
      ),
    ).toBe(true)
  })

  test('GET /api/logs?type=trace includes persisted running spans', async () => {
    const sessionId = 'sess_20260316_2326_trace_api_run'
    const span = zero.tracer.startSpan(sessionId, 'turn:running-trace-api', undefined, {
      kind: 'turn',
    })

    const res = await app.request('/api/logs?type=trace&limit=20')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(
      data.entries.some(
        (entry: { spanId: string; sessionId: string; status: string }) =>
          entry.spanId === span.id && entry.sessionId === sessionId && entry.status === 'running',
      ),
    ).toBe(true)
  })

  test('GET /api/logs/sessions exposes session run.log summaries and entries', async () => {
    const sessionId = 'sess_20260316_2327_run_log_api'
    zero.tracer.logSession(sessionId, 'debug', 'llm_request.raw_request', {
      request: { model: 'fake-model', messages: [{ role: 'user', content: 'hello' }] },
    })
    zero.tracer.logSession(sessionId, 'error', 'tool_call.raw_result', {
      tool: 'read',
      result: { success: false, outputSummary: 'File not found' },
    })

    const listRes = await app.request('/api/logs/sessions?limit=20')
    expect(listRes.status).toBe(200)
    const listData = await listRes.json()
    const summary = listData.sessions.find((entry: { sessionId: string }) => entry.sessionId === sessionId)
    expect(summary).toMatchObject({
      sessionId,
      entryCount: 2,
      rawRequestCount: 1,
      errorCount: 1,
    })

    const detailRes = await app.request(`/api/logs/sessions/${sessionId}/run?level=error&q=File`)
    expect(detailRes.status).toBe(200)
    const detailData = await detailRes.json()
    expect(detailData.total).toBe(2)
    expect(detailData.matched).toBe(1)
    expect(detailData.entries[0].event).toBe('tool_call.raw_result')

    const descRes = await app.request(`/api/logs/sessions/${sessionId}/run?order=desc`)
    expect(descRes.status).toBe(200)
    const descData = await descRes.json()
    expect(descData.order).toBe('desc')
    expect(descData.entries[0].event).toBe('tool_call.raw_result')
    expect(descData.entries[1].event).toBe('llm_request.raw_request')
  })

  test('GET /api/sessions/channel/:channel/current returns current candidates only', async () => {
    const feishu = zero.sessionManager.getOrCreateForChannel(
      'feishu',
      'shared-room',
      'feishu:ops',
    ).session
    feishu.data.updatedAt = '2026-03-08T00:00:02.000Z'

    const telegram = zero.sessionManager.getOrCreateForChannel('telegram', 'shared-room').session
    telegram.data.updatedAt = '2026-03-08T00:00:03.000Z'

    const feishuHr = zero.sessionManager.getOrCreateForChannel(
      'feishu',
      'shared-room',
      'feishu:hr',
    ).session
    feishuHr.data.updatedAt = '2026-03-08T00:00:01.000Z'

    const res = await app.request('/api/sessions/channel/shared-room/current')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(
      data.sessions.map(
        (session: { source: string; channelName?: string }) =>
          `${session.source}:${session.channelName ?? 'none'}`,
      ),
    ).toEqual(['telegram:none', 'feishu:feishu:ops', 'feishu:feishu:hr'])
    expect(data.sessions.every((session: { placement: string }) => session.placement === 'current')).toBe(
      true,
    )
  })

  test('GET /api/sessions/channel/:channel/current returns empty array for missing channel', async () => {
    const res = await app.request('/api/sessions/channel/no-such-channel/current')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions).toEqual([])
  })

  test('GET /api/sessions/sources/current returns current channel sources', async () => {
    const newest = zero.sessionManager.getOrCreateForChannel(
      'weixin',
      'wx_source_room_2',
      'v1ki-bot',
    ).session
    newest.data.updatedAt = '2026-12-31T00:00:03.000Z'

    const older = zero.sessionManager.getOrCreateForChannel(
      'weixin',
      'wx_source_room_1',
      'v1ki-bot-legacy',
    ).session
    older.data.updatedAt = '2026-12-31T00:00:02.000Z'

    const telegram = zero.sessionManager.getOrCreateForChannel('telegram', 'tg_source_room').session
    telegram.data.updatedAt = '2026-12-31T00:00:01.000Z'

    const res = await app.request('/api/sessions/sources/current')
    expect(res.status).toBe(200)
    const data = await res.json()
    const sources = data.sources as Array<{
      source: string
      channelCount: number
      updatedAt: string | null
    }>
    const weixinSource = sources.find((entry) => entry.source === 'weixin')

    expect(sources[0].source).toBe('weixin')
    expect(sources.find((entry) => entry.source === 'telegram')).toBeTruthy()
    expect(weixinSource?.source).toBe('weixin')
    expect(typeof weixinSource?.channelCount).toBe('number')
    expect(weixinSource?.updatedAt).toBe('2026-12-31T00:00:03.000Z')
    expect(weixinSource?.channelCount ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('GET /api/sessions/source/:source/current returns source-scoped current channels', async () => {
    const newest = zero.sessionManager.getOrCreateForChannel('scheduler', 'sched_room_2').session
    newest.data.updatedAt = '2026-03-09T00:00:03.000Z'

    const older = zero.sessionManager.getOrCreateForChannel('scheduler', 'sched_room_1').session
    older.data.updatedAt = '2026-03-09T00:00:02.000Z'

    const otherSource = zero.sessionManager.getOrCreateForChannel('telegram', 'chat_tg_1').session
    otherSource.data.updatedAt = '2026-03-09T00:00:04.000Z'

    const res = await app.request('/api/sessions/source/scheduler/current')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.sessions.map((session: { channelId: string }) => session.channelId)).toEqual([
      'sched_room_2',
      'sched_room_1',
    ])
    expect(
      data.sessions.every((session: { source: string }) => session.source === 'scheduler'),
    ).toBe(true)
    expect(
      data.sessions.every((session: { placement: string }) => session.placement === 'current'),
    ).toBe(true)
  })

  test('GET /api/sessions includes channelName when present', async () => {
    const session = zero.sessionManager.getOrCreateForChannel(
      'feishu',
      'room-with-name',
      'feishu:ops',
    ).session
    const res = await app.request(`/api/sessions?q=${session.data.id}`)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions[0].channelName).toBe('feishu:ops')
  })
})
