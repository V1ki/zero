import { describe, expect, test } from 'bun:test'
import type { ChannelCapabilities, Message, SessionSource } from '@zero-os/shared'
import type { SessionManager } from '../../session/manager'
import { modelCommand } from '../builtins/model'
import { newSessionCommand } from '../builtins/new-session'
import { sessionCommand } from '../builtins/session'
import type { CommandContext } from '../types'

interface MockSession {
  data: {
    id: string
    currentModel: string
    createdAt: string
    updatedAt: string
  }
  switchModel(target: string): Promise<{ success: boolean; message: string }>
  initAgent(config: { name: string; agentInstruction: string }): void
  setChannelCapabilities(capabilities: ChannelCapabilities): void
  listModels(): string[]
  getMessages(): Message[]
}

function createContext(
  sessionManager: SessionManager,
  source: SessionSource = 'telegram',
): CommandContext {
  return {
    source,
    channelName: `${source}:ops`,
    chatId: 'chat-1',
    senderId: 'user-1',
    sessionManager,
    agentConfig: {
      name: 'zero-agent',
      agentInstruction: 'You are ZeRo OS, be concise and accurate.',
    },
    channelCapabilities: {
      streaming: true,
      inlineImages: true,
    },
    reply: async () => {},
  }
}

describe('builtin commands', () => {
  test('/new creates a new session and returns a reply', async () => {
    const initCalls: Array<{ name: string; agentInstruction: string }> = []
    const capabilityCalls: ChannelCapabilities[] = []
    const mockSession: MockSession = {
      data: {
        id: 'sess_new_1',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:30:05',
      },
      switchModel: async () => ({ success: true, message: 'ok' }),
      initAgent: (config) => {
        initCalls.push(config)
      },
      setChannelCapabilities: (capabilities) => {
        capabilityCalls.push(capabilities)
      },
      listModels: () => [],
      getMessages: () => [],
    }

    const startCalls: Array<[SessionSource, string, { channelName?: string }]> = []
    const sessionManager = {
      startNewForChannel: (
        source: SessionSource,
        chatId: string,
        options: { channelName?: string },
      ) => {
        startCalls.push([source, chatId, options])
        return { session: mockSession, previousSessionId: 'sess_old' }
      },
    } as unknown as SessionManager

    const ctx = createContext(sessionManager)
    const result = await newSessionCommand.execute({}, ctx)

    expect(startCalls).toEqual([['telegram', 'chat-1', { channelName: 'telegram:ops' }]])
    expect(initCalls).toEqual([
      {
        name: 'zero-agent',
        agentInstruction: 'You are ZeRo OS, be concise and accurate.',
      },
    ])
    expect(capabilityCalls).toEqual([{ streaming: true, inlineImages: true }])
    expect(result).toEqual({
      handled: true,
      reply:
        'New conversation started with model: openai-codex/gpt-5.3-codex-medium\nPrevious session: sess_old',
    })
  })

  test('/new <model> switches model for the new session', async () => {
    const switchCalls: string[] = []
    const mockSession: MockSession = {
      data: {
        id: 'sess_new_2',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:30:05',
      },
      switchModel: async (target: string) => {
        switchCalls.push(target)
        mockSession.data.currentModel = `openai-codex/${target}`
        return { success: true, message: `Switched to ${target}` }
      },
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => [],
      getMessages: () => [],
    }

    const sessionManager = {
      startNewForChannel: () => ({ session: mockSession }),
    } as unknown as SessionManager

    const ctx = createContext(sessionManager)
    const result = await newSessionCommand.execute({ modelArg: 'gpt-5.4-medium' }, ctx)

    expect(switchCalls).toEqual(['gpt-5.4-medium'])
    expect(result).toEqual({
      handled: true,
      reply: 'New conversation started with model: openai-codex/gpt-5.4-medium',
    })
  })

  test('/model with no args returns current model', async () => {
    const mockSession: MockSession = {
      data: {
        id: 'sess_model_1',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:30:05',
      },
      switchModel: async () => ({ success: true, message: 'ok' }),
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => [],
      getMessages: () => [],
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session: mockSession, isNew: false }),
    } as unknown as SessionManager

    const result = await modelCommand.execute({}, createContext(sessionManager, 'web'))

    expect(result).toEqual({
      handled: true,
      reply: 'Current model: openai-codex/gpt-5.3-codex-medium',
    })
  })

  test('/model list returns available models', async () => {
    const mockSession: MockSession = {
      data: {
        id: 'sess_model_2',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:30:05',
      },
      switchModel: async () => ({ success: true, message: 'ok' }),
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => ['openai-codex/gpt-5.3-codex-medium', 'openai-codex/gpt-5.4-medium'],
      getMessages: () => [],
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session: mockSession, isNew: false }),
    } as unknown as SessionManager

    const result = await modelCommand.execute(
      { target: 'list' },
      createContext(sessionManager, 'feishu'),
    )

    expect(result).toEqual({
      handled: true,
      reply:
        'Available models:\n- openai-codex/gpt-5.3-codex-medium\n- openai-codex/gpt-5.4-medium',
    })
  })

  test('/model <target> switches model', async () => {
    const switchCalls: string[] = []
    const mockSession: MockSession = {
      data: {
        id: 'sess_model_3',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:30:05',
      },
      switchModel: async (target: string) => {
        switchCalls.push(target)
        return { success: true, message: `Switched model to: ${target}` }
      },
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => [],
      getMessages: () => [],
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session: mockSession, isNew: false }),
    } as unknown as SessionManager

    const result = await modelCommand.execute(
      { target: 'gpt-4' },
      createContext(sessionManager, 'telegram'),
    )

    expect(switchCalls).toEqual(['gpt-4'])
    expect(result).toEqual({ handled: true, reply: 'Switched model to: gpt-4' })
  })

  test('parsers support @bot suffix and case-insensitive command names', () => {
    expect(newSessionCommand.parse('/NEW@ZeroBot')).toEqual({})
    expect(newSessionCommand.parse('/NeW@ZeroBot gpt-4')).toEqual({ modelArg: 'gpt-4' })
    expect(modelCommand.parse('/MoDeL@ZeroBot')).toEqual({})
    expect(modelCommand.parse('/MODEL@ZeroBot list')).toEqual({ target: 'list' })
    expect(sessionCommand.parse('/SESSION@ZeroBot')).toEqual({})
    expect(sessionCommand.parse('/session extra')).toBeNull()
  })

  test('/session returns formatted session info with metrics', async () => {
    const messages: Message[] = [
      {
        id: 'msg_user_1',
        sessionId: 'sess_session_1',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'Need help with deploy' }],
        createdAt: '2026-03-27T14:31:00',
      },
      {
        id: 'msg_assistant_1',
        sessionId: 'sess_session_1',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'text', text: 'I will check that.' },
          { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'deploy.md' } },
        ],
        createdAt: '2026-03-27T14:31:10',
      },
      {
        id: 'msg_user_2',
        sessionId: 'sess_session_1',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'tool_1', content: 'done' }],
        createdAt: '2026-03-27T14:31:12',
      },
    ]
    const mockSession: MockSession = {
      data: {
        id: 'sess_session_1',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T15:12:33',
      },
      switchModel: async () => ({ success: true, message: 'ok' }),
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => [],
      getMessages: () => messages,
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session: mockSession, isNew: false }),
    } as unknown as SessionManager
    const ctx = createContext(sessionManager, 'web')
    ctx.metrics = {
      sessionStats: () => ({
        totalCost: 0.0834,
        totalTokens: 58030,
        inputTokens: 45230,
        outputTokens: 12800,
        cacheWriteTokens: 8200,
        cacheReadTokens: 3100,
        effectiveInputTokens: 56530,
        cacheHitRate: 0.38,
        requestCount: 18,
      }),
      sessionToolCallCount: () => 45,
    } as unknown as NonNullable<CommandContext['metrics']>

    const result = await sessionCommand.execute({}, ctx)

    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Session Info')
    expect(result.reply).toContain('ID:           sess_session_1')
    expect(result.reply).toContain('Model:        openai-codex/gpt-5.3-codex-medium')
    expect(result.reply).toContain('Messages:     3')
    expect(result.reply).toContain('Turns:        1')
    expect(result.reply).toContain('Requests:     18')
    expect(result.reply).toContain('Tool calls:   45')
    expect(result.reply).toContain('Tokens:       45,230 in / 12,800 out')
    expect(result.reply).toContain('Cache:        8,200 write / 3,100 read (38% hit)')
    expect(result.reply).toContain('Cost:         $0.0834')
  })

  test('/session falls back to message-derived tool calls when metrics are unavailable', async () => {
    const mockSession: MockSession = {
      data: {
        id: 'sess_session_2',
        currentModel: 'openai-codex/gpt-5.3-codex-medium',
        createdAt: '2026-03-27T14:30:05',
        updatedAt: '2026-03-27T14:31:05',
      },
      switchModel: async () => ({ success: true, message: 'ok' }),
      initAgent: () => {},
      setChannelCapabilities: () => {},
      listModels: () => [],
      getMessages: () => [
        {
          id: 'msg_user_1',
          sessionId: 'sess_session_2',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: 'hello' }],
          createdAt: '2026-03-27T14:30:10',
        },
        {
          id: 'msg_assistant_1',
          sessionId: 'sess_session_2',
          role: 'assistant',
          messageType: 'message',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'tool_2', name: 'bash', input: { cmd: 'pwd' } },
          ],
          createdAt: '2026-03-27T14:30:11',
        },
      ],
    }

    const sessionManager = {
      getOrCreateForChannel: () => ({ session: mockSession, isNew: false }),
    } as unknown as SessionManager

    const result = await sessionCommand.execute({}, createContext(sessionManager, 'feishu'))

    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Tool calls:   2')
    expect(result.reply).toContain('Requests:     0')
    expect(result.reply).toContain('Cost:         $0.0000')
  })
})
