import { describe, expect, test } from 'bun:test'
import { EventBus } from '../runtime/bus'

describe('EventBus', () => {
  test('emit and receive events', () => {
    const bus = new EventBus()
    let receivedTool: unknown

    bus.on('tool:call', (payload) => {
      receivedTool = payload.data.tool
    })

    bus.emit('tool:call', { tool: 'bash', input: 'ls' })

    expect(receivedTool).toBe('bash')
  })

  test('wildcard listener receives all events', () => {
    const bus = new EventBus()
    const events: string[] = []

    bus.on('*', (payload) => {
      events.push(payload.topic)
    })

    bus.emit('session:create', {})
    bus.emit('tool:call', {})
    bus.emit('model:switch', {})

    expect(events).toEqual(['session:create', 'tool:call', 'model:switch'])
  })

  test('off removes listener', () => {
    const bus = new EventBus()
    let count = 0
    const handler = () => {
      count++
    }

    bus.on('heartbeat', handler)
    bus.emit('heartbeat', {})
    expect(count).toBe(1)

    bus.off('heartbeat', handler)
    bus.emit('heartbeat', {})
    expect(count).toBe(1)
  })

  test('once fires only once', () => {
    const bus = new EventBus()
    let count = 0

    bus.once('notification', () => {
      count++
    })
    bus.emit('notification', {})
    bus.emit('notification', {})

    expect(count).toBe(1)
  })

  test('payload includes timestamp', () => {
    const bus = new EventBus()
    let ts: string | undefined

    bus.on('session:update', (payload) => {
      ts = payload.timestamp
    })

    bus.emit('session:update', {})
    expect(ts).toBeDefined()
    if (!ts) {
      throw new Error('expected timestamp')
    }
    expect(new Date(ts).getTime()).toBeGreaterThan(0)
  })
})
