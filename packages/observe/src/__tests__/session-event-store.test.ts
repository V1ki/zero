import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ContextCheckpoint,
  type Message,
  type TimelineCompactionBlock,
  isMessageAppendEvent,
} from '@zero-os/shared'
import { SessionEventStore, checkSessionEvents, readEventsFile } from '../session-event-store'

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

function contextCheckpoint(
  id: string,
  fields: Pick<ContextCheckpoint, 'summarizedThroughMessageId' | 'prunedThroughMessageId'>,
): ContextCheckpoint {
  return {
    id,
    sessionId: 'sess_1',
    generation: 1,
    ...fields,
    summary: fields.summarizedThroughMessageId ? `summary ${id}` : undefined,
    coveredMessageCount: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    createdAt: '2026-11-09T00:00:00.000Z',
  }
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
  test('projectForRestore folds the prompt, turn index and injected memories, also after reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_r', schemaVersion: 1, source: 'web' })
      const empty = store.projectForRestore('sess_r')
      expect(empty?.systemPrompt).toBeUndefined()
      expect(empty?.lastTurnIndex).toBeUndefined()
      expect(empty?.injectedMemoryIds).toEqual(new Map())

      const prompt = (content: string) =>
        ({ type: 'system/prompt', data: { hash: `h_${content}`, chars: 1, content } }) as const
      const retrieval = (
        layer: 'layer1' | 'layer2',
        status: 'injected' | 'skipped' | 'failed',
        selected: Array<{ id: string; title: string }>,
      ) =>
        ({ type: 'memory/retrieval/end', data: { layer, status, queries: [], selected } }) as const
      store.append('sess_r', [
        prompt('first prompt'),
        { type: 'turn/start', data: { turnIndex: 3, trigger: 'channel' } },
        retrieval('layer1', 'injected', [{ id: 'mem_a', title: 'A' }]),
        retrieval('layer2', 'skipped', [{ id: 'mem_skipped', title: 'S' }]),
        { type: 'turn/end', data: { turnIndex: 3, status: 'failed' } },
        prompt('second prompt'),
        { type: 'turn/start', data: { turnIndex: 4, trigger: 'channel' } },
        retrieval('layer2', 'injected', [
          { id: 'mem_b', title: 'B' },
          { id: 'mem_a', title: 'A renamed' },
        ]),
        { type: 'turn/end', data: { turnIndex: 4, status: 'completed' } },
      ])

      const expected = {
        systemPrompt: 'second prompt',
        lastTurnIndex: 4,
        injectedMemoryIds: new Map([
          ['mem_a', 'A renamed'],
          ['mem_b', 'B'],
        ]),
      }
      expect(store.projectForRestore('sess_r')).toMatchObject(expected)
      expect(createStore(dir).store.projectForRestore('sess_r')).toMatchObject(expected)
      // 返回的是副本
      store.projectForRestore('sess_r')?.injectedMemoryIds.clear()
      expect(store.projectForRestore('sess_r')?.injectedMemoryIds.size).toBe(2)
      expect(store.projectForRestore('sess_missing')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  test('appendMessage assigns consecutive indexes and syncCanonical then finds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'feishu' })

      const messages = [userMessage('hello'), assistantMessage('hi'), userMessage('again')]
      for (const message of messages) store.appendMessage('sess_1', message)

      expect(store.project('sess_1')?.messages).toEqual(messages)
      expect(store.project('sess_1')?.header?.source).toBe('feishu')
      const messageEvents = store.readEvents('sess_1').filter(isMessageAppendEvent)
      expect(messageEvents.map((event) => [event.type, event.data.messageIndex])).toEqual([
        ['user/message', 0],
        ['assistant/message', 1],
        ['user/message', 2],
      ])

      // 对账:没有消息事件、没有截断,只补一条 checkpoint
      const lastSeq = store.getLastSeq('sess_1') as number
      store.syncCanonical('sess_1', { messages, blocks: [] })
      const after = store.readEvents('sess_1').filter((event) => event.seq > lastSeq)
      expect(after.map((event) => event.type)).toEqual(['checkpoint'])
      expect(after[0].data).toMatchObject({ messageCount: 3 })
      // 没有新变化时不再写 checkpoint
      store.syncCanonical('sess_1', { messages, blocks: [] })
      expect(store.getLastSeq('sess_1')).toBe(lastSeq + 1)
      expect(errors).toEqual([])

      // 新 store 实例从磁盘重放后继续按投影长度分配下标
      const reopened = new SessionEventStore({ basePath: dir })
      reopened.appendMessage('sess_1', assistantMessage('done'))
      const last = reopened.readEvents('sess_1').filter(isMessageAppendEvent).at(-1)
      expect(last?.data.messageIndex).toBe(3)
      expect(reopened.project('sess_1')?.messages).toEqual([...messages, assistantMessage('done')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('appendMessage externalizes images; sync with the raw message matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      const data = Buffer.from('fake png bytes').toString('base64')
      const withImage = {
        ...userMessage('look'),
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mediaType: 'image/png', data },
        ],
      } as Message

      store.appendMessage('sess_1', withImage)

      const event = store.readEvents('sess_1').find(isMessageAppendEvent)
      const image = event?.data.message.content[1] as { data?: string; imageRef?: { path: string } }
      expect(image.data).toBeUndefined()
      expect(existsSync(image.imageRef?.path as string)).toBe(true)
      // 调用方手里的消息不被改写
      expect((withImage.content[1] as { data?: string }).data).toBe(data)

      const lastSeq = store.getLastSeq('sess_1') as number
      store.syncCanonical('sess_1', { messages: [withImage], blocks: [] })
      expect(
        store
          .readEvents('sess_1')
          .filter((e) => e.seq > lastSeq)
          .map((e) => e.type),
      ).toEqual(['checkpoint'])
      expect(errors).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('syncMessages records the declared truncate reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      for (const message of [userMessage('a'), assistantMessage('b'), userMessage('c')]) {
        store.appendMessage('sess_1', message)
      }

      // 回滚到 2 条,再走新分支
      store.syncMessages('sess_1', [userMessage('a'), assistantMessage('b')], 'turn_failed')
      store.appendMessage('sess_1', userMessage('new-turn'))

      const projection = store.project('sess_1')
      expect(projection?.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
        'a',
        'b',
        'new-turn',
      ])
      const truncates = store
        .readEvents('sess_1')
        .filter((event) => event.type === 'messages/truncate')
      expect(truncates.map((event) => event.data)).toEqual([
        { toMessageIndex: 2, reason: 'turn_failed' },
      ])
      expect(errors).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an undeclared mismatch at sync is recorded as unexpected and reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store, errors } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      for (const message of [userMessage('a'), assistantMessage('b'), userMessage('c')]) {
        store.appendMessage('sess_1', message)
      }

      store.syncCanonical('sess_1', {
        messages: [userMessage('a'), assistantMessage('b'), userMessage('changed')],
        blocks: [],
      })

      expect(store.project('sess_1')?.messages.at(-1)).toEqual(userMessage('changed'))
      const truncates = store
        .readEvents('sess_1')
        .filter((event) => event.type === 'messages/truncate')
      expect(truncates.map((event) => event.data)).toEqual([
        { toMessageIndex: 2, reason: 'unexpected' },
      ])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('canonical changed outside the store')
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

      const logFile = store.registerSubagent({
        childSessionId: 'sess_child',
        parentSessionId: 'sess_parent',
        name: 'worker-1',
      })
      expect(logFile).toEndWith('sub-sess_child.jsonl')

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
      expect(index.children.sess_child).toBe(logFile as string)
      expect(existsSync(join(dir, index.children.sess_child))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('openRun writes a file that only its handle reaches, outside the index and the cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      const run = store.openRun({
        childSessionId: 'memory_1',
        parentSessionId: 'sess_main',
        name: 'memory_retrieval',
        role: 'layer1',
      })
      expect(run.logFile).toBe('sessions/sess_main/sub-memory_1.jsonl')
      expect(run.append([{ type: 'loop/start', data: { requireThinkingForToolUse: false } }])).toBe(
        1,
      )
      run.appendMessage(userMessage('hello'))
      run.appendMessage(assistantMessage('hi'))

      const events = readEventsFile(join(dir, run.logFile))
      expect(events.map((event) => [event.seq, event.type])).toEqual([
        [0, 'session'],
        [1, 'loop/start'],
        [2, 'user/message'],
        [3, 'assistant/message'],
      ])
      expect(events[0].data).toMatchObject({
        sessionId: 'memory_1',
        origin: 'subagent',
        parentSessionId: 'sess_main',
        name: 'memory_retrieval',
        role: 'layer1',
      })
      expect(
        events.slice(2).map((event) => (event.data as { messageIndex: number }).messageIndex),
      ).toEqual([0, 1])
      // 每个 turn、每次调用都会新建一份:不进索引,store 也不按 id 持有它
      expect(existsSync(join(dir, 'subagent-index.json'))).toBe(false)
      expect(store.hasSession('memory_1')).toBe(false)
      expect(
        store.append('memory_1', [
          { type: 'loop/start', data: { requireThinkingForToolUse: false } },
        ]),
      ).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteFilesBefore removes old files of matching directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
    try {
      const { store } = createStore(dir)
      const register = (child: string, parent: string) =>
        store.openRun({ childSessionId: child, parentSessionId: parent }).logFile
      const old = register('call-old', 'router-2026-11-01')
      const fresh = register('call-fresh', 'router-2026-11-01')
      const other = register('agent-x', 'sess_main')
      const runLog = join(dir, 'sessions', 'router-2026-11-01', 'run.log')
      writeFileSync(runLog, '{}\n')
      const cutoff = new Date('2026-11-05T00:00:00.000Z')
      const before = new Date('2026-11-02T00:00:00.000Z')
      for (const file of [join(dir, old), runLog, join(dir, other)])
        utimesSync(file, before, before)

      expect(store.deleteFilesBefore('router-', cutoff)).toBe(2)
      expect(existsSync(join(dir, old))).toBe(false)
      expect(existsSync(runLog)).toBe(false)
      expect(existsSync(join(dir, fresh))).toBe(true)
      expect(existsSync(join(dir, other))).toBe(true)

      utimesSync(join(dir, fresh), before, before)
      expect(store.deleteFilesBefore('router-', cutoff)).toBe(1)
      expect(existsSync(join(dir, 'sessions', 'router-2026-11-01'))).toBe(false)
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

  describe('context checkpoint replay', () => {
    function setup(dir: string) {
      const { store } = createStore(dir)
      store.ensureSession({ v: 1, sessionId: 'sess_1', schemaVersion: 1, source: 'web' })
      const messages = [userMessage('a'), assistantMessage('b'), userMessage('c')]
      store.syncCanonical('sess_1', { messages, blocks: [] })
      return store
    }

    test('the latest valid checkpoint is projected and survives a reload', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
      try {
        const store = setup(dir)
        const checkpoint = contextCheckpoint('cp_1', { summarizedThroughMessageId: 'msg_a' })
        store.append('sess_1', [{ type: 'compaction/checkpoint', data: { checkpoint } }])

        expect(store.project('sess_1')?.checkpoint).toEqual(checkpoint)
        expect(new SessionEventStore({ basePath: dir }).project('sess_1')?.checkpoint).toEqual(
          checkpoint,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('an invalid latest checkpoint falls back to the most recent valid one', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
      try {
        const store = setup(dir)
        const valid = contextCheckpoint('cp_1', { prunedThroughMessageId: 'msg_b' })
        store.append('sess_1', [
          { type: 'compaction/checkpoint', data: { checkpoint: valid } },
          {
            type: 'compaction/checkpoint',
            data: {
              checkpoint: contextCheckpoint('cp_2', {
                summarizedThroughMessageId: 'msg_b',
                prunedThroughMessageId: 'msg_lost',
              }),
            },
          },
          {
            type: 'compaction/checkpoint',
            data: {
              checkpoint: contextCheckpoint('cp_3', { summarizedThroughMessageId: 'msg_x' }),
            },
          },
        ])

        expect(store.project('sess_1')?.checkpoint).toEqual(valid)
        expect(new SessionEventStore({ basePath: dir }).project('sess_1')?.checkpoint).toEqual(
          valid,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('no valid checkpoint projects none', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
      try {
        const store = setup(dir)
        store.append('sess_1', [
          {
            type: 'compaction/checkpoint',
            data: {
              checkpoint: contextCheckpoint('cp_1', { summarizedThroughMessageId: 'msg_x' }),
            },
          },
        ])
        expect(store.project('sess_1')?.checkpoint).toBeUndefined()

        // 截断掉检查点指向的消息后同样回退
        store.append('sess_1', [
          {
            type: 'compaction/checkpoint',
            data: {
              checkpoint: contextCheckpoint('cp_2', { summarizedThroughMessageId: 'msg_c' }),
            },
          },
        ])
        expect(store.project('sess_1')?.checkpoint?.id).toBe('cp_2')
        store.syncCanonical('sess_1', {
          messages: [userMessage('a'), assistantMessage('b')],
          blocks: [],
        })
        expect(store.project('sess_1')?.checkpoint).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a null checkpoint resets to none and earlier checkpoints are not revived', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ses-test-'))
      try {
        const store = setup(dir)
        store.append('sess_1', [
          {
            type: 'compaction/checkpoint',
            data: { checkpoint: contextCheckpoint('cp_1', { prunedThroughMessageId: 'msg_a' }) },
          },
          { type: 'compaction/checkpoint', data: { checkpoint: null } },
        ])
        expect(store.project('sess_1')?.checkpoint).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
