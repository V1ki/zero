import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ModelRouter } from '@zero-os/model'
import { SessionDB } from '@zero-os/observe'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { loadConfig } from '../../config/loader'
import { ToolRegistry } from '../../tool/registry'
import { createTestProjectRoot } from './test-helpers'
import { SessionManager } from '../manager'
import { Session } from '../session'

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
    expect(row.status).toBe('active')
  })

  test('setStatus persists status change', () => {
    const session = new Session('web', modelRouter, toolRegistry, {
      sessionDb,
      projectRoot: testProject.projectRoot,
    })
    session.setStatus('completed')

    const row = expectDefined(sessionDb.getSession(session.data.id))
    expect(row.status).toBe('completed')
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
    const data: SessionData = {
      id: 'sess_restore_test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'feishu',
      status: 'active',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: new Date().toISOString(), to: null }],
      tags: ['restored'],
      channelName: 'feishu:ops',
      channelId: 'chat_123',
    }

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
    expect(session.getStatus()).toBe('active')
    expect(session.getMessages()).toHaveLength(2)
    expect(session.getMessages()[0].content[0]).toEqual({ type: 'text', text: 'Hello' })
    expect(session.getAgentConfig()).toBeNull()
  })

  test('SessionManager.restoreFromDB restores sessions and channel mappings', () => {
    const data1: SessionData = {
      id: 'sess_mgr_1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'feishu',
      status: 'active',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: new Date().toISOString(), to: null }],
      tags: [],
      channelName: 'feishu:ops',
      channelId: 'chat_feishu_1',
    }
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

    const data2: SessionData = {
      id: 'sess_mgr_2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'web',
      status: 'idle',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: new Date().toISOString(), to: null }],
      tags: [],
    }
    sessionDb.saveSession(data2)

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const count = manager.restoreFromDB()

    expect(count).toBeGreaterThanOrEqual(2)
    expect(manager.get('sess_mgr_1')).toBeDefined()
    expect(manager.get('sess_mgr_2')).toBeDefined()

    expect(expectDefined(manager.get('sess_mgr_1')).getMessages()).toHaveLength(1)

    const { session, isNew } = manager.getOrCreateForChannel(
      'feishu',
      'chat_feishu_1',
      'feishu:ops',
    )
    expect(isNew).toBe(false)
    expect(session.data.id).toBe('sess_mgr_1')
  })

  test('SessionManager.restoreFromDB migrates older agent config payloads', () => {
    const data: SessionData = {
      id: 'sess_mgr_older',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'web',
      status: 'active',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: new Date().toISOString(), to: null }],
      tags: [],
    }

    sessionDb.saveSession(
      data,
      '{"name":"older-agent","systemPrompt":"older prompt"}',
      '<role>older rendered prompt</role>',
    )

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
    const data: SessionData = {
      id: 'sess_mgr_restore_prompt',
      createdAt,
      updatedAt: createdAt,
      source: 'web',
      status: 'active',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: createdAt, to: null }],
      tags: [],
    }
    const renderedSystemPrompt = '<role>restored rendered prompt</role>'

    sessionDb.saveSession(
      data,
      '{"name":"restored-agent","agentInstruction":"restored prompt"}',
      renderedSystemPrompt,
    )

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
    s2.data.channelId = 'tg_flush'

    manager.flushAll()

    const row1 = sessionDb.getSession(s1.data.id)
    const row2 = sessionDb.getSession(s2.data.id)
    expect(row1).not.toBeNull()
    expect(row2).not.toBeNull()
    expect(expectDefined(row2).channelId).toBe('tg_flush')
  })

  test('SessionManager.flushAll preserves rendered systemPrompt after restoreFromDB', () => {
    const createdAt = new Date().toISOString()
    const data: SessionData = {
      id: 'sess_mgr_flush_prompt',
      createdAt,
      updatedAt: createdAt,
      source: 'web',
      status: 'active',
      currentModel: 'gpt-5.3-codex-medium',
      modelHistory: [{ model: 'gpt-5.3-codex-medium', from: createdAt, to: null }],
      tags: [],
    }
    const renderedSystemPrompt = '<role>flush rendered prompt</role>'

    sessionDb.saveSession(
      data,
      '{"name":"flush-agent","agentInstruction":"flush prompt"}',
      renderedSystemPrompt,
    )

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

  test('SessionManager.drainAndCollectInterrupted returns empty after active turns drain cleanly', async () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const session = manager.create('feishu', {
      channelId: 'chat_drain_ok',
      channelName: 'feishu',
    })
    const internal = session as unknown as {
      mutex: { acquire(ownerId: string): Promise<void>; release(ownerId: string): void }
    }

    await internal.mutex.acquire('drain-ok')
    setTimeout(() => internal.mutex.release('drain-ok'), 10)

    await expect(manager.drainAndCollectInterrupted(100)).resolves.toEqual([])
  })

  test('SessionManager.drainAndCollectInterrupted returns only still-interrupted sessions', async () => {
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, projectRoot: testProject.projectRoot },
      sessionDb,
    )
    const session = manager.create('telegram', {
      channelId: 'chat_drain_timeout',
      channelName: 'telegram',
    })
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

    const completed = manager.listAllFromDB({ status: 'completed' })
    expect(completed.every((r) => r.status === 'completed')).toBe(true)
  })
})
