import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { SessionDB } from '../session-db'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: `sess_${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'web',
    currentModel: 'gpt-5.3-codex-medium',
    modelHistory: [{ model: 'gpt-5.3-codex-medium', from: new Date().toISOString(), to: null }],
    tags: [],
    ...overrides,
  }
}

function makeMessages(count: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `msg_${i}`,
      sessionId: 'sess_test',
      role: i % 2 === 0 ? 'user' : 'assistant',
      messageType: 'message',
      content: [{ type: 'text', text: `Message ${i}` }],
      createdAt: new Date().toISOString(),
    })
  }
  return msgs
}

type UnsafeSessionDb = {
  db: {
    run(sql: string, bindings?: unknown[]): unknown
  }
  backfillLegacyBindings(): void
}

function insertLegacySession(
  db: SessionDB,
  data: {
    id: string
    source: string
    status: string
    currentModel?: string
    createdAt: string
    updatedAt: string
    channelName?: string
    channelId?: string
  },
): void {
  const unsafe = db as unknown as UnsafeSessionDb
  unsafe.db.run(
    `INSERT INTO sessions (
      id, source, status, current_model, reasoning_effort, model_history_json, summary, tags_json,
      channel_name, channel_id, agent_config_json, system_prompt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.source,
      data.status,
      data.currentModel ?? 'gpt-5.3-codex-medium',
      null,
      JSON.stringify([
        {
          model: data.currentModel ?? 'gpt-5.3-codex-medium',
          from: data.createdAt,
          to: null,
        },
      ]),
      null,
      JSON.stringify([]),
      data.channelName ?? null,
      data.channelId ?? null,
      null,
      null,
      data.createdAt,
      data.updatedAt,
    ],
  )
}

describe('SessionDB', () => {
  let db: SessionDB | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  test('initializes schema and creates tables', () => {
    db = SessionDB.createInMemory()
    expect(db).toBeDefined()
  })

  test('saveSession + getSession round-trip', () => {
    db = SessionDB.createInMemory()
    const data = makeSessionData({
      id: 'sess_roundtrip',
      tags: ['test', 'unit'],
      reasoningEffort: 'high',
    })
    db.saveSession(data, '{"name":"zero"}')

    const row = db.getSession('sess_roundtrip')
    const savedRow = expectDefined(row)
    expect(savedRow.id).toBe('sess_roundtrip')
    expect(savedRow.source).toBe('web')
    expect(savedRow.currentModel).toBe('gpt-5.3-codex-medium')
    expect(savedRow.tags).toEqual(['test', 'unit'])
    expect(savedRow.reasoningEffort).toBe('high')
    expect(savedRow.modelHistory).toHaveLength(1)
    expect(savedRow.modelHistory[0].model).toBe('gpt-5.3-codex-medium')
    expect(savedRow.agentConfigJson).toBe('{"name":"zero"}')
  })

  test('saveSession upserts on duplicate ID', () => {
    db = SessionDB.createInMemory()
    const data = makeSessionData({ id: 'sess_upsert', summary: 'v1' })
    db.saveSession(data)
    expect(expectDefined(db.getSession('sess_upsert')).summary).toBe('v1')

    data.summary = 'v2'
    data.updatedAt = new Date().toISOString()
    db.saveSession(data)
    expect(expectDefined(db.getSession('sess_upsert')).summary).toBe('v2')
  })

  test('saveMessages + loadSessionMessages round-trip', () => {
    db = SessionDB.createInMemory()
    const msgs = makeMessages(4)
    db.saveMessages('sess_msgs', msgs)

    const loaded = db.loadSessionMessages('sess_msgs')
    expect(loaded).toHaveLength(4)
    expect(loaded[0].role).toBe('user')
    expect(loaded[1].role).toBe('assistant')
    expect(loaded[2].content[0]).toEqual({ type: 'text', text: 'Message 2' })
  })

  test('saveMessages with tool_use and tool_result blocks', () => {
    db = SessionDB.createInMemory()
    const msgs: Message[] = [
      {
        id: 'msg_tool_1',
        sessionId: 'sess_tool',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/test' } },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'msg_tool_2',
        sessionId: 'sess_tool',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file contents here' }],
        createdAt: new Date().toISOString(),
      },
    ]
    db.saveMessages('sess_tool', msgs)

    const loaded = db.loadSessionMessages('sess_tool')
    expect(loaded).toHaveLength(2)
    expect(loaded[0].content[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'read',
      input: { path: '/tmp/test' },
    })
  })

  test('loadSessionMessages returns empty for non-existent session', () => {
    db = SessionDB.createInMemory()
    const msgs = db.loadSessionMessages('sess_nonexistent')
    expect(msgs).toEqual([])
  })

  test('saveBinding + getBinding + loadBindings round-trip', () => {
    db = SessionDB.createInMemory()
    db.saveSession(
      makeSessionData({
        id: 'sess_bind_1',
        source: 'feishu',
        channelName: 'feishu:ops',
        channelId: 'chat_001',
        participantId: 'ou_alice',
      }),
    )

    db.saveBinding(
      'feishu',
      'chat_001',
      'sess_bind_1',
      'feishu:ops',
      '2026-04-22T00:00:00.000Z',
      'ou_alice',
    )

    expect(db.getBinding('feishu', 'chat_001', 'feishu:ops', 'ou_alice')).toEqual({
      source: 'feishu',
      channelName: 'feishu:ops',
      channelId: 'chat_001',
      participantId: 'ou_alice',
      sessionId: 'sess_bind_1',
      updatedAt: '2026-04-22T00:00:00.000Z',
    })
    expect(db.getSession('sess_bind_1')?.participantId).toBe('ou_alice')

    expect(db.loadBindings()).toEqual([
      {
        source: 'feishu',
        channelName: 'feishu:ops',
        channelId: 'chat_001',
        participantId: 'ou_alice',
        sessionId: 'sess_bind_1',
        updatedAt: '2026-04-22T00:00:00.000Z',
      },
    ])
  })

  test('saveBinding keeps participants isolated in the same channel', () => {
    db = SessionDB.createInMemory()

    db.saveBinding(
      'feishu',
      'chat_001',
      'sess_alice',
      'feishu:ops',
      '2026-04-22T00:00:00.000Z',
      'ou_alice',
    )
    db.saveBinding(
      'feishu',
      'chat_001',
      'sess_bob',
      'feishu:ops',
      '2026-04-22T00:01:00.000Z',
      'ou_bob',
    )

    expect(db.getBinding('feishu', 'chat_001', 'feishu:ops', 'ou_alice')?.sessionId).toBe(
      'sess_alice',
    )
    expect(db.getBinding('feishu', 'chat_001', 'feishu:ops', 'ou_bob')?.sessionId).toBe('sess_bob')
  })

  test('deleteSession removes associated bindings', () => {
    db = SessionDB.createInMemory()
    db.saveSession(
      makeSessionData({
        id: 'sess_delete_1',
        source: 'telegram',
        channelId: 'tg_001',
      }),
    )
    db.saveBinding('telegram', 'tg_001', 'sess_delete_1', undefined, '2026-04-22T00:01:00.000Z')

    expect(db.deleteSession('sess_delete_1')).toBe(true)
    expect(db.getSession('sess_delete_1')).toBeNull()
    expect(db.getBinding('telegram', 'tg_001')).toBeNull()
  })

  test('loadAllSessions orders by updatedAt and respects limit', () => {
    db = SessionDB.createInMemory()
    db.saveSession(
      makeSessionData({
        id: 'sess_old',
        updatedAt: '2026-04-22T00:00:00.000Z',
      }),
    )
    db.saveSession(
      makeSessionData({
        id: 'sess_new',
        updatedAt: '2026-04-22T00:05:00.000Z',
      }),
    )

    expect(
      db
        .loadAllSessions()
        .map((row) => row.id)
        .slice(0, 2),
    ).toEqual(['sess_new', 'sess_old'])
    expect(db.loadAllSessions({ limit: 1 }).map((row) => row.id)).toEqual(['sess_new'])
  })

  test('legacy backfill builds bindings from active and idle rows only', () => {
    db = SessionDB.createInMemory()
    const unsafe = db as unknown as UnsafeSessionDb

    insertLegacySession(db, {
      id: 'sess_old_active',
      source: 'feishu',
      status: 'active',
      channelName: 'feishu:ops',
      channelId: 'shared_room',
      createdAt: '2026-04-22T00:00:00.000Z',
      updatedAt: '2026-04-22T00:00:00.000Z',
    })
    insertLegacySession(db, {
      id: 'sess_new_idle',
      source: 'feishu',
      status: 'idle',
      channelName: 'feishu:ops',
      channelId: 'shared_room',
      createdAt: '2026-04-22T00:10:00.000Z',
      updatedAt: '2026-04-22T00:10:00.000Z',
    })
    insertLegacySession(db, {
      id: 'sess_completed',
      source: 'feishu',
      status: 'completed',
      channelName: 'feishu:ops',
      channelId: 'shared_room',
      createdAt: '2026-04-22T00:20:00.000Z',
      updatedAt: '2026-04-22T00:20:00.000Z',
    })
    insertLegacySession(db, {
      id: 'sess_web_legacy',
      source: 'web',
      status: 'active',
      createdAt: '2026-04-22T00:30:00.000Z',
      updatedAt: '2026-04-22T00:30:00.000Z',
    })

    unsafe.backfillLegacyBindings()

    expect(db.loadBindings()).toEqual([
      {
        source: 'web',
        channelName: 'web',
        channelId: 'default',
        sessionId: 'sess_web_legacy',
        updatedAt: '2026-04-22T00:30:00.000Z',
      },
      {
        source: 'feishu',
        channelName: 'feishu:ops',
        channelId: 'shared_room',
        sessionId: 'sess_new_idle',
        updatedAt: '2026-04-22T00:10:00.000Z',
      },
    ])
  })

  test('getSession returns null for non-existent ID', () => {
    db = SessionDB.createInMemory()
    expect(db.getSession('sess_nonexistent')).toBeNull()
  })
})
