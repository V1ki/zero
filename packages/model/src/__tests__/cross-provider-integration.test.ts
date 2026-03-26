import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  CompletionRequest,
  ContentBlock,
  Message,
  SystemConfig,
  ToolDefinition,
} from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { getMasterKey } from '../../../secrets/src/keychain'
import { Vault } from '../../../secrets/src/vault'
import { AnthropicAdapter } from '../adapters/anthropic'
import type { ProviderAdapter } from '../adapters/base'
import { OpenAIChatAdapter } from '../adapters/openai-chat'
import { OpenAIResponsesAdapter } from '../adapters/openai-resp'
import { ModelRouter } from '../router'
import { collectStream } from '../stream'

type ChatMessageLike = {
  role: string
  content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string }>
}

type AnthropicMessageLike = {
  role: string
  content: Array<Record<string, unknown>>
}

interface OpenAIChatAdapterTestHarness {
  convertMessages(req: CompletionRequest): ChatMessageLike[]
}

interface AnthropicAdapterTestHarness {
  convertMessages(req: CompletionRequest): AnthropicMessageLike[]
}

const __dirname = import.meta.dir
const SECRETS_PATH = join(__dirname, '../../../../.zero/secrets.enc')
const SESSION_ID = 'cross-provider-integration'
const FAKE_TOOL_RESULT = '2025-01-15T10:30:00+08:00'
const INITIAL_SYSTEM_PROMPT =
  'You are running a cross-provider integration test. If the get_current_time tool is available, call it exactly once with timezone "Asia/Shanghai" before answering.'
const CONTINUATION_SYSTEM_PROMPT =
  'Continue the conversation using the existing history. If a tool_result already exists, use it directly instead of calling the tool again.'

const tools: ToolDefinition[] = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'The timezone, e.g., "UTC", "Asia/Shanghai"',
        },
      },
      required: ['timezone'],
    },
  },
]

let vault: Vault | undefined

try {
  const masterKey = await getMasterKey()
  vault = new Vault(masterKey, SECRETS_PATH)
  vault.load()
} catch {}

const OPENAI_CODEX_API_KEY = vault?.get('openai_codex_api_key')?.trim()
const ANTHROPIC_OAUTH_TOKEN = vault?.get('CLAUDE_CODE_OAUTH_TOKEN')?.trim()
const CHATGPT_OAUTH_TOKEN = vault?.get('chatgpt_oauth_token')?.trim()

const HAS_VAULT = Boolean(vault)
const HAS_OPENAI_CODEX = Boolean(OPENAI_CODEX_API_KEY)
const HAS_ANTHROPIC = Boolean(ANTHROPIC_OAUTH_TOKEN)
const HAS_CHATGPT = Boolean(CHATGPT_OAUTH_TOKEN)

function getOpenAIChatHarness(instance: OpenAIChatAdapter): OpenAIChatAdapterTestHarness {
  return instance as unknown as OpenAIChatAdapterTestHarness
}

function getAnthropicHarness(instance: AnthropicAdapter): AnthropicAdapterTestHarness {
  return instance as unknown as AnthropicAdapterTestHarness
}

function requireSecret(
  key: 'openai_codex_api_key' | 'CLAUDE_CODE_OAUTH_TOKEN' | 'chatgpt_oauth_token',
) {
  const value = vault?.get(key)?.trim()
  if (!value) {
    throw new Error(`Missing required secret: ${key}`)
  }
  return value
}

function makeMessage(
  role: 'user' | 'assistant',
  content: Message['content'],
  model?: string,
): Message {
  return {
    id: generateId(),
    sessionId: SESSION_ID,
    role,
    messageType: 'message',
    content,
    model,
    createdAt: now(),
  }
}

function makeTextMessage(role: 'user' | 'assistant', text: string, model?: string): Message {
  return makeMessage(role, [{ type: 'text', text }], model)
}

function createOpenAIChatAdapter(): OpenAIChatAdapter {
  return new OpenAIChatAdapter({
    baseUrl: 'https://www.right.codes/codex',
    auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
    modelConfig: {
      modelId: 'gpt-5.3-codex-medium',
      maxContext: 400000,
      maxOutput: 128000,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['powerful', 'coding'],
    },
    apiKey: requireSecret('openai_codex_api_key'),
  })
}

function createAnthropicAdapter(): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.com',
    auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
    modelConfig: {
      modelId: 'claude-sonnet-4-6',
      maxContext: 200000,
      maxOutput: 32000,
      capabilities: ['tools', 'vision'],
      tags: ['balanced'],
    },
    oauthToken: requireSecret('CLAUDE_CODE_OAUTH_TOKEN'),
  })
}

function createChatGptAdapter(): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    providerName: 'chatgpt',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
    modelConfig: {
      modelId: 'gpt-5.4',
      maxContext: 400000,
      maxOutput: 128000,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['powerful', 'coding'],
    },
    oauthToken: requireSecret('chatgpt_oauth_token'),
  })
}

function createRouterConfig(): SystemConfig {
  return {
    providers: {
      anthropic: {
        apiType: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
        models: {
          'claude-sonnet-4-6': {
            modelId: 'claude-sonnet-4-6',
            maxContext: 200000,
            maxOutput: 32000,
            capabilities: ['tools', 'vision'],
            tags: ['balanced'],
          },
        },
      },
      'openai-codex': {
        apiType: 'openai_chat_completions',
        baseUrl: 'https://www.right.codes/codex',
        auth: { type: 'api_key', apiKeyRef: 'openai_codex_api_key' },
        models: {
          'gpt-5.3-codex-medium': {
            modelId: 'gpt-5.3-codex-medium',
            maxContext: 400000,
            maxOutput: 128000,
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['powerful', 'coding'],
          },
          'gpt-5.3-codex-medium-backup': {
            modelId: 'gpt-5.3-codex-medium',
            maxContext: 400000,
            maxOutput: 128000,
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['powerful', 'coding', 'backup'],
          },
        },
      },
      chatgpt: {
        apiType: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
        models: {
          'gpt-5.4': {
            modelId: 'gpt-5.4',
            maxContext: 400000,
            maxOutput: 128000,
            capabilities: ['tools', 'vision', 'reasoning'],
            tags: ['powerful', 'coding'],
          },
        },
      },
    },
    defaultModel: 'anthropic/claude-sonnet-4-6',
    fallbackChain: [
      'anthropic/claude-sonnet-4-6',
      'openai-codex/gpt-5.3-codex-medium',
      'chatgpt/gpt-5.4',
      'openai-codex/gpt-5.3-codex-medium-backup',
    ],
    schedules: [],
    fuseList: [],
  }
}

function createSecretsMap(): Map<string, string> {
  const secrets = new Map<string, string>()

  if (OPENAI_CODEX_API_KEY) {
    secrets.set('openai_codex_api_key', OPENAI_CODEX_API_KEY)
  }

  if (ANTHROPIC_OAUTH_TOKEN) {
    secrets.set('CLAUDE_CODE_OAUTH_TOKEN', ANTHROPIC_OAUTH_TOKEN)
  }

  if (CHATGPT_OAUTH_TOKEN) {
    secrets.set('chatgpt_oauth_token', CHATGPT_OAUTH_TOKEN)
  }

  return secrets
}

function makeStreamingRequest(messages: Message[], system: string): CompletionRequest {
  return {
    messages,
    tools,
    system,
    stream: true,
    maxTokens: 256,
  }
}

function extractToolUses(content: ContentBlock[]) {
  return content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => {
    return block.type === 'tool_use'
  })
}

function buildToolResultMessage(
  toolUses: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
): Message {
  return makeMessage(
    'user',
    toolUses.map((toolUse) => ({
      type: 'tool_result',
      toolUseId: toolUse.id,
      content: FAKE_TOOL_RESULT,
    })),
  )
}

function buildFollowUpHistory(
  initialUserText: string,
  assistantContent: ContentBlock[],
  assistantModel: string,
  textFallback: string,
) {
  const messages: Message[] = [
    makeTextMessage('user', initialUserText),
    makeMessage('assistant', assistantContent, assistantModel),
  ]
  const toolUses = extractToolUses(assistantContent)

  if (toolUses.length > 0) {
    messages.push(buildToolResultMessage(toolUses))
  } else {
    messages.push(makeTextMessage('user', textFallback))
  }

  return { messages, toolUses }
}

function extendHistoryForNextProvider(
  history: Message[],
  assistantContent: ContentBlock[],
  assistantModel: string,
  textFallback: string,
) {
  const messages = [...history, makeMessage('assistant', assistantContent, assistantModel)]
  const toolUses = extractToolUses(assistantContent)

  if (toolUses.length > 0) {
    messages.push(buildToolResultMessage(toolUses))
  } else {
    messages.push(makeTextMessage('user', textFallback))
  }

  return { messages, toolUses }
}

async function runStreamingTurn(adapter: ProviderAdapter, messages: Message[], system: string) {
  return collectStream(adapter.stream(makeStreamingRequest(messages, system)))
}

function expectUsableAssistantTurn(content: ContentBlock[]) {
  expect(content.length).toBeGreaterThan(0)
  expect(content.some((block) => block.type === 'text' || block.type === 'tool_use')).toBe(true)
}

describe.skipIf(!HAS_VAULT)('Cross-provider Integration (Real API)', () => {
  test.skipIf(!HAS_ANTHROPIC || !HAS_OPENAI_CODEX)(
    'Anthropic -> OpenAI Chat handles tool history across providers',
    async () => {
      const anthropic = createAnthropicAdapter()
      const openai = createOpenAIChatAdapter()
      const initialUserText =
        'What time is it in Asia/Shanghai? Use get_current_time before answering, then keep the answer under 20 words.'

      const firstTurn = await runStreamingTurn(
        anthropic,
        [makeTextMessage('user', initialUserText)],
        INITIAL_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(firstTurn.content)

      const history = buildFollowUpHistory(
        initialUserText,
        firstTurn.content,
        'anthropic/claude-sonnet-4-6',
        'Continue the same conversation in one short sentence.',
      )

      if (history.toolUses.length > 0) {
        expect(history.toolUses.every((toolUse) => toolUse.id.startsWith('toolu_'))).toBe(true)

        const converted = getOpenAIChatHarness(openai).convertMessages({
          ...makeStreamingRequest(history.messages, CONTINUATION_SYSTEM_PROMPT),
          stream: false,
        })

        expect(
          converted
            .find((message) => message.role === 'assistant')
            ?.tool_calls?.map((call) => call.id),
        ).toEqual(history.toolUses.map((toolUse) => toolUse.id))
        expect(
          converted
            .filter((message) => message.role === 'tool')
            .map((message) => message.tool_call_id),
        ).toEqual(history.toolUses.map((toolUse) => toolUse.id))
      }

      const followUp = await runStreamingTurn(openai, history.messages, CONTINUATION_SYSTEM_PROMPT)
      expectUsableAssistantTurn(followUp.content)
    },
    60000,
  )

  test.skipIf(!HAS_OPENAI_CODEX || !HAS_ANTHROPIC)(
    'OpenAI Chat -> Anthropic handles tool history across providers',
    async () => {
      const openai = createOpenAIChatAdapter()
      const anthropic = createAnthropicAdapter()
      const initialUserText =
        'Tell me the current time in Asia/Shanghai. Call get_current_time first if the tool is available.'

      const firstTurn = await runStreamingTurn(
        openai,
        [makeTextMessage('user', initialUserText)],
        INITIAL_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(firstTurn.content)

      const history = buildFollowUpHistory(
        initialUserText,
        firstTurn.content,
        'openai-codex/gpt-5.3-codex-medium',
        'Continue the same conversation in one short sentence.',
      )

      if (history.toolUses.length > 0) {
        expect(history.toolUses.every((toolUse) => toolUse.id.startsWith('call_'))).toBe(true)

        const converted = getAnthropicHarness(anthropic).convertMessages({
          ...makeStreamingRequest(history.messages, CONTINUATION_SYSTEM_PROMPT),
          stream: false,
        })

        expect(
          converted
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.id),
        ).toEqual(history.toolUses.map((toolUse) => toolUse.id))
        expect(
          converted
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'tool_result')
            .map((block) => block.tool_use_id),
        ).toEqual(history.toolUses.map((toolUse) => toolUse.id))
      }

      const followUp = await runStreamingTurn(
        anthropic,
        history.messages,
        CONTINUATION_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(followUp.content)
    },
    60000,
  )

  test.skipIf(!HAS_ANTHROPIC || !HAS_OPENAI_CODEX)(
    'ModelRouter supports Anthropic -> OpenAI Chat -> ChatGPT/OpenAI fallback switching',
    async () => {
      const router = new ModelRouter(createRouterConfig(), createSecretsMap())
      const initResult = router.init()

      expect(initResult.success).toBe(true)
      expect(initResult.model?.providerName).toBe('anthropic')

      const initialUserText =
        'Use get_current_time for Asia/Shanghai if available, then answer briefly.'
      const firstTurn = await runStreamingTurn(
        router.getAdapter(),
        [makeTextMessage('user', initialUserText)],
        INITIAL_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(firstTurn.content)

      let history = buildFollowUpHistory(
        initialUserText,
        firstTurn.content,
        'anthropic/claude-sonnet-4-6',
        'Continue from the previous answer in one sentence.',
      ).messages

      const secondSwitch = router.switchModel('openai-codex/gpt-5.3-codex-medium')
      expect(secondSwitch.success).toBe(true)
      expect(secondSwitch.model?.providerName).toBe('openai-codex')

      const secondTurn = await runStreamingTurn(
        router.getAdapter(),
        history,
        CONTINUATION_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(secondTurn.content)

      history = extendHistoryForNextProvider(
        history,
        secondTurn.content,
        'openai-codex/gpt-5.3-codex-medium',
        'Summarize the handoff so far in one short sentence.',
      ).messages

      let thirdTarget = 'chatgpt/gpt-5.4'
      let expectedProvider = 'chatgpt'

      if (HAS_CHATGPT) {
        const chatgptAdapter = createChatGptAdapter()
        const chatgptHealthy = await chatgptAdapter.healthCheck().catch(() => false)
        if (!chatgptHealthy) {
          thirdTarget = 'openai-codex/gpt-5.3-codex-medium-backup'
          expectedProvider = 'openai-codex'
        }
      } else {
        thirdTarget = 'openai-codex/gpt-5.3-codex-medium-backup'
        expectedProvider = 'openai-codex'
      }

      const thirdSwitch = router.switchModel(thirdTarget)
      expect(thirdSwitch.success).toBe(true)
      expect(thirdSwitch.model?.providerName).toBe(expectedProvider)

      const thirdTurn = await runStreamingTurn(
        router.getAdapter(),
        history,
        CONTINUATION_SYSTEM_PROMPT,
      )
      expectUsableAssistantTurn(thirdTurn.content)
    },
    60000,
  )
})
