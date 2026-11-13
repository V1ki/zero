import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRetriever } from '@zero-os/memory'
import type { ProviderAdapter, ResolvedModel } from '@zero-os/model'
import { SessionDB, SessionEventStore } from '@zero-os/observe'
import {
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type Message,
  SESSION_EVENT_FILE,
  type SessionEvent,
  type StreamEvent,
  type SystemConfig,
  type ToolContext,
  type ToolResult,
  getSessionLogRelativeDir,
} from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import { Session } from '../session'
import {
  TEST_API_KEY,
  TEST_SYSTEM_CONFIG,
  createTestModelRouter,
  createTestProjectRoot,
  setSessionAgentForTest,
} from './test-helpers'

/**
 * 恢复只读日志、不改写 canonical(docs/session-log-replay.md 步骤 4、5)。
 */

const OPENAI = 'openai-codex/gpt-5.3-codex-medium'
const DEEPSEEK = 'deepseek/deepseek-v4-pro'

const ROUTER_CONFIG: SystemConfig = {
  ...TEST_SYSTEM_CONFIG,
  providers: {
    ...TEST_SYSTEM_CONFIG.providers,
    deepseek: {
      apiType: 'anthropic-deepseek',
      baseUrl: 'https://example.invalid/anthropic',
      auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
      models: {
        'deepseek-v4-pro': {
          modelId: 'deepseek-v4-pro',
          maxContext: 1000000,
          maxOutput: 384000,
          capabilities: ['tools', 'reasoning'],
          tags: [],
        },
      },
    },
  },
}

/** 输出 size 个字符的工具:控制上下文压力 */
class EmitTool extends BaseTool {
  name = 'emit'
  description = 'Emit text'
  parameters = { type: 'object', properties: { size: { type: 'number' } } }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const size = (input as { size?: number }).size ?? 2
    return { success: true, output: '7'.repeat(size), outputSummary: `emitted ${size}` }
  }
}

type Step = CompletionResponse | Error

function text(value: string): CompletionResponse {
  return {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text: value }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'fake',
  }
}

function emit(size: number): CompletionResponse {
  const id = `call_${Math.random().toString(36).slice(2)}`
  return {
    id: `resp_${id}`,
    content: [{ type: 'tool_use', id, name: 'emit', input: { size } }],
    stopReason: 'tool_use',
    usage: { input: 1, output: 1 },
    model: 'fake',
  }
}

/**
 * 主 loop 的请求按脚本回复(用完后回复 done)并留存;收尾判定、压缩摘要、记忆检索各有固定回复。
 * apiType 决定 Agent 是否要求签名 thinking。
 */
class FakeAdapter implements ProviderAdapter {
  readonly received: CompletionRequest[] = []
  private script: Step[] = []
  private held?: { started: () => void; release: Promise<void> }

  constructor(readonly apiType: string = 'fake') {}

  push(...steps: Step[]): void {
    this.script.push(...steps)
  }

  hold(): { started: Promise<void>; release: () => void } {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    this.held = { started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const purpose = request.meta?.purpose
    if (purpose === 'task_closure') return text('{"action":"finish","reason":"done"}')
    if (purpose === 'compression') return text('## 用户请求与意图\n测试摘要')
    if (purpose === 'memory_retrieval') return this.retrieval(request)

    this.received.push(structuredClone(request))
    const held = this.held
    if (held) {
      this.held = undefined
      held.started()
      await held.release
    }
    const step = this.script.shift() ?? text('done')
    if (step instanceof Error) throw step
    return step
  }

  private retrieval(request: CompletionRequest): CompletionResponse {
    const searched = request.messages.some((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    )
    if (searched) return text('{"result":[{"id":"mem_pref","reason":"relevant"}]}')
    return {
      id: 'resp_retrieval',
      content: [
        { type: 'tool_use', id: 'call_search', name: 'memory_search', input: { query: 'pref' } },
      ],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
      model: 'fake',
    }
  }

  /** 其余 adapter 从流回退到 complete;DeepSeek 风格的不回退,按 complete 的回复逐块发出 */
  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.apiType !== 'anthropic-deepseek') throw new Error('stream not supported in test')
    const response = await this.complete(request)
    for (const block of response.content) {
      if (block.type === 'text') yield { type: 'text_delta', data: { text: block.text } }
      if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', data: { id: block.id, name: block.name } }
        yield {
          type: 'tool_use_delta',
          data: { id: block.id, arguments: JSON.stringify(block.input) },
        }
        yield { type: 'tool_use_end', data: { id: block.id } }
      }
    }
    yield { type: 'done', data: { finishReason: response.stopReason } }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

const memoryRetriever = {
  async retrieve() {
    return []
  },
  async retrieveScored() {
    return [
      {
        memory: {
          id: 'mem_pref',
          type: 'preference',
          title: 'Answer briefly',
          content: 'The user prefers short answers.',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          status: 'verified',
          confidence: 0.98,
          tags: [],
          related: [],
        },
        score: 0.91,
        scoreBreakdown: { keyword: 0, recency: 1, vector: 0.91 },
      },
    ]
  },
} as unknown as MemoryRetriever

/** 小窗口的模型:turn 内会压缩;它的 adapter 只回答记忆检索 */
function smallModel(): ResolvedModel {
  return {
    providerName: 'fake',
    modelName: 'fake-model',
    modelConfig: {
      modelId: 'fake-model',
      maxContext: 11000,
      maxOutput: 2000,
      capabilities: ['tools', 'vision'],
      tags: [],
    },
    providerConfig: {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://example.invalid',
      auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
      models: {},
    },
    adapter: new FakeAdapter(),
  }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
  const project = createTestProjectRoot('zero-session-restore-')
  const logsDir = mkdtempSync(join(tmpdir(), 'zero-session-restore-logs-'))
  const sessionDb = SessionDB.createInMemory()
  cleanups.push(() => {
    sessionDb.close()
    rmSync(logsDir, { recursive: true, force: true })
    project.cleanup()
  })
  const errors: string[] = []
  const createStore = () =>
    new SessionEventStore({ basePath: logsDir, onError: (message) => errors.push(message) })
  const modelRouter = createTestModelRouter({
    config: ROUTER_CONFIG,
    secrets: new Map([
      ['openai_codex_api_key', TEST_API_KEY],
      ['deepseek_api_key', TEST_API_KEY],
    ]),
  })
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(new EmitTool())
  const baseDeps = {
    sessionDb,
    projectRoot: project.projectRoot,
    identityMemory: 'I am the restore test identity.',
    memoryRetriever,
  }

  const attachAgent = (session: Session, store: SessionEventStore, adapter: FakeAdapter) => {
    setSessionAgentForTest(
      session,
      new Agent(
        { name: 'restore-agent', agentInstruction: 'test', promptMode: 'minimal' },
        adapter,
        toolRegistry,
        {
          sessionId: session.data.id,
          workDir: project.projectRoot,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
        { sessionEvents: store },
      ),
    )
  }

  /** store 为 undefined:事件流上线前的旧会话,只写 DB */
  const createSession = (
    id: string,
    store: SessionEventStore | undefined,
    options: { promptMode: 'full' | 'minimal'; sessionEventsOnly?: boolean },
  ) => {
    const session = new Session(
      'web',
      modelRouter,
      toolRegistry,
      { ...baseDeps, sessionEvents: store, sessionEventsOnly: options.sessionEventsOnly },
      OPENAI,
      id,
    )
    session.initAgent({
      name: 'restore-agent',
      agentInstruction: 'test',
      promptMode: options.promptMode,
    })
    return session
  }

  /** 新进程:新的 store 与 manager(没有 trace)从同一份日志和 DB 恢复 */
  const restore = (id: string, options: { sessionEventsOnly?: boolean } = {}) => {
    const store = createStore()
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      { ...baseDeps, sessionEvents: store, sessionEventsOnly: options.sessionEventsOnly },
      sessionDb,
    )
    const restored = manager.switchCurrentSessionForChannel('web', 'default', id)
    if (!restored) throw new Error('restore failed')
    return { session: restored.session, store }
  }

  const eventFile = (id: string) => join(logsDir, getSessionLogRelativeDir(id), SESSION_EVENT_FILE)

  return {
    sessionDb,
    errors,
    createStore,
    createSession,
    attachAgent,
    restore,
    eventFile,
  }
}

function internals(session: Session) {
  const state = session as unknown as {
    turnRuntime: { nextTurnIndex: number }
    conversation: { injectedMemoryIds: Map<string, string> }
  }
  return {
    nextTurnIndex: state.turnRuntime.nextTurnIndex,
    injectedMemoryIds: state.conversation.injectedMemoryIds,
  }
}

function setActiveModel(session: Session, model: ResolvedModel): void {
  ;(session as unknown as { activeModel: ResolvedModel }).activeModel = model
}

/** 每条带 tool_use 的 assistant 消息后面紧跟带全部对应 tool_result 的 user 消息 */
function expectProviderValid(messages: Message[], requireThinkingForToolUse: boolean): void {
  messages.forEach((message, index) => {
    const uses = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
    if (uses.length === 0) return
    const next = messages[index + 1]
    expect(next?.role).toBe('user')
    const results = new Set(
      next?.content.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : [])),
    )
    for (const id of uses) expect(results.has(id)).toBe(true)
    if (requireThinkingForToolUse) {
      expect(
        message.content.some((block) => block.type === 'thinking' && Boolean(block.signature)),
      ).toBe(true)
    }
  })
}

function toolUseIds(messages: Message[]): string[] {
  return messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])),
  )
}

function message(
  sessionId: string,
  id: string,
  role: Message['role'],
  content: ContentBlock[],
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    sessionId,
    role,
    messageType: 'message',
    content,
    createdAt: '2026-11-13T00:00:00.000Z',
    ...extra,
  }
}

/**
 * 一个封好口的 turn:签名 thinking 的并行工具调用,中间夹着排队消息和后台完成控制消息;
 * 一个无签名 thinking 的工具调用,中间夹着排队消息。
 */
function seedInterleavedTurn(store: SessionEventStore, sessionId: string): Message[] {
  const history: Message[] = [
    message(sessionId, 'm_user', 'user', [{ type: 'text', text: 'start' }]),
    message(sessionId, 'm_parallel', 'assistant', [
      { type: 'thinking', thinking: 'Two tools.', signature: 'sig_1' },
      { type: 'tool_use', id: 'signed_1', name: 'emit', input: {} },
      { type: 'tool_use', id: 'signed_2', name: 'emit', input: {} },
    ]),
    message(sessionId, 'm_queued_1', 'user', [{ type: 'text', text: 'queued during tools' }], {
      messageType: 'queued',
    }),
    message(
      sessionId,
      'm_background',
      'user',
      [{ type: 'text', text: '<system_event type="background_tool.completed" />' }],
      { messageType: 'control', controlKind: 'background_tool_completed' },
    ),
    message(sessionId, 'm_results', 'user', [
      { type: 'tool_result', toolUseId: 'signed_1', content: 'one' },
      { type: 'tool_result', toolUseId: 'signed_2', content: 'two' },
    ]),
    message(sessionId, 'm_unsigned', 'assistant', [
      { type: 'text', text: 'One more without thinking.' },
      { type: 'tool_use', id: 'unsigned_1', name: 'emit', input: {} },
    ]),
    message(sessionId, 'm_queued_2', 'user', [{ type: 'text', text: 'queued again' }], {
      messageType: 'queued',
    }),
    message(sessionId, 'm_unsigned_result', 'user', [
      { type: 'tool_result', toolUseId: 'unsigned_1', content: 'three' },
    ]),
    message(sessionId, 'm_done', 'assistant', [{ type: 'text', text: 'done' }]),
  ]
  store.append(sessionId, [{ type: 'turn/start', data: { turnIndex: 1, trigger: 'channel' } }])
  for (const entry of history) store.appendMessage(sessionId, entry)
  store.append(sessionId, [{ type: 'turn/end', data: { turnIndex: 1, status: 'completed' } }])
  // 与运行时一样,turn 结束时对账并写 checkpoint
  store.syncCanonical(sessionId, { messages: history, blocks: [] })
  return history
}

function lastRetrievalStatus(events: SessionEvent[]): string | undefined {
  const end = events.findLast((event) => event.type === 'memory/retrieval/end')
  return end?.type === 'memory/retrieval/end' ? end.data.status : undefined
}

describe('restore is read-only', () => {
  test('interleaved and unsigned tool calls survive restores under both adapters and a model switch', async () => {
    const { errors, createStore, createSession, attachAgent, restore, eventFile } = setup()
    const id = 'sess_restore_read_only'
    const seedStore = createStore()
    createSession(id, seedStore, { promptMode: 'minimal' })
    const history = seedInterleavedTurn(seedStore, id)

    // 普通 adapter:日志一个字节不变,canonical 原样,下一次请求合法
    const beforeFirst = readFileSync(eventFile(id), 'utf-8')
    const first = restore(id)
    expect(readFileSync(eventFile(id), 'utf-8')).toEqual(beforeFirst)
    expect(first.session.getMessages()).toEqual(history)
    const plain = new FakeAdapter()
    attachAgent(first.session, first.store, plain)
    await first.session.handleMessage('continue please')
    expectProviderValid(plain.received[0].messages, false)
    expect(toolUseIds(plain.received[0].messages)).toEqual(['signed_1', 'signed_2', 'unsigned_1'])
    const canonical = first.session.getMessages()
    expect(canonical.slice(0, history.length)).toEqual(history)

    // 切到 DeepSeek 风格的模型再恢复:不删无签名的工具调用,请求里才清理
    expect((await first.session.switchModel(DEEPSEEK)).success).toBe(true)
    const beforeSecond = readFileSync(eventFile(id), 'utf-8')
    const second = restore(id)
    expect(readFileSync(eventFile(id), 'utf-8')).toEqual(beforeSecond)
    expect(second.session.getMessages()).toEqual(canonical)
    const deepseek = new FakeAdapter('anthropic-deepseek')
    attachAgent(second.session, second.store, deepseek)
    await second.session.handleMessage('and continue again')
    expectProviderValid(deepseek.received[0].messages, true)
    expect(toolUseIds(deepseek.received[0].messages)).toEqual(['signed_1', 'signed_2'])

    // 切回去再恢复:canonical 什么都没丢
    expect((await second.session.switchModel(OPENAI)).success).toBe(true)
    const third = restore(id)
    expect(toolUseIds(third.session.getMessages())).toEqual(['signed_1', 'signed_2', 'unsigned_1'])
    expect(third.session.getMessages()).toEqual(second.session.getMessages())
    expect(third.store.readEvents(id).some((event) => event.type === 'messages/truncate')).toBe(
      false,
    )
    expect(errors).toEqual([])
  })
})

describe('restore rebuilds session state from the log', () => {
  for (const fileOnly of [false, true]) {
    test(`restored session equals the live one${fileOnly ? ' (file-only, empty DB rows)' : ''}`, async () => {
      const { sessionDb, errors, createStore, createSession, attachAgent, restore } = setup()
      const id = fileOnly ? 'sess_restore_file_only' : 'sess_restore_equivalence'
      const store = createStore()
      const live = createSession(id, store, { promptMode: 'full', sessionEventsOnly: fileOnly })
      setActiveModel(live, smallModel())
      const adapter = new FakeAdapter()
      attachAgent(live, store, adapter)

      // turn 1:注入记忆、turn 内压缩、一条排队消息
      adapter.push(emit(9000), emit(9000), emit(9000))
      const held = adapter.hold()
      const turn = live.handleMessage('please remember my preferences')
      await held.started
      await live.handleMessage('while busy')
      held.release()
      await turn
      // turn 2:正常;turn 3:失败回滚(turn 编号照样前进,消息不留)
      adapter.push(text('two'), new Error('main model down'))
      await live.handleMessage('second turn with my preferences')
      await expect(live.handleMessage('this turn fails please')).rejects.toThrow('main model down')

      const events = store.readEvents(id)
      expect(
        events.some(
          (event) => event.type === 'compaction/start' && event.data.trigger === 'in_turn',
        ),
      ).toBe(true)
      expect(live.getContextCheckpoint()).toBeDefined()
      expect(internals(live).injectedMemoryIds).toEqual(new Map([['mem_pref', 'Answer briefly']]))
      expect(internals(live).nextTurnIndex).toBe(4)

      // DB 的系统提示词过期;file-only 时大字段为空
      sessionDb.saveSession(
        live.data,
        JSON.stringify(live.getAgentConfig()),
        'stale system prompt from the DB row',
      )
      if (fileOnly) {
        sessionDb.saveMessages(id, [])
        sessionDb.saveCompactionBlocks(id, [])
        sessionDb.saveContextCheckpoint(id, undefined)
      }

      const { session: restored, store: restoredStore } = restore(id, {
        sessionEventsOnly: fileOnly,
      })
      expect(restored.getMessages()).toEqual(live.getMessages())
      expect(restored.getContextCheckpoint()).toEqual(live.getContextCheckpoint())
      expect(restored.getSystemPrompt()).toBe(live.getSystemPrompt())
      expect(internals(restored).nextTurnIndex).toBe(internals(live).nextTurnIndex)
      expect(internals(restored).injectedMemoryIds).toEqual(internals(live).injectedMemoryIds)

      // 下一个 turn:编号接着走,已注入的记忆不再注入
      setActiveModel(restored, smallModel())
      const next = new FakeAdapter()
      attachAgent(restored, restoredStore, next)
      await restored.handleMessage('one more with my preferences')
      const after = restoredStore.readEvents(id).slice(events.length)
      const turnStart = after.find((event) => event.type === 'turn/start')
      expect(turnStart?.type === 'turn/start' && turnStart.data.turnIndex).toBe(4)
      expect(lastRetrievalStatus(after)).toBe('skipped')
      expect(JSON.stringify(next.received)).not.toContain('<retrieved_memories>')
      expect(errors).toEqual([])
    })
  }
})

describe('restore without an event file', () => {
  test('falls back to the DB row and message-derived turn index', async () => {
    const { sessionDb, errors, createSession, restore, eventFile } = setup()
    const id = 'sess_restore_db_only'
    const legacy = createSession(id, undefined, { promptMode: 'minimal' })
    const history = [
      message(id, 'm_first', 'user', [{ type: 'text', text: 'first' }]),
      message(id, 'm_reply', 'assistant', [{ type: 'text', text: 'reply' }]),
    ]
    sessionDb.saveMessages(id, history)
    sessionDb.saveSession(
      legacy.data,
      JSON.stringify(legacy.getAgentConfig()),
      'system prompt from the DB row',
    )

    const { session: restored, store } = restore(id)

    expect(restored.getMessages()).toEqual(history)
    expect(restored.getSystemPrompt()).toBe('system prompt from the DB row')
    expect(internals(restored).nextTurnIndex).toBe(2)
    expect(internals(restored).injectedMemoryIds.size).toBe(0)
    // DB 快照写进了新建的事件文件,之后按下标即时追加
    expect(readFileSync(eventFile(id), 'utf-8')).toContain('m_reply')
    expect(store.project(id)?.messages).toEqual(history)
    expect(errors).toEqual([])
  })
})
