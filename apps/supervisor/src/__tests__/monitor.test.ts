import { describe, expect, test } from 'bun:test'
import { type HeartbeatCheckResult, RepairEngine } from '@zero-os/supervisor'
import { createSupervisorMonitor } from '../monitor'

function createDeadHeartbeatResult(): HeartbeatCheckResult {
  return {
    alive: false,
    lastBeat: new Date('2026-04-14T09:26:51.986Z'),
    elapsedMs: 12_000,
  }
}

describe('Supervisor monitor', () => {
  test('skips overlapping repair cycles while one repair is in flight', async () => {
    const logs: string[] = []
    let repairCalls = 0
    let releaseRepair: (() => void) | null = null

    const monitor = createSupervisorMonitor({
      checker: {
        check: () => createDeadHeartbeatResult(),
      } as never,
      repairEngine: new RepairEngine(),
      logger: {
        log: (message) => logs.push(`log:${message}`),
        warn: (message) => logs.push(`warn:${message}`),
        error: (message) => logs.push(`error:${message}`),
      },
      async diagnose(result) {
        return `dead for ${result.elapsedMs}ms`
      },
      async repair() {
        repairCalls += 1
        await new Promise<void>((resolve) => {
          releaseRepair = resolve
        })
        return {
          action: 'started replacement',
          verify: async () => true,
        }
      },
    })

    const firstTick = monitor.tick()
    await Promise.resolve()

    expect(monitor.isRepairing()).toBe(true)

    const overlappingTicks = Promise.all([monitor.tick(), monitor.tick()])
    await Promise.resolve()

    expect(repairCalls).toBe(1)
    expect(logs.some((entry) => entry.includes('Repair already in progress'))).toBe(true)

    const finishRepair = releaseRepair as (() => void) | null
    if (!finishRepair) {
      throw new Error('expected repair release function to be defined')
    }
    finishRepair()
    await firstTick
    await overlappingTicks

    expect(monitor.isRepairing()).toBe(false)
    expect(repairCalls).toBe(1)
  })

  test('verifies the execution returned by the same repair cycle', async () => {
    const verified: string[] = []
    const monitor = createSupervisorMonitor({
      checker: {
        check: () => createDeadHeartbeatResult(),
      } as never,
      repairEngine: new RepairEngine(),
      logger: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      async diagnose() {
        return 'stale heartbeat'
      },
      async repair(_diagnosis, result) {
        expect(result.pid).toBeUndefined()
        return {
          action: 'spawned exact child',
          verify: async () => {
            verified.push('exact child')
            return true
          },
        }
      },
    })

    await monitor.tick()
    expect(verified).toEqual(['exact child'])
  })

  test('repairs a live process that exceeds the startup readiness lease', async () => {
    let repairCalls = 0
    const warnings: string[] = []
    const result: HeartbeatCheckResult = {
      alive: true,
      ready: false,
      stage: 'starting_channels',
      uptime: 301,
      pid: 4242,
      bootId: 'stuck-boot',
      lastBeat: new Date(),
    }
    const monitor = createSupervisorMonitor({
      checker: { check: () => result } as never,
      repairEngine: new RepairEngine(),
      startupReadyLeaseMs: 300_000,
      logger: {
        log: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
      async diagnose() {
        return 'startup lease expired'
      },
      async repair() {
        repairCalls++
        return {
          action: 'replaced stuck startup',
          verify: async () => true,
        }
      },
    })

    await monitor.tick()

    expect(repairCalls).toBe(1)
    expect(warnings).toContain('[Supervisor] Main process exceeded the startup readiness lease!')
  })

  test('defers a dead verdict after a clock jump until the heartbeat settles', async () => {
    let fakeNow = 1_000_000
    let alive = true
    let repairCalls = 0
    const logs: string[] = []
    const monitor = createSupervisorMonitor({
      checker: {
        check: () =>
          alive
            ? { alive: true, ready: true, lastBeat: new Date(fakeNow) }
            : { alive: false, lastBeat: new Date(fakeNow - 900_000), elapsedMs: 900_000 },
      } as never,
      repairEngine: new RepairEngine(),
      checkIntervalMs: 5_000,
      wakeSettleMs: 30_000,
      now: () => fakeNow,
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      async diagnose() {
        return 'dead'
      },
      async repair() {
        repairCalls++
        return { action: 'restart', verify: async () => true }
      },
    })

    await monitor.tick() // healthy baseline tick
    expect(repairCalls).toBe(0)

    // Host slept for 15 minutes; the heartbeat looks stale right after wake.
    alive = false
    fakeNow += 900_000
    await monitor.tick()
    expect(repairCalls).toBe(0)
    expect(logs.some((entry) => entry.includes('clock jump'))).toBe(true)

    // Still within the settle window: keep waiting.
    fakeNow += 10_000
    await monitor.tick()
    expect(repairCalls).toBe(0)

    fakeNow += 10_000
    await monitor.tick()
    expect(repairCalls).toBe(0)

    // Heartbeat is still stale once the settle window elapses: repair now.
    fakeNow += 12_000
    await monitor.tick()
    expect(repairCalls).toBe(1)
  })

  test('a fresh heartbeat after wake-up cancels the deferred repair', async () => {
    let fakeNow = 1_000_000
    let alive = true
    let repairCalls = 0
    const monitor = createSupervisorMonitor({
      checker: {
        check: () =>
          alive
            ? { alive: true, ready: true, lastBeat: new Date(fakeNow) }
            : { alive: false, lastBeat: new Date(fakeNow - 900_000), elapsedMs: 900_000 },
      } as never,
      repairEngine: new RepairEngine(),
      checkIntervalMs: 5_000,
      wakeSettleMs: 30_000,
      now: () => fakeNow,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      async diagnose() {
        return 'dead'
      },
      async repair() {
        repairCalls++
        return { action: 'restart', verify: async () => true }
      },
    })

    await monitor.tick()

    alive = false
    fakeNow += 900_000
    await monitor.tick() // wake detected, verdict deferred

    // The slept-but-healthy server writes a fresh beat during the settle window.
    alive = true
    fakeNow += 5_000
    await monitor.tick()

    fakeNow += 60_000
    alive = true
    await monitor.tick()

    expect(repairCalls).toBe(0)
  })

  test('throttles repeated verdict logs while the fuse is engaged', async () => {
    let fakeNow = 1_000_000
    const logs: string[] = []
    let repairCalls = 0
    const engine = new RepairEngine(1, undefined, {
      fuseCooldownMs: 60 * 60_000,
      now: () => fakeNow,
    })
    await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => false,
    )

    const monitor = createSupervisorMonitor({
      checker: {
        check: () => ({ alive: false, lastBeat: new Date(fakeNow - 60_000), elapsedMs: 60_000 }),
      } as never,
      repairEngine: engine,
      checkIntervalMs: 5_000,
      verdictLogIntervalMs: 30_000,
      now: () => fakeNow,
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      async diagnose() {
        return 'dead'
      },
      async repair() {
        repairCalls++
        return { action: 'restart', verify: async () => true }
      },
    })

    for (let i = 0; i < 10; i++) {
      await monitor.tick()
      fakeNow += 5_000
    }

    // 10 ticks over 45s with a 30s log interval: exactly two verdict batches.
    expect(logs.filter((entry) => entry.includes('fusing')).length).toBe(2)
    expect(logs.filter((entry) => entry.includes('appears dead')).length).toBe(2)
    expect(repairCalls).toBe(0)
  })

  test('does not interrupt a process that is explicitly shutting down', async () => {
    let repairCalls = 0
    const monitor = createSupervisorMonitor({
      checker: {
        check: () => ({
          alive: true,
          ready: false,
          stage: 'shutting_down',
          uptime: 10_000,
        }),
      } as never,
      repairEngine: new RepairEngine(),
      startupReadyLeaseMs: 1,
      logger: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      async diagnose() {
        return 'unused'
      },
      async repair() {
        repairCalls++
        return { action: 'unused', verify: async () => true }
      },
    })

    await monitor.tick()
    expect(repairCalls).toBe(0)
  })
})
