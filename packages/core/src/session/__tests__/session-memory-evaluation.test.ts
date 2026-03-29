import { describe, expect, test } from 'bun:test'
import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import { ModelRouter } from '@zero-os/model'
import type { TraceSpan } from '@zero-os/observe'
import type { Message, SystemConfig } from '@zero-os/shared'
import { BashTool } from '../../tool/bash'
import { ReadTool } from '../../tool/read'
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

function createRouter() {
  const router = new ModelRouter(config, new Map([['openai_codex_api_key', API_KEY]]))
  router.init()
  return router
}

function createToolRegistry() {
  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new BashTool([]))
  return registry
}

function makeStoredMessage(
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `msg_${role}_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_hidden_eval',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function createTracingSession() {
  const endedSpans: Array<{
    spanId: string
    status: 'success' | 'error'
    metadata?: Record<string, unknown>
  }> = []

  const session = new Session('web', createRouter(), createToolRegistry(), {
    tracer: {
      startSpan: (
        sessionId: string,
        name: string,
        parentId?: string,
        options: {
          kind?: TraceSpan['kind']
          data?: Record<string, unknown>
          metadata?: Record<string, unknown>
        } = {},
      ): TraceSpan => ({
        id: name === 'session_evaluate' ? `span_${endedSpans.length + 1}` : 'unused',
        sessionId,
        parentId,
        name,
        kind: options?.kind ?? 'turn',
        startTime: new Date().toISOString(),
        status: 'running',
        data: options?.data,
        metadata: options?.metadata,
        children: [],
      }),
      updateSpan: () => {},
      endSpan: (
        spanId: string,
        status: 'success' | 'error',
        metadata?: Record<string, unknown>,
      ) => {
        endedSpans.push({ spanId, status, metadata })
      },
      getSpan: () => undefined,
    } as never,
  })

  return { session, endedSpans }
}

describe('Session.evaluateSessionMemory', () => {
  test('routes evaluation through handleMessage and records a session_evaluate trace', async () => {
    const { session, endedSpans } = createTracingSession()

    session.initAgent({
      name: 'session-eval-test',
      agentInstruction: 'You are a helpful assistant. Reply briefly.',
    })

    let capturedPrompt: string | undefined
    ;(
      session as unknown as {
        handleMessage: (prompt: string) => Promise<Message[]>
      }
    ).handleMessage = async (prompt) => {
      capturedPrompt = prompt
      ;(session as unknown as { messages: Message[] }).messages.push(
        makeStoredMessage('user', prompt),
        makeStoredMessage('assistant', '无需记忆'),
      )
      return session.getMessages()
    }

    await session.evaluateSessionMemory('请回顾这次会话并判断是否需要创建 session memory。')

    expect(capturedPrompt).toBe('请回顾这次会话并判断是否需要创建 session memory。')
    expect(session.getMessages().at(-2)?.content[0]).toEqual({
      type: 'text',
      text: '请回顾这次会话并判断是否需要创建 session memory。',
    })
    expect(endedSpans).toHaveLength(1)
    expect(endedSpans[0]).toMatchObject({
      spanId: 'span_1',
      status: 'success',
    })
  })

  test('records failure metadata when evaluation errors', async () => {
    const { session, endedSpans } = createTracingSession()

    session.initAgent({
      name: 'session-eval-test',
      agentInstruction: 'You are a helpful assistant. Reply briefly.',
    })

    ;(
      session as unknown as {
        handleMessage: () => Promise<Message[]>
      }
    ).handleMessage = async () => {
      throw new Error('evaluation failed')
    }

    await expect(
      session.evaluateSessionMemory('请回顾这次会话并判断是否需要创建 session memory。'),
    ).rejects.toThrow('evaluation failed')
    expect(endedSpans).toHaveLength(1)
    expect(endedSpans[0]?.status).toBe('error')
    expect(String(endedSpans[0]?.metadata?.error)).toContain('evaluation failed')
  })

  test('excludes control messages from top-level user turns', () => {
    const internalMessage = makeStoredMessage('user', MEMORY_NUDGE_PROMPT, {
      messageType: 'control',
      controlKind: 'memory_nudge',
    })
    const visibleMessage = makeStoredMessage('user', '这是用户正常输入')

    expect(Session.isTopLevelUserTurn(internalMessage)).toBe(false)
    expect(Session.isTopLevelUserTurn(visibleMessage)).toBe(true)
  })

  test('describes the nudge as a completed phase rather than a fully finished task', () => {
    expect(MEMORY_NUDGE_PROMPT).toContain('当前阶段已完成')
    expect(MEMORY_NUDGE_PROMPT).not.toContain('任务已完成')
  })
})
