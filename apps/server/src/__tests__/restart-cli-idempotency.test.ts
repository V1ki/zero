import { describe, expect, test } from 'bun:test'
import {
  classifyRestartHeartbeatUpdate,
  isSameHeartbeatOwner,
  signalRestartTarget,
  waitForRestartHeartbeatUpdate,
} from '../cli/restart'

describe('restart CLI process handoff', () => {
  test('treats ESRCH as an idempotent handoff', () => {
    const result = signalRestartTarget(4242, () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })

    expect(result).toBe('already_exited')
  })

  test('rethrows other signaling errors', () => {
    expect(() =>
      signalRestartTarget(4242, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }),
    ).toThrow('denied')
  })

  test('requires PID and known boot identity to remain stable across the build', () => {
    expect(isSameHeartbeatOwner({ pid: 1, bootId: 'boot-a' }, { pid: 1, bootId: 'boot-a' })).toBe(
      true,
    )
    expect(isSameHeartbeatOwner({ pid: 1, bootId: 'boot-a' }, { pid: 1, bootId: 'boot-b' })).toBe(
      false,
    )
    expect(isSameHeartbeatOwner({ pid: 1, bootId: 'boot-a' }, { pid: 1 })).toBe(false)
    expect(isSameHeartbeatOwner({ pid: 1 }, { pid: 1, bootId: 'boot-a' })).toBe(false)
    expect(isSameHeartbeatOwner({ pid: 1 }, { pid: 1 })).toBe(true)
    expect(isSameHeartbeatOwner({ pid: 1 }, { pid: 2 })).toBe(false)
  })

  test('requires the same owner to publish a newer, fresh heartbeat', () => {
    const baseline = {
      pid: 1,
      bootId: 'boot-a',
      sequence: 10,
      timestamp: '2026-07-25T00:00:00.000Z',
    }

    expect(
      classifyRestartHeartbeatUpdate(baseline, baseline, {
        nowMs: Date.parse('2026-07-25T00:00:01.000Z'),
        freshnessMs: 10_000,
      }),
    ).toBe('waiting')
    expect(
      classifyRestartHeartbeatUpdate(
        baseline,
        {
          ...baseline,
          sequence: 11,
          timestamp: '2026-07-25T00:00:03.000Z',
        },
        {
          nowMs: Date.parse('2026-07-25T00:00:30.000Z'),
          freshnessMs: 10_000,
        },
      ),
    ).toBe('waiting')
    expect(
      classifyRestartHeartbeatUpdate(
        baseline,
        {
          ...baseline,
          sequence: 11,
          timestamp: '2026-07-25T00:00:03.000Z',
        },
        {
          nowMs: Date.parse('2026-07-25T00:00:04.000Z'),
          freshnessMs: 10_000,
        },
      ),
    ).toBe('ready')
  })

  test('accepts a newer timestamp when legacy heartbeat sequence is absent', () => {
    const baseline = {
      pid: 1,
      timestamp: '2026-07-25T00:00:00.000Z',
    }

    expect(
      classifyRestartHeartbeatUpdate(
        baseline,
        {
          pid: 1,
          timestamp: '2026-07-25T00:00:03.000Z',
        },
        {
          nowMs: Date.parse('2026-07-25T00:00:04.000Z'),
          freshnessMs: 10_000,
        },
      ),
    ).toBe('ready')
  })

  test('waits deterministically for a newer heartbeat from the same owner', async () => {
    const baseline = {
      pid: 1,
      bootId: 'boot-a',
      sequence: 10,
      timestamp: '2026-07-25T00:00:00.000Z',
    }
    const readings = [
      baseline,
      {
        ...baseline,
        sequence: 11,
        timestamp: '2026-07-25T00:00:03.000Z',
      },
    ]
    let nowMs = Date.parse('2026-07-25T00:00:03.000Z')
    const waits: number[] = []

    const result = await waitForRestartHeartbeatUpdate({
      baseline,
      readHeartbeat: () => readings.shift() ?? baseline,
      now: () => nowMs,
      wait: async (delayMs) => {
        waits.push(delayMs)
        nowMs += delayMs
      },
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      freshnessMs: 10_000,
    })

    expect(result.status).toBe('ready')
    expect(result.heartbeat?.sequence).toBe(11)
    expect(waits).toEqual([100])
  })

  test('treats a changed owner as an immediate idempotent handoff', async () => {
    let waitCalls = 0
    const result = await waitForRestartHeartbeatUpdate({
      baseline: {
        pid: 1,
        bootId: 'boot-a',
        sequence: 10,
        timestamp: '2026-07-25T00:00:00.000Z',
      },
      readHeartbeat: () => ({
        pid: 2,
        bootId: 'boot-b',
        sequence: 1,
        timestamp: '2026-07-25T00:00:03.000Z',
      }),
      now: () => Date.parse('2026-07-25T00:00:03.000Z'),
      wait: async () => {
        waitCalls += 1
      },
    })

    expect(result.status).toBe('handoff')
    expect(result.heartbeat?.pid).toBe(2)
    expect(waitCalls).toBe(0)
  })

  test('times out instead of signaling from an unchanged or stale heartbeat', async () => {
    const heartbeat = {
      pid: 1,
      bootId: 'boot-a',
      sequence: 10,
      timestamp: '2026-07-25T00:00:00.000Z',
    }
    let nowMs = Date.parse('2026-07-25T00:01:00.000Z')
    const waits: number[] = []

    const result = await waitForRestartHeartbeatUpdate({
      baseline: heartbeat,
      readHeartbeat: () => heartbeat,
      now: () => nowMs,
      wait: async (delayMs) => {
        waits.push(delayMs)
        nowMs += delayMs
      },
      timeoutMs: 100,
      pollIntervalMs: 40,
      freshnessMs: 10_000,
    })

    expect(result.status).toBe('unavailable')
    expect(waits).toEqual([40, 40, 20])
  })
})
