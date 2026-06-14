import { describe, expect, test } from 'bun:test'
import { CommandRouter } from '@zero-os/core'
import type { ChannelAdapter } from '../channels/adapter'
import { type MessageHandlerDeps, handleChannelMessage } from '../message/handler'
import { createIncomingMessage } from './message-handler-harness'

describe('handleChannelMessage command context', () => {
  test('passes metrics into the command context', async () => {
    let seenMetrics: unknown

    const commandRouter = new CommandRouter()
    commandRouter.register({
      name: '/session',
      description: 'probe metrics',
      parse: (content) => (content === '/session' ? {} : null),
      execute: async (_args, ctx) => {
        seenMetrics = ctx.metrics
        return { handled: true, reply: 'ok' }
      },
    })

    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    const metrics = { sessionStats: () => ({ requestCount: 1 }) }

    await handleChannelMessage(
      createIncomingMessage({
        channelType: 'telegram',
        content: '/session',
      }),
      {
        channelType: 'telegram',
        channelName: 'telegram',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: {} as MessageHandlerDeps['sessionManager'],
        commandRouter: commandRouter as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        metrics: metrics as unknown as MessageHandlerDeps['metrics'],
        isShuttingDown: () => false,
      },
    )

    expect(seenMetrics).toBe(metrics)
  })
})
