import { afterAll, describe, expect, test } from 'bun:test'
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
    status: 'active',
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

describe('SessionDB', () => {
  let db: SessionDB

  afterAll(() => {
    db?.close()
  })

  test('initializes schema and creates tables', () => {
    db = SessionDB.createInMemory()
    expect(db).toBeDefined()
  })

  test('saveSession + getSession round-trip', () => {
    const data = makeSessionData({ id: 'sess_roundtrip', tags: ['test', 'unit'] })
    db.saveSession(data, '{"name":"zero"}')

    const row = db.getSession('sess_roundtrip')
    const savedRow = expectDefined(row)
    expect(savedRow.id).toBe('sess_roundtrip')
    expect(savedRow.source).toBe('web')
    expect(savedRow.status).toBe('active')
    expect(savedRow.currentModel).toBe('gpt-5.3-codex-medium')
    expect(savedRow.tags).toEqual(['test', 'unit'])
    expect(savedRow.modelHistory).toHaveLength(1)
    expect(savedRow.modelHistory[0].model).toBe('gpt-5.3-codex-medium')
    expect(savedRow.agentConfigJson).toBe('{"name":"zero"}')
  })

  test('saveSession upserts on duplicate ID', () => {
    const data = makeSessionData({ id: 'sess_upsert', summary: 'v1' })
    db.saveSession(data)
    expect(expectDefined(db.getSession('sess_upsert')).summary).toBe('v1')

    data.summary = 'v2'
    data.updatedAt = new Date().toISOString()
    db.saveSession(data)
    expect(expectDefined(db.getSession('sess_upsert')).summary).toBe('v2')
  })

  test('saveMessages + loadSessionMessages round-trip', () => {
    const msgs = makeMessages(4)
    db.saveMessages('sess_msgs', msgs)

    const loaded = db.loadSessionMessages('sess_msgs')
    expect(loaded).toHaveLength(4)
    expect(loaded[0].role).toBe('user')
    expect(loaded[1].role).toBe('assistant')
    expect(loaded[2].content[0]).toEqual({ type: 'text', text: 'Message 2' })
  })

  test('saveMessages with tool_use and tool_result blocks', () => {
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
    const msgs = db.loadSessionMessages('sess_nonexistent')
    expect(msgs).toEqual([])
  })

  test('updateStatus changes status and updatedAt', () => {
    const data = makeSessionData({ id: 'sess_status' })
    db.saveSession(data)
    expect(expectDefined(db.getSession('sess_status')).status).toBe('active')

    const newTime = new Date().toISOString()
    db.updateStatus('sess_status', 'completed', newTime)

    const row = expectDefined(db.getSession('sess_status'))
    expect(row.status).toBe('completed')
    expect(row.updatedAt).toBe(newTime)
  })

  test('loadActiveSessions returns only active/idle', () => {
    db.saveSession(makeSessionData({ id: 'sess_a1', status: 'active' }))
    db.saveSession(makeSessionData({ id: 'sess_a2', status: 'idle' }))
    db.saveSession(makeSessionData({ id: 'sess_a3', status: 'completed' }))
    db.saveSession(makeSessionData({ id: 'sess_a4', status: 'archived' }))

    const active = db.loadActiveSessions()
    const activeIds = active.map((r) => r.id)
    expect(activeIds).toContain('sess_a1')
    expect(activeIds).toContain('sess_a2')
    expect(activeIds).not.toContain('sess_a3')
    expect(activeIds).not.toContain('sess_a4')
  })

  test('loadAllSessions with status filter', () => {
    const completed = db.loadAllSessions({ status: 'completed' })
    expect(completed.every((r) => r.status === 'completed')).toBe(true)
    expect(completed.length).toBeGreaterThanOrEqual(1)
  })

  test('loadAllSessions with limit', () => {
    const limited = db.loadAllSessions({ limit: 2 })
    expect(limited.length).toBeLessThanOrEqual(2)
  })

  test('getChannelMappings returns active sessions with channelId', () => {
    db.saveSession(
      makeSessionData({
        id: 'sess_ch1',
        source: 'feishu',
        channelName: 'feishu:ops',
        channelId: 'chat_001',
        status: 'active',
      }),
    )
    db.saveSession(
      makeSessionData({ id: 'sess_ch2', source: 'telegram', channelId: 'tg_001', status: 'idle' }),
    )
    db.saveSession(
      makeSessionData({
        id: 'sess_ch3',
        source: 'feishu',
        channelId: 'chat_002',
        status: 'completed',
      }),
    )

    const mappings = db.getChannelMappings()
    const ids = mappings.map((m) => m.id)
    expect(ids).toContain('sess_ch1')
    expect(ids).toContain('sess_ch2')
    expect(ids).not.toContain('sess_ch3')

    const feishuMapping = expectDefined(mappings.find((m) => m.id === 'sess_ch1'))
    expect(feishuMapping.source).toBe('feishu')
    expect(feishuMapping.channelName).toBe('feishu:ops')
    expect(feishuMapping.channelId).toBe('chat_001')
  })

  test('getSession returns null for non-existent ID', () => {
    expect(db.getSession('sess_nonexistent')).toBeNull()
  })
})
