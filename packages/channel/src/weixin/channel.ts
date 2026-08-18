import type { Channel, ChannelCapabilities, MessageHandler } from '../base'
import { type ApiOptions, type FetchImpl, postJson } from './api-transport'
import {
  CONFIG_TIMEOUT_MS,
  EP_NOTIFY_START,
  EP_NOTIFY_STOP,
  ILINK_BASE_URL,
  MAX_MESSAGE_LENGTH,
  SESSION_EXPIRED_ERRCODE,
  WEIXIN_CDN_BASE_URL,
} from './constants'
import { WeixinDelivery } from './delivery'
import { WeixinInboundDispatcher } from './inbound-dispatcher'
import { runWeixinPollingLoop } from './polling'
import { ContextTokenStore } from './storage'
import type { IncomingMessage as ILinkIncomingMessage, WeixinChannelConfig } from './types'
import { WeixinTypingNotifier } from './typing'

export { guessChatType } from './inbound'

export interface WeixinChannelRuntimeOptions {
  /** Override fetch for tests */
  fetchImpl?: FetchImpl
  /** Override clock (ms since epoch) for tests */
  now?: () => number
  /** Sleep helper so tests can short-circuit backoff */
  sleep?: (ms: number) => Promise<void>
}

export interface NotifyResponse {
  ret?: number
  errmsg?: string
}

export async function notifyStart(
  params: { baseUrl: string; token: string },
  opts: ApiOptions = {},
): Promise<NotifyResponse> {
  return postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_NOTIFY_START,
      payload: {},
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    },
    opts,
  )
}

export async function notifyStop(
  params: { baseUrl: string; token: string },
  opts: ApiOptions = {},
): Promise<NotifyResponse> {
  return postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_NOTIFY_STOP,
      payload: {},
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    },
    opts,
  )
}

function sleepUntilAborted(ms: number, getAbortSignal: () => AbortSignal | undefined): Promise<void> {
  const abortSignal = getAbortSignal()
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (abortSignal.aborted) return Promise.reject(makeAbortError())

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(makeAbortError())
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortableFetch(
  baseFetch: FetchImpl,
  getAbortSignal: () => AbortSignal | undefined,
): FetchImpl {
  return async (input, init) => {
    const abortSignal = getAbortSignal()
    if (!abortSignal) return baseFetch(input, init)
    if (abortSignal.aborted) throw makeAbortError()

    let onAbort: (() => void) | undefined
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(makeAbortError())
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      return await Promise.race([baseFetch(input, init), abortPromise])
    } finally {
      if (onAbort) abortSignal.removeEventListener('abort', onAbort)
    }
  }
}

function makeAbortError(): Error {
  const error = new Error('aborted') as Error & { name: string }
  error.name = 'AbortError'
  return error
}

class WeixinSessionPauseState {
  private pausedUntilMs: number | null = null

  constructor(private readonly now: () => number) {}

  pauseUntil(pausedUntilMs: number): void {
    this.pausedUntilMs = pausedUntilMs
  }

  assertActive(): void {
    const pausedUntil = this.pausedUntilMs
    if (!pausedUntil || this.now() >= pausedUntil) {
      if (pausedUntil) this.pausedUntilMs = null
      return
    }

    throw new Error(
      `Weixin session paused after ${SESSION_EXPIRED_ERRCODE}; retry after ${new Date(
        pausedUntil,
      ).toISOString()}`,
    )
  }

  isPaused(): boolean {
    try {
      this.assertActive()
      return false
    } catch {
      return true
    }
  }
}

export class WeixinChannel implements Channel {
  readonly name: string
  readonly type = 'weixin' as const

  private readonly accountId: string
  private readonly token: string
  private readonly baseUrl: string
  private readonly cdnBaseUrl: string
  private readonly botAgent: string | undefined
  private readonly homeDir: string
  private readonly delivery: WeixinDelivery
  private readonly inboundDispatcher: WeixinInboundDispatcher
  private readonly typingNotifier: WeixinTypingNotifier

  private readonly tokenStore: ContextTokenStore

  private messageHandler: MessageHandler | null = null
  private pollAbort: AbortController | null = null
  private pollTask: Promise<void> | null = null
  private running = false
  private connected = false

  private readonly fetchImpl: FetchImpl
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly sessionPause: WeixinSessionPauseState

  constructor(config: WeixinChannelConfig, runtime: WeixinChannelRuntimeOptions = {}) {
    if (!config.accountId) throw new Error('WeixinChannel: accountId is required')
    if (!config.token) throw new Error('WeixinChannel: token is required')
    if (!config.homeDir) throw new Error('WeixinChannel: homeDir is required')

    this.name = config.name ?? 'weixin'
    this.accountId = config.accountId
    this.token = config.token
    this.baseUrl = (config.baseUrl ?? ILINK_BASE_URL).replace(/\/$/, '')
    this.cdnBaseUrl = (config.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL).replace(/\/$/, '')
    this.botAgent = config.botAgent
    this.homeDir = config.homeDir
    const dmPolicy = config.dmPolicy ?? 'open'
    const groupPolicy = config.groupPolicy ?? 'disabled'
    const sendChunkDelayMs = config.sendChunkDelayMs ?? 350
    const sendChunkRetries = config.sendChunkRetries ?? 2
    const sendChunkRetryDelayMs = config.sendChunkRetryDelayMs ?? 1000
    const splitMultiline = config.splitMultilineMessages ?? false

    this.tokenStore = new ContextTokenStore(this.homeDir)

    const baseFetch = runtime.fetchImpl ?? globalThis.fetch
    this.fetchImpl = createAbortableFetch(baseFetch, () => this.pollAbort?.signal)
    this.sleep = runtime.sleep ?? ((ms) => sleepUntilAborted(ms, () => this.pollAbort?.signal))
    this.now = runtime.now ?? (() => Date.now())
    this.sessionPause = new WeixinSessionPauseState(this.now)
    this.delivery = new WeixinDelivery({
      baseUrl: this.baseUrl,
      token: this.token,
      cdnBaseUrl: this.cdnBaseUrl,
      botAgent: this.botAgent,
      accountId: this.accountId,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      getContextToken: (accountId, chatId) => this.tokenStore.get(accountId, chatId),
      sendChunkDelayMs,
      sendChunkRetries,
      sendChunkRetryDelayMs,
      splitMultiline,
    })
    this.typingNotifier = new WeixinTypingNotifier({
      baseUrl: this.baseUrl,
      token: this.token,
      getApiOptions: () => this.apiOpts(),
      isSessionPaused: () => this.sessionPause.isPaused(),
    })
    this.inboundDispatcher = new WeixinInboundDispatcher({
      accountId: this.accountId,
      channelName: this.name,
      cdnBaseUrl: this.cdnBaseUrl,
      dmPolicy,
      groupPolicy,
      allowFrom: config.allowFrom,
      groupAllowFrom: config.groupAllowFrom,
      tokenStore: this.tokenStore,
      getApiOptions: () => this.apiOpts(),
      getMessageHandler: () => this.messageHandler,
      maybeFetchTypingTicket: (chatId, contextToken) => {
        void this.typingNotifier.maybeFetchTicket(chatId, contextToken)
      },
    })
  }

  async start(): Promise<void> {
    if (this.running) return
    this.tokenStore.restore(this.accountId)
    this.running = true
    this.connected = true
    this.pollAbort = new AbortController()
    try {
      const response = await notifyStart(
        { baseUrl: this.baseUrl, token: this.token },
        this.apiOpts(),
      )
      if (response.ret !== undefined && response.ret !== 0) {
        console.warn(
          `[WeixinChannel] notifyStart returned ret=${response.ret} channel=${this.name}`,
        )
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[WeixinChannel] notifyStart failed channel=${this.name}: ${reason}`)
    }
    this.pollTask = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.pollAbort?.abort()
    const task = this.pollTask
    this.pollTask = null
    if (task) {
      try {
        await task
      } catch {
        // expected on abort
      }
    }
    this.pollAbort = null
    try {
      const response = await notifyStop(
        { baseUrl: this.baseUrl, token: this.token },
        this.apiOpts(),
      )
      if (response.ret !== undefined && response.ret !== 0) {
        console.warn(`[WeixinChannel] notifyStop returned ret=${response.ret} channel=${this.name}`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[WeixinChannel] notifyStop failed channel=${this.name}: ${reason}`)
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: false,
      inlineImages: true,
      imageMessages: true,
      fileMessages: true,
      interactiveCards: false,
      mentions: false,
      reactions: false,
      threadReply: false,
      maxMessageLength: MAX_MESSAGE_LENGTH,
      markdownNotes: `Weixin does not support true inline image embedding; markdown image references are delivered as follow-up image messages. H1 headings are converted to 【Title】. H2+ become **bold**. Tables are flattened to \`- key: value\` lists. Sent messages cannot be edited. Long content is split into multiple bubbles at ${MAX_MESSAGE_LENGTH} chars.`,
    }
  }

  private apiOpts(): ApiOptions {
    return { fetchImpl: this.fetchImpl, botAgent: this.botAgent }
  }

  private async pollLoop(): Promise<void> {
    await runWeixinPollingLoop({
      homeDir: this.homeDir,
      accountId: this.accountId,
      baseUrl: this.baseUrl,
      token: this.token,
      channelName: this.name,
      getApiOptions: () => this.apiOpts(),
      isRunning: () => this.running,
      sleep: this.sleep,
      now: this.now,
      setSessionPausedUntil: (pausedUntilMs) => {
        this.sessionPause.pauseUntil(pausedUntilMs)
      },
      processMessage: (message) => this.processMessageSafe(message),
    })
  }

  private async processMessageSafe(message: ILinkIncomingMessage): Promise<void> {
    await this.inboundDispatcher.processSafe(message)
  }

  private async processMessage(message: ILinkIncomingMessage): Promise<void> {
    await this.inboundDispatcher.process(message)
  }

  async send(_sessionId: string, content: string): Promise<void> {
    await this.sendToChat(_sessionId, content)
  }

  /**
   * Internal send — accepts the chat identifier directly (the chatId stored in
   * metadata by processMessage). This is used by the adapter layer.
   */
  async sendToChat(chatId: string, content: string): Promise<void> {
    this.sessionPause.assertActive()
    await this.delivery.sendToChat(chatId, content)
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.typingNotifier.sendTypingIndicator(chatId)
  }

  async clearTypingIndicator(chatId: string): Promise<void> {
    await this.typingNotifier.clearTypingIndicator(chatId)
  }

  /**
   * Upload an in-memory file as a Weixin attachment. Used by the adapter for
   * both image attachments and generic file sends.
   */
  async sendAttachment(
    chatId: string,
    bytes: Buffer,
    filename: string,
    mimeHint?: string,
  ): Promise<string> {
    this.sessionPause.assertActive()
    return this.delivery.sendAttachment(chatId, bytes, filename, mimeHint)
  }
}
