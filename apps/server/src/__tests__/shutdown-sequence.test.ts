import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, FeishuStreamingSession } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import type { MetricsDB, SessionDB } from '@zero-os/observe'
import type { CronScheduler } from '@zero-os/scheduler'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { runShutdownSequence } from '../runtime/shutdown'

describe('runShutdownSequence', () => {
  test('keeps the shutdown lifecycle order explicit', async () => {
    const calls: string[] = []
    const zeroDir = mkdtempSync(join(tmpdir(), 'zero-shutdown-sequence-'))
    const activeStreamingSessions = new Set<FeishuStreamingSession>([
      {
        abort: async (message) => {
          calls.push(`stream:abort:${message}`)
        },
        complete: async () => {},
        dismiss: async () => {},
        update: async () => {},
        messageId: null,
      },
    ])

    try {
      await runShutdownSequence({
        zeroDir,
        restartSentinelPath: join(zeroDir, 'restart-sentinel.json'),
        scheduler: { stop: () => calls.push('scheduler:stop') } as unknown as CronScheduler,
        sessionManager: {
          drainAndCollectInterrupted: async (timeoutMs: number) => {
            calls.push(`sessions:drain:${timeoutMs}`)
            return []
          },
          flushAll: () => calls.push('sessions:flush'),
        } as unknown as SessionManager,
        channels: new Map([
          [
            'web',
            {
              stop: async () => {
                calls.push('channel:stop')
              },
            } as unknown as Channel,
          ],
        ]),
        activeStreamingSessionSets: [activeStreamingSessions],
        stopChannelRecovery: () => calls.push('channel-recovery:stop'),
        disposeRuntimeEventListeners: () => calls.push('dispose:listeners'),
        disposePricing: () => calls.push('dispose:pricing'),
        heartbeat: {
          setReady: (ready: boolean, stage: string) =>
            calls.push(`heartbeat:ready:${ready}:${stage}`),
          write: () => calls.push('heartbeat:write'),
          stop: () => calls.push('heartbeat:stop'),
        } as unknown as HeartbeatWriter,
        sessionDb: { close: () => calls.push('session-db:close') } as unknown as SessionDB,
        metrics: { close: () => calls.push('metrics:close') } as unknown as MetricsDB,
        closeFiberRoot: () => {
          calls.push('fiber-root:close')
          return Promise.resolve()
        },
      })

      expect(calls).toEqual([
        'heartbeat:ready:false:shutting_down',
        'heartbeat:write',
        'heartbeat:stop',
        'channel-recovery:stop',
        'scheduler:stop',
        'sessions:drain:30000',
        'stream:abort:ZeRo OS is restarting...',
        'dispose:listeners',
        'dispose:pricing',
        'channel:stop',
        'sessions:flush',
        'session-db:close',
        'metrics:close',
        'fiber-root:close',
      ])
      expect(activeStreamingSessions.size).toBe(0)
    } finally {
      rmSync(zeroDir, { recursive: true, force: true })
    }
  })
})
