import type {
  TelegramBotCommand,
  TelegramChannel,
  TelegramMenuButtonConfig,
  TelegramSetMyCommandsOptions,
} from '@zero-os/channel'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from './adapter'

type TelegramSentMessage = Awaited<ReturnType<TelegramChannel['sendRich']>>

export interface TelegramAdapterOptions {
  streaming?: boolean
}

export class TelegramAdapter implements ChannelAdapter {
  constructor(
    private readonly telegramChannel: TelegramChannel,
    private readonly options: TelegramAdapterOptions = {},
  ) {}

  async reply(chatId: string, text: string, replyToMessageId?: string | number): Promise<void> {
    if (replyToMessageId !== undefined && replyToMessageId !== null) {
      await this.telegramChannel.replyRich(chatId, Number(replyToMessageId), text)
      return
    }
    await this.telegramChannel.sendRich(chatId, text)
  }

  async showTyping(chatId: string, messageId?: string | number): Promise<TypingHandle | null> {
    await this.telegramChannel.sendTyping(chatId).catch(() => {})

    if (messageId !== undefined && messageId !== null) {
      await this.telegramChannel.react(chatId, Number(messageId), '👀').catch(() => {})
    }

    return {
      clear: async () => {},
    }
  }

  async createStreaming(
    chatId: string,
    replyToMessageId?: string | number,
  ): Promise<StreamAdapter | null> {
    if (this.options.streaming === false) return null

    return createTelegramStreamingAdapter({
      telegramChannel: this.telegramChannel,
      chatId,
      replyToMessageId,
    })
  }

  async markDone(chatId: string, messageId?: string | number): Promise<void> {
    if (messageId === undefined || messageId === null) return
    await this.telegramChannel.react(chatId, Number(messageId), '✅')
  }

  async markError(chatId: string, messageId?: string | number): Promise<void> {
    if (messageId === undefined || messageId === null) return
    await this.telegramChannel.react(chatId, Number(messageId), '❌')
  }
}

export interface TelegramStreamingAdapterOptions {
  telegramChannel: Pick<TelegramChannel, 'sendRich' | 'replyRich' | 'editRich' | 'sendTyping'>
  chatId: string
  replyToMessageId?: string | number
  minIntervalMs?: number
}

export function createTelegramStreamingAdapter({
  telegramChannel,
  chatId,
  replyToMessageId,
  minIntervalMs,
}: TelegramStreamingAdapterOptions): StreamAdapter {
  let streamText = ''
  const flusher = createTelegramStreamFlusher({
    minIntervalMs,
    getText: () => streamText,
    sendInitial: async (text) => {
      const sent =
        replyToMessageId !== undefined && replyToMessageId !== null
          ? await telegramChannel.replyRich(chatId, Number(replyToMessageId), text)
          : await telegramChannel.sendRich(chatId, text)
      return getTelegramSentMessageId(sent)
    },
    edit: async (sentMessageId, text) => {
      await telegramChannel.editRich(chatId, sentMessageId, text)
    },
  })

  return {
    update: async (fullText: string) => {
      streamText = fullText
      await telegramChannel.sendTyping(chatId).catch(() => {})
      await flusher.flush(false)
    },
    complete: async (finalText: string) => {
      streamText = reconcileTelegramFinalText(streamText, finalText)
      if (!streamText) return
      await flusher.flush(true)
    },
    abort: async (errorMessage?: string) => {
      const text = errorMessage?.trim()
      if (!text) return
      streamText = text
      await flusher.flush(true)
    },
  }
}

function getTelegramSentMessageId(sent: TelegramSentMessage): number | null {
  return sent?.message_id ?? null
}

function reconcileTelegramFinalText(streamText: string, finalReply: string): string {
  if (!finalReply) return streamText
  return finalReply === streamText ? streamText : finalReply
}

export interface TelegramStreamFlusherConfig {
  minIntervalMs?: number
  now?: () => number
  getText: () => string
  sendInitial: (text: string) => Promise<number | null>
  edit: (messageId: number, text: string) => Promise<void>
}

/**
 * Maintain streaming flush state so forced final flush cannot be lost during in-flight edits.
 */
export function createTelegramStreamFlusher(config: TelegramStreamFlusherConfig) {
  const minIntervalMs = config.minIntervalMs ?? 350
  const now = config.now ?? Date.now

  let lastFlushedText = ''
  let lastFlushAt = 0
  let editedMessageId: number | null = null

  let running = false
  let pending = false
  let pendingForce = false
  const idleWaiters: Array<() => void> = []

  const resolveIdle = () => {
    if (running || pending) return
    const waiters = idleWaiters.splice(0, idleWaiters.length)
    for (const notify of waiters) {
      notify()
    }
  }

  const waitForIdle = (): Promise<void> => {
    if (!running && !pending) return Promise.resolve()
    return new Promise((resolve) => {
      idleWaiters.push(resolve)
    })
  }

  const flush = async (force = false): Promise<void> => {
    pending = true
    pendingForce = pendingForce || force

    if (running) {
      await waitForIdle()
      return
    }

    running = true
    try {
      while (pending) {
        const cycleForce = pendingForce
        pending = false
        pendingForce = false

        const text = config.getText()

        const nowMs = now()
        if (
          !shouldFlushTelegramStreamText({
            text,
            force: cycleForce,
            nowMs,
            lastFlushAt,
            minIntervalMs,
            lastFlushedText,
          })
        ) {
          continue
        }

        if (editedMessageId === null) {
          editedMessageId = await config.sendInitial(text)
        } else {
          await config.edit(editedMessageId, text)
        }

        lastFlushAt = now()
        lastFlushedText = text
      }
    } finally {
      running = false
      resolveIdle()
    }
  }

  return {
    flush,
    getLastFlushedText: () => lastFlushedText,
  }
}

export interface TelegramStreamFlushPolicyInput {
  text: string
  force: boolean
  nowMs: number
  lastFlushAt: number
  minIntervalMs: number
  lastFlushedText: string
}

export function shouldFlushTelegramStreamText({
  text,
  force,
  nowMs,
  lastFlushAt,
  minIntervalMs,
  lastFlushedText,
}: TelegramStreamFlushPolicyInput): boolean {
  if (!text) return false
  if (force) return true
  if (nowMs - lastFlushAt < minIntervalMs) return false
  return text !== lastFlushedText
}

export interface TelegramCommandSyncTarget {
  commands: TelegramBotCommand[]
  options: TelegramSetMyCommandsOptions
}

interface TelegramMenuSyncChannel {
  setMyCommands(
    commands: TelegramBotCommand[],
    options: TelegramSetMyCommandsOptions,
  ): Promise<void>
  setChatMenuButton(options: { menuButton: TelegramMenuButtonConfig }): Promise<void>
}

export function buildTelegramDefaultCommands(): TelegramBotCommand[] {
  return [
    {
      command: 'new',
      description: 'Start a new conversation (/new [model])',
    },
    {
      command: 'model',
      description: 'Show or switch model (/model [name])',
    },
    {
      command: 'think',
      description: 'Show or set thinking effort (/think [xhigh])',
    },
    {
      command: 'session',
      description: 'Show current session info (/session)',
    },
  ]
}

export function buildTelegramPrivateCommands(): TelegramBotCommand[] {
  return [
    ...buildTelegramDefaultCommands(),
    {
      command: 'restart',
      description: 'Restart ZeRo OS service',
    },
  ]
}

export function buildTelegramMenuButton(): TelegramMenuButtonConfig {
  return { type: 'commands' }
}

export function buildTelegramCommandSyncTargets(): TelegramCommandSyncTarget[] {
  return [
    {
      commands: buildTelegramDefaultCommands(),
      options: {
        scope: { type: 'default' },
        languageCode: '',
      },
    },
    {
      commands: buildTelegramPrivateCommands(),
      options: {
        scope: { type: 'all_private_chats' },
        languageCode: '',
      },
    },
  ]
}

export async function syncTelegramCommandMenu(channel: TelegramMenuSyncChannel): Promise<void> {
  for (const target of buildTelegramCommandSyncTargets()) {
    await channel.setMyCommands(target.commands, target.options)
  }

  await channel.setChatMenuButton({
    menuButton: buildTelegramMenuButton(),
  })
}
