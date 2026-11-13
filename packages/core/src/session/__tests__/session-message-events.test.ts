import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionDB, SessionEventStore } from '@zero-os/observe'
import {
  type CompletionRequest,
  type CompletionResponse,
  type Message,
  type SessionEvent,
  type StreamEvent,
  type ToolResult,
  isMessageAppendEvent,
} from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'
import {
  createTestModelRouter,
  createTestProjectRoot,
  setSessionAgentForTest,
} from './test-helpers'

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Do nothing'
  parameters = { type: 'object', properties: {} }

  protected async execute(): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

/**
 * 每个 turn:toolSteps 次 noop 工具调用后回复 done。failing 时主模型请求失败;
 * hold 设置后第一次主模型请求等到 release 才返回。
 */
class ScriptedAdapter implements ProviderAdapter {
  readonly apiType = 'fake-scripted'
  toolSteps = 1
  failing = false
  private calls = 0
  private held?: { started: () => void; release: Promise<void> }

  hold(): { started: Promise<void>; release: () => void } {
    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.held = { started, release: releasePromise }
    return { started: startedPromise, release }
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.meta?.purpose === 'task_closure') {
      return reply('closure', [{ type: 'text', text: '{"action":"finish","reason":"done"}' }])
    }
    if (this.failing) throw new Error('main model down')
    const held = this.held
    if (held) {
      this.held = undefined
      held.started()
      await held.release
    }
    // 上一条是工具结果说明在 turn 中途;否则是新 turn 的第一步
    const last = req.messages.at(-1)
    const inTurn = last?.content.some((block) => block.type === 'tool_result') ?? false
    this.calls = inTurn ? this.calls + 1 : 1
    if (this.calls <= this.toolSteps) {
      return reply(
        `resp_${this.calls}`,
        [{ type: 'tool_use', id: `call_${Date.now()}_${this.calls}`, name: 'noop', input: {} }],
        'tool_use',
      )
    }
    return reply('resp_done', [{ type: 'text', text: 'done' }])
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function reply(
  id: string,
  content: CompletionResponse['content'],
  stopReason: CompletionResponse['stopReason'] = 'end_turn',
): CompletionResponse {
  return { id, content, stopReason, usage: { input: 1, output: 1 }, model: 'fake' }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
  const project = createTestProjectRoot('zero-session-message-events-')
  const logsDir = mkdtempSync(join(tmpdir(), 'zero-session-message-events-logs-'))
  const sessionDb = SessionDB.createInMemory()
  cleanups.push(() => {
    sessionDb.close()
    rmSync(logsDir, { recursive: true, force: true })
    project.cleanup()
  })
  const errors: string[] = []
  const createStore = () =>
    new SessionEventStore({ basePath: logsDir, onError: (message) => errors.push(message) })
  const store = createStore()
  const modelRouter = createTestModelRouter()
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(new NoopTool())
  const adapter = new ScriptedAdapter()

  const attachAgent = (session: Session, sessionEvents: SessionEventStore | undefined) => {
    setSessionAgentForTest(
      session,
      new Agent(
        { name: 'events-agent', agentInstruction: 'test', promptMode: 'minimal' },
        adapter,
        toolRegistry,
        {
          sessionId: session.data.id,
          workDir: project.projectRoot,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
        { sessionEvents },
      ),
    )
  }

  /** withoutEvents:事件流上线前的旧会话,只写 DB */
  const createSession = (id: string, options: { withoutEvents?: boolean } = {}) => {
    const sessionEvents = options.withoutEvents ? undefined : store
    const session = new Session(
      'web',
      modelRouter,
      toolRegistry,
      { sessionDb, sessionEvents, projectRoot: project.projectRoot },
      undefined,
      id,
    )
    session.initAgent({ name: 'events-agent', agentInstruction: 'test', promptMode: 'minimal' })
    attachAgent(session, sessionEvents)
    return session
  }

  /** 新进程:新的 store 实例与 manager 从同一份日志和 DB 恢复 */
  const restore = (id: string) => {
    const restoredStore = createStore()
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { sessionDb, sessionEvents: restoredStore, projectRoot: project.projectRoot },
      sessionDb,
    )
    const restored = manager.switchCurrentSessionForChannel('web', 'default', id)
    if (!restored) throw new Error('restore failed')
    attachAgent(restored.session, restoredStore)
    return { session: restored.session, store: restoredStore }
  }

  return { store, adapter, errors, createSession, restore }
}

function messageEvents(events: SessionEvent[]) {
  return events.filter(isMessageAppendEvent)
}

function truncates(events: SessionEvent[]) {
  return events.flatMap((event) => (event.type === 'messages/truncate' ? [event.data] : []))
}

describe('Session message events', () => {
  test('a normal turn writes each message once, interleaved with step and tool events', async () => {
    const { store, errors, createSession } = setup()
    const session = createSession('sess_events_normal')

    await session.handleMessage('first')
    await session.handleMessage('second')

    const events = store.readEvents('sess_events_normal')
    const canonical = session.getMessages()
    expect(messageEvents(events).map((event) => event.data.message)).toEqual(canonical)
    expect(truncates(events)).toEqual([])
    expect(errors).toEqual([])

    // 第二个 turn 内的顺序
    const turnStart = events.findLast((event) => event.type === 'turn/start')
    const turnEvents = events.filter(
      (event) =>
        event.seq >= (turnStart?.seq ?? Number.POSITIVE_INFINITY) &&
        [
          'turn/start',
          'turn/end',
          'user/message',
          'assistant/message',
          'step/start',
          'tool/call',
          'tool/result',
        ].includes(event.type),
    )
    expect(turnEvents.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'user/message',
      'step/start',
      'assistant/message',
      'turn/end',
    ])
    // 请求前的注入写在 user 消息与 step/start 之间
    const firstStep = turnEvents[2]
    for (const injection of events.filter(
      (event) => event.type === 'injection/context' && event.seq > (turnStart?.seq ?? 0),
    )) {
      if (injection.seq < firstStep.seq) expect(injection.seq).toBeGreaterThan(turnEvents[1].seq)
    }
    // turn 结束的对账只补 checkpoint
    expect(events.at(-1)?.type).toBe('checkpoint')
    expect(events.at(-1)?.data).toMatchObject({ messageCount: canonical.length })
  })

  test('a failed turn that rolls back writes a turn_failed truncate', async () => {
    const { store, adapter, errors, createSession } = setup()
    const session = createSession('sess_events_failed')
    await session.handleMessage('first')
    const before = session.getMessages()

    adapter.failing = true
    await expect(session.handleMessage('second')).rejects.toThrow('main model down')

    const events = store.readEvents('sess_events_failed')
    expect(session.getMessages()).toEqual(before)
    expect(store.project('sess_events_failed')?.messages).toEqual(before)
    expect(truncates(events)).toEqual([{ toMessageIndex: before.length, reason: 'turn_failed' }])
    // 失败 turn 的 user 消息在请求前已写入,随后被截断
    const failedTurnStart = events.findLast((event) => event.type === 'turn/start')
    expect(
      messageEvents(events).filter((event) => event.seq > (failedTurnStart?.seq ?? 0)),
    ).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('a tail rollback writes an admin truncate', async () => {
    const { store, errors, createSession } = setup()
    const session = createSession('sess_events_tail')
    await session.handleMessage('first')
    const before = session.getMessages()

    const result = session.rollbackTailMessages(2, { dryRun: false })

    expect(result.ok).toBe(true)
    expect(store.project('sess_events_tail')?.messages).toEqual(before.slice(0, -2))
    expect(truncates(store.readEvents('sess_events_tail'))).toEqual([
      { toMessageIndex: before.length - 2, reason: 'admin' },
    ])
    expect(errors).toEqual([])
  })

  test('an external recall writes a recall truncate and re-appends the rest', async () => {
    const { store, errors, createSession } = setup()
    const session = createSession('sess_events_recall')
    const source = { channelType: 'web' as const, channelId: 'c1', messageId: 'ext_1' }
    await session.handleMessage('to be recalled', { source })
    await session.handleMessage('later')

    const result = session.markExternalMessageRecalled({ source, recalledAt: '2026-11-13' })

    expect(result.status).toBe('recalled')
    expect(store.project('sess_events_recall')?.messages).toEqual(session.getMessages())
    expect(truncates(store.readEvents('sess_events_recall'))).toEqual([
      { toMessageIndex: 0, reason: 'recall' },
    ])
    expect(errors).toEqual([])
  })

  test('a message queued mid-turn is written once, when it is queued', async () => {
    const { store, adapter, errors, createSession } = setup()
    const session = createSession('sess_events_queued')
    adapter.toolSteps = 1
    const held = adapter.hold()

    const turn = session.handleMessage('first')
    await held.started
    await session.handleMessage('while busy')

    const queuedEvents = () =>
      messageEvents(store.readEvents('sess_events_queued')).filter(
        (event) => event.data.message.messageType === 'queued',
      )
    expect(queuedEvents()).toHaveLength(1)
    const queuedSeq = queuedEvents()[0].seq

    held.release()
    await turn

    const events = store.readEvents('sess_events_queued')
    expect(queuedEvents()).toHaveLength(1)
    expect(queuedEvents()[0].seq).toBe(queuedSeq)
    // 排队时 turn 第一步的请求还没返回:之后的消息都排在它后面
    const assistantSeqs = messageEvents(events)
      .filter((event) => event.type === 'assistant/message')
      .map((event) => event.seq)
    expect(assistantSeqs.every((seq) => seq > queuedSeq)).toBe(true)
    expect(messageEvents(events).map((event) => event.data.message)).toEqual(session.getMessages())
    expect(truncates(events)).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('Session restore without an event file', () => {
  test('the DB snapshot is written to the log so later messages get the right indexes', async () => {
    const { errors, createSession, restore } = setup()
    const legacy = createSession('sess_legacy', { withoutEvents: true })
    await legacy.handleMessage('before the event log')
    const before = legacy.getMessages()

    const { session, store } = restore('sess_legacy')
    expect(store.project('sess_legacy')?.messages).toEqual(before)

    await session.handleMessage('after')
    const events = store.readEvents('sess_legacy')
    expect(messageEvents(events).map((event) => event.data.messageIndex)).toEqual(
      session.getMessages().map((_, index) => index),
    )
    expect(store.project('sess_legacy')?.messages).toEqual(session.getMessages())
    expect(truncates(events)).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('Session restore seals a turn the process did not finish', () => {
  function crashedTurn(
    store: SessionEventStore,
    sessionId: string,
    messages: Array<Omit<Message, 'id' | 'sessionId' | 'createdAt'>>,
  ) {
    const turnStartSeq = store.append(sessionId, [
      {
        type: 'turn/start',
        data: {
          turnIndex: 2,
          trigger: 'channel',
          baseSeq: store.getLastSeq(sessionId) ?? undefined,
        },
      },
    ])
    messages.forEach((message, index) => {
      store.appendMessage(sessionId, {
        ...message,
        id: `crashed_${index}`,
        sessionId,
        createdAt: '2026-11-13T00:00:00.000Z',
      })
    })
    return turnStartSeq as number
  }

  test('a turn without a completed assistant message is rolled back, queued messages kept', async () => {
    const { store, errors, createSession, restore } = setup()
    const session = createSession('sess_crash_rollback')
    await session.handleMessage('first')
    const before = session.getMessages()
    crashedTurn(store, 'sess_crash_rollback', [
      { role: 'user', messageType: 'message', content: [{ type: 'text', text: 'crashed' }] },
      { role: 'user', messageType: 'queued', content: [{ type: 'text', text: 'queued' }] },
    ])

    const first = restore('sess_crash_rollback')

    const queued = expect.objectContaining({ id: 'crashed_1', messageType: 'queued' })
    expect(first.session.getMessages()).toEqual([...before, queued])
    const events = first.store.readEvents('sess_crash_rollback')
    expect(truncates(events)).toEqual([{ toMessageIndex: before.length, reason: 'restore_repair' }])
    expect(events.findLast((event) => event.type === 'turn/end')?.data).toEqual({
      turnIndex: 2,
      status: 'failed',
      reason: 'process_restart',
    })

    // 封口后再恢复不再改动
    const lastSeq = first.store.getLastSeq('sess_crash_rollback')
    const second = restore('sess_crash_rollback')
    expect(second.store.getLastSeq('sess_crash_rollback')).toBe(lastSeq)
    expect(second.session.getMessages()).toEqual(first.session.getMessages())

    // 下一个 turn 正常运行
    await second.session.handleMessage('after restart')
    expect(second.session.getMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
    expect(second.store.project('sess_crash_rollback')?.messages).toEqual(
      second.session.getMessages(),
    )
    expect(errors).toEqual([])
  })

  test('a turn with completed work keeps it', async () => {
    const { store, errors, createSession, restore } = setup()
    const session = createSession('sess_crash_keep')
    await session.handleMessage('first')
    const before = session.getMessages()
    crashedTurn(store, 'sess_crash_keep', [
      { role: 'user', messageType: 'message', content: [{ type: 'text', text: 'crashed' }] },
      {
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_use', id: 'call_crashed', name: 'noop', input: {} }],
      },
      {
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_crashed', content: 'ok' }],
      },
    ])

    const first = restore('sess_crash_keep')

    const messages = first.session.getMessages()
    expect(messages.slice(0, before.length)).toEqual(before)
    expect(messages.slice(before.length).map((message) => message.id)).toEqual([
      'crashed_0',
      'crashed_1',
      'crashed_2',
    ])
    const events = first.store.readEvents('sess_crash_keep')
    expect(truncates(events)).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { turnIndex: 2, status: 'failed', reason: 'process_restart' },
    })

    const second = restore('sess_crash_keep')
    expect(second.store.getLastSeq('sess_crash_keep')).toBe(
      first.store.getLastSeq('sess_crash_keep'),
    )

    await second.session.handleMessage('after restart')
    expect(second.session.getMessages().at(-1)).toMatchObject({ role: 'assistant' })
    expect(second.store.project('sess_crash_keep')?.messages).toEqual(second.session.getMessages())
    expect(errors).toEqual([])
  })
})
