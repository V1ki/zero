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

export interface ExternalChannelRegistrarOptions {
  zeroDir: string
  channels: Map<string, Channel>
  sessionManager: SessionManager
  commandRouter: CommandRouter
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'write'>
  agentInstruction: string
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

export function createRuntimeChannelMessageHandler(
  registrarOptions: ExternalChannelRegistrarOptions,
  handlerOptions: RuntimeChannelMessageHandlerOptions,
): MessageHandler {
  return async (message) => {
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
