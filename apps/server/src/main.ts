import { join } from 'node:path'
import { installConsoleTimestamping } from '@zero-os/shared'
import { globalBus } from './runtime/bus'
import {
  createStartupRuntime,
  markStartupRuntimeReady,
  startStartupRuntimeChannels,
} from './runtime/startup'
import type { StartOptions, ZeroOS } from './runtime/types'

export { createFeishuStreamingStarter } from './runtime/channel-runtime/runtime'
export { createUsageRecorder } from './runtime/observability'
export type { ReloadModelProvidersOptions, StartOptions, ZeroOS } from './runtime/types'

/**
 * Initialize and start ZeRo OS.
 */
export async function startZeroOS(options?: StartOptions): Promise<ZeroOS> {
  installConsoleTimestamping()
  const zeroDir = resolveZeroDataDir(options)
  console.log('[ZeRo OS] Starting...')

  const runtime = await createStartupRuntime({
    zeroDir,
    projectRoot: resolveZeroProjectRoot(options),
    bus: globalBus,
    skipProcessExit: options?.skipProcessExit,
    routerSources: options?.routerSources,
    routerExecutors: options?.routerExecutors,
  })

  try {
    await options?.onCoreReady?.(runtime.zero)
    await startStartupRuntimeChannels(runtime)
    markStartupRuntimeReady(runtime)
  } catch (error) {
    await runtime.zero.listeners.close()
    // onCoreReady may already have exposed the Worker through the Web API.
    try {
      await runtime.core.worker.close()
    } catch (closeError) {
      console.warn(
        '[ZeRo OS] Could not close the Codex app-server during startup cleanup:',
        closeError,
      )
    }
    throw error
  }

  return runtime.zero
}

// Auto-start if run directly
if (import.meta.main) {
  startZeroOS()
    .then((zero) => {
      process.on('SIGINT', zero.shutdown)
      process.on('SIGTERM', zero.shutdown)
    })
    .catch(console.error)
}

function resolveZeroDataDir(options?: Pick<StartOptions, 'dataDir'>): string {
  return options?.dataDir ?? process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
}

function resolveZeroProjectRoot(options?: Pick<StartOptions, 'projectRoot'>): string {
  return options?.projectRoot ?? process.cwd()
}
