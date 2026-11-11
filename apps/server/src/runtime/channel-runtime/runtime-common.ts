import type {
  Channel,
  FeishuStreamingSession,
  IncomingMessage,
  MessageHandler,
} from '@zero-os/channel'
import type { CommandRouter, SessionManager } from '@zero-os/core'
import type { MetricsDB } from '@zero-os/observe'
import type { ChannelCapabilities, SessionSource } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import type { ChannelAdapter } from '../../channels/adapter'
import { handleChannelMessage } from '../../message/handler'
import { type TriggerTaskBridge, isRouterChannelCommand } from '../../triggers/task-bridge'

export interface ExternalChannelRegistrarOptions {
  getTaskBridge?(): TriggerTaskBridge | undefined
  zeroDir: string
  channels: Map<string, Channel>
  channelAdapters: Map<string, ChannelAdapter>
  sessionManager: SessionManager
  commandRouter: CommandRouter
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'write'>
  agentInstruction: string
  sessionStallTimeoutMs?: number
  isShuttingDown(): boolean
  registerFeishuStreamingSessionSet(sessionSet: Set<FeishuStreamingSession>): void
}

interface RuntimeChannelMessageHandlerOptions {
  channelType: SessionSource
  channelName: string
  agentName: string
  channelAdapter: ChannelAdapter
  channelCapabilities: ChannelCapabilities
  mapMessage?: (message: IncomingMessage) => IncomingMessage
}

interface FeishuStreamingStarterChannel {
  replyStreaming(messageId: string): Promise<FeishuStreamingSession>
  sendStreaming(chatId: string): Promise<FeishuStreamingSession>
}

export function createFeishuStreamingStarter(
  channel: FeishuStreamingStarterChannel,
  chatId: string,
  replyToMessageId?: string,
): () => Promise<FeishuStreamingSession> {
  return () =>
    replyToMessageId ? channel.replyStreaming(replyToMessageId) : channel.sendStreaming(chatId)
}

/** Claimed inputs, including unsupported events on a selected bot, cannot open an Agent session. */
export async function dispatchRouterCommand(
  message: IncomingMessage,
  {
    channelName: channelId,
    channelType: platform,
    channelAdapter,
  }: Pick<RuntimeChannelMessageHandlerOptions, 'channelName' | 'channelType' | 'channelAdapter'>,
  bridge?: TriggerTaskBridge,
): Promise<boolean> {
  if (platform !== 'weixin' && platform !== 'feishu' && platform !== 'dingtalk') return false
  const selected = bridge?.isSelectedBot(platform, channelId) ?? false
  if (
    message.eventType === 'message_recalled' ||
    message.metadata?.eventType === 'message_recalled'
  )
    return selected
  const text = message.commandText ?? message.content
  const command = isRouterChannelCommand(text)
  if (!selected && !command) return false
  if (!bridge) return true
  const metadata = message.metadata
  const direct =
    platform === 'weixin'
      ? metadata?.chatType === 'dm'
      : platform === 'feishu'
        ? metadata?.chatType === 'p2p'
        : String(metadata?.conversationType) === '1'
  // A selected bot may handle an authorized group task, but never treat an
  // apparent DM with conflicting sender, corporation or room metadata as private.
  if (selected && (!direct || metadata?.routerDirect !== true)) {
    const group =
      (platform === 'feishu' && metadata?.chatType === 'group') ||
      (platform === 'dingtalk' && String(metadata?.conversationType) === '2')
    if (!command || !group) return true
  }
  const peerId = typeof metadata?.chatId === 'string' ? metadata.chatId : ''
  const rawId = metadata?.messageId
  const messageId = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : ''
  // Read the authenticated sender before any channel-specific session mapping replaces it.
  const result = await bridge.handle({
    platform,
    channelId,
    peerId,
    messageId,
    text,
    actorId: message.senderId,
    isDirect: direct && (!selected || metadata?.routerDirect === true),
  })
  if (result.reply && peerId && messageId && (!result.mayReply || result.mayReply()))
    await channelAdapter.reply(peerId, result.reply, messageId)
  return true
}

export function createRuntimeChannelMessageHandler(
  registrarOptions: ExternalChannelRegistrarOptions,
  handlerOptions: RuntimeChannelMessageHandlerOptions,
): MessageHandler {
  return async (message) => {
    if (registrarOptions.isShuttingDown()) return
    if (await dispatchRouterCommand(message, handlerOptions, registrarOptions.getTaskBridge?.()))
      return
    await handleChannelMessage(handlerOptions.mapMessage?.(message) ?? message, {
      channelType: handlerOptions.channelType,
      channelName: handlerOptions.channelName,
      agentName: handlerOptions.agentName,
      agentInstruction: registrarOptions.agentInstruction,
      sessionManager: registrarOptions.sessionManager,
      commandRouter: registrarOptions.commandRouter,
      channelAdapter: handlerOptions.channelAdapter,
      metrics: registrarOptions.metrics,
      channelCapabilities: handlerOptions.channelCapabilities,
      sessionStallTimeoutMs: registrarOptions.sessionStallTimeoutMs,
      isShuttingDown: registrarOptions.isShuttingDown,
    })
  }
}

export class UnconfiguredChannel implements Channel {
  constructor(
    readonly name: string,
    readonly type: 'dingtalk' | 'feishu' | 'telegram' | 'weixin',
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(): Promise<void> {
    throw new Error(`Channel "${this.name}" is not configured`)
  }

  isConnected(): boolean {
    return false
  }

  setMessageHandler(): void {}

  getCapabilities(): ChannelCapabilities {
    return {}
  }
}

export function buildAgentName(channelName: string): string {
  return `zero-${channelName.replace(/[^a-z0-9_-]+/gi, '-')}`
}
