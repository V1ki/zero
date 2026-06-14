import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from '../base'
import { WebMessageHandler } from '../web'

function expectIncomingMessage(message: IncomingMessage | null): IncomingMessage {
  if (!message) {
    throw new Error('expected message to be received')
  }
  return message
}

describe('WebMessageHandler', () => {
  test('invalid JSON returns error response', async () => {
    const handler = new WebMessageHandler()
    const result = await handler.handleMessage('client-1', 'not json{{{')
    expect(result).toEqual({ type: 'error', error: 'Invalid JSON' })
  })

  test('ping returns pong response', async () => {
    const handler = new WebMessageHandler()
    const result = await handler.handleMessage('client-1', JSON.stringify({ type: 'ping' }))
    expect(result).toEqual({ type: 'pong' })
  })

  test('unknown message type returns error response', async () => {
    const handler = new WebMessageHandler()
    const result = await handler.handleMessage('client-1', JSON.stringify({ type: 'unknown' }))
    expect(result).toEqual({ type: 'error', error: 'Unknown message type' })
  })

  test('message without content returns Missing content error', async () => {
    const handler = new WebMessageHandler()
    const result = await handler.handleMessage('client-1', JSON.stringify({ type: 'message' }))
    expect(result).toEqual({ type: 'error', error: 'Missing content' })
  })

  test('subscribe stores client topics', async () => {
    const handler = new WebMessageHandler()
    await handler.handleMessage(
      'client-1',
      JSON.stringify({
        type: 'subscribe',
        topics: ['session:update', 'metrics'],
      }),
    )
    expect(handler.isSubscribed('client-1', 'session:update')).toBe(true)
    expect(handler.isSubscribed('client-1', 'metrics')).toBe(true)
  })

  test('message calls messageHandler with correct IncomingMessage', async () => {
    const handler = new WebMessageHandler()
    let received: IncomingMessage | null = null
    handler.setMessageHandler(async (msg) => {
      received = msg
    })

    await handler.handleMessage(
      'client-42',
      JSON.stringify({
        type: 'message',
        content: 'hello world',
        sessionId: 'sess-1',
      }),
    )

    expect(received).not.toBeNull()
    const message = expectIncomingMessage(received)
    expect(message.channelType).toBe('web')
    expect(message.senderId).toBe('client-42')
    expect(message.content).toBe('hello world')
    expect(typeof message.timestamp).toBe('string')
    expect(message.metadata).toEqual({ sessionId: 'sess-1' })
  })

  test('IncomingMessage has valid ISO timestamp', async () => {
    const handler = new WebMessageHandler()
    let received: IncomingMessage | null = null
    handler.setMessageHandler(async (msg) => {
      received = msg
    })

    const before = new Date().toISOString()
    await handler.handleMessage('c1', JSON.stringify({ type: 'message', content: 'test' }))
    const after = new Date().toISOString()

    expect(received).not.toBeNull()
    const message = expectIncomingMessage(received)
    expect(message.timestamp >= before).toBe(true)
    expect(message.timestamp <= after).toBe(true)
  })

  test('isSubscribed returns true for exact topic match', async () => {
    const handler = new WebMessageHandler()
    await handler.handleMessage(
      'c1',
      JSON.stringify({
        type: 'subscribe',
        topics: ['metrics'],
      }),
    )
    expect(handler.isSubscribed('c1', 'metrics')).toBe(true)
  })

  test('isSubscribed wildcard session:* matches session:update', async () => {
    const handler = new WebMessageHandler()
    await handler.handleMessage(
      'c1',
      JSON.stringify({
        type: 'subscribe',
        topics: ['session:*'],
      }),
    )
    expect(handler.isSubscribed('c1', 'session:update')).toBe(true)
    expect(handler.isSubscribed('c1', 'session:delete')).toBe(true)
  })

  test('isSubscribed global wildcard * matches any topic', async () => {
    const handler = new WebMessageHandler()
    await handler.handleMessage(
      'c1',
      JSON.stringify({
        type: 'subscribe',
        topics: ['*'],
      }),
    )
    expect(handler.isSubscribed('c1', 'anything')).toBe(true)
    expect(handler.isSubscribed('c1', 'session:update')).toBe(true)
  })

  test('isSubscribed returns false for unsubscribed topic', () => {
    const handler = new WebMessageHandler()
    expect(handler.isSubscribed('c1', 'metrics')).toBe(false)
  })

  test('removeClient clears all subscriptions', async () => {
    const handler = new WebMessageHandler()
    await handler.handleMessage(
      'c1',
      JSON.stringify({
        type: 'subscribe',
        topics: ['metrics', 'session:*'],
      }),
    )
    expect(handler.isSubscribed('c1', 'metrics')).toBe(true)

    handler.removeClient('c1')
    expect(handler.isSubscribed('c1', 'metrics')).toBe(false)
    expect(handler.isSubscribed('c1', 'session:update')).toBe(false)
  })
})
