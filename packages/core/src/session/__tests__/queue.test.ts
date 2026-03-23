import { describe, expect, test } from 'bun:test'
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
import { Session } from '../session'

const API_KEY = 'sk-test-placeholder'

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
        '{"action":"finish","reason":"task is complete","trimFrom":""}',
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
      workDir: process.cwd(),
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

describe('Session queue handling', () => {
  test('queues running input as a persisted queued message and emits a session update', async () => {
    const sessionDb = SessionDB.createInMemory()
    const tool = new BlockingTool()
    const registry = new ToolRegistry()
    registry.register(tool)

    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const session = new Session('web', createRouter(), registry, {
      sessionDb,
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
    const session = new Session('web', createRouter(), registry)
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
    const session = new Session('web', createRouter(), registry)
    attachCustomAgent(session, registry, adapter)

    const turnPromise = session.handleMessage('生成架构图')
    await tool.waitUntilStarted()

    const queuedResult = await session.handleMessage('可以使用 qwen image 这个来生成图片')
    expect(queuedResult).toEqual([])

    tool.release()
    const messages = await turnPromise

    expect(adapter.queuedRequestSeen).toBe(true)
    expect(adapter.normalRequestHasTools).toEqual([true, true, true])
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
    const seed = new Session('web', router, registry)

    const restored = Session.restore(
      seed.data,
      [
        makeMessage(seed.data.id, 'user', 'message', 'first turn'),
        makeMessage(seed.data.id, 'assistant', 'message', 'reply'),
        makeMessage(seed.data.id, 'user', 'queued', 'late follow-up'),
      ],
      router,
      registry,
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
            requestLogMeta?: { turnIndex?: number },
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
        requestLogMeta?: { turnIndex?: number },
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
    const seed = new Session('web', router, registry)

    const restored = Session.restore(
      seed.data,
      [
        makeMessage(seed.data.id, 'user', 'message', 'first turn'),
        makeMessage(seed.data.id, 'assistant', 'message', 'reply'),
        makeMessage(seed.data.id, 'user', 'notification', '<memory_hint>hint</memory_hint>'),
      ],
      router,
      registry,
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
            requestLogMeta?: { turnIndex?: number },
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
        requestLogMeta?: { turnIndex?: number },
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

  test('failed turn rollback emits session:update for subscribers', async () => {
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const session = new Session('web', createRouter(), new ToolRegistry(), {
      bus: {
        emit(topic, data) {
          events.push({ topic, data })
        },
      },
    })
    session.initAgent({ name: 'queue-agent', agentInstruction: 'queue test agent' })

    const failedMessage = makeMessage(session.data.id, 'assistant', 'message', 'partial output')
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
        onNewMessage?.(failedMessage)
        throw new Error('provider overloaded')
      },
    }

    await expect(session.handleMessage('hello')).rejects.toThrow('provider overloaded')
    expect(session.getMessages()).toEqual([])

    const rollbackUpdate = events.find(
      (event) => event.topic === 'session:update' && event.data.event === 'message_rollback',
    )
    expect(rollbackUpdate?.data.sessionId).toBe(session.data.id)
    expect(rollbackUpdate?.data.messageCount).toBe(0)
  })
})
