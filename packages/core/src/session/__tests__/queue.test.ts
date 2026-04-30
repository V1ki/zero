import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { ModelRouter } from '@zero-os/model'
import { SessionDB } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  SystemConfig,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { Agent } from '../../agent/agent'
import type { QueuedMessage } from '../../agent/queue'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { createTestProjectRoot } from './test-helpers'
import { Session } from '../session'

const API_KEY = 'sk-test-placeholder'
const testProject = createTestProjectRoot('zero-session-queue-')

const config: SystemConfig = {
  providers: {
    'openai-codex': {
      apiType: 'openai_chat_completions',
      baseUrl: 'https://example.invalid',
      auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
      models: {
        'gpt-5.3-codex-medium': {
          modelId: 'gpt-5.3-codex-medium',
          maxContext: 400000,
          maxOutput: 128000,
          capabilities: ['tools', 'vision', 'reasoning'],
          tags: ['powerful', 'coding'],
        },
      },
    },
  },
  defaultModel: 'gpt-5.3-codex-medium',
  fallbackChain: ['gpt-5.3-codex-medium'],
  schedules: [],
  fuseList: [],
}

function createRouter(): ModelRouter {
  const router = new ModelRouter(config, new Map([['openai_codex_api_key', API_KEY]]))
  router.init()
  return router
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createTextResponse(id: string, text: string): CompletionResponse {
  return {
    id,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'fake-queue-test',
  }
}

function createToolResponse(id: string, toolUseId: string): CompletionResponse {
  return {
    id,
    content: [{ type: 'tool_use', id: toolUseId, name: 'hold', input: {} }],
    stopReason: 'tool_use',
    usage: { input: 1, output: 1 },
    model: 'fake-queue-test',
  }
}

function getLastUserText(request: CompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]
    if (message.role !== 'user') continue

    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }

  return ''
}

async function* failStream(error: Error): AsyncIterable<StreamEvent> {
  yield* []
  throw error
}

class BlockingTool extends BaseTool {
  name = 'hold'
  description = 'Blocks once so queue behavior can be observed.'
  parameters = { type: 'object', properties: {} }

  private readonly started = createDeferred<void>()
  private readonly releaseGate = createDeferred<void>()
  private callCount = 0

  async waitUntilStarted(): Promise<void> {
    await this.started.promise
  }

  release(): void {
    this.releaseGate.resolve()
  }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    this.callCount += 1
    if (this.callCount === 1) {
      this.started.resolve()
      await this.releaseGate.promise
    }

    return {
      success: true,
      output: `tool-result-${this.callCount}`,
      outputSummary: `tool-result-${this.callCount}`,
    }
  }
}

class SingleToolAdapter implements ProviderAdapter {
  readonly apiType = 'fake-single-tool'
  private callCount = 0

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    this.callCount += 1
    if (this.callCount === 1) {
      return createToolResponse('resp_tool_1', 'call_hold_1')
    }

    return createTextResponse('resp_done', 'done 已完成')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream failed'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class QueueResumeAdapter implements ProviderAdapter {
  readonly apiType = 'fake-queue-resume'
  readonly normalRequestHasTools: boolean[] = []
  queuedRequestSeen = false
  sawUnexpectedNoToolsRequest = false

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const hasTools = Boolean(request.tools?.length)

    if (!hasTools && isTaskClosureClassifierRequest(request)) {
      return createTextResponse(
        'resp_classifier',
        '{"action":"finish","reason":"task is complete"}',
      )
    }

    if (!hasTools) {
      this.sawUnexpectedNoToolsRequest = true
      return createTextResponse('resp_unexpected_final', 'unexpected no-tools final request')
    }

    this.normalRequestHasTools.push(true)

    if (this.normalRequestHasTools.length === 1) {
      return createToolResponse('resp_tool_1', 'call_hold_1')
    }

    const lastUserText = getLastUserText(request)
    if (lastUserText.includes('<queued_message>') || lastUserText.includes('<queued_messages ')) {
      this.queuedRequestSeen = true
      return createToolResponse('resp_tool_2', 'call_hold_2')
    }

    return createTextResponse('resp_done', '任务处理完成，已完成')
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream failed'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function isTaskClosureClassifierRequest(request: CompletionRequest): boolean {
  const combinedText = request.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

  return combinedText.includes('任务收尾判定器') && combinedText.includes('<assistant_tail>')
}

function attachCustomAgent(
  session: Session,
  registry: ToolRegistry,
  adapter: ProviderAdapter,
): void {
  session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })
  ;(session as unknown as { agent: Agent }).agent = new Agent(
    { name: 'queue-agent', agentInstruction: 'queue test agent' },
    adapter,
    registry,
    {
      sessionId: session.data.id,
      workDir: join(testProject.projectRoot, '.zero', 'workspace', 'queue-agent'),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  )
}

function makeMessage(
  sessionId: string,
  role: Message['role'],
  messageType: Message['messageType'],
  text: string,
): Message {
  return {
    id: generateId(),
    sessionId,
    role,
    messageType,
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

function makeToolUseMessage(
  sessionId: string,
  toolUseId: string,
  toolName = 'hold',
): Message {
  return {
    id: generateId(),
    sessionId,
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
    createdAt: now(),
  }
}

function makeToolResultMessage(sessionId: string, toolUseId: string, output: string): Message {
  return {
    id: generateId(),
    sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'tool_result', toolUseId, content: output }],
    createdAt: now(),
  }
}

describe('Session queue handling', () => {
  afterAll(() => {
    testProject.cleanup()
  })

  test('queues running input as a persisted queued message and emits a session update', async () => {
    const sessionDb = SessionDB.createInMemory()
    const tool = new BlockingTool()
    const registry = new ToolRegistry()
    registry.register(tool)

    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const session = new Session('web', createRouter(), registry, {
      sessionDb,
      projectRoot: testProject.projectRoot,
      bus: {
        emit(topic, data) {
          events.push({ topic, data })
        },
      },
    })
    attachCustomAgent(session, registry, new SingleToolAdapter())

    const turnPromise = session.handleMessage('start work')
    await tool.waitUntilStarted()

    const queuedResult = await session.handleMessage('queued follow-up', {
      images: [{ mediaType: 'image/png', data: 'img-data' }],
    })

    expect(queuedResult).toEqual([])

    const queuedMessage = session.getMessages().find((message) => message.messageType === 'queued')
    expect(queuedMessage).toBeDefined()
    expect(queuedMessage).toMatchObject({
      role: 'user',
      messageType: 'queued',
      content: [
        { type: 'text', text: 'queued follow-up' },
        { type: 'image', mediaType: 'image/png', data: 'img-data' },
      ],
    })

    const persistedQueuedMessage = sessionDb
      .loadSessionMessages(session.data.id)
      .find((message) => message.messageType === 'queued')
    expect(persistedQueuedMessage).toEqual(queuedMessage)

    const queueUpdate = events.find(
      (event) => event.topic === 'session:update' && event.data.event === 'message_queued',
    )
    expect(queueUpdate?.data.sessionId).toBe(session.data.id)

    tool.release()
    await turnPromise
    sessionDb.close()
  })

  test('draining queued messages clears the interrupt flag', async () => {
    const registry = new ToolRegistry()
    const session = new Session('web', createRouter(), registry, {
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const ready = createDeferred<void>()
    const release = createDeferred<void>()
    let shouldInterrupt: (() => boolean) | undefined
    let getQueuedMessages: (() => QueuedMessage[]) | undefined
    ;(
      session as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
            onTextDelta?: unknown,
            shouldInterrupt?: () => boolean,
            getQueuedMessages?: () => QueuedMessage[],
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        _userMessage: string,
        _images: unknown,
        _onNewMessage?: (message: Message) => void,
        _onTextDelta?: unknown,
        nextShouldInterrupt?: () => boolean,
        nextGetQueuedMessages?: () => QueuedMessage[],
      ) => {
        shouldInterrupt = nextShouldInterrupt
        getQueuedMessages = nextGetQueuedMessages
        ready.resolve()
        await release.promise
        return []
      },
    }

    const turnPromise = session.handleMessage('start work')
    await ready.promise

    const queuedResult = await session.handleMessage('queued follow-up')
    expect(queuedResult).toEqual([])
    expect(shouldInterrupt?.()).toBe(true)

    const drained = getQueuedMessages?.()
    expect(drained).toEqual([
      expect.objectContaining({
        content: 'queued follow-up',
      }),
    ])
    expect(shouldInterrupt?.()).toBe(false)

    release.resolve()
    await turnPromise
  })

  test('queued follow-up does not trigger a no-tools final request after the queue is drained', async () => {
    const tool = new BlockingTool()
    const registry = new ToolRegistry()
    registry.register(tool)

    const adapter = new QueueResumeAdapter()
    const session = new Session('web', createRouter(), registry, {
      projectRoot: testProject.projectRoot,
    })
    attachCustomAgent(session, registry, adapter)

    const turnPromise = session.handleMessage('生成架构图')
    await tool.waitUntilStarted()

    let appliedCount = 0
    const queuedResult = await session.handleMessage('可以使用 qwen image 这个来生成图片', {
      onQueuedMessageApplied: () => {
        appliedCount += 1
      },
    })
    expect(queuedResult).toEqual([])
    expect(appliedCount).toBe(0)

    tool.release()
    const messages = await turnPromise

    expect(appliedCount).toBe(1)
    expect(adapter.queuedRequestSeen).toBe(true)
    expect(adapter.normalRequestHasTools).toEqual([true, true, true, true])
    expect(adapter.sawUnexpectedNoToolsRequest).toBe(false)
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: '任务处理完成，已完成' }])
    expect(
      session
        .getMessages()
        .some(
          (message) =>
            message.messageType === 'queued' &&
            message.content.some(
              (block) =>
                block.type === 'text' && block.text === '可以使用 qwen image 这个来生成图片',
            ),
        ),
    ).toBe(true)
  })

  test('queued messages do not advance recovered turn indexes', async () => {
    const router = createRouter()
    const registry = new ToolRegistry()
    const seed = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const restored = Session.restore(
      seed.data,
      [
        makeMessage(seed.data.id, 'user', 'message', 'first turn'),
        makeMessage(seed.data.id, 'assistant', 'message', 'reply'),
        makeMessage(seed.data.id, 'user', 'queued', 'late follow-up'),
      ],
      router,
      registry,
      { projectRoot: testProject.projectRoot },
    )
    restored.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const turnIndexes: number[] = []
    ;(
      restored as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
            onTextDelta?: unknown,
            shouldInterrupt?: () => boolean,
            getQueuedMessages?: () => QueuedMessage[],
            requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
        _onTextDelta?: unknown,
        _shouldInterrupt?: () => boolean,
        _getQueuedMessages?: () => QueuedMessage[],
        requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
      ) => {
        turnIndexes.push(requestLogMeta?.turnIndex ?? -1)
        const user = makeMessage(restored.data.id, 'user', 'message', userMessage)
        const assistant = makeMessage(restored.data.id, 'assistant', 'message', 'ok')
        onNewMessage?.(user)
        onNewMessage?.(assistant)
        return [user, assistant]
      },
    }

    await restored.handleMessage('next turn')

    expect(turnIndexes).toEqual([2])
  })

  test('notification messages do not advance recovered turn indexes', async () => {
    const router = createRouter()
    const registry = new ToolRegistry()
    const seed = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const restored = Session.restore(
      seed.data,
      [
        makeMessage(seed.data.id, 'user', 'message', 'first turn'),
        makeMessage(seed.data.id, 'assistant', 'message', 'reply'),
        makeMessage(seed.data.id, 'user', 'notification', '<memory_hint>hint</memory_hint>'),
      ],
      router,
      registry,
      { projectRoot: testProject.projectRoot },
    )
    restored.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const turnIndexes: number[] = []
    ;(
      restored as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
            onTextDelta?: unknown,
            shouldInterrupt?: () => boolean,
            getQueuedMessages?: () => QueuedMessage[],
            requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
        _onTextDelta?: unknown,
        _shouldInterrupt?: () => boolean,
        _getQueuedMessages?: () => QueuedMessage[],
        requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
      ) => {
        turnIndexes.push(requestLogMeta?.turnIndex ?? -1)
        const user = makeMessage(restored.data.id, 'user', 'message', userMessage)
        const assistant = makeMessage(restored.data.id, 'assistant', 'message', 'ok')
        onNewMessage?.(user)
        onNewMessage?.(assistant)
        return [user, assistant]
      },
    }

    await restored.handleMessage('next turn')

    expect(turnIndexes).toEqual([2])
  })

  test('control messages do not advance recovered turn indexes', async () => {
    const router = createRouter()
    const registry = new ToolRegistry()
    const seed = new Session('web', router, registry, {
      projectRoot: testProject.projectRoot,
    })

    const restored = Session.restore(
      seed.data,
      [
        makeMessage(seed.data.id, 'user', 'message', 'first turn'),
        makeMessage(seed.data.id, 'assistant', 'message', 'reply'),
        {
          ...makeMessage(seed.data.id, 'user', 'control', '<system_notice>continue</system_notice>'),
          controlKind: 'task_closure',
        },
      ],
      router,
      registry,
      { projectRoot: testProject.projectRoot },
    )
    restored.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const turnIndexes: number[] = []
    ;(
      restored as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
            onTextDelta?: unknown,
            shouldInterrupt?: () => boolean,
            getQueuedMessages?: () => QueuedMessage[],
            requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
        _onTextDelta?: unknown,
        _shouldInterrupt?: () => boolean,
        _getQueuedMessages?: () => QueuedMessage[],
        requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
      ) => {
        turnIndexes.push(requestLogMeta?.turnIndex ?? -1)
        const user = makeMessage(restored.data.id, 'user', 'message', userMessage)
        const assistant = makeMessage(restored.data.id, 'assistant', 'message', 'ok')
        onNewMessage?.(user)
        onNewMessage?.(assistant)
        return [user, assistant]
      },
    }

    await restored.handleMessage('next turn')

    expect(turnIndexes).toEqual([2])
  })

  test('passes a prebuilt user message entry into the agent request metadata', async () => {
    const session = new Session('web', createRouter(), new ToolRegistry(), {
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    let capturedUserMessage: Message | undefined
    ;(
      session as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
            onTextDelta?: unknown,
            shouldInterrupt?: () => boolean,
            getQueuedMessages?: () => QueuedMessage[],
            requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        _userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
        _onTextDelta?: unknown,
        _shouldInterrupt?: () => boolean,
        _getQueuedMessages?: () => QueuedMessage[],
        requestLogMeta?: { turnIndex?: number; userMessageEntry?: Message },
      ) => {
        capturedUserMessage = requestLogMeta?.userMessageEntry
        const assistant = makeMessage(session.data.id, 'assistant', 'message', 'ok')
        if (capturedUserMessage) onNewMessage?.(capturedUserMessage)
        onNewMessage?.(assistant)
        return capturedUserMessage ? [capturedUserMessage, assistant] : [assistant]
      },
    }

    await session.handleMessage('prebuilt user message')

    expect(capturedUserMessage).toMatchObject({
      sessionId: session.data.id,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'prebuilt user message' }],
    })
    expect(capturedUserMessage?.createdAt).toEqual(expect.any(String))
  })

  test('failed turn with completed assistant work keeps messages and reports partial failure', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const completedTurnMessages: Message[] = []

    const session = new Session('web', createRouter(), new ToolRegistry(), {
      projectRoot: testProject.projectRoot,
      bus: {
        emit(topic, data) {
          events.push({ topic, data })
        },
      },
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })
    const assistantToolUseMessage = makeToolUseMessage(session.data.id, 'call_hold_1')
    const toolResultMessage = makeToolResultMessage(session.data.id, 'call_hold_1', 'tool result')

    ;(
      session as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
      ) => {
        const userMessageForThisTurn = makeMessage(session.data.id, 'user', 'message', userMessage)
        onNewMessage?.(userMessageForThisTurn)
        completedTurnMessages.push(userMessageForThisTurn, assistantToolUseMessage, toolResultMessage)
        onNewMessage?.(assistantToolUseMessage)
        onNewMessage?.(toolResultMessage)
        throw new Error('provider overloaded')
      },
    }

    let error: unknown
    try {
      await session.handleMessage('hello')
    } catch (err) {
      error = err
    }

    expect((error as Error & { rolledBack?: boolean })?.rolledBack).toBe(false)
    expect(session.getMessages()).toEqual(completedTurnMessages)

    const rollbackUpdate = events.find(
      (event) =>
        event.topic === 'session:update' &&
        event.data.event === 'message_partial_failure',
    )
    expect(rollbackUpdate?.data.event).toBe('message_partial_failure')
    expect(rollbackUpdate?.data.sessionId).toBe(session.data.id)
    expect(rollbackUpdate?.data.messageCount).toBe(3)

    const fullRollbackUpdate = events.find(
      (event) => event.topic === 'session:update' && event.data.event === 'message_rollback',
    )
    expect(fullRollbackUpdate).toBeUndefined()
  })

  test('failed turn with no completed assistant output fully rolls back and keeps queued messages', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const session = new Session('web', createRouter(), new ToolRegistry(), {
      projectRoot: testProject.projectRoot,
      bus: {
        emit(topic, data) {
          events.push({ topic, data })
        },
      },
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const userMessage = makeMessage(session.data.id, 'user', 'message', 'hello')
    const queuedMessage = makeMessage(session.data.id, 'user', 'queued', 'queued follow-up')

    ;(
      session as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (_context: unknown, _userMessage: string, _images: unknown, onNewMessage?: (message: Message) => void) => {
        onNewMessage?.(userMessage)
        onNewMessage?.(queuedMessage)
        throw new Error('provider overloaded')
      },
    }

    let error: unknown
    try {
      await session.handleMessage('hello')
    } catch (err) {
      error = err
    }

    expect((error as Error & { rolledBack?: boolean })?.rolledBack).toBe(true)
    expect(session.getMessages()).toEqual([queuedMessage])

    const rollbackUpdate = events.find(
      (event) => event.topic === 'session:update' && event.data.event === 'message_rollback',
    )
    expect(rollbackUpdate?.data.event).toBe('message_rollback')
    expect(rollbackUpdate?.data.sessionId).toBe(session.data.id)
    expect(rollbackUpdate?.data.messageCount).toBe(1)
  })

  test('logs leaked queued messages after a turn finishes without draining them', async () => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const session = new Session('web', createRouter(), new ToolRegistry(), {
      projectRoot: testProject.projectRoot,
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })
    ;(
      session as unknown as {
        logger: {
          info(event: string, data?: Record<string, unknown>): void
          warn(event: string, data?: Record<string, unknown>): void
          error(event: string, data?: Record<string, unknown>): void
        }
      }
    ).logger = {
      info: () => {},
      warn: (event, data) => {
        warnings.push({ event, data })
      },
      error: () => {},
    }

    const ready = createDeferred<void>()
    const release = createDeferred<void>()
    ;(
      session as unknown as {
        agent: {
          run: (
            context: unknown,
            userMessage: string,
            images: unknown,
            onNewMessage?: (message: Message) => void,
          ) => Promise<Message[]>
        }
      }
    ).agent = {
      run: async (
        _context: unknown,
        userMessage: string,
        _images: unknown,
        onNewMessage?: (message: Message) => void,
      ) => {
        onNewMessage?.(makeMessage(session.data.id, 'user', 'message', userMessage))
        ready.resolve()
        await release.promise
        return []
      },
    }

    const turnPromise = session.handleMessage('start work')
    await ready.promise
    await session.handleMessage('queued follow-up')
    release.resolve()
    await turnPromise

    expect(warnings).toContainEqual({
      event: 'queued_messages_leaked_after_turn',
      data: {
        sessionId: session.data.id,
        queueLength: 1,
        interruptFlag: true,
      },
    })
  })
})
