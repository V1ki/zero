import type { HeartbeatChecker, HeartbeatCheckResult } from '@zero-os/supervisor'
import type { RepairAttempt, RepairEngine } from '@zero-os/supervisor'

export interface SupervisorLogger {
  log(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface SupervisorMonitorDeps {
  checker: HeartbeatChecker
  repairEngine: RepairEngine
  logger: SupervisorLogger
  diagnose(result: HeartbeatCheckResult): Promise<string>
  repair(diagnosis: string): Promise<string>
  verify(): Promise<boolean>
}

export interface SupervisorMonitor {
  tick(): Promise<void>
  isRepairing(): boolean
}

export function createSupervisorMonitor(deps: SupervisorMonitorDeps): SupervisorMonitor {
  let repairInFlight: Promise<RepairAttempt> | null = null

  return {
    async tick() {
      const result = deps.checker.check()

      if (result.alive) {
        return
      }

      deps.logger.warn('[Supervisor] Main process appears dead!')
      deps.logger.warn(`[Supervisor] Last heartbeat: ${result.lastBeat?.toISOString() ?? 'never'}`)

      if (repairInFlight) {
        deps.logger.log('[Supervisor] Repair already in progress; skipping overlapping cycle.')
        return
      }

      if (deps.repairEngine.shouldFuse()) {
        deps.logger.error(
          '[Supervisor] Max repair attempts reached — fusing. Manual intervention required.',
        )
        return
      }

      repairInFlight = deps.repairEngine.runRepairCycle(
        () => deps.diagnose(result),
        deps.repair,
        deps.verify,
      )

      try {
        const attempt = await repairInFlight
        deps.logger.log(`[Supervisor] Repair attempt: ${attempt.status} — ${attempt.result}`)
      } finally {
        repairInFlight = null
      }
    },

    isRepairing() {
      return repairInFlight !== null
    },
  }
}
