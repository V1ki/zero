import { join } from 'node:path'
import { FeishuChannel, type FeishuStreamingSession } from '@zero-os/channel'
import type { Vault } from '@zero-os/secrets'
import type { ChannelInstanceConfig } from '@zero-os/shared'
import { FeishuAdapter } from '../../channels/feishu'
import {
  type ExternalChannelRegistrarOptions,
  buildAgentName,
  createRuntimeChannelMessageHandler,
} from './runtime-common'
import type { FeishuRuntimeDefinition } from './types'

export function buildConfiguredFeishuDefinition(
  channel: Extract<ChannelInstanceConfig, { type: 'feishu' }>,
  vault: Vault,
): FeishuRuntimeDefinition {
  const appId = vault.get(channel.appIdRef)
  const appSecret = vault.get(channel.appSecretRef)

  return {
    name: channel.name,
    type: 'feishu',
    configured: !!(appId && appSecret),
    receiveNotifications: channel.receiveNotifications ?? false,
    secretRefs: [
      channel.appIdRef,
      channel.appSecretRef,
      ...(channel.encryptKeyRef ? [channel.encryptKeyRef] : []),
      ...(channel.verificationTokenRef ? [channel.verificationTokenRef] : []),
    ],
    credentials:
      appId && appSecret
        ? {
            appId,
            appSecret,
            encryptKey: channel.encryptKeyRef
              ? (vault.get(channel.encryptKeyRef) ?? undefined)
              : undefined,
            verificationToken: channel.verificationTokenRef
              ? (vault.get(channel.verificationTokenRef) ?? undefined)
              : undefined,
          }
        : undefined,
  }
}

export async function registerFeishuRuntimeChannel(
  definition: FeishuRuntimeDefinition,
  options: ExternalChannelRegistrarOptions,
): Promise<void> {
  const agentName = buildAgentName(definition.name)
  const feishuChannel = new FeishuChannel({
    name: definition.name,
    appId: definition.credentials?.appId ?? '',
    appSecret: definition.credentials?.appSecret ?? '',
    encryptKey: definition.credentials?.encryptKey,
    verificationToken: definition.credentials?.verificationToken,
    downloadsDir: join(options.zeroDir, 'workspace', agentName, 'uploads'),
  })

  let activeStreamingSessions: Set<FeishuStreamingSession> | undefined
  if (definition.credentials) {
    const channelName = definition.name
    activeStreamingSessions = new Set<FeishuStreamingSession>()
    const feishuAdapter = new FeishuAdapter(feishuChannel, {
      activeStreamingSessions,
    })

    feishuChannel.setMessageHandler(
      createRuntimeChannelMessageHandler(options, {
        channelType: 'feishu',
        channelName,
        agentName,
        channelAdapter: feishuAdapter,
        channelCapabilities: feishuChannel.getCapabilities(),
      }),
    )

    await feishuChannel.start()
    console.log(`[ZeRo OS] Channel started: ${definition.name}`)
  }

  options.channels.set(definition.name, feishuChannel)
  options.heartbeat.write()
  if (activeStreamingSessions) options.registerFeishuStreamingSessionSet(activeStreamingSessions)
}
