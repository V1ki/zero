import { describe, expect, test } from 'bun:test'
import {
  buildTelegramCommandSyncTargets,
  buildTelegramMenuButton,
  canRunTelegramRestart,
  syncTelegramCommandMenu,
} from '../telegram-menu'

describe('telegram menu sync definitions', () => {
  test('builds default and private scope command targets', () => {
    const targets = buildTelegramCommandSyncTargets()

    expect(targets).toHaveLength(2)

    expect(targets[0].options).toEqual({
      scope: { type: 'default' },
      languageCode: '',
    })
    expect(targets[0].commands.map((c) => c.command)).toEqual(['new', 'model', 'think', 'session'])

    expect(targets[1].options).toEqual({
      scope: { type: 'all_private_chats' },
      languageCode: '',
    })
    expect(targets[1].commands.map((c) => c.command)).toEqual([
      'new',
      'model',
      'think',
      'session',
      'restart',
    ])
  })

  test('menu button defaults to commands', () => {
    expect(buildTelegramMenuButton()).toEqual({ type: 'commands' })
  })
})

describe('telegram menu sync behavior', () => {
  test('sync applies commands then menu button', async () => {
    const calls: string[] = []
    const payloads: unknown[] = []
    const channel = {
      setMyCommands: async (commands: unknown, options: unknown) => {
        calls.push('setMyCommands')
        payloads.push({ commands, options })
      },
      setChatMenuButton: async (options: unknown) => {
        calls.push('setChatMenuButton')
        payloads.push({ menu: options })
      },
    }

    await syncTelegramCommandMenu(channel)

    expect(calls).toEqual(['setMyCommands', 'setMyCommands', 'setChatMenuButton'])
    expect(payloads[2]).toEqual({
      menu: {
        menuButton: { type: 'commands' },
      },
    })
  })

  test('restart allowed only in private chats', () => {
    expect(canRunTelegramRestart('private')).toBe(true)
    expect(canRunTelegramRestart('group')).toBe(false)
    expect(canRunTelegramRestart('supergroup')).toBe(false)
    expect(canRunTelegramRestart(undefined)).toBe(false)
  })
})
