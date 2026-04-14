import { describe, expect, test } from 'bun:test'
import { RepairEngine, type HeartbeatCheckResult } from '@zero-os/supervisor'
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
        return 'started replacement'
      },
      async verify() {
        return true
      },
    })

    const firstTick = monitor.tick()
    await Promise.resolve()

    expect(monitor.isRepairing()).toBe(true)

    const overlappingTicks = Promise.all([monitor.tick(), monitor.tick()])
    await Promise.resolve()

    expect(repairCalls).toBe(1)
    expect(logs.some((entry) => entry.includes('Repair already in progress'))).toBe(true)

    releaseRepair?.()
    await firstTick
    await overlappingTicks

    expect(monitor.isRepairing()).toBe(false)
    expect(repairCalls).toBe(1)
  })
})
