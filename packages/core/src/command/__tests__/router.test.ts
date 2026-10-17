import { describe, expect, test } from 'bun:test'
import type { SessionSource } from '@zero-os/shared'
import type { SessionManager } from '../../session/manager'
import { CommandRouter } from '../router'
import type { Command, CommandContext, CommandResult } from '../types'

function createContext(source: SessionSource = 'web'): CommandContext {
  return {
    source,
    channelName: `${source}:test`,
    chatId: 'chat-1',
    senderId: 'user-1',
    sessionManager: {} as SessionManager,
    reply: async () => {},
  }
}

function createCommand(
  name: string,
  parse: (content: string) => Record<string, unknown> | null,
  result: CommandResult,
  sources?: SessionSource[],
): Command {
  return {
    name,
    description: `${name} description`,
    sources,
    parse,
    execute: async () => result,
  }
}

describe('CommandRouter', () => {
  test('non-command content returns null', async () => {
    const router = new CommandRouter()

    const result = await router.handle('hello world', createContext())

    expect(result).toBeNull()
  })

  test('matching command returns result', async () => {
    const router = new CommandRouter()
    const expected = { handled: true, reply: 'started' }
    router.register(createCommand('/new', (content) => (content === '/new' ? {} : null), expected))

    const result = await router.handle('/new', createContext())

    expect(result).toEqual(expected)
  })

  test('source filtering skips commands not allowed for the current source', async () => {
    const router = new CommandRouter()
    router.register(
      createCommand(
        '/restart',
        (content) => (content === '/restart' ? {} : null),
        {
          handled: true,
        },
        ['feishu'],
      ),
    )

    const result = await router.handle('/restart', createContext('telegram'))

    expect(result).toBeNull()
  })

  test('first matching command wins', async () => {
    const router = new CommandRouter()
    router.register(
      createCommand('/first', (content) => (content === '/new' ? { order: 'first' } : null), {
        handled: true,
        reply: 'first',
      }),
    )
    router.register(
      createCommand('/second', (content) => (content === '/new' ? { order: 'second' } : null), {
        handled: true,
        reply: 'second',
      }),
    )

    const result = await router.handle('/new', createContext())

    expect(result).toEqual({ handled: true, reply: 'first' })
  })

  test('unrecognized slash command returns null', async () => {
    const router = new CommandRouter()
    router.register(
      createCommand('/new', (content) => (content === '/new' ? {} : null), {
        handled: true,
      }),
    )

    const result = await router.handle('/unknown', createContext())

    expect(result).toBeNull()
  })

  test('list returns all commands and filters by source', () => {
    const router = new CommandRouter()
    const anySource = createCommand('/new', () => null, { handled: true })
    const feishuOnly = createCommand('/restart', () => null, { handled: true }, ['feishu'])

    router.register(anySource)
    router.register(feishuOnly)

    expect(router.list()).toHaveLength(2)
    expect(router.list('feishu')).toHaveLength(2)
    expect(router.list('telegram')).toEqual([anySource])
  })
})
