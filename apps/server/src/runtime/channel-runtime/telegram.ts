import { TelegramChannel } from '@zero-os/channel'
import type { Vault } from '@zero-os/secrets'
import type { ChannelInstanceConfig } from '@zero-os/shared'
import { syncTelegramCommandMenu, TelegramAdapter } from '../../channels/telegram'
import {
  type ExternalChannelRegistrarOptions,
  buildAgentName,
  createRuntimeChannelMessageHandler,
} from './runtime-common'
import type { TelegramRuntimeDefinition } from './types'

export function buildConfiguredTelegramDefinition(
  channel: Extract<ChannelInstanceConfig, { type: 'telegram' }>,
  vault: Vault,
): TelegramRuntimeDefinition {
  const botToken = vault.get(channel.botTokenRef)

  return {
    name: channel.name,
    type: 'telegram',
    configured: !!botToken,
    receiveNotifications: channel.receiveNotifications ?? false,
    streaming: channel.streaming ?? true,
    secretRefs: [channel.botTokenRef],
    credentials: botToken ? { botToken } : undefined,
  }
}

export async function registerTelegramRuntimeChannel(
  definition: TelegramRuntimeDefinition,
  options: ExternalChannelRegistrarOptions,
): Promise<void> {
  const telegramChannel = new TelegramChannel({
    name: definition.name,
    botToken: definition.credentials?.botToken ?? '',
    streaming: definition.streaming,
  })

  if (definition.credentials) {
    const channelName = definition.name
    const agentName = buildAgentName(channelName)
    const telegramAdapter = new TelegramAdapter(telegramChannel, {
      streaming: definition.streaming,
    })

    telegramChannel.setMessageHandler(
      createRuntimeChannelMessageHandler(options, {
        channelType: 'telegram',
        channelName,
        agentName,
        channelAdapter: telegramAdapter,
        channelCapabilities: telegramChannel.getCapabilities(),
      }),
    )

    await telegramChannel.start()

    try {
      await syncTelegramCommandMenu(telegramChannel)
      console.log(`[ZeRo OS] ${definition.name} commands/menu synced`)
    } catch (err) {
      console.warn(`[ZeRo OS] ${definition.name} commands/menu sync failed:`, err)
    }

    console.log(`[ZeRo OS] Channel started: ${definition.name}`)
  }

  options.channels.set(definition.name, telegramChannel)
  options.heartbeat.write()
}
