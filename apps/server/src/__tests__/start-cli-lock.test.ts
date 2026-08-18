import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStartCommand } from '../cli/start'
import { consumeRestartTrigger, writeRestartTrigger } from '../system/restart-trigger'
import { acquireServerDaemonLock } from '../system/server-daemon-lock'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('start CLI single-instance lock', () => {
  test('acquires the stable server lock before runtime initialization and keeps it held', async () => {
    const zeroDir = createZeroDir()
    const events: string[] = []
    let releaseCalls = 0
    const signals: string[] = []

    await runStartCommand(
      { zeroDir },
      {
        acquireLock: async (lockPath) => {
          events.push(`lock:${lockPath}`)
          return async () => {
            releaseCalls++
          }
        },
        installConsoleTimestamping: () => {},
        registerSignalHandler: (signal) => {
          signals.push(signal)
        },
        startZeroOS: async (options) => {
          events.push(`start:${options?.dataDir}`)
          return { shutdown: async () => {} }
        },
      },
    )

    expect(events).toEqual([`lock:${join(zeroDir, 'server.lock')}`, `start:${zeroDir}`])
    expect(releaseCalls).toBe(0)
    expect(signals).toEqual(['SIGINT', 'SIGTERM'])
  })

  test('does not initialize the runtime when the server lock is already held', async () => {
    const zeroDir = createZeroDir()
    const releaseExistingLock = await acquireServerDaemonLock(join(zeroDir, 'server.lock'))
    let startCalls = 0

    try {
      await expect(
        runStartCommand(
          { zeroDir },
          {
            installConsoleTimestamping: () => {},
            registerSignalHandler: () => {},
            startZeroOS: async () => {
              startCalls++
              return { shutdown: async () => {} }
            },
          },
        ),
      ).rejects.toThrow('another ZeRo OS server is already running')
      expect(startCalls).toBe(0)
    } finally {
      await releaseExistingLock()
    }
  })

  test('releases the server lock when runtime initialization throws', async () => {
    const zeroDir = createZeroDir()
    const startupError = new Error('startup failed')
    let releaseCalls = 0

    await expect(
      runStartCommand(
        { zeroDir },
        {
          acquireLock: async () => async () => {
            releaseCalls++
          },
          installConsoleTimestamping: () => {},
          registerSignalHandler: () => {},
          startZeroOS: async () => {
            throw startupError
          },
        },
      ),
    ).rejects.toBe(startupError)

    expect(releaseCalls).toBe(1)
  })

  test('discards an orphaned restart trigger after becoming the new owner', async () => {
    const zeroDir = createZeroDir()
    writeRestartTrigger(zeroDir, { source: 'stale-cli' })

    await runStartCommand(
      { zeroDir },
      {
        acquireLock: async () => async () => {},
        installConsoleTimestamping: () => {},
        registerSignalHandler: () => {},
        startZeroOS: async () => ({ shutdown: async () => {} }),
      },
    )

    expect(consumeRestartTrigger(zeroDir)).toBeUndefined()
  })

  test('does not steal a live owner lock when its token is older than the old stale lease', async () => {
    const zeroDir = createZeroDir()
    const lockPath = join(zeroDir, 'server.lock')
    const releaseExistingLock = await acquireServerDaemonLock(lockPath)
    const ownerDirectory = `${lockPath}.owner`
    const staleDate = new Date(Date.now() - 60_000)
    utimesSync(ownerDirectory, staleDate, staleDate)

    try {
      await expect(acquireServerDaemonLock(lockPath)).rejects.toMatchObject({
        code: 'ELOCKED',
      })
      expect(readOwnerToken(ownerDirectory)).toBeDefined()
    } finally {
      await releaseExistingLock()
    }
  })

  test('reclaims an owner token only after its PID is no longer alive', async () => {
    const zeroDir = createZeroDir()
    const lockPath = join(zeroDir, 'server.lock')
    const registerExitHandler = () => () => {}
    const releaseDeadOwner = await acquireServerDaemonLock(lockPath, {
      pid: 41_001,
      createTokenId: () => 'dead-owner',
      isProcessAlive: () => true,
      registerExitHandler,
    })

    const releaseReplacement = await acquireServerDaemonLock(lockPath, {
      pid: 41_002,
      createTokenId: () => 'replacement',
      isProcessAlive: (pid) => pid !== 41_001,
      registerExitHandler,
    })

    expect(readOwnerToken(`${lockPath}.owner`)).toBe('replacement')

    await releaseDeadOwner()
    await releaseReplacement()
  })

  test('allows exactly one of two simultaneous contenders to acquire the lock', async () => {
    const zeroDir = createZeroDir()
    const lockPath = join(zeroDir, 'server.lock')
    const registerExitHandler = () => () => {}

    const contenders = await Promise.allSettled([
      acquireServerDaemonLock(lockPath, {
        pid: 42_001,
        createTokenId: () => 'first',
        isProcessAlive: () => true,
        registerExitHandler,
      }),
      acquireServerDaemonLock(lockPath, {
        pid: 42_002,
        createTokenId: () => 'second',
        isProcessAlive: () => true,
        registerExitHandler,
      }),
    ])

    const acquired = contenders.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === 'fulfilled',
    )
    const rejected = contenders.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(acquired).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'ELOCKED' })
    const ownerToken = readOwnerToken(`${lockPath}.owner`)
    expect(ownerToken === 'first' || ownerToken === 'second').toBe(true)

    await acquired[0]?.value()
  })
})

function createZeroDir(): string {
  const zeroDir = mkdtempSync(join(tmpdir(), 'zero-start-lock-'))
  tempDirs.push(zeroDir)
  writeFileSync(join(zeroDir, 'config.yaml'), 'providers: {}\nchannels: []\n')
  return zeroDir
}

function readOwnerToken(ownerDirectory: string): string | undefined {
  const content = JSON.parse(readFileSync(join(ownerDirectory, 'owner.json'), 'utf8')) as {
    token?: string
  }
  return content.token
}
