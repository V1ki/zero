import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeartbeatChecker, HeartbeatWriter, waitForHeartbeatReady } from '../heartbeat'

const testDir = mkdtempSync(join(tmpdir(), 'zero-heartbeat-identity-'))

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('Heartbeat process identity', () => {
  test('continues to decode a legacy heartbeat without boot identity fields', () => {
    const file = join(testDir, 'legacy.json')
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: 4242,
        uptime: 10,
        ready: true,
        stage: 'ready',
        health: {
          memoryUsageMB: 1,
          errorCount: 0,
          status: 'healthy',
          channels: {
            total: 0,
            configured: 0,
            connected: 0,
            disconnected: 0,
            offline: [],
          },
        },
        channels: [],
      }),
    )

    expect(new HeartbeatChecker(file).check()).toMatchObject({
      alive: true,
      pid: 4242,
      ready: true,
      bootId: undefined,
      sequence: undefined,
    })
  })

  test('persists an injected boot id and increasing sequence', () => {
    const file = join(testDir, 'identity.json')
    const writer = new HeartbeatWriter(file, { bootId: 'boot-for-test' })
    const checker = new HeartbeatChecker(file)

    writer.write()
    const first = checker.check()
    writer.write()
    const second = checker.check()

    expect(first.bootId).toBe('boot-for-test')
    expect(first.sequence).toBe(1)
    expect(second.bootId).toBe('boot-for-test')
    expect(second.sequence).toBe(2)
  })

  test('uses one random process boot id by default', () => {
    const firstFile = join(testDir, 'default-identity-first.json')
    const secondFile = join(testDir, 'default-identity-second.json')
    const firstWriter = new HeartbeatWriter(firstFile)
    const secondWriter = new HeartbeatWriter(secondFile)

    firstWriter.write()
    secondWriter.write()

    const firstBootId = new HeartbeatChecker(firstFile).check().bootId
    const secondBootId = new HeartbeatChecker(secondFile).check().bootId
    expect(firstBootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(secondBootId).toBe(firstBootId)
  })

  test('atomically replaces the heartbeat without leaving a temporary file', () => {
    const file = join(testDir, 'atomic.json')
    const writer = new HeartbeatWriter(file, { bootId: 'atomic-test' })

    writer.write()
    writer.write()

    expect(readdirSync(testDir).filter((name) => name.startsWith('atomic.json.'))).toEqual([])
    expect(new HeartbeatChecker(file).check()).toMatchObject({
      alive: true,
      bootId: 'atomic-test',
      sequence: 2,
    })
  })

  test('ready wait rejects mismatched process identity', async () => {
    const file = join(testDir, 'identity-wait.json')
    const writer = new HeartbeatWriter(file, { bootId: 'current-boot' })
    const checker = new HeartbeatChecker(file)
    writer.setReady(true)
    writer.write()

    await expect(
      waitForHeartbeatReady(checker, {
        timeoutMs: 20,
        pollIntervalMs: 5,
        expectedPid: process.pid + 1,
      }),
    ).resolves.toBe(false)
    await expect(
      waitForHeartbeatReady(checker, {
        timeoutMs: 20,
        pollIntervalMs: 5,
        expectedBootId: 'old-boot',
      }),
    ).resolves.toBe(false)
    await expect(
      waitForHeartbeatReady(checker, {
        timeoutMs: 20,
        pollIntervalMs: 5,
        expectedPid: process.pid,
        expectedBootId: 'current-boot',
      }),
    ).resolves.toBe(true)
  })

  test('ready wait ignores a heartbeat older than notBefore', async () => {
    const file = join(testDir, 'not-before-wait.json')
    const writer = new HeartbeatWriter(file, { bootId: 'new-boot' })
    const checker = new HeartbeatChecker(file)
    writer.setReady(true)
    writer.write()

    const notBefore = Date.now() + 40
    setTimeout(() => writer.write(), 60)

    await expect(
      waitForHeartbeatReady(checker, {
        timeoutMs: 500,
        pollIntervalMs: 5,
        expectedPid: process.pid,
        expectedBootId: 'new-boot',
        notBefore,
      }),
    ).resolves.toBe(true)
    expect(checker.check().lastBeat?.getTime()).toBeGreaterThanOrEqual(notBefore)
  })
})
