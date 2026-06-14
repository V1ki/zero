import { describe, expect, test } from 'bun:test'
import type { Channel } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import type { MetricsDB, SessionDB } from '@zero-os/observe'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { closeShutdownResources } from '../runtime/shutdown'

function createChannel(stop: () => Promise<void>): Channel {
  return { stop } as Channel
}

describe('closeShutdownResources', () => {
  test('continues closing runtime resources when one channel stop fails', async () => {
    const calls: string[] = []

    await closeShutdownResources({
      channels: new Map([
        [
          'broken',
          createChannel(async () => {
            calls.push('stop:broken')
            throw new Error('close failed')
          }),
        ],
        [
          'healthy',
          createChannel(async () => {
            calls.push('stop:healthy')
          }),
        ],
      ]),
      disposeRuntimeEventListeners: () => calls.push('dispose:listeners'),
      disposePricing: () => calls.push('dispose:pricing'),
      heartbeat: { stop: () => calls.push('heartbeat:stop') } as unknown as HeartbeatWriter,
      sessionManager: {
        flushAll: () => calls.push('sessions:flush'),
      } as unknown as SessionManager,
      sessionDb: { close: () => calls.push('session-db:close') } as unknown as SessionDB,
      metrics: { close: () => calls.push('metrics:close') } as unknown as MetricsDB,
    })

    expect(calls).toEqual([
      'dispose:listeners',
      'dispose:pricing',
      'stop:broken',
      'stop:healthy',
      'heartbeat:stop',
      'sessions:flush',
      'session-db:close',
      'metrics:close',
    ])
  })
})
