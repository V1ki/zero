import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { CompletionRequest, Message } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { getMasterKey } from '../../../secrets/src/keychain'
import { Vault } from '../../../secrets/src/vault'
import { AnthropicDeepSeekAdapter } from '../adapters/anthropic-deepseek'
import { collectStream } from '../stream'

const __dirname = import.meta.dir
const SECRETS_PATH = join(__dirname, '../../../../.zero/secrets.enc')

let vault: Vault | undefined

try {
  const masterKey = await getMasterKey()
  vault = new Vault(masterKey, SECRETS_PATH)
  vault.load()
} catch {}

const DEEPSEEK_API_KEY = vault?.get('deepseek_api_key')?.trim()

function createAdapter(): AnthropicDeepSeekAdapter {
  return new AnthropicDeepSeekAdapter({
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
    modelConfig: {
      modelId: 'deepseek-v4-pro',
      maxContext: 1000000,
      maxOutput: 384000,
      capabilities: ['tools', 'reasoning'],
      tags: ['deepseek'],
    },
    apiKey: 'dummy',
  })
}

function createRealAdapter(): AnthropicDeepSeekAdapter {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('Missing required secret: deepseek_api_key')
  }

  return new AnthropicDeepSeekAdapter({
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
    modelConfig: {
      modelId: 'deepseek-v4-pro',
      maxContext: 1000000,
      maxOutput: 384000,
      capabilities: ['tools', 'reasoning'],
      tags: ['deepseek'],
    },
    apiKey: DEEPSEEK_API_KEY,
  })
}

function makeUserMessage(text: string): Message {
  return {
    id: generateId(),
    sessionId: 'sess_test',
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

describe('AnthropicDeepSeekAdapter', () => {
  test('uses its own apiType, enables thinking, and defaults effort to high', async () => {
    const adapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create: (params: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async (params) => {
          calls.push(params)
          return {
            id: 'msg_deepseek_test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'deepseek-v4-pro',
          }
        },
      },
    }

    const req: CompletionRequest = {
      messages: [makeUserMessage('hello')],
      stream: false,
      model: 'deepseek-v4-pro',
    }

    await adapter.complete(req)

    expect(adapter.apiType).toBe('anthropic-deepseek')
    expect(calls[0].thinking).toEqual({ type: 'enabled' })
    expect(calls[0].output_config).toEqual({ effort: 'high' })
  })

  test('/think reasoning effort is forwarded as DeepSeek output_config effort', async () => {
    const adapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create: (params: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async (params) => {
          calls.push(params)
          return {
            id: 'msg_deepseek_test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'deepseek-v4-pro',
          }
        },
      },
    }

    const req: CompletionRequest = {
      messages: [makeUserMessage('hello')],
      stream: false,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'medium',
    }

    await adapter.complete(req)

    expect(calls[0].output_config).toEqual({ effort: 'medium' })
  })

  test('/think xhigh is normalized to DeepSeek max output_config effort', async () => {
    const adapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create: (params: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async (params) => {
          calls.push(params)
          return {
            id: 'msg_deepseek_test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'deepseek-v4-pro',
          }
        },
      },
    }

    const req: CompletionRequest = {
      messages: [makeUserMessage('hello')],
      stream: false,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'xhigh',
    }

    await adapter.complete(req)

    expect(calls[0].output_config).toEqual({ effort: 'max' })
  })

  test('round-trips thinking blocks in assistant history for tool-call continuation', async () => {
    const adapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create: (params: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async (params) => {
          calls.push(params)
          return {
            id: 'msg_deepseek_test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'deepseek-v4-pro',
          }
        },
      },
    }

    const toolUseId = 'toolu_1'
    const messages: Message[] = [
      makeUserMessage('lookup'),
      {
        id: generateId(),
        sessionId: 'sess_test',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'thinking', thinking: 'Need a tool result.', signature: 'sig_1' },
          { type: 'tool_use', id: toolUseId, name: 'lookup', input: { query: 'x' } },
        ],
        createdAt: now(),
      },
      {
        id: generateId(),
        sessionId: 'sess_test',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId, content: 'tool output' }],
        createdAt: now(),
      },
    ]

    await adapter.complete({
      messages,
      stream: false,
      model: 'deepseek-v4-pro',
    })

    const requestMessages = calls[0].messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    expect(requestMessages[1].content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need a tool result.',
      signature: 'sig_1',
    })
    expect(requestMessages[1].content[1]).toEqual({
      type: 'tool_use',
      id: toolUseId,
      name: 'lookup',
      input: { query: 'x' },
    })
  })

  test('drops legacy tool calls that lack thinking content', async () => {
    const adapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create: (params: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async (params) => {
          calls.push(params)
          return {
            id: 'msg_deepseek_test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'deepseek-v4-pro',
          }
        },
      },
    }

    const toolUseId = 'toolu_legacy'
    const messages: Message[] = [
      makeUserMessage('legacy lookup'),
      {
        id: generateId(),
        sessionId: 'sess_test',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'text', text: 'I will check that.' },
          { type: 'tool_use', id: toolUseId, name: 'lookup', input: { query: 'x' } },
        ],
        createdAt: now(),
      },
      {
        id: generateId(),
        sessionId: 'sess_test',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId, content: 'legacy output' }],
        createdAt: now(),
      },
      makeUserMessage('continue'),
    ]

    await adapter.complete({
      messages,
      stream: false,
      model: 'deepseek-v4-pro',
    })

    const requestMessages = calls[0].messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    expect(
      requestMessages.some((message) => message.content.some((b) => b.type === 'tool_use')),
    ).toBe(false)
    expect(
      requestMessages.some((message) => message.content.some((b) => b.type === 'tool_result')),
    ).toBe(false)
    expect(
      requestMessages.some((message) => message.content.some((b) => b.text === 'continue')),
    ).toBe(true)
  })
})

describe.skipIf(!DEEPSEEK_API_KEY)('AnthropicDeepSeekAdapter (Real API)', () => {
  test('streams a real DeepSeek response through the Anthropic-compatible adapter', async () => {
    const adapter = createRealAdapter()
    const events = await collectStream(
      adapter.stream({
        messages: [makeUserMessage('Reply with exactly: deepseek-ok')],
        stream: true,
        maxTokens: 64,
        model: 'deepseek-v4-pro',
      }),
    )

    expect(events.content.some((block) => block.type === 'text')).toBe(true)
    expect(
      events.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    ).toContain('deepseek-ok')
    expect(events.usage).toBeDefined()
  }, 60000)
})
