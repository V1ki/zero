import type { GitOps } from './git-ops'

export type RepairStatus = 'idle' | 'diagnosing' | 'repairing' | 'verifying' | 'success' | 'failed'

export interface RepairAttempt {
  timestamp: string
  status: RepairStatus
  diagnosis: string
  action: string
  result: string
}

export interface RepairEngineOptions {
  /** How long the fuse blocks new repair attempts after a failure streak. */
  fuseCooldownMs?: number
  now?: () => number
}

const DEFAULT_FUSE_COOLDOWN_MS = 30 * 60_000

/**
 * Self-repair engine — diagnose, repair, verify flow.
 */
export class RepairEngine {
  private maxAttempts: number
  private attempts: RepairAttempt[] = []
  private status: RepairStatus = 'idle'
  private gitOps?: GitOps
  private fuseCooldownMs: number
  private now: () => number

  constructor(maxAttempts = 5, gitOps?: GitOps, options: RepairEngineOptions = {}) {
    this.maxAttempts = maxAttempts
    this.gitOps = gitOps
    this.fuseCooldownMs = options.fuseCooldownMs ?? DEFAULT_FUSE_COOLDOWN_MS
    this.now = options.now ?? Date.now
  }

  getStatus(): RepairStatus {
    return this.status
  }

  getAttempts(): RepairAttempt[] {
    return [...this.attempts]
  }

  getAttemptCount(): number {
    return this.attempts.length
  }

  shouldFuse(): boolean {
    // Only consecutive failures count toward the fuse. A single successful
    // repair proves the system recovered and resets the streak, so isolated
    // failures spread over a long process lifetime cannot permanently
    // disable self-healing.
    let consecutiveFails = 0
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      if (this.attempts[i].status !== 'failed') break
      consecutiveFails++
    }
    if (consecutiveFails < this.maxAttempts) return false

    // The fuse is a cooldown, not a permanent latch: once it elapses the next
    // cycle may probe again. A failed probe re-engages the fuse for another
    // cooldown; a successful probe resets the streak entirely. This keeps a
    // burst of transient failures (network outage, sleep/wake churn) from
    // disabling self-healing forever.
    const lastAttempt = this.attempts[this.attempts.length - 1]
    const lastAttemptAt = lastAttempt ? Date.parse(lastAttempt.timestamp) : Number.NaN
    if (Number.isNaN(lastAttemptAt)) return true
    return this.now() - lastAttemptAt < this.fuseCooldownMs
  }

  /**
   * Run a repair cycle: diagnose → repair → verify.
   */
  async runRepairCycle(
    diagnose: () => Promise<string>,
    repair: (diagnosis: string) => Promise<string>,
    verify: () => Promise<boolean>,
  ): Promise<RepairAttempt> {
    this.status = 'diagnosing'
    let diagnosis: string
    try {
      diagnosis = await diagnose()
    } catch (e) {
      diagnosis = `Diagnosis failed: ${e}`
    }

    this.status = 'repairing'
    let action: string
    try {
      action = await repair(diagnosis)
    } catch (e) {
      action = `Repair failed: ${e}`
    }

    this.status = 'verifying'
    let success: boolean
    try {
      success = await verify()
    } catch {
      success = false
    }

    const attempt: RepairAttempt = {
      timestamp: new Date(this.now()).toISOString(),
      status: success ? 'success' : 'failed',
      diagnosis,
      action,
      result: success ? 'Verification passed' : 'Verification failed',
    }

    this.attempts.push(attempt)
    this.status = success ? 'success' : 'failed'

    // After successful repair, commit and tag via git
    if (success && this.gitOps) {
      try {
        await this.gitOps.commitAndTag(`repair: ${diagnosis}`)
      } catch {
        // Git commit failure is non-fatal for the repair cycle
      }
    }

    // If fuse threshold reached, rollback to last stable tag
    if (this.shouldFuse() && this.gitOps) {
      try {
        const lastStable = await this.gitOps.getLastStableTag()
        if (lastStable) {
          await this.gitOps.rollbackToTag(lastStable)
        }
      } catch {
        // Rollback failure is non-fatal
      }
    }

    return attempt
  }

  reset(): void {
    this.attempts = []
    this.status = 'idle'
  }
}
