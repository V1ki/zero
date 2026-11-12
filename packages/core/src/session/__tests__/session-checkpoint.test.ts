import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionDB, SessionEventStore } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  SystemConfig,
} from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'
import {
  TEST_SYSTEM_CONFIG,
  createTestModelRouter,
  createTestProjectRoot,
  setSessionAgentForTest,
} from './test-helpers'

const SESSION_ID = 'sess_checkpoint_1'
const BIG = 'x'.repeat(60_000)

// 默认模型 U = 18000:阈值 14400、保留 3600;另带一个窗口很小的模型用于切换
const SMALL_WINDOW_CONFIG: SystemConfig = {
  ...TEST_SYSTEM_CONFIG,
  providers: {
    'openai-codex': {
      ...TEST_SYSTEM_CONFIG.providers['openai-codex'],
      models: {
        'gpt-5.3-codex-medium': {
          modelId: 'gpt-5.3-codex-medium',
          maxContext: 20_000,
          maxOutput: 2_000,
          capabilities: ['tools'],
          tags: [],
        },
        tiny: {
          modelId: 'tiny',
          maxContext: 2_000,
          maxOutput: 500,
          capabilities: ['tools'],
          tags: [],
        },
      },
    },
  },
}

/** 主模型回复 ok;failing 时 agent loop 请求失败。压缩请求返回 SUMMARY n。 */
class FakeAdapter implements ProviderAdapter {
  readonly apiType = 'fake'
  failing = false
  summaries = 0

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.meta?.purpose === 'compression') {
      this.summaries += 1
      return reply(`SUMMARY ${this.summaries}`)
    }
    if (req.meta?.purpose === 'task_closure') return reply('{"action":"finish","reason":"done"}')
    if (this.failing) throw new Error('main model down')
    return reply('ok')
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function reply(text: string): CompletionResponse {
  return {
    id: `resp_${text}`,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'fake',
  }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
  const project = createTestProjectRoot('zero-session-checkpoint-')
  const logsDir = mkdtempSync(join(tmpdir(), 'zero-session-checkpoint-logs-'))
  const sessionDb = SessionDB.createInMemory()
  cleanups.push(() => {
    sessionDb.close()
    rmSync(logsDir, { recursive: true, force: true })
    project.cleanup()
  })
  const store = new SessionEventStore({ basePath: logsDir })
  const modelRouter = createTestModelRouter({ config: SMALL_WINDOW_CONFIG })
  const toolRegistry = new ToolRegistry()
  const deps = { sessionDb, sessionEvents: store, projectRoot: project.projectRoot }
  const session = new Session('web', modelRouter, toolRegistry, deps, undefined, SESSION_ID)
  session.initAgent({ name: 'checkpoint-agent', agentInstruction: 'test', promptMode: 'minimal' })

  // 真实 Agent + 假模型:压缩事件经 obs.sessionEvents 写入同一个事件流
  const adapter = new FakeAdapter()
  setSessionAgentForTest(
    session,
    new Agent(
      { name: 'checkpoint-agent', agentInstruction: 'test', promptMode: 'minimal' },
      adapter,
      toolRegistry,
      {
        sessionId: SESSION_ID,
        workDir: project.projectRoot,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      { sessionEvents: store },
    ),
  )
  return { session, adapter, store, logsDir, sessionDb, modelRouter, toolRegistry }
}

function writtenCheckpoints(store: SessionEventStore) {
  return store
    .readEvents(SESSION_ID)
    .flatMap((event) => (event.type === 'compaction/checkpoint' ? [event.data.checkpoint] : []))
}

describe('Session context checkpoint', () => {
  test('a checkpoint created in a turn survives persist and restore', async () => {
    const { session, store, logsDir, sessionDb, modelRouter, toolRegistry } = setup()

    await session.handleMessage(BIG)
    expect(session.getContextCheckpoint()).toBeUndefined()
    await session.handleMessage('second')

    const checkpoint = session.getContextCheckpoint()
    expect(checkpoint).toMatchObject({
      generation: 1,
      summarizedThroughMessageId: session.getMessages()[0].id,
      summary: 'SUMMARY 1',
    })
    expect(store.project(SESSION_ID)?.checkpoint).toEqual(checkpoint)
    expect(sessionDb.loadContextCheckpoint(SESSION_ID)).toEqual(checkpoint)

    const fromEvents = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, sessionEvents: new SessionEventStore({ basePath: logsDir }) },
      sessionDb,
    ).switchCurrentSessionForChannel('web', 'default', SESSION_ID)
    expect(fromEvents?.isRestored).toBe(true)
    expect(fromEvents?.session.getContextCheckpoint()).toEqual(checkpoint)

    const fromDb = new SessionManager(modelRouter, toolRegistry, { sessionDb }, sessionDb)
    expect(
      fromDb
        .switchCurrentSessionForChannel('web', 'default', SESSION_ID)
        ?.session.getContextCheckpoint(),
    ).toEqual(checkpoint)
  })

  test('a failed turn restores the checkpoint from turn start', async () => {
    const { session, adapter, store, sessionDb } = setup()
    await session.handleMessage(BIG)
    await session.handleMessage(BIG)
    const turnStart = session.getContextCheckpoint()
    expect(turnStart?.generation).toBe(1)
    const messagesBefore = session.getMessages()

    adapter.failing = true
    await expect(session.handleMessage('third')).rejects.toThrow('main model down')

    // turn 开始时的压缩产生了第二份检查点,回滚后恢复第一份并补写事件
    expect(adapter.summaries).toBe(2)
    expect(session.getMessages()).toEqual(messagesBefore)
    expect(session.getContextCheckpoint()).toBe(turnStart)
    const written = writtenCheckpoints(store)
    expect(written.map((checkpoint) => checkpoint?.generation)).toEqual([1, 2, 1])
    expect(written.at(-1)).toEqual(turnStart)
    expect(store.project(SESSION_ID)?.checkpoint).toEqual(turnStart)
    expect(sessionDb.loadContextCheckpoint(SESSION_ID)).toEqual(turnStart)
  })

  test('switching model leaves canonical messages untouched', async () => {
    const { session, adapter } = setup()
    await session.handleMessage(BIG)
    const before = structuredClone(session.getMessages())

    const result = await session.switchModel('tiny')

    expect(result.success).toBe(true)
    expect(session.getMessages()).toEqual(before)
    expect(adapter.summaries).toBe(0)
  })
})
