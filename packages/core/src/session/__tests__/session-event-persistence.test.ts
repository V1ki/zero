import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelRouter } from '@zero-os/model'
import { SessionDB, SessionEventStore } from '@zero-os/observe'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'
import { persistSessionState } from '../session-persistence'
import { createTestModelRouter, createTestProjectRoot } from './test-helpers'

const testProject = createTestProjectRoot('zero-session-event-persistence-')

const MESSAGE_CACHE = new Map<string, Message>()

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  const key = `${role}:${text}`
  const cached = MESSAGE_CACHE.get(key)
  if (cached) return cached
  const message = {
    id: `msg_${text}`,
    sessionId: 'sess_event_1',
    role,
    content: [{ type: 'text', text }],
    createdAt: '2026-11-09T00:00:00.000Z',
    messageType: 'message',
  } as unknown as Message
  MESSAGE_CACHE.set(key, message)
  return message
}

function makeSessionData(id: string): SessionData {
  const createdAt = new Date().toISOString()
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    source: 'web',
    currentModel: 'gpt-5.3-codex-medium',
    modelHistory: [{ model: 'gpt-5.3-codex-medium', from: createdAt, to: null }],
    tags: [],
  }
}

describe('Session event persistence (double-write)', () => {
  let sessionDb: SessionDB
  let modelRouter: ModelRouter
  let toolRegistry: ToolRegistry
  let store: SessionEventStore
  let logsDir: string

  afterAll(() => {
    sessionDb?.close()
    rmSync(logsDir, { recursive: true, force: true })
    testProject.cleanup()
  })

  test('setup', () => {
    logsDir = mkdtempSync(join(tmpdir(), 'zero-session-events-'))
    sessionDb = SessionDB.createInMemory()
    modelRouter = createTestModelRouter()
    toolRegistry = new ToolRegistry()
    store = new SessionEventStore({ basePath: logsDir })
  })

  test('persistSessionState writes events first and projection equals input', () => {
    const data = makeSessionData('sess_event_1')
    const messages = [makeMessage('user', 'hello'), makeMessage('assistant', 'hi')]

    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages,
      timelineCompactionBlocks: [],
      checkpoint: undefined,
    })

    const projection = store.project('sess_event_1')
    expect(projection).not.toBeNull()
    expect(projection?.messages).toEqual(messages)
    // DB 同步写入,双读一致
    expect(sessionDb.loadSessionMessages('sess_event_1')).toEqual(messages)
    expect(projection?.header?.source).toBe('web')
  })

  test('incremental turn only appends new message events', () => {
    const data = makeSessionData('sess_event_1')
    const grown = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
      makeMessage('user', 'next turn'),
    ]
    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages: grown,
      timelineCompactionBlocks: [],
      checkpoint: undefined,
    })

    const events = store.readEvents('sess_event_1')
    const messageEvents = events.filter(
      (event) => event.type === 'user/message' || event.type === 'assistant/message',
    )
    expect(messageEvents.length).toBe(3)
    expect(store.project('sess_event_1')?.messages).toEqual(grown)
  })

  test('rollback truncates projection without rewriting history', () => {
    const data = makeSessionData('sess_event_1')
    const rolledBack = [makeMessage('user', 'hello'), makeMessage('assistant', 'hi')]
    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages: rolledBack,
      timelineCompactionBlocks: [],
      checkpoint: undefined,
    })

    const events = store.readEvents('sess_event_1')
    expect(events.some((event) => event.type === 'messages/truncate')).toBe(true)
    expect(store.project('sess_event_1')?.messages).toEqual(rolledBack)
  })

  test('system prompt event emitted once and re-emitted only on change', () => {
    const data = makeSessionData('sess_prompt_1')

    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages: [makeMessage('user', 'q')],
      timelineCompactionBlocks: [],
      checkpoint: undefined,
      systemPrompt: 'prompt-v1',
    })
    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages: [makeMessage('user', 'q'), makeMessage('assistant', 'a')],
      timelineCompactionBlocks: [],
      checkpoint: undefined,
      systemPrompt: 'prompt-v1',
    })
    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages: [makeMessage('user', 'q'), makeMessage('assistant', 'a')],
      timelineCompactionBlocks: [],
      checkpoint: undefined,
      systemPrompt: 'prompt-v2',
    })

    const promptEvents = store
      .readEvents('sess_prompt_1')
      .filter((event) => event.type === 'system/prompt')
    expect(promptEvents.length).toBe(2)
    expect(store.getSystemPrompt('sess_prompt_1')?.content).toBe('prompt-v2')
  })

  test('file-only mode writes events but skips DB message/block rows', () => {
    const data = makeSessionData('sess_fileonly_1')
    const messages = [makeMessage('user', 'only file')]

    persistSessionState({
      sessionDb,
      sessionEvents: store,
      sessionEventsOnly: true,
      data,
      messages,
      timelineCompactionBlocks: [],
      checkpoint: undefined,
    })

    // 事件文件是权威
    expect(store.project('sess_fileonly_1')?.messages).toEqual(messages)
    // DB 大字段不写,元数据小行仍写
    expect(sessionDb.loadSessionMessages('sess_fileonly_1')).toEqual([])
    expect(sessionDb.getSession('sess_fileonly_1')?.id).toBe('sess_fileonly_1')
  })

  test('read path prefers event projection over stale DB snapshot', () => {
    // DB 快照落后一版(模拟事件先写、DB 写失败)
    const data = makeSessionData('sess_restore_1')
    const messages = [makeMessage('user', 'q'), makeMessage('assistant', 'a')]
    persistSessionState({
      sessionDb,
      sessionEvents: store,
      data,
      messages,
      timelineCompactionBlocks: [],
      checkpoint: undefined,
    })
    sessionDb.saveMessages('sess_restore_1', messages.slice(0, 1))

    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, sessionEvents: store },
      sessionDb,
    )
    expect(manager.getMessagesFromDB('sess_restore_1').length).toBe(2)
  })

  test('Session constructor ensures the header event once', () => {
    const session = new Session(
      'web',
      modelRouter,
      toolRegistry,
      {
        sessionDb,
        sessionEvents: store,
      },
      undefined,
      'sess_header_1',
    )
    expect(session.data.id).toBe('sess_header_1')
    const events = store.readEvents('sess_header_1')
    expect(events[0]).toMatchObject({ seq: 0, type: 'session' })
    expect(events.filter((event) => event.type === 'session').length).toBe(1)
  })
})
