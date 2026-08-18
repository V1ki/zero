import { describe, expect, test } from 'bun:test'
import { RepairEngine } from '../repair'

describe('RepairEngine', () => {
  test('initial status is idle', () => {
    const engine = new RepairEngine()
    expect(engine.getStatus()).toBe('idle')
  })

  test('initial attemptCount is 0', () => {
    const engine = new RepairEngine()
    expect(engine.getAttemptCount()).toBe(0)
  })

  test('shouldFuse initially returns false', () => {
    const engine = new RepairEngine()
    expect(engine.shouldFuse()).toBe(false)
  })

  test('successful repair cycle sets status to success', async () => {
    const engine = new RepairEngine()
    const statuses: string[] = []

    const diagnose = async () => {
      statuses.push(engine.getStatus())
      return 'issue found'
    }
    const repair = async (diagnosis: string) => {
      statuses.push(engine.getStatus())
      return `fixed: ${diagnosis}`
    }
    const verify = async () => {
      statuses.push(engine.getStatus())
      return true
    }

    const attempt = await engine.runRepairCycle(diagnose, repair, verify)

    expect(statuses).toEqual(['diagnosing', 'repairing', 'verifying'])
    expect(attempt.status).toBe('success')
    expect(attempt.diagnosis).toBe('issue found')
    expect(attempt.action).toBe('fixed: issue found')
    expect(attempt.result).toBe('Verification passed')
    expect(engine.getStatus()).toBe('success')
    expect(engine.getAttemptCount()).toBe(1)
  })

  test('failed verify results in failed attempt', async () => {
    const engine = new RepairEngine()

    const attempt = await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => false,
    )

    expect(attempt.status).toBe('failed')
    expect(attempt.result).toBe('Verification failed')
    expect(engine.getStatus()).toBe('failed')
  })

  test('diagnose throwing includes error in diagnosis', async () => {
    const engine = new RepairEngine()

    const attempt = await engine.runRepairCycle(
      async () => {
        throw new Error('diag error')
      },
      async (d) => `repaired with: ${d}`,
      async () => true,
    )

    expect(attempt.diagnosis).toContain('Diagnosis failed:')
    expect(attempt.diagnosis).toContain('diag error')
  })

  test('repair throwing includes error in action', async () => {
    const engine = new RepairEngine()

    const attempt = await engine.runRepairCycle(
      async () => 'diag ok',
      async () => {
        throw new Error('repair error')
      },
      async () => true,
    )

    expect(attempt.action).toContain('Repair failed:')
    expect(attempt.action).toContain('repair error')
  })

  test('verify throwing is treated as failure', async () => {
    const engine = new RepairEngine()

    const attempt = await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => {
        throw new Error('verify error')
      },
    )

    expect(attempt.status).toBe('failed')
    expect(attempt.result).toBe('Verification failed')
  })

  test('maxAttempts failures triggers shouldFuse', async () => {
    const engine = new RepairEngine(3)

    for (let i = 0; i < 3; i++) {
      await engine.runRepairCycle(
        async () => 'diag',
        async () => 'action',
        async () => false,
      )
    }

    expect(engine.getAttemptCount()).toBe(3)
    expect(engine.shouldFuse()).toBe(true)
  })

  test('a successful repair resets the consecutive failure streak', async () => {
    const engine = new RepairEngine(3)

    for (let i = 0; i < 2; i++) {
      await engine.runRepairCycle(
        async () => 'diag',
        async () => 'action',
        async () => false,
      )
    }
    await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => true,
    )
    for (let i = 0; i < 2; i++) {
      await engine.runRepairCycle(
        async () => 'diag',
        async () => 'action',
        async () => false,
      )
    }

    // 4 failures total but never 3 in a row — must not fuse
    expect(engine.getAttemptCount()).toBe(5)
    expect(engine.shouldFuse()).toBe(false)

    await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => false,
    )
    expect(engine.shouldFuse()).toBe(true)
  })

  test('fuse releases after the cooldown to allow a probe attempt', async () => {
    let fakeNow = Date.parse('2026-08-15T00:00:00.000Z')
    const engine = new RepairEngine(2, undefined, {
      fuseCooldownMs: 60_000,
      now: () => fakeNow,
    })
    const runCycle = (success: boolean) =>
      engine.runRepairCycle(
        async () => 'diag',
        async () => 'action',
        async () => success,
      )

    await runCycle(false)
    await runCycle(false)
    expect(engine.shouldFuse()).toBe(true)

    // Cooldown elapsed: one probe attempt is allowed again.
    fakeNow += 60_001
    expect(engine.shouldFuse()).toBe(false)

    // A failed probe re-engages the fuse for another cooldown.
    await runCycle(false)
    expect(engine.shouldFuse()).toBe(true)

    // A successful probe after the next cooldown clears the streak entirely.
    fakeNow += 60_001
    expect(engine.shouldFuse()).toBe(false)
    await runCycle(true)
    expect(engine.shouldFuse()).toBe(false)
  })

  test('reset clears attempts and status', async () => {
    const engine = new RepairEngine()

    await engine.runRepairCycle(
      async () => 'diag',
      async () => 'action',
      async () => false,
    )

    expect(engine.getAttemptCount()).toBe(1)
    expect(engine.getStatus()).toBe('failed')

    engine.reset()

    expect(engine.getAttemptCount()).toBe(0)
    expect(engine.getStatus()).toBe('idle')
    expect(engine.getAttempts()).toEqual([])
  })
})
