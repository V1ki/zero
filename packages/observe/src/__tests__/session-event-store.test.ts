import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, TimelineCompactionBlock } from '@zero-os/shared'
import { SessionEventStore, checkSessionEvents } from '../session-event-store'

function createStore(basePath: string) {
  const errors: string[] = []
  const store = new SessionEventStore({
    basePath,
    now: () => '2026-11-09T00:00:00.000Z',
    onError: (message) => errors.push(message),
  })
  return { store, errors }
}

function userMessage(text: string): Message {
  return {
    id: `msg_${text}`,
    sessionId: 'sess_test_1',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: '2026-11-09T00:00:00.000Z',
    messageType: 'message',
  } as unknown as Message
}

function assistantMessage(text: string): Message {
  return {
    id: `msg_${text}`,
    sessionId: 'sess_test_1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: '2026-11-09T00:00:00.000Z',
  } as unknown as Message
}

function compactionBlock(id: string): TimelineCompactionBlock {
  return {
    id,
    status: 'active',
    coveredMessageIds: [],
    coveredRange: { startMessageId: 'm1', endMessageId: 'm2' },
    summary: 's',
  } as unknown as TimelineCompactionBlock
}

describe('SessionEventStore', () => {
  test('ensureSession writes header at seq 0 and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      expect(
        store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' }),
      ).toBe(true)
      expect(
        store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' }),
      ).toBe(false)

      const header = store.readEvents('sess_1')[0]
      expect(header.type).toBe('session')
      expect(header.seq).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('syncCanonical appends message events and projects equivalently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'feishu' })

      const messages = [userMessage('hello'), assistantMessage('hi'), userMessage('again')]
      store.syncCanonical('sess_1', { messages, blocks: [] })

      const projection = store.project('sess_1')
      expect(projection?.messages).toEqual(messages)
      expect(projection?.header?.source).toBe('feishu')
      expect(errors).toEqual([])

      // 增量追加
      const grown = [...messages, assistantMessage('done')]
      store.syncCanonical('sess_1', { messages: grown, blocks: [] })
      expect(store.project('sess_1')?.messages).toEqual(grown)
      // 只新增一条消息事件,不重写历史
      const messageEvents = store
        .readEvents('sess_1')
        .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
      expect(messageEvents.length).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rollback emits truncate event and projection matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })

      store.syncCanonical('sess_1', {
        messages: [userMessage('a'), assistantMessage('b'), userMessage('c')],
        blocks: [],
      })
      // 回滚到 2 条,再走新分支
      store.syncCanonical('sess_1', {
        messages: [userMessage('a'), assistantMessage('b'), userMessage('new-turn')],
        blocks: [],
      })

      const projection = store.project('sess_1')
      expect(projection?.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
        'a',
        'b',
        'new-turn',
      ])

      const truncates = store
        .readEvents('sess_1')
        .filter((event) => event.type === 'messages/truncate')
      expect(truncates.length).toBe(1)
      expect((truncates[0].data as { toMessageIndex: number }).toMessageIndex).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('compaction blocks sync replaces array and projects latest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })

      const blocksV1 = [compactionBlock('blk_1')]
      store.syncCanonical('sess_1', { messages: [userMessage('a')], blocks: blocksV1 })
      const blocksV2 = [compactionBlock('blk_1'), compactionBlock('blk_2')]
      store.syncCanonical('sess_1', { messages: [userMessage('a')], blocks: blocksV2 })

      expect(store.project('sess_1')?.blocks).toEqual(blocksV2)
      // 相同数组不重复追加
      store.syncCanonical('sess_1', { messages: [userMessage('a')], blocks: blocksV2 })
      const blockEvents = store
        .readEvents('sess_1')
        .filter((event) => event.type === 'compaction/block')
      expect(blockEvents.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('diagnostics append shares the seq space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      expect(store.getLastSeq('sess_1')).toBe(0)

      const anchor = store.append('sess_1', [
        { type: 'step/start', data: { stepIndex: 0, model: 'pool/x' } },
      ])
      expect(anchor).toBe(1)
      expect(store.getLastSeq('sess_1')).toBe(1)
      store.append('sess_1', [{ type: 'turn/start', data: { turnIndex: 1, trigger: 'channel' } }])
      const events = store.readEvents('sess_1')
      expect(checkSessionEvents(events).ok).toBe(true)
      expect(events.map((event) => event.seq)).toEqual([0, 1, 2])

      // 请求重建锚点:projectUpTo(seq=1) 只含 step/start 之前的 canonical 消息
      store.syncCanonical('sess_1', { messages: [userMessage('late')], blocks: [] })
      expect(store.projectUpTo('sess_1', 1)?.messages).toEqual([])
      expect(store.project('sess_1')?.messages.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('subagent file lives in parent directory with lineage header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_parent', schemaVersion: 1, source: 'feishu' })

      expect(
        store.registerSubagent({
          childSessionId: 'sess_child',
          parentSessionId: 'sess_parent',
          name: 'worker-1',
        }),
      ).toBe(true)

      const header = store.readEvents('sess_child')[0]
      expect(header.type).toBe('session')
      const data = header.data as { origin?: string; parentSessionId?: string }
      expect(data.origin).toBe('subagent')
      expect(data.parentSessionId).toBe('sess_parent')

      store.syncCanonical('sess_child', { messages: [userMessage('child-msg')], blocks: [] })
      expect(store.project('sess_child')?.messages.length).toBe(1)

      // 文件落在父会话目录:sub-<childId>.jsonl
      const relative = readFileSync(join(dir, 'subagent-index.json'), 'utf-8')
      expect(relative).toContain('sess_child')
      expect(relative).toContain('sub-sess_child.jsonl')
      const index = JSON.parse(relative) as { children: Record<string, string> }
      expect(existsSync(join(dir, index.children.sess_child))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('corrupt file (missing header) reports invalid and yields null projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      const file = join(dir, 'sessions', 'sess_bad', 'session.jsonl')
      const { mkdirSync, writeFileSync } = require('node:fs')
      mkdirSync(join(dir, 'sessions', 'sess_bad'), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ seq: 0, ts: 'x', type: 'turn/start', data: {} })}\n`)

      expect(store.project('sess_bad')).toBeNull()
      expect(errors.length).toBeGreaterThan(0)
      // 损坏会话不再接受写入
      expect(
        store.append('sess_bad', [{ type: 'turn/end', data: { turnIndex: 1, status: 'failed' } }]),
      ).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tools/set folds into projection and getToolSet tracks latest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      expect(store.getToolSet('sess_1')).toBeNull()

      store.append('sess_1', [
        { type: 'tools/set', data: { hash: 'sha256:a', toolNames: ['read', 'bash'], count: 2 } },
      ])
      expect(store.getToolSet('sess_1')?.toolNames).toEqual(['read', 'bash'])

      store.append('sess_1', [
        { type: 'tools/set', data: { hash: 'sha256:b', toolNames: ['read'], count: 1 } },
      ])
      expect(store.getToolSet('sess_1')?.hash).toBe('sha256:b')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('system/prompt folds into projection and getSystemPrompt tracks latest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      expect(store.getSystemPrompt('sess_1')).toBeNull()

      store.append('sess_1', [
        { type: 'system/prompt', data: { hash: 'sha256:aaa', chars: 3, content: 'v1' } },
      ])
      expect(store.getSystemPrompt('sess_1')).toEqual({ hash: 'sha256:aaa', content: 'v1' })

      store.append('sess_1', [
        { type: 'system/prompt', data: { hash: 'sha256:bbb', chars: 3, content: 'v2' } },
      ])
      expect(store.getSystemPrompt('sess_1')).toEqual({ hash: 'sha256:bbb', content: 'v2' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fresh store instance reloads projection from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      const messages = [userMessage('persisted'), assistantMessage('response')]
      store.syncCanonical('sess_1', { messages, blocks: [] })

      const reopened = new SessionEventStore({ basePath: dir })
      expect(reopened.project('sess_1')?.messages).toEqual(messages)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
