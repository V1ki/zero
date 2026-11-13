import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRetriever } from '@zero-os/memory'
import type { ModelRouter, ProviderAdapter, ResolvedModel } from '@zero-os/model'
import { SessionDB, SessionEventStore } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  SessionEvent,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import { AgentControl } from '../../agent/agent-control'
import { type AssembledRequest, assembleRequest, hashRequest } from '../../agent/request-assembly'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { SpawnAgentTool } from '../../tool/spawn-agent'
import { SessionManager } from '../manager'
import { Session } from '../session'
import {
  createTestModelRouter,
  createTestProjectRoot,
  setSessionAgentForTest,
} from './test-helpers'

/**
 * 请求重放等价(docs/session-log-replay.md 步骤 3):对日志里每一条 step/start,
 * 事件记下的 requestHash、fake adapter 实际收到的请求的 hash、assembleRequest(重放日志)的 hash 三者相等。
 */

/** 输出 size 个字符的工具:控制上下文压力 */
class EmitTool extends BaseTool {
  name = 'emit'
  description = 'Emit text'
  parameters = { type: 'object', properties: { size: { type: 'number' } } }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const size = (input as { size?: number }).size ?? 2
    const output = Array.from({ length: size }, (_, index) => String(index % 10)).join('')
    return { success: true, output, outputSummary: `emitted ${size}` }
  }
}

/** 执行到一半等放行的工具:在 tool_use 与 tool_result 之间排队消息 */
class GateTool extends BaseTool {
  name = 'gate'
  description = 'Wait for the test'
  parameters = { type: 'object', properties: {} }
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()

  protected async execute(): Promise<ToolResult> {
    this.started.resolve()
    await this.release.promise
    return { success: true, output: 'gate opened', outputSummary: 'gate opened' }
  }
}

const MAIN_PURPOSES = new Set(['agent_loop', 'memory_nudge', 'sub_agent'])

type Step = CompletionResponse | Error | ((request: CompletionRequest) => CompletionResponse)

function text(value: string): CompletionResponse {
  return {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text: value }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'fake',
  }
}

function emit(size = 2): CompletionResponse {
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
 * 主 loop 的请求按脚本依次回复(每条 step/start 对应一次),并深拷贝留存实际收到的请求;
 * 收尾判定、压缩摘要、记忆检索各有固定回复。
 */
class ReplayAdapter implements ProviderAdapter {
  readonly apiType = 'fake-replay'
  readonly received: CompletionRequest[] = []
  private script: Step[] = []
  /** 脚本用完后的回复;不设时报错 */
  otherwise?: (request: CompletionRequest) => CompletionResponse
  private held?: {
    when: (request: CompletionRequest) => boolean
    started: () => void
    release: Promise<void>
  }

  push(...steps: Step[]): void {
    this.script.push(...steps)
  }

  /** 下一个(满足 when 的)主 loop 请求等到 release 才返回 */
  hold(when: (request: CompletionRequest) => boolean = () => true): {
    started: Promise<void>
    release: () => void
  } {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    this.held = { when, started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const purpose = request.meta?.purpose
    if (purpose === 'task_closure') return text('{"action":"finish","reason":"done"}')
    if (purpose === 'compression') return text('## 用户请求与意图\n测试摘要')
    if (purpose === 'memory_retrieval') return this.retrieval(request)
    if (!purpose || !MAIN_PURPOSES.has(purpose)) throw new Error(`unexpected purpose ${purpose}`)

    this.received.push(structuredClone(request))
    const held = this.held
    if (held?.when(request)) {
      this.held = undefined
      held.started()
      await held.release
    }
    const step = this.script.shift() ?? this.otherwise
    if (!step) throw new Error(`no scripted reply for request ${this.received.length}`)
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(request) : step
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

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
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

function fakeModel(
  adapter: ProviderAdapter,
  options: { maxContext?: number; maxOutput?: number; vision?: boolean } = {},
): ResolvedModel {
  return {
    providerName: 'fake',
    modelName: 'fake-model',
    modelConfig: {
      modelId: 'fake-model',
      maxContext: options.maxContext ?? 400000,
      maxOutput: options.maxOutput ?? 128000,
      capabilities: options.vision === false ? ['tools'] : ['tools', 'vision'],
      tags: [],
    },
    providerConfig: {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://example.invalid',
      auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
      models: {},
    },
    adapter,
  }
}

const PNG = Buffer.from('not really a png, only its bytes matter').toString('base64')
const JPEG = Buffer.from('another image payload').toString('base64')

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
  const project = createTestProjectRoot('zero-request-replay-')
  const logsDir = mkdtempSync(join(tmpdir(), 'zero-request-replay-logs-'))
  const sessionDb = SessionDB.createInMemory()
  cleanups.push(() => {
    sessionDb.close()
    rmSync(logsDir, { recursive: true, force: true })
    project.cleanup()
  })
  const errors: string[] = []
  const createStore = () =>
    new SessionEventStore({ basePath: logsDir, onError: (message) => errors.push(message) })
  let store = createStore()
  const modelRouter = createTestModelRouter()
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(new EmitTool())
  const adapter = new ReplayAdapter()

  const attachAgent = (
    session: Session,
    sessionEvents: SessionEventStore,
    promptMode: 'full' | 'minimal',
  ) => {
    setSessionAgentForTest(
      session,
      new Agent(
        { name: 'replay-agent', agentInstruction: 'test', promptMode },
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

  const createSession = (
    id: string,
    options: {
      /** 主 agent 的 promptMode:full 才有记忆提醒 */
      agentPromptMode?: 'full' | 'minimal'
      /** 会话的 promptMode:full 才做开场记忆检索 */
      sessionPromptMode?: 'full' | 'minimal'
      model?: ResolvedModel
    } = {},
  ) => {
    const session = new Session(
      'web',
      modelRouter,
      toolRegistry,
      {
        sessionDb,
        sessionEvents: store,
        projectRoot: project.projectRoot,
        identityMemory: 'I am the replay test identity.',
        memoryRetriever,
      },
      undefined,
      id,
    )
    session.initAgent({
      name: 'replay-agent',
      agentInstruction: 'test',
      promptMode: options.sessionPromptMode ?? 'minimal',
    })
    if (options.model) {
      ;(session as unknown as { activeModel: ResolvedModel }).activeModel = options.model
    }
    attachAgent(session, store, options.agentPromptMode ?? 'minimal')
    return session
  }

  /** 新进程:新的 store 实例与 manager 从同一份日志和 DB 恢复 */
  const restore = (id: string) => {
    store = createStore()
    const manager = new SessionManager(
      modelRouter,
      toolRegistry,
      {
        sessionDb,
        sessionEvents: store,
        projectRoot: project.projectRoot,
        identityMemory: 'I am the replay test identity.',
      },
      sessionDb,
    )
    const restored = manager.switchCurrentSessionForChannel('web', 'default', id)
    if (!restored) throw new Error('restore failed')
    attachAgent(restored.session, store, 'minimal')
    return restored.session
  }

  return {
    adapter,
    errors,
    logsDir,
    project,
    toolRegistry,
    getStore: () => store,
    createSession,
    restore,
  }
}

function sentRequest(request: CompletionRequest): AssembledRequest {
  return {
    system: request.system ?? '',
    toolNames: (request.tools ?? []).map((tool) => tool.name),
    messages: request.messages,
  }
}

/** 每条 step/start:记录的 hash == adapter 收到的请求的 hash == 重放组装的 hash */
function expectReplayEquality(
  store: SessionEventStore,
  sessionId: string,
  received: CompletionRequest[],
): SessionEvent[] {
  const events = store.readEvents(sessionId)
  const steps = events.filter((event) => event.type === 'step/start')
  expect(steps.length).toBe(received.length)
  steps.forEach((step, index) => {
    if (step.type !== 'step/start') throw new Error('not a step/start')
    const input = store.getRequestAssemblyInput(sessionId, step.seq)
    if (!input) throw new Error(`step/start ${step.seq} is not reconstructable`)
    const replayed = assembleRequest(input)
    const sent = sentRequest(received[index])
    // 先比结构,失败时能看出差在哪;hash 才是判据
    expect(replayed.system).toBe(sent.system)
    expect(replayed.toolNames).toEqual(sent.toolNames)
    expect(replayed.messages.map((message) => message.id)).toEqual(
      sent.messages.map((message) => message.id),
    )
    expect(hashRequest(replayed)).toBe(hashRequest(sent))
    expect(step.data.requestHash).toBe(hashRequest(sent))
  })
  return events
}

function countEvents(events: SessionEvent[], predicate: (event: SessionEvent) => boolean): number {
  return events.filter(predicate).length
}

function compactionEnds(events: SessionEvent[]) {
  return events.flatMap((event) => (event.type === 'compaction/end' ? [event.data.status] : []))
}

function compactionTriggers(events: SessionEvent[]) {
  return events.flatMap((event) => (event.type === 'compaction/start' ? [event.data.trigger] : []))
}

describe('every step/start replays to the request that was sent', () => {
  test('plain multi-turn chat, with identity memory in the system text and an image', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_chat')
    adapter.push(text('one'), text('two'), text('three'))

    await session.handleMessage('first')
    await session.handleMessage('look', { images: [{ mediaType: 'image/png', data: PNG }] })
    await session.handleMessage('third')

    const events = expectReplayEquality(getStore(), 'sess_replay_chat', adapter.received)
    expect(adapter.received[0].system).toContain('I am the replay test identity.')
    const prompt = events.find((event) => event.type === 'system/prompt')
    expect(prompt?.type === 'system/prompt' && prompt.data.identity).toBe(
      'I am the replay test identity.',
    )
    // 图片以 base64 发出,日志里是 imageRef
    expect(
      adapter.received[1].messages.at(-1)?.content.some((block) => block.type === 'image'),
    ).toBe(true)
    expect(errors).toEqual([])
  })

  test('a multi-step tool turn', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_tools')
    adapter.push(emit(), emit(), emit(), text('done'), text('again'))

    await session.handleMessage('use tools')
    await session.handleMessage('next')

    expectReplayEquality(getStore(), 'sess_replay_tools', adapter.received)
    expect(adapter.received).toHaveLength(5)
    expect(errors).toEqual([])
  })

  test('retrieved memories in the dynamic context of the first user message', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_dynamic', {
      sessionPromptMode: 'full',
      model: fakeModel(new ReplayAdapter()),
    })
    adapter.push(emit(), text('done'), text('second turn'))

    await session.handleMessage('please remember my preferences')
    await session.handleMessage('and again with my preferences')

    const events = expectReplayEquality(getStore(), 'sess_replay_dynamic', adapter.received)
    const dynamic = events.filter(
      (event) => event.type === 'injection/context' && event.data.kind === 'dynamic',
    )
    expect(dynamic.length).toBeGreaterThan(0)
    expect(JSON.stringify(adapter.received[0].messages.at(-1))).toContain('<retrieved_memories>')
    expect(errors).toEqual([])
  })

  test('image delegation for a model without vision', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_delegation', {
      model: fakeModel(new ReplayAdapter(), { vision: false }),
    })
    adapter.push(emit(), text('done'))

    await session.handleMessage('what is in this picture', {
      images: [{ mediaType: 'image/png', data: PNG }],
    })

    const events = expectReplayEquality(getStore(), 'sess_replay_delegation', adapter.received)
    expect(
      countEvents(
        events,
        (event) => event.type === 'injection/context' && event.data.kind === 'image_delegation',
      ),
    ).toBe(1)
    // 请求里的首条 user 消息去掉了图片,canonical 里还在
    const firstUser = adapter.received[0].messages.at(-1)
    expect(firstUser?.content.some((block) => block.type === 'image')).toBe(false)
    expect(session.getMessages()[0].content.some((block) => block.type === 'image')).toBe(true)
    expect(errors).toEqual([])
  })

  test('a message queued mid-turn, with an image, is merged into the next request', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_queued')
    // 处理完排队消息但没说完成:loop 追加一次 continuation
    adapter.push(emit(), text('handled the queued message'), text('done'), text('next turn'))
    const held = adapter.hold()

    const turn = session.handleMessage('first')
    await held.started
    await session.handleMessage('while busy', { images: [{ mediaType: 'image/jpeg', data: JPEG }] })
    held.release()
    await turn
    await session.handleMessage('after')

    const events = expectReplayEquality(getStore(), 'sess_replay_queued', adapter.received)
    const merges = events.filter(
      (event) => event.type === 'injection/context' && event.data.kind === 'queued_merge',
    )
    expect(merges).toHaveLength(1)
    const merged = adapter.received[1].messages.at(-1)
    expect(merged?.content.some((block) => block.type === 'image')).toBe(true)
    expect(errors).toEqual([])
  })

  test('in-turn compaction that only prunes, re-applying injections and a queued merge', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_prune', {
      model: fakeModel(new ReplayAdapter(), { maxContext: 11000, maxOutput: 2000, vision: false }),
    })
    adapter.push(emit(9000), emit(9000), emit(9000))
    adapter.otherwise = () => text('done')
    const held = adapter.hold()

    // 首条 user 消息带图片委托注入;第一步返回前排队一条消息,拼进第一个工具结果;压缩重建后两者都要补回
    const turn = session.handleMessage('produce big outputs', {
      images: [{ mediaType: 'image/png', data: PNG }],
    })
    await held.started
    await session.handleMessage('while busy')
    held.release()
    await turn
    await session.handleMessage('after')

    const events = expectReplayEquality(getStore(), 'sess_replay_prune', adapter.received)
    expect(compactionTriggers(events)).toContain('in_turn')
    expect(compactionEnds(events)).toContain('pruned')
    expect(compactionEnds(events)).not.toContain('summarized')
    const checkpointSeq = events.find((event) => event.type === 'compaction/checkpoint')?.seq ?? 0
    const firstStepAfterRebuild = events.findIndex(
      (event) => event.type === 'step/start' && event.seq > checkpointSeq,
    )
    const rebuilt =
      adapter.received[
        events.slice(0, firstStepAfterRebuild).filter((event) => event.type === 'step/start').length
      ]
    const serialized = JSON.stringify(rebuilt.messages)
    expect(serialized).toContain('<image_delegation>')
    expect(serialized).toContain('while busy')
    expect(errors).toEqual([])
  })

  test('in-turn compaction with a summary', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_summary', {
      model: fakeModel(new ReplayAdapter(), { maxContext: 9000, maxOutput: 2000 }),
    })
    adapter.push(...Array.from({ length: 10 }, () => emit(1900)), text('done'), text('next'))

    await session.handleMessage('many medium outputs')
    await session.handleMessage('after')

    const events = expectReplayEquality(getStore(), 'sess_replay_summary', adapter.received)
    expect(compactionTriggers(events)).toContain('in_turn')
    expect(compactionEnds(events)).toContain('summarized')
    expect(errors).toEqual([])
  })

  test('compaction at turn start', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_turn_start', {
      model: fakeModel(new ReplayAdapter(), { maxContext: 14000, maxOutput: 2000 }),
    })
    adapter.push(emit(9000), text('x'.repeat(30000)), emit(), text('done'))

    await session.handleMessage('first')
    await session.handleMessage('second')

    const events = expectReplayEquality(getStore(), 'sess_replay_turn_start', adapter.received)
    expect(compactionTriggers(events)).toEqual(['turn_start'])
    expect(errors).toEqual([])
  })

  test('a turn with a memory nudge; the nudge messages stay out of later turns', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_nudge', { agentPromptMode: 'full' })
    // 正常两步 → 记忆提醒:提醒回复先调一次工具,再给出结论 → 下一个 turn
    adapter.push(emit(), text('done'), emit(), text('nothing to record'), text('next turn'))

    await session.handleMessage('a task worth remembering')
    await session.handleMessage('next')

    const events = expectReplayEquality(getStore(), 'sess_replay_nudge', adapter.received)
    expect(adapter.received[2].meta?.purpose).toBe('memory_nudge')
    // 提醒 prompt、提醒阶段的 assistant(tool_use)、工具结果、结论
    expect(countEvents(events, (event) => event.type === 'request/message')).toBe(4)
    expect(session.getMessages().some((message) => message.controlKind === 'memory_nudge')).toBe(
      false,
    )
    const lastRequest = adapter.received.at(-1)
    expect(lastRequest?.messages.some((message) => message.controlKind === 'memory_nudge')).toBe(
      false,
    )
    expect(errors).toEqual([])
  })

  test('a memory nudge interrupted by a queued message', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_nudge_queued', { agentPromptMode: 'full' })
    adapter.push(emit(), text('done'), emit(), text('answered the queued message'))
    adapter.otherwise = (request) =>
      text(request.meta?.purpose === 'memory_nudge' ? 'nothing to record' : 'done')

    // 记忆提醒请求返回前排队一条消息:提醒阶段的工具结果之后拼进请求,提醒被打断
    const held = adapter.hold((request) => request.meta?.purpose === 'memory_nudge')
    const turn = session.handleMessage('a task worth remembering')
    await held.started
    await session.handleMessage('one more thing')
    held.release()
    await turn

    const events = expectReplayEquality(getStore(), 'sess_replay_nudge_queued', adapter.received)
    const nudgeMessageIds = events.flatMap((event) =>
      event.type === 'request/message' ? [event.data.message.id] : [],
    )
    const merges = events.flatMap((event) =>
      event.type === 'injection/context' && event.data.kind === 'queued_merge' ? [event.data] : [],
    )
    // 排队原文拼进的是提醒阶段的工具结果(只在请求里的消息)
    expect(merges).toHaveLength(1)
    expect(nudgeMessageIds).toContain(merges[0].messageId ?? 'missing messageId')
    expect(errors).toEqual([])
  })

  test('a failed turn followed by a normal one', async () => {
    const { adapter, errors, getStore, createSession } = setup()
    const session = createSession('sess_replay_failed')
    adapter.push(text('one'), emit(), new Error('main model down'), emit(), text('recovered'))

    await session.handleMessage('first')
    await expect(session.handleMessage('second')).rejects.toThrow('main model down')
    await session.handleMessage('third')

    const events = expectReplayEquality(getStore(), 'sess_replay_failed', adapter.received)
    expect(
      events.some((event) => event.type === 'turn/end' && event.data.status === 'failed'),
    ).toBe(true)
    expect(errors).toEqual([])
  })

  test('a restored session', async () => {
    const { adapter, errors, getStore, createSession, restore, toolRegistry } = setup()
    const gate = new GateTool()
    toolRegistry.register(gate)
    const session = createSession('sess_replay_restore')
    const gateCall: CompletionResponse = {
      id: 'resp_gate',
      content: [{ type: 'tool_use', id: 'call_gate', name: 'gate', input: {} }],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
      model: 'fake',
    }
    adapter.push(emit(), gateCall, text('done'), emit(), text('after restore'))

    // 工具执行中排队一条消息:canonical 里它夹在 tool_use 与 tool_result 之间,恢复不重排它
    const turn = session.handleMessage('before', {
      images: [{ mediaType: 'image/png', data: PNG }],
    })
    await gate.started.promise
    await session.handleMessage('while the gate is closed')
    gate.release.resolve()
    await turn
    const canonical = session.getMessages()
    const queuedIndex = canonical.findIndex((message) => message.messageType === 'queued')
    expect(canonical[queuedIndex - 1].content.some((block) => block.type === 'tool_use')).toBe(true)

    const restored = restore('sess_replay_restore')
    expect(restored.getMessages().map((message) => message.id)).toEqual(
      canonical.map((message) => message.id),
    )
    await restored.handleMessage('after')

    const events = expectReplayEquality(getStore(), 'sess_replay_restore', adapter.received)
    expect(countEvents(events, (event) => event.type === 'messages/truncate')).toBe(0)
    // 恢复后的请求里图片只有 imageRef,按内容 hash 与日志一致
    const restoredImage = adapter.received
      .at(-2)
      ?.messages[0].content.find(
        (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
      )
    expect(restoredImage?.imageRef?.sha256).toBeDefined()
    expect(errors).toEqual([])
  })
})

function stubRouter(adapter: ProviderAdapter): ModelRouter {
  const resolved = {
    adapter,
    providerName: 'test-provider',
    modelConfig: { capabilities: ['tools'] },
  }
  return {
    getCurrentModel: () => resolved,
    resolveModel: () => resolved,
    getAdapter: () => adapter,
    getModelLabel: () => 'test-provider/fake-model',
    getRegistry: () => ({
      listModels: () => [
        { providerName: 'test-provider', modelName: 'fake-model', modelId: 'fake-model', tags: [] },
      ],
    }),
    listModelRoutes: () => [],
  } as unknown as ModelRouter
}

describe('a sub-agent replays from its own event file', () => {
  test('an interactive sub-agent with a tool step and a follow-up input', async () => {
    const { adapter, errors, logsDir, project, toolRegistry } = setup()
    const parentId = 'sess_replay_parent'
    const store = new SessionEventStore({
      basePath: logsDir,
      onError: (message) => errors.push(message),
    })
    store.ensureSession({ v: 1, sessionId: parentId, schemaVersion: 1, source: 'web' })
    const tool = new SpawnAgentTool(stubRouter(adapter), toolRegistry, undefined, store)
    const agentControl = new AgentControl()
    adapter.push(emit(), text('first result'), emit(), text('second result'))

    const result = await tool.run(
      {
        sessionId: parentId,
        workDir: project.projectRoot,
        projectRoot: project.projectRoot,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        agentControl,
        currentRequestId: 'req_parent',
      },
      { instruction: 'Do the work.', label: 'Worker', mode: 'interactive', tools: ['emit'] },
    )
    expect(result.success).toBe(true)
    const agentId = (JSON.parse(result.output) as { agent_id: string }).agent_id
    await agentControl.waitReady([agentId], 5000)
    expect(agentControl.sendInput(agentId, 'Follow up.').success).toBe(true)
    while (adapter.received.length < 4) await Bun.sleep(1)
    await agentControl.waitReady([agentId], 5000)
    agentControl.close(agentId)

    const events = expectReplayEquality(store, agentId, adapter.received)
    expect(countEvents(events, (event) => event.type === 'loop/start')).toBe(2)
    expect(store.readEvents(parentId).some((event) => event.type === 'step/start')).toBe(false)
    expect(errors).toEqual([])
  })
})
