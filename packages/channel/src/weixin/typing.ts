import { type ApiOptions, postJson } from './api-transport'
import {
  CONFIG_TIMEOUT_MS,
  EP_GET_CONFIG,
  EP_SEND_TYPING,
  TYPING_START,
  TYPING_STOP,
} from './constants'

export interface WeixinTypingNotifierOptions {
  baseUrl: string
  token: string
  getApiOptions: () => ApiOptions
  isSessionPaused: () => boolean
}

export async function sendTyping(
  params: {
    baseUrl: string
    token: string
    toUserId: string
    typingTicket: string
    status: number
  },
  opts: ApiOptions = {},
): Promise<void> {
  await postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_SEND_TYPING,
      payload: {
        ilink_user_id: params.toUserId,
        typing_ticket: params.typingTicket,
        status: params.status,
      },
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    },
    opts,
  )
}

export async function getTypingConfig(
  params: {
    baseUrl: string
    token: string
    userId: string
    contextToken?: string
  },
  opts: ApiOptions = {},
): Promise<{ typing_ticket?: string } & Record<string, unknown>> {
  const payload: Record<string, unknown> = { ilink_user_id: params.userId }
  if (params.contextToken) payload.context_token = params.contextToken
  return postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_GET_CONFIG,
      payload,
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    },
    opts,
  )
}

export class WeixinTypingNotifier {
  private readonly typingCache = new Map<string, { ticket: string; ts: number }>()

  constructor(private readonly options: WeixinTypingNotifierOptions) {}

  async maybeFetchTicket(chatId: string, contextToken: string | undefined): Promise<void> {
    const cached = this.typingCache.get(chatId)
    if (cached && Date.now() - cached.ts < 600_000) return
    try {
      const response = await getTypingConfig(
        {
          baseUrl: this.options.baseUrl,
          token: this.options.token,
          userId: chatId,
          contextToken,
        },
        this.options.getApiOptions(),
      )
      const ticket = typeof response.typing_ticket === 'string' ? response.typing_ticket : ''
      if (ticket) this.typingCache.set(chatId, { ticket, ts: Date.now() })
    } catch {
      // non-fatal
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.sendTypingStatus(chatId, TYPING_START)
  }

  async clearTypingIndicator(chatId: string): Promise<void> {
    await this.sendTypingStatus(chatId, TYPING_STOP)
  }

  private async sendTypingStatus(chatId: string, status: number): Promise<void> {
    if (this.options.isSessionPaused()) return
    const cached = this.typingCache.get(chatId)
    if (!cached) return
    try {
      await sendTyping(
        {
          baseUrl: this.options.baseUrl,
          token: this.options.token,
          toUserId: chatId,
          typingTicket: cached.ticket,
          status,
        },
        this.options.getApiOptions(),
      )
    } catch {
      // non-fatal
    }
  }
}
