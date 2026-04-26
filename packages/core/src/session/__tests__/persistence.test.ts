import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { type ObservabilityStore, SessionDB } from '@zero-os/observe'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { loadConfig } from '../../config/loader'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'
import { createTestProjectRoot } from './test-helpers'

const config = loadConfig(join(process.cwd(), '.zero', 'config.yaml'))
const secrets = new Map<string, string>([['openai_codex_api_key', 'sk-test-placeholder']])
const testProject = createTestProjectRoot('zero-session-persistence-')

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  const createdAt = overrides.createdAt ?? new Date().toISOString()
  return {
    id: overrides.id ?? `sess_${Date.now()}`,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    source: overrides.source ?? 'web',
    currentModel: overrides.currentModel ?? 'gpt-5.3-codex-medium',
    modelHistory: overrides.modelHistory ?? [
      { model: overrides.currentModel ?? 'gpt-5.3-codex-medium', from: createdAt, to: null },
    ],
    tags: overrides.tags ?? [],
    summary: overrides.summary,
    channelName: overrides.channelName,
    channelId: overrides.channelId,
    reasoningEffort: overrides.reasoningEffort,
  }
}

describe('Session Persistence', () => {
  let sessionDb: SessionDB
  let modelRouter: ModelRouter
  let toolRegistry: ToolRegistry

  afterAll(() => {
    sessionDb?.close()
    testProject.cleanup()
  })

  test('setup', () => {
    sessionDb = SessionDB.createInMemory()
    modelRouter = new ModelRouter(config, secrets)
    modelRouter.init()
    toolRegistry = new ToolRegistry()
  })

  test('Session constructor persists to DB when sessionDb provided', () => {
    const session = new Session('web', modelRouter, toolRegistry, {
      sessionDb,
      projectRoot: testProject.projectRoot,
    })
    const row = expectDefined(sessionDb.getSession(session.data.id))
    expect(row.id).toBe(session.data.id)
    expect(row.source).toBe('web')
    expect(row.currentModel).toBe(session.data.currentModel)
  })

  test('ensureChannelContext persists routing metadata', () => {
    const session = new Session('feishu', modelRouter, toolRegistry, {
      sessionDb,
      projectRoot: testProject.projectRoot,
    })

    session.ensureChannelContext('chat_context_1', 'feishu:ops')

    const row = expectDefined(sessionDb.getSession(session.data.id))
    expect(row.channelId).toBe('chat_context_1')
    expect(row.channelName).toBe('feishu:ops')
  })

  test('initAgent persists agent config', () => {
    const session = new Session('web', modelRouter, toolRegistry, {
      sessionDb,
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'test-agent', agentInstruction: 'You are a test.' })

    const row = expectDefined(sessionDb.getSession(session.data.id))
    expect(row.agentConfigJson).toBeDefined()
    const config = JSON.parse(expectDefined(row.agentConfigJson))
    expect(config.name).toBe('test-agent')
    expect(config.agentInstruction).toBe('You are a test.')
    expect(row.systemPrompt).toBeUndefined()
  })

  test('Session.restore creates session with correct data and messages', () => {
    const data = makeSessionData({
      id: 'sess_restore_test',
      source: 'feishu',
      channelName: 'feishu:ops',
      channelId: 'chat_123',
      tags: ['restored'],
    })

    const messages: Message[] = [
      {
        id: 'msg_1',
        sessionId: 'sess_restore_test',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'msg_2',
        sessionId: 'sess_restore_test',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'Hi there!' }],
        createdAt: new Date().toISOString(),
      },
    ]

    const session = Session.restore(data, messages, modelRouter, toolRegistry, {
      projectRoot: testProject.projectRoot,
    })
    expect(session.data.id).toBe('sess_restore_test')
    expect(session.data.source).toBe('feishu')
    expect(session.data.channelName).toBe('feishu:ops')
    expect(session.data.channelId).toBe('chat_123')
    expect(session.data.tags).toEqual(['restored'])
    expect(session.getMessages()).toHaveLength(2)
    expect(session.getMessages()[0].content[0]).toEqual({ type: 'text', text: 'Hello' })
    expect(session.getAgentConfig()).toBeNull()
  })

  test('SessionManager.restoreFromDB restores only current bindings', () => {
    const data1 = makeSessionData({
      id: 'sess_mgr_1',
      source: 'feishu',
      channelName: 'feishu:ops',
      channelId: 'chat_feishu_1',
      participantId: 'ou_alice',
    })
    sessionDb.saveSession(data1, '{"name":"zero-feishu","agentInstruction":"test"}')
    sessionDb.saveMessages('sess_mgr_1', [
      {
        id: 'm1',
        sessionId: 'sess_mgr_1',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'Hi' }],
        createdAt: new Date().toISOString(),
      },
    ])
    sessionDb.saveBinding(
      'feishu',
      'chat_feishu_1',
      'sess_mgr_1',
      'feishu:ops',
      data1.updatedAt,
      'ou_alice',
    )

    const data2 = makeSessionData({
      id: 'sess_mgr_2',
      source: 'web',
      channelName: 'web',
      channelId: 'default',
    })
    sessionDb.saveSession(data2)
    sessionDb.saveBinding('web', 'default', 'sess_mgr_2', 'web', data2.updatedAt)

    sessionDb.saveSession(
      makeSessionData({
        id: 'sess_history_only',
        source: 'telegram',
        channelId: 'tg_history',
      }),
    )

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const count = manager.restoreFromDB()

    expect(count).toBe(2)
    expect(manager.get('sess_mgr_1')).toBeDefined()
    expect(manager.get('sess_mgr_2')).toBeDefined()
    expect(manager.get('sess_history_only')).toBeUndefined()

    expect(expectDefined(manager.get('sess_mgr_1')).getMessages()).toHaveLength(1)

    const feishu = manager.getOrCreateForChannel(
      'feishu',
      'chat_feishu_1',
      'feishu:ops',
      'ou_alice',
    )
    expect(feishu.isNew).toBe(false)
    expect(feishu.session.data.id).toBe('sess_mgr_1')
    expect(feishu.session.data.participantId).toBe('ou_alice')

    const web = manager.getOrCreateForChannel('web', 'default', 'web')
    expect(web.isNew).toBe(false)
    expect(web.session.data.id).toBe('sess_mgr_2')
  })

  test('SessionManager.restoreFromDB skips lifecycle side effects beyond current sync', () => {
    const isolatedDb = SessionDB.createInMemory()
    const syncCalls: Array<{ sessionId: string; isCurrent: boolean }> = []
    const eventCalls: Array<{ event: string; sessionId: string }> = []
    const newerAt = '2026-04-08T08:37:17.836Z'

    isolatedDb.saveSession(
      makeSessionData({
        id: 'sess_mgr_side_new',
        source: 'feishu',
        channelName: 'nanoclaw',
        channelId: 'chat_side',
        createdAt: newerAt,
        updatedAt: newerAt,
      }),
    )
    isolatedDb.saveBinding('feishu', 'chat_side', 'sess_mgr_side_new', 'nanoclaw', newerAt)

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      {
        sessionDb: isolatedDb,
        projectRoot: testProject.projectRoot,
        observability: {
          readSessionRequests() {
            return []
          },
          readSessionSnapshots() {
            return []
          },
          syncSessionCurrentState(sessionId: string, isCurrent: boolean) {
            syncCalls.push({ sessionId, isCurrent })
          },
        } as unknown as ObservabilityStore,
        bus: {
          emit(event, payload: { sessionId: string }) {
            eventCalls.push({ event, sessionId: payload.sessionId })
          },
        },
      },
      isolatedDb,
    )

    try {
      const restoredCount = manager.restoreFromDB()

      expect(restoredCount).toBe(1)
      expect(syncCalls).toEqual([{ sessionId: 'sess_mgr_side_new', isCurrent: true }])
      expect(eventCalls).toEqual([])
      expect(manager.get('sess_mgr_side_new')).toBeDefined()
    } finally {
      isolatedDb.close()
    }
  })

  test('SessionManager.restoreFromDB migrates older agent config payloads', () => {
    const data = makeSessionData({
      id: 'sess_mgr_older',
      channelId: 'default',
      channelName: 'web',
    })

    sessionDb.saveSession(
      data,
      '{"name":"older-agent","systemPrompt":"older prompt"}',
      '<role>older rendered prompt</role>',
    )
    sessionDb.saveBinding('web', 'default', 'sess_mgr_older', 'web', data.updatedAt)

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    manager.restoreFromDB()

    const session = manager.get('sess_mgr_older')
    expect(expectDefined(session).getAgentConfig()).toEqual({
      name: 'older-agent',
      agentInstruction: 'older prompt',
    })
  })

  test('SessionManager.restoreFromDB preserves rendered systemPrompt after initAgent', () => {
    const createdAt = new Date().toISOString()
    const data = makeSessionData({
      id: 'sess_mgr_restore_prompt',
      createdAt,
      updatedAt: createdAt,
      channelId: 'default',
      channelName: 'web',
    })
    const renderedSystemPrompt = '<role>restored rendered prompt</role>'

    sessionDb.saveSession(
      data,
      '{"name":"restored-agent","agentInstruction":"restored prompt"}',
      renderedSystemPrompt,
    )
    sessionDb.saveBinding('web', 'default', data.id, 'web', data.updatedAt)

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    manager.restoreFromDB()

    const session = expectDefined(manager.get(data.id))
    expect(session.getAgentConfig()).toEqual({
      name: 'restored-agent',
      agentInstruction: 'restored prompt',
    })
    expect(session.getSystemPrompt()).toBe(renderedSystemPrompt)
    expect(expectDefined(sessionDb.getSession(data.id)).systemPrompt).toBe(renderedSystemPrompt)
  })

  test('SessionManager.flushAll saves all sessions to DB', () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )

    const s1 = manager.create('web')
    const s2 = manager.create('telegram')
    s2.ensureChannelContext('tg_flush', 'telegram')

    manager.flushAll()

    const row1 = sessionDb.getSession(s1.data.id)
    const row2 = sessionDb.getSession(s2.data.id)
    expect(row1).not.toBeNull()
    expect(row2).not.toBeNull()
    expect(expectDefined(row2).channelId).toBe('tg_flush')
  })

  test('SessionManager.flushAll preserves rendered systemPrompt after restoreFromDB', () => {
    const createdAt = new Date().toISOString()
    const data = makeSessionData({
      id: 'sess_mgr_flush_prompt',
      createdAt,
      updatedAt: createdAt,
      channelId: 'default',
      channelName: 'web',
    })
    const renderedSystemPrompt = '<role>flush rendered prompt</role>'

    sessionDb.saveSession(
      data,
      '{"name":"flush-agent","agentInstruction":"flush prompt"}',
      renderedSystemPrompt,
    )
    sessionDb.saveBinding('web', 'default', data.id, 'web', data.updatedAt)

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    manager.restoreFromDB()
    manager.flushAll()

    expect(expectDefined(sessionDb.getSession(data.id)).systemPrompt).toBe(renderedSystemPrompt)
  })

  test('SessionManager.drainAndCollectInterrupted returns empty after current turns drain cleanly', async () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const session = manager.getOrCreateForChannel('feishu', 'chat_drain_ok', 'feishu').session
    const internal = session as unknown as {
      mutex: { acquire(ownerId: string): Promise<void>; release(ownerId: string): void }
    }

    await internal.mutex.acquire('drain-ok')
    setTimeout(() => internal.mutex.release('drain-ok'), 10)

    await expect(manager.drainAndCollectInterrupted(100)).resolves.toEqual([])
  })

  test('SessionManager.drainAndCollectInterrupted returns only still-interrupted current sessions', async () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const session = manager.getOrCreateForChannel(
      'telegram',
      'chat_drain_timeout',
      'telegram',
    ).session
    const internal = session as unknown as {
      mutex: { acquire(ownerId: string): Promise<void>; release(ownerId: string): void }
    }

    await internal.mutex.acquire('drain-timeout')

    const interrupted = await manager.drainAndCollectInterrupted(20)
    expect(interrupted).toEqual([
      {
        sessionId: session.data.id,
        source: 'telegram',
        channelId: 'chat_drain_timeout',
        channelName: 'telegram',
      },
    ])

    internal.mutex.release('drain-timeout')
  })

  test('SessionManager DB query proxies work', () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )

    const row = manager.getFromDB('sess_roundtrip')
    expect(row === null || row?.id === 'sess_roundtrip').toBe(true)

    const all = manager.listAllFromDB()
    expect(all.length).toBeGreaterThan(0)

    const limited = manager.listAllFromDB({ limit: 1 })
    expect(limited.length).toBe(1)
  })
})
