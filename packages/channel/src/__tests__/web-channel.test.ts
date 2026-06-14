import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '../base'
import { WebChannel, WebMessageHandler } from '../web'

function expectIncomingMessage(message: IncomingMessage | null): IncomingMessage {
  if (!message) {
    throw new Error('expected message to be received')
  }
  return message
}

describe('WebChannel', () => {
  test('name is web', () => {
    const channel = new WebChannel()
    expect(channel.name).toBe('web')
  })

  test('type is web', () => {
    const channel = new WebChannel()
    expect(channel.type).toBe('web')
  })

  test('isConnected is false before start', () => {
    const channel = new WebChannel()
    expect(channel.isConnected()).toBe(false)
  })

  test('isConnected is true after start', async () => {
    const channel = new WebChannel()
    await channel.start()
    expect(channel.isConnected()).toBe(true)
  })

  test('isConnected is false after stop', async () => {
    const channel = new WebChannel()
    await channel.start()
    await channel.stop()
    expect(channel.isConnected()).toBe(false)
  })

  test('setMessageHandler delegates to internal handler', async () => {
    const channel = new WebChannel()
    let received: IncomingMessage | null = null
    channel.setMessageHandler(async (msg) => {
      received = msg
    })

    const handler = channel.getHandler()
    await handler.handleMessage(
      'c1',
      JSON.stringify({
        type: 'message',
        content: 'delegated',
      }),
    )

    expect(received).not.toBeNull()
    expect(expectIncomingMessage(received).content).toBe('delegated')
  })

  test('getHandler returns WebMessageHandler instance', () => {
    const channel = new WebChannel()
    expect(channel.getHandler()).toBeInstanceOf(WebMessageHandler)
  })
})
