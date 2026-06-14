import { join } from 'node:path'
import { installConsoleTimestamping } from '@zero-os/shared'
import { HeartbeatChecker } from '@zero-os/supervisor'
import { RepairEngine } from '@zero-os/supervisor'
import { waitForHeartbeatReady } from '@zero-os/supervisor'
import { getBunExecutable, getRuntimeEnv, rebuildWebBundle } from '../../server/src/system/runtime'
import { createSupervisorMonitor } from './monitor'

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
  async diagnose(result) {
    return result.alive
      ? 'Process recovered during diagnosis'
      : `Process dead. Last heartbeat: ${result.lastBeat?.toISOString() ?? 'never'}, elapsed: ${result.elapsedMs ?? 'unknown'}ms`
  },
  async repair(diagnosis) {
    console.log(`[Supervisor] Diagnosis: ${diagnosis}`)
    console.log('[Supervisor] Rebuilding web UI before restart...')
    const build = rebuildWebBundle()
    if (!build.ok) {
      throw new Error(`web rebuild failed: ${build.error ?? 'unknown error'}`)
    }
    console.log('[Supervisor] Attempting restart via Bun...')
    const proc = Bun.spawn(
      [getBunExecutable(), 'run', join(PROJECT_ROOT, 'apps/server/src/cli.ts'), 'start'],
      {
        cwd: PROJECT_ROOT,
        env: getRuntimeEnv(),
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    return `Started new process PID: ${proc.pid}`
  },
  async verify() {
    return waitForHeartbeatReady(checker)
  },
})

setInterval(() => {
  void monitor.tick()
}, CHECK_INTERVAL)
