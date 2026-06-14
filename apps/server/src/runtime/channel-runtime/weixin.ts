import { WeixinChannel } from '@zero-os/channel'
import type { Vault } from '@zero-os/secrets'
import type { ChannelInstanceConfig } from '@zero-os/shared'
import { WeixinAdapter } from '../../channels/weixin'
import {
  type ExternalChannelRegistrarOptions,
  UnconfiguredChannel,
  buildAgentName,
  createRuntimeChannelMessageHandler,
} from './runtime-common'
import type { WeixinRuntimeDefinition } from './types'

export function buildConfiguredWeixinDefinition(
  channel: Extract<ChannelInstanceConfig, { type: 'weixin' }>,
  vault: Vault,
): WeixinRuntimeDefinition {
  const accountId = vault.get(channel.accountIdRef)
  const token = vault.get(channel.tokenRef)
  const baseUrl = channel.baseUrlRef ? (vault.get(channel.baseUrlRef) ?? undefined) : undefined
  const cdnBaseUrl = channel.cdnBaseUrlRef
    ? (vault.get(channel.cdnBaseUrlRef) ?? undefined)
    : undefined

  return {
    name: channel.name,
    type: 'weixin',
    configured: !!(accountId && token),
    receiveNotifications: channel.receiveNotifications ?? false,
    secretRefs: [
      channel.accountIdRef,
      channel.tokenRef,
      ...(channel.baseUrlRef ? [channel.baseUrlRef] : []),
      ...(channel.cdnBaseUrlRef ? [channel.cdnBaseUrlRef] : []),
    ],
    credentials:
      accountId && token
        ? {
            accountId,
            token,
            baseUrl,
            cdnBaseUrl,
            botAgent: channel.botAgent,
            dmPolicy: channel.dmPolicy,
            groupPolicy: channel.groupPolicy,
            allowFrom: channel.allowFrom,
            groupAllowFrom: channel.groupAllowFrom,
          }
        : undefined,
  }
}

export async function registerWeixinRuntimeChannel(
  definition: WeixinRuntimeDefinition,
  options: ExternalChannelRegistrarOptions,
): Promise<void> {
  if (!definition.credentials) {
    options.channels.set(definition.name, new UnconfiguredChannel(definition.name, 'weixin'))
    options.heartbeat.write()
    return
  }

  const agentName = buildAgentName(definition.name)
  const weixinChannel = new WeixinChannel({
    name: definition.name,
    accountId: definition.credentials.accountId,
    token: definition.credentials.token,
    baseUrl: definition.credentials.baseUrl,
    cdnBaseUrl: definition.credentials.cdnBaseUrl,
    botAgent: definition.credentials.botAgent,
    homeDir: options.zeroDir,
    dmPolicy: definition.credentials.dmPolicy,
    groupPolicy: definition.credentials.groupPolicy,
    allowFrom: definition.credentials.allowFrom,
    groupAllowFrom: definition.credentials.groupAllowFrom,
  })

  const channelName = definition.name
  const weixinAdapter = new WeixinAdapter(weixinChannel)
  weixinChannel.setMessageHandler(
    createRuntimeChannelMessageHandler(options, {
      channelType: 'weixin',
      channelName,
      agentName,
      channelAdapter: weixinAdapter,
      channelCapabilities: weixinChannel.getCapabilities(),
      mapMessage(message) {
        const metadata = (message.metadata ?? {}) as { chatId?: string }
        const routedChatId = metadata.chatId ?? message.senderId
        return { ...message, senderId: routedChatId }
      },
    }),
  )

  await weixinChannel.start()
  console.log(`[ZeRo OS] Channel started: ${definition.name}`)

  options.channels.set(definition.name, weixinChannel)
  options.heartbeat.write()
}
