import { describe, expect, test } from 'bun:test'
import type { HeartbeatCheckResult } from '@zero-os/supervisor'
import {
  type ProcessRecoveryControl,
  isSameHeartbeatOwner,
  stopUnreadyReplacement,
  terminateStaleHeartbeatOwner,
  verifySpawnedReplacement,
} from '../process-recovery'

function createChecker(result: () => HeartbeatCheckResult) {
  return { check: result } as never
}

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value)
    },
  }
}

describe('supervisor process recovery', () => {
  test('terminates the exact stale heartbeat owner before replacement', async () => {
    let now = 0
    let running = true
    const signals: Array<number | string> = []
    const control: ProcessRecoveryControl = {
      signal: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0 && !running) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
        if (signal === 'SIGTERM') running = false
        return true
      },
      fingerprint: () => (running ? 'owner-1' : undefined),
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => ({ alive: false, pid: 4242 })),
        staleResult: { alive: false, pid: 4242 },
        control,
      }),
    ).resolves.toBe('terminated')
    expect(signals).toEqual([0, 'SIGTERM', 0])
  })

  test('escalates to SIGKILL only after the graceful deadline', async () => {
    let now = 0
    let running = true
    const signals: Array<number | string> = []
    const control: ProcessRecoveryControl = {
      signal: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0 && !running) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
        if (signal === 'SIGKILL') running = false
        return true
      },
      fingerprint: () => (running ? 'owner-1' : undefined),
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => ({ alive: false, pid: 4242 })),
        staleResult: { alive: false, pid: 4242 },
        gracefulWaitMs: 20,
        forceWaitMs: 20,
        pollIntervalMs: 10,
        control,
      }),
    ).resolves.toBe('terminated')
    expect(signals).toContain('SIGTERM')
    expect(signals).toContain('SIGKILL')
  })

  test('does not signal when heartbeat ownership changed', async () => {
    const control: ProcessRecoveryControl = {
      signal: () => {
        throw new Error('must not signal')
      },
      fingerprint: () => {
        throw new Error('must not inspect process identity')
      },
      now: () => 0,
      sleep: async () => {},
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => ({ alive: false, pid: 5252 })),
        staleResult: { alive: false, pid: 4242 },
        control,
      }),
    ).resolves.toBe('identity_changed')
  })

  test('does not SIGKILL a reused PID when identity changes during graceful wait', async () => {
    let now = 0
    let fingerprint = 'owner-1'
    const signals: Array<number | string> = []
    const control: ProcessRecoveryControl = {
      signal: (_pid, signal) => {
        signals.push(signal)
        return true
      },
      fingerprint: () => fingerprint,
      now: () => now,
      sleep: async (ms) => {
        now += ms
        fingerprint = 'owner-2'
      },
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => ({
          alive: false,
          pid: 4242,
          bootId: 'stale-boot',
        })),
        staleResult: {
          alive: false,
          pid: 4242,
          bootId: 'stale-boot',
        },
        gracefulWaitMs: 20,
        pollIntervalMs: 10,
        control,
      }),
    ).resolves.toBe('identity_changed')
    expect(signals).toEqual([0, 'SIGTERM'])
  })

  test('detects PID reuse while waiting for a SIGKILLed owner to disappear', async () => {
    let now = 0
    let fingerprint = 'owner-1'
    let forcePolls = 0
    const signals: Array<number | string> = []
    const control: ProcessRecoveryControl = {
      signal: (_pid, signal) => {
        signals.push(signal)
        return true
      },
      fingerprint: () => fingerprint,
      now: () => now,
      sleep: async (ms) => {
        now += ms
        if (signals.includes('SIGKILL')) {
          forcePolls += 1
          if (forcePolls === 1) fingerprint = 'owner-2'
        }
      },
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => ({ alive: false, pid: 4242 })),
        staleResult: { alive: false, pid: 4242 },
        gracefulWaitMs: 10,
        forceWaitMs: 20,
        pollIntervalMs: 10,
        control,
      }),
    ).resolves.toBe('identity_changed')
    expect(signals).toEqual([0, 'SIGTERM', 'SIGKILL'])
  })

  test('requires boot identity when either heartbeat provides one', async () => {
    expect(isSameHeartbeatOwner({ pid: 4242, bootId: 'old' }, { pid: 4242, bootId: 'old' })).toBe(
      true,
    )
    expect(isSameHeartbeatOwner({ pid: 4242, bootId: 'old' }, { pid: 4242 })).toBe(false)
    expect(isSameHeartbeatOwner({ pid: 4242 }, { pid: 4242, bootId: 'new' })).toBe(false)
    expect(isSameHeartbeatOwner({ pid: 4242 }, { pid: 4242 })).toBe(true)
  })

  test('terminates a live owner that remains beyond the startup readiness lease', async () => {
    let running = true
    const signals: Array<number | string> = []
    const control: ProcessRecoveryControl = {
      signal: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0 && !running) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
        if (signal === 'SIGTERM') running = false
        return true
      },
      fingerprint: () => (running ? 'old-process' : undefined),
      now: () => 0,
      sleep: async () => {},
    }
    const stuck = {
      alive: true,
      ready: false,
      stage: 'starting_channels',
      uptime: 301,
      pid: 4242,
      bootId: 'stuck-boot',
    }

    await expect(
      terminateStaleHeartbeatOwner({
        checker: createChecker(() => stuck),
        staleResult: stuck,
        control,
      }),
    ).resolves.toBe('terminated')
    expect(signals).toContain('SIGTERM')
  })

  test('fails immediately when the spawned child exits before exact readiness', async () => {
    const childExit = createDeferred<number>()
    const child = {
      pid: 5252,
      exited: childExit.promise,
      killed: false,
      kill() {},
    }
    const verification = verifySpawnedReplacement({
      checker: createChecker(() => ({
        alive: true,
        ready: true,
        pid: 4242,
        bootId: 'old',
        lastBeat: new Date(),
      })),
      child,
      bootId: 'new',
      notBefore: Date.now(),
      timeoutMs: 5_000,
      pollIntervalMs: 5,
    })

    childExit.resolve(1)
    await expect(verification).resolves.toBe(false)
  })

  test('accepts only the spawned child identity', async () => {
    const childExit = createDeferred<number>()
    const child = {
      pid: 5252,
      exited: childExit.promise,
      killed: false,
      kill() {},
    }

    await expect(
      verifySpawnedReplacement({
        checker: createChecker(() => ({
          alive: true,
          ready: true,
          pid: 5252,
          bootId: 'new',
          lastBeat: new Date(),
        })),
        child,
        bootId: 'new',
        notBefore: Date.now() - 1,
        timeoutMs: 100,
        pollIntervalMs: 5,
      }),
    ).resolves.toBe(true)
  })

  test('extends the readiness deadline while boot heartbeat keeps progressing', async () => {
    const child = {
      pid: 5252,
      exited: new Promise<number>(() => {}),
      killed: false,
      kill() {},
    }
    let checks = 0
    const checker = createChecker(() => {
      checks += 1
      return {
        alive: true,
        ready: checks >= 20, // becomes ready only well past one progress window
        pid: 5252,
        bootId: 'new',
        sequence: checks, // advancing sequence = boot progress
        stage: 'booting',
        lastBeat: new Date(),
      }
    })

    const startedAt = Date.now()
    const result = await verifySpawnedReplacement({
      checker,
      child,
      bootId: 'new',
      notBefore: startedAt - 1_000,
      timeoutMs: 40,
      pollIntervalMs: 5,
    })

    expect(result).toBe(true)
    expect(Date.now() - startedAt).toBeGreaterThan(40)
  })

  test('fails when the boot heartbeat stalls for a full progress window', async () => {
    const child = {
      pid: 5252,
      exited: new Promise<number>(() => {}),
      killed: false,
      kill() {},
    }
    const checker = createChecker(() => ({
      alive: true,
      ready: false,
      pid: 5252,
      bootId: 'new',
      sequence: 1, // stalled: never advances
      stage: 'booting',
      lastBeat: new Date(),
    }))

    const startedAt = Date.now()
    const result = await verifySpawnedReplacement({
      checker,
      child,
      bootId: 'new',
      notBefore: startedAt - 1_000,
      timeoutMs: 40,
      pollIntervalMs: 5,
    })

    const elapsed = Date.now() - startedAt
    expect(result).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(35)
    expect(elapsed).toBeLessThan(2_000)
  })

  test('hard cap bounds the total wait even while progress continues', async () => {
    const child = {
      pid: 5252,
      exited: new Promise<number>(() => {}),
      killed: false,
      kill() {},
    }
    let checks = 0
    const checker = createChecker(() => {
      checks += 1
      return {
        alive: true,
        ready: false,
        pid: 5252,
        bootId: 'new',
        sequence: checks, // progressing but never ready
        stage: 'booting',
        lastBeat: new Date(),
      }
    })

    const startedAt = Date.now()
    const result = await verifySpawnedReplacement({
      checker,
      child,
      bootId: 'new',
      notBefore: startedAt - 1_000,
      timeoutMs: 40,
      maxTimeoutMs: 90,
      pollIntervalMs: 5,
    })

    const elapsed = Date.now() - startedAt
    expect(result).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(85)
    expect(elapsed).toBeLessThan(2_000)
  })

  test('extends verify deadlines across host suspension', async () => {
    const child = {
      pid: 5252,
      exited: new Promise<number>(() => {}),
      killed: false,
      kill() {},
    }
    let fakeNow = 0
    let checks = 0
    const checker = createChecker(() => {
      checks += 1
      return {
        alive: true,
        ready: checks >= 8,
        pid: 5252,
        bootId: 'new',
        sequence: checks,
        stage: 'booting',
        lastBeat: new Date(fakeNow),
      }
    })

    const result = await verifySpawnedReplacement({
      checker,
      child,
      bootId: 'new',
      notBefore: 0,
      timeoutMs: 40,
      maxTimeoutMs: 60,
      pollIntervalMs: 5,
      suspensionToleranceMs: 20,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms
        if (checks === 2) {
          fakeNow += 300_000 // host slept 5 minutes mid-boot
        }
      },
    })

    // Without suspension awareness the 60ms hard cap would have failed the
    // boot immediately after the 5-minute clock jump.
    expect(result).toBe(true)
  })

  test('waits for the replacement to exit after SIGKILL', async () => {
    const childExit = createDeferred<number>()
    const signals: Array<NodeJS.Signals | number | undefined> = []
    let stopResolved = false
    const child = {
      pid: 5252,
      exited: childExit.promise,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal)
      },
    }

    const stopping = stopUnreadyReplacement({
      child,
      gracefulWaitMs: 1,
      forceWaitMs: 1_000,
    }).then(() => {
      stopResolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stopResolved).toBe(false)

    childExit.resolve(137)
    await stopping
    expect(stopResolved).toBe(true)
  })
})
