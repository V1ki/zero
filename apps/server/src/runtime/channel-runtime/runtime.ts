import { type Channel, type FeishuStreamingSession, WebChannel } from '@zero-os/channel'
import type { CommandRouter, SessionManager } from '@zero-os/core'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import type { ChannelInstanceConfig, SystemConfig } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import type { ChannelAdapter } from '../../channels/adapter'
import { buildConfiguredDingtalkDefinition, registerDingtalkRuntimeChannel } from './dingtalk'
import { buildConfiguredFeishuDefinition, registerFeishuRuntimeChannel } from './feishu'
import type { ExternalChannelRegistrarOptions } from './runtime-common'
import { buildConfiguredTelegramDefinition, registerTelegramRuntimeChannel } from './telegram'
import type {
  ChannelRuntimeDefinition,
  DingtalkRuntimeDefinition,
  ExternalChannelRuntimeDefinition,
  FeishuRuntimeDefinition,
  TelegramRuntimeDefinition,
} from './types'
import { buildConfiguredWeixinDefinition, registerWeixinRuntimeChannel } from './weixin'

export { createFeishuStreamingStarter } from './runtime-common'

interface RegisterExternalRuntimeChannelsOptions {
  zeroDir: string
  config: SystemConfig
  vault: Vault
  channels: Map<string, Channel>
  channelAdapters: Map<string, ChannelAdapter>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  sessionManager: SessionManager
  commandRouter: CommandRouter
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'write'>
  agentInstruction: string
  sessionStallTimeoutMs?: number
  isShuttingDown(): boolean
  registerFeishuStreamingSessionSet(sessionSet: Set<FeishuStreamingSession>): void
}

export async function registerExternalRuntimeChannels({
  zeroDir,
  config,
  vault,
  channels,
  channelAdapters,
  channelDefinitions,
  sessionManager,
  commandRouter,
  metrics,
  heartbeat,
  agentInstruction,
  sessionStallTimeoutMs,
  isShuttingDown,
  registerFeishuStreamingSessionSet,
}: RegisterExternalRuntimeChannelsOptions): Promise<void> {
  const externalChannelDefinitions = buildExternalChannelDefinitions(config.channels, vault)
  const registrarOptions = {
    zeroDir,
    channels,
    channelAdapters,
    sessionManager,
    commandRouter,
    metrics,
    heartbeat,
    agentInstruction,
    sessionStallTimeoutMs,
    isShuttingDown,
    registerFeishuStreamingSessionSet,
  }

  for (const definition of externalChannelDefinitions) {
    channelDefinitions.set(definition.name, definition)
    await registerExternalChannelDefinition(definition, registrarOptions)
  }
}

export async function registerWebRuntimeChannel(options: {
  channels: Map<string, Channel>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  heartbeat: Pick<HeartbeatWriter, 'write'>
}): Promise<void> {
  const webChannel = new WebChannel()
  await webChannel.start()
  options.channels.set('web', webChannel)
  options.channelDefinitions.set('web', {
    name: 'web',
    type: 'web',
    configured: true,
    receiveNotifications: false,
    secretRefs: [],
  })
  options.heartbeat.write()
}

export async function abortActiveStreamingSessions(
  allActiveStreamingSessions: Set<FeishuStreamingSession>[],
): Promise<void> {
  const activeStreamingCount = allActiveStreamingSessions.reduce(
    (count, sessions) => count + sessions.size,
    0,
  )
  if (activeStreamingCount === 0) return

  await Promise.allSettled(
    allActiveStreamingSessions.flatMap((sessions) =>
      Array.from(sessions).map(async (streaming) => {
        try {
          await streaming.abort('ZeRo OS is restarting...')
        } finally {
          sessions.delete(streaming)
        }
      }),
    ),
  )
  console.log(
    `[ZeRo OS] Aborted ${activeStreamingCount} active Feishu streaming session(s) during shutdown`,
  )
}

function buildExternalChannelDefinitions(
  configuredChannels: ChannelInstanceConfig[] | undefined,
  vault: Vault,
): ExternalChannelRuntimeDefinition[] {
  if (!configuredChannels) {
    return buildFallbackChannelDefinitions(vault)
  }

  return configuredChannels.flatMap((channel) => {
    const definition = buildConfiguredChannelDefinition(channel, vault)
    return definition ? [definition] : []
  })
}

function buildConfiguredChannelDefinition(
  channel: ChannelInstanceConfig,
  vault: Vault,
): ExternalChannelRuntimeDefinition | undefined {
  if (channel.enabled === false || channel.type === 'web') return undefined

  if (channel.type === 'feishu') {
    return buildConfiguredFeishuDefinition(channel, vault)
  }

  if (channel.type === 'dingtalk') {
    return buildConfiguredDingtalkDefinition(channel, vault)
  }

  if (channel.type === 'weixin') {
    return buildConfiguredWeixinDefinition(channel, vault)
  }

  if (channel.type === 'telegram') {
    return buildConfiguredTelegramDefinition(channel, vault)
  }

  return undefined
}

function buildFallbackChannelDefinitions(vault: Vault): ExternalChannelRuntimeDefinition[] {
  return [
    buildFallbackDingtalkDefinition(vault),
    buildFallbackFeishuDefinition(vault),
    buildFallbackTelegramDefinition(vault),
  ]
}

function buildFallbackDingtalkDefinition(vault: Vault): DingtalkRuntimeDefinition {
  const clientId = vault.get('dingtalk_client_id')
  const clientSecret = vault.get('dingtalk_client_secret')
  const robotCode = vault.get('dingtalk_robot_code') ?? undefined

  return {
    name: 'dingtalk',
    type: 'dingtalk',
    configured: !!(clientId && clientSecret),
    receiveNotifications: false,
    secretRefs: ['dingtalk_client_id', 'dingtalk_client_secret', 'dingtalk_robot_code'],
    debug: false,
    keepAlive: true,
    credentials:
      clientId && clientSecret
        ? {
            clientId,
            clientSecret,
            robotCode,
          }
        : undefined,
  }
}

function buildFallbackFeishuDefinition(vault: Vault): FeishuRuntimeDefinition {
  const appId = vault.get('feishu_app_id')
  const appSecret = vault.get('feishu_app_secret')

  return {
    name: 'feishu',
    type: 'feishu',
    configured: !!(appId && appSecret),
    receiveNotifications: false,
    secretRefs: [
      'feishu_app_id',
      'feishu_app_secret',
      'feishu_encrypt_key',
      'feishu_verification_token',
    ],
    credentials:
      appId && appSecret
        ? {
            appId,
            appSecret,
            encryptKey: vault.get('feishu_encrypt_key') ?? undefined,
            verificationToken: vault.get('feishu_verification_token') ?? undefined,
          }
        : undefined,
  }
}

function buildFallbackTelegramDefinition(vault: Vault): TelegramRuntimeDefinition {
  const botToken = vault.get('telegram_bot_token')

  return {
    name: 'telegram',
    type: 'telegram',
    configured: !!botToken,
    receiveNotifications: false,
    streaming: true,
    secretRefs: ['telegram_bot_token'],
    credentials: botToken ? { botToken } : undefined,
  }
}

async function registerExternalChannelDefinition(
  definition: ExternalChannelRuntimeDefinition,
  options: ExternalChannelRegistrarOptions,
): Promise<void> {
  if (definition.type === 'feishu') {
    await registerFeishuRuntimeChannel(definition, options)
    return
  }

  if (definition.type === 'dingtalk') {
    await registerDingtalkRuntimeChannel(definition, options)
    return
  }

  if (definition.type === 'weixin') {
    await registerWeixinRuntimeChannel(definition, options)
    return
  }

  await registerTelegramRuntimeChannel(definition, options)
}
