import { join } from 'node:path'
import { DingtalkChannel } from '@zero-os/channel'
import type { Vault } from '@zero-os/secrets'
import type { ChannelInstanceConfig } from '@zero-os/shared'
import { DingtalkAdapter } from '../../channels/dingtalk'
import {
  type ExternalChannelRegistrarOptions,
  UnconfiguredChannel,
  buildAgentName,
  createRuntimeChannelMessageHandler,
} from './runtime-common'
import type { DingtalkRuntimeDefinition } from './types'

export function buildConfiguredDingtalkDefinition(
  channel: Extract<ChannelInstanceConfig, { type: 'dingtalk' }>,
  vault: Vault,
): DingtalkRuntimeDefinition {
  const clientId = vault.get(channel.clientIdRef)
  const clientSecret = vault.get(channel.clientSecretRef)
  const robotCode = channel.robotCodeRef
    ? (vault.get(channel.robotCodeRef) ?? undefined)
    : undefined

  return {
    name: channel.name,
    type: 'dingtalk',
    configured: !!(clientId && clientSecret),
    receiveNotifications: channel.receiveNotifications ?? false,
    secretRefs: [
      channel.clientIdRef,
      channel.clientSecretRef,
      ...(channel.robotCodeRef ? [channel.robotCodeRef] : []),
    ],
    debug: channel.debug ?? false,
    keepAlive: channel.keepAlive ?? true,
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

export async function registerDingtalkRuntimeChannel(
  definition: DingtalkRuntimeDefinition,
  options: ExternalChannelRegistrarOptions,
): Promise<void> {
  if (!definition.credentials) {
    options.channels.set(definition.name, new UnconfiguredChannel(definition.name, 'dingtalk'))
    options.heartbeat.write()
    return
  }

  const agentName = buildAgentName(definition.name)
  const dingtalkChannel = new DingtalkChannel({
    name: definition.name,
    clientId: definition.credentials.clientId,
    clientSecret: definition.credentials.clientSecret,
    robotCode: definition.credentials.robotCode,
    debug: definition.debug,
    keepAlive: definition.keepAlive,
    downloadsDir: join(options.zeroDir, 'workspace', agentName, 'uploads'),
  })

  const channelName = definition.name
  const dingtalkAdapter = new DingtalkAdapter(dingtalkChannel)
  dingtalkChannel.setMessageHandler(
    createRuntimeChannelMessageHandler(options, {
      channelType: 'dingtalk',
      channelName,
      agentName,
      channelAdapter: dingtalkAdapter,
      channelCapabilities: dingtalkChannel.getCapabilities(),
    }),
  )

  await dingtalkChannel.start()
  console.log(`[ZeRo OS] Channel started: ${definition.name}`)

  options.channels.set(definition.name, dingtalkChannel)
  options.heartbeat.write()
}
