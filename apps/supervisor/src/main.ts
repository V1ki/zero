import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { installConsoleTimestamping } from '@zero-os/shared'
import { HeartbeatChecker } from '@zero-os/supervisor'
import { RepairEngine } from '@zero-os/supervisor'
import { Effect } from 'effect'
import { getBunExecutable, getRuntimeEnv } from '../../server/src/system/runtime'
import { createSupervisorMonitor } from './monitor'
import {
  isSameHeartbeatOwner,
  stopUnreadyReplacement,
  terminateStaleHeartbeatOwner,
  verifySpawnedReplacement,
} from './process-recovery'

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..')
const ZERO_DIR = join(PROJECT_ROOT, '.zero')
const HEARTBEAT_FILE = join(ZERO_DIR, 'heartbeat.json')
const CHECK_INTERVAL = 5_000 // 5 seconds

const checker = new HeartbeatChecker(HEARTBEAT_FILE)
const repairEngine = new RepairEngine()

installConsoleTimestamping()

console.log('[Supervisor] Starting heartbeat monitor...')
console.log(`[Supervisor] Checking: ${HEARTBEAT_FILE}`)
console.log(`[Supervisor] Interval: ${CHECK_INTERVAL / 1000}s`)

const monitor = createSupervisorMonitor({
  checker,
  repairEngine,
  logger: console,
  checkIntervalMs: CHECK_INTERVAL,
  async diagnose(result) {
    return result.alive
      ? `Process alive but not ready after ${result.uptime?.toFixed(1) ?? 'unknown'}s`
      : `Process dead. Last heartbeat: ${result.lastBeat?.toISOString() ?? 'never'}, elapsed: ${result.elapsedMs ?? 'unknown'}ms`
  },
  async repair(diagnosis, staleResult) {
    console.log(`[Supervisor] Diagnosis: ${diagnosis}`)

    const latest = checker.check()
    if (latest.alive && latest.ready) {
      const recoveredPid = latest.pid
      const recoveredBootId = latest.bootId
      return {
        action: `Process recovered before restart (PID: ${recoveredPid ?? 'unknown'})`,
        async verify() {
          const current = checker.check()
          return (
            current.alive &&
            current.ready === true &&
            isSameHeartbeatOwner(
              { pid: recoveredPid, bootId: recoveredBootId },
              { pid: current.pid, bootId: current.bootId },
            )
          )
        },
      }
    }

    const termination = await terminateStaleHeartbeatOwner({
      checker,
      staleResult,
    })
    if (termination === 'identity_changed') {
      throw new Error('heartbeat ownership changed during diagnosis; retrying with fresh state')
    }
    if (termination === 'recovered') {
      const recovered = checker.check()
      return {
        action: `Process recovered during termination check (PID: ${recovered.pid ?? 'unknown'})`,
        async verify() {
          const current = checker.check()
          return current.alive && current.ready === true && isSameHeartbeatOwner(recovered, current)
        },
      }
    }

    console.log(`[Supervisor] Stale owner handling: ${termination}`)
    console.log('[Supervisor] Attempting restart via Bun...')
    const bootId = randomUUID()
    const notBefore = Date.now()
    const proc = Bun.spawn(
      [getBunExecutable(), 'run', join(PROJECT_ROOT, 'apps/server/src/cli.ts'), 'start'],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...getRuntimeEnv(),
          ZERO_HEARTBEAT_BOOT_ID: bootId,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    proc.unref()

    return {
      action: `Started new process PID: ${proc.pid}`,
      async verify() {
        const ready = await verifySpawnedReplacement({
          checker,
          child: proc,
          bootId,
          notBefore,
        })
        if (!ready) {
          await stopUnreadyReplacement({ child: proc })
        }
        return ready
      },
    }
  },
})

const tickMonitor = () => {
  void monitor.tick()
}

// Process-lifetime daemon loop; the supervisor exits via signals, so the
// fiber is intentionally never interrupted (same lifecycle as the old interval).
Effect.runFork(
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(CHECK_INTERVAL)
      yield* Effect.sync(tickMonitor)
    }
  }),
)
