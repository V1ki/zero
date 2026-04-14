import type {
  TelegramBotCommand,
  TelegramMenuButtonConfig,
  TelegramSetMyCommandsOptions,
} from '@zero-os/channel'

interface TelegramMenuSyncChannel {
  setMyCommands(
    commands: TelegramBotCommand[],
    options: TelegramSetMyCommandsOptions,
  ): Promise<void>
  setChatMenuButton(options: { menuButton: TelegramMenuButtonConfig }): Promise<void>
}

export interface TelegramCommandSyncTarget {
  commands: TelegramBotCommand[]
  options: TelegramSetMyCommandsOptions
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
      description: 'Show or set thinking effort (/think [high])',
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

export function canRunTelegramRestart(chatType: unknown): boolean {
  return chatType === 'private'
}
