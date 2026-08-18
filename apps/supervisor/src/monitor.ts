import type { HeartbeatCheckResult, HeartbeatChecker } from '@zero-os/supervisor'
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
  repair(diagnosis: string, result: HeartbeatCheckResult): Promise<SupervisorRepairExecution>
  startupReadyLeaseMs?: number
  /** Expected interval between ticks; used to detect host suspension gaps. */
  checkIntervalMs?: number
  /** How long to wait for a fresh heartbeat after a detected wake-up. */
  wakeSettleMs?: number
  /** Minimum interval between repeated identical stale/fused verdict logs. */
  verdictLogIntervalMs?: number
  now?: () => number
}

export interface SupervisorRepairExecution {
  action: string
  verify(): Promise<boolean>
}

export interface SupervisorMonitor {
  tick(): Promise<void>
  isRepairing(): boolean
}

/** Extra tick delay tolerated before a gap is treated as host suspension. */
const SUSPENSION_GAP_TOLERANCE_MS = 10_000

export function createSupervisorMonitor(deps: SupervisorMonitorDeps): SupervisorMonitor {
  let repairInFlight: Promise<RepairAttempt> | null = null
  const startupReadyLeaseMs = deps.startupReadyLeaseMs ?? 5 * 60_000
  const checkIntervalMs = deps.checkIntervalMs ?? 5_000
  const wakeSettleMs = deps.wakeSettleMs ?? 30_000
  const verdictLogIntervalMs = deps.verdictLogIntervalMs ?? 10 * 60_000
  const now = deps.now ?? Date.now
  let lastTickAt: number | null = null
  let settleUntil = 0
  let verdictLogMutedUntil = 0

  return {
    async tick() {
      const tickAt = now()
      const gapMs = lastTickAt === null ? 0 : tickAt - lastTickAt
      lastTickAt = tickAt
      if (gapMs > checkIntervalMs + SUSPENSION_GAP_TOLERANCE_MS) {
        // The host was suspended (e.g. macOS sleep): the server could not
        // write heartbeats while frozen, so a stale file proves nothing yet.
        // Give it one settle window to publish a fresh beat before judging.
        settleUntil = tickAt + wakeSettleMs
        verdictLogMutedUntil = 0
        deps.logger.log(
          `[Supervisor] Detected a ${Math.round(gapMs / 1000)}s clock jump (system sleep?); allowing ${Math.round(wakeSettleMs / 1000)}s for the heartbeat to settle.`,
        )
      }

      const result = deps.checker.check()
      const readinessLeaseExpired =
        result.alive &&
        result.ready === false &&
        result.stage !== 'shutting_down' &&
        typeof result.uptime === 'number' &&
        result.uptime * 1000 >= startupReadyLeaseMs

      if (result.alive && !readinessLeaseExpired) {
        settleUntil = 0
        verdictLogMutedUntil = 0
        return
      }

      if (!result.alive && tickAt < settleUntil) {
        return
      }

      const shouldLogVerdict = tickAt >= verdictLogMutedUntil
      if (shouldLogVerdict) {
        deps.logger.warn(
          readinessLeaseExpired
            ? '[Supervisor] Main process exceeded the startup readiness lease!'
            : '[Supervisor] Main process appears dead!',
        )
        deps.logger.warn(
          `[Supervisor] Last heartbeat: ${result.lastBeat?.toISOString() ?? 'never'}`,
        )
      }

      if (repairInFlight) {
        if (shouldLogVerdict) {
          deps.logger.log('[Supervisor] Repair already in progress; skipping overlapping cycle.')
          verdictLogMutedUntil = tickAt + verdictLogIntervalMs
        }
        return
      }

      if (deps.repairEngine.shouldFuse()) {
        if (shouldLogVerdict) {
          deps.logger.error(
            '[Supervisor] Max consecutive repair failures reached — fusing. Will probe again after the cooldown.',
          )
          verdictLogMutedUntil = tickAt + verdictLogIntervalMs
        }
        return
      }

      verdictLogMutedUntil = 0
      let execution: SupervisorRepairExecution | null = null
      repairInFlight = deps.repairEngine.runRepairCycle(
        () => deps.diagnose(result),
        async (diagnosis) => {
          execution = await deps.repair(diagnosis, result)
          return execution.action
        },
        () => execution?.verify() ?? Promise.resolve(false),
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
