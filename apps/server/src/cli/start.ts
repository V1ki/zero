import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installConsoleTimestamping } from '@zero-os/shared'
import { startZeroOS } from '../main'
import { consumeRestartTrigger } from '../system/restart-trigger'
import { acquireServerDaemonLock } from '../system/server-daemon-lock'

interface RunStartCommandOptions {
  zeroDir: string
}

type StartedZeroOS = Pick<Awaited<ReturnType<typeof startZeroOS>>, 'shutdown'>

interface RunStartCommandDependencies {
  acquireLock: typeof acquireServerDaemonLock
  installConsoleTimestamping: typeof installConsoleTimestamping
  registerSignalHandler: (signal: 'SIGINT' | 'SIGTERM', handler: () => void | Promise<void>) => void
  startZeroOS: (options?: Parameters<typeof startZeroOS>[0]) => Promise<StartedZeroOS>
}

const DEFAULT_DEPENDENCIES: RunStartCommandDependencies = {
  acquireLock: acquireServerDaemonLock,
  installConsoleTimestamping,
  registerSignalHandler: (signal, handler) => {
    process.on(signal, handler)
  },
  startZeroOS,
}

export async function runStartCommand(
  { zeroDir }: RunStartCommandOptions,
  dependencies: Partial<RunStartCommandDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  deps.installConsoleTimestamping()

  if (!existsSync(join(zeroDir, 'config.yaml'))) {
    console.error('[ZeRo OS] Error: .zero/config.yaml not found. Run `bun zero init` first.')
    process.exit(1)
  }

  const lockPath = join(zeroDir, 'server.lock')
  let releaseLock: () => Promise<void>
  try {
    releaseLock = await deps.acquireLock(lockPath)
  } catch (error) {
    if (isLockAlreadyHeldError(error)) {
      throw new Error(
        `[ZeRo OS] Cannot start: another ZeRo OS server is already running (lock: ${lockPath}).`,
        { cause: error },
      )
    }
    throw error
  }

  const orphanedRestartTrigger = consumeRestartTrigger(zeroDir)
  if (orphanedRestartTrigger) {
    console.warn(
      `[ZeRo OS] Discarded an orphaned restart trigger from ${orphanedRestartTrigger.source}.`,
    )
  }

  let zero: StartedZeroOS
  try {
    zero = await deps.startZeroOS({
      dataDir: zeroDir,
      onCoreReady: async (runtime) => {
        const { startWebServer } = await import('../../../web/src/server')
        const web = startWebServer(runtime)
        console.log(`[ZeRo OS] Web UI: http://localhost:${web.port}`)
      },
    })
  } catch (error) {
    await releaseLock()
    throw error
  }

  deps.registerSignalHandler('SIGINT', () => zero.shutdown())
  deps.registerSignalHandler('SIGTERM', () => zero.shutdown())
}

function isLockAlreadyHeldError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOCKED'
}
