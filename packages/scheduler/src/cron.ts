import type { ForkEffect, ScheduleConfig } from '@zero-os/shared'
import parser from 'cron-parser'
import { Effect, Fiber } from 'effect'

export interface ScheduleEntry {
  config: ScheduleConfig
  nextRun: Date
  lastRun?: Date
  running: boolean
}

export interface CronSchedulerOptions {
  /**
   * Fork wait fibers into a host-owned lifetime (the composition root's
   * fiber root). Defaults to a standalone Effect.runFork.
   */
  forkEffect?: ForkEffect
}

const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Cron scheduler — manages timed task execution.
 */
export class CronScheduler {
  private entries: Map<string, ScheduleEntry> = new Map()
  private fibers: Map<string, Fiber.RuntimeFiber<void>> = new Map()
  private onTrigger: ((config: ScheduleConfig) => Promise<void>) | null = null
  private onRemoved: ((name: string) => void) | null = null
  private queued: Map<string, ScheduleConfig[]> = new Map()
  private pendingReplace: Set<string> = new Set()
  private readonly forkEffect: ForkEffect

  constructor(options: CronSchedulerOptions = {}) {
    this.forkEffect = options.forkEffect ?? ((effect) => Effect.runFork(effect))
  }

  /**
   * Set the trigger handler called when a schedule fires.
   */
  setTriggerHandler(handler: (config: ScheduleConfig) => Promise<void>): void {
    this.onTrigger = handler
  }

  /**
   * Set a callback invoked when a schedule is removed (e.g. oneShot cleanup).
   */
  setOnRemoved(handler: (name: string) => void): void {
    this.onRemoved = handler
  }

  /**
   * Add a schedule.
   */
  add(config: ScheduleConfig): void {
    const interval = parser.parseExpression(config.cron)
    const nextRun = interval.next().toDate()

    this.entries.set(config.name, {
      config,
      nextRun,
      running: false,
    })
  }

  /**
   * Add a schedule and immediately start its timer.
   * Use this when the scheduler is already running.
   */
  addAndStart(config: ScheduleConfig): void {
    this.add(config)
    const entry = this.entries.get(config.name)
    if (entry) {
      this.scheduleNext(config.name, entry)
    }
  }

  /**
   * Remove a schedule by name. Returns true if it existed.
   */
  remove(name: string): boolean {
    this.cancelFiber(name)
    this.queued.delete(name)
    this.pendingReplace.delete(name)
    return this.entries.delete(name)
  }

  /**
   * Get a single schedule entry.
   */
  getEntry(name: string): ScheduleEntry | undefined {
    return this.entries.get(name)
  }

  /**
   * Start all schedules.
   */
  start(): void {
    for (const [name, entry] of this.entries) {
      this.scheduleNext(name, entry)
    }
  }

  /**
   * Stop all schedules.
   */
  stop(): void {
    for (const name of Array.from(this.fibers.keys())) {
      this.cancelFiber(name)
    }
  }

  /**
   * Get the status of all schedules.
   */
  getStatus(): { name: string; nextRun: Date; running: boolean; lastRun?: Date }[] {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.config.name,
      nextRun: e.nextRun,
      running: e.running,
      lastRun: e.lastRun,
    }))
  }

  /**
   * Parse a cron expression and return the next N execution times.
   */
  static getNextRuns(cronExpr: string, count = 5): Date[] {
    const interval = parser.parseExpression(cronExpr)
    const dates: Date[] = []
    for (let i = 0; i < count; i++) {
      dates.push(interval.next().toDate())
    }
    return dates
  }

  private scheduleNext(name: string, entry: ScheduleEntry): void {
    this.cancelFiber(name)

    const delay = entry.nextRun.getTime() - Date.now()
    if (delay < 0) {
      // Missed execution — check misfire policy
      const policy = entry.config.misfirePolicy ?? 'skip'
      if (policy === 'run_once') {
        this.launchFire(name, entry)
      }
      // Calculate next run
      const interval = parser.parseExpression(entry.config.cron)
      entry.nextRun = interval.next().toDate()
      this.scheduleNext(name, entry)
      return
    }

    this.fibers.set(name, this.forkEffect(this.waitAndFire(name, entry, delay)))
  }

  /**
   * Sleep until the entry's nextRun is due, then fire it.
   *
   * Each sleep is capped at the JS timer maximum: Effect's Clock treats
   * longer durations as infinite (they never fire), so far-future waits
   * re-check the remaining delay after every slice — the same chaining the
   * previous bare-setTimeout implementation performed.
   */
  private waitAndFire(name: string, entry: ScheduleEntry, delay: number): Effect.Effect<void> {
    const launch = () => this.launchFire(name, entry)
    return Effect.gen(function* () {
      let remaining = delay
      while (remaining > MAX_TIMEOUT_MS) {
        yield* Effect.sleep(MAX_TIMEOUT_MS)
        remaining = entry.nextRun.getTime() - Date.now()
      }
      yield* Effect.sleep(Math.max(remaining, 0))
      yield* Effect.sync(launch)
    })
  }

  private cancelFiber(name: string): void {
    const fiber = this.fibers.get(name)
    if (!fiber) return
    this.fibers.delete(name)
    // Interruption cancels only pending sleeps (Effect's Clock finalizer
    // clears the timer) and does not reject in practice.
    void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {})
  }

  private launchFire(name: string, entry: ScheduleEntry): void {
    void this.fire(name, entry).catch((err) => {
      console.error(`[CronScheduler] schedule "${name}" failed:`, err)
    })
  }

  private async fire(name: string, entry: ScheduleEntry): Promise<void> {
    const policy = entry.config.overlapPolicy?.type ?? 'skip'

    if (entry.running) {
      switch (policy) {
        case 'skip':
          // Skip this execution
          this.scheduleFollowingRun(entry)
          return
        case 'queue': {
          // Queue for later execution
          const queuedRuns = this.queued.get(name)
          if (queuedRuns) {
            queuedRuns.push(entry.config)
          } else {
            this.queued.set(name, [entry.config])
          }
          this.scheduleFollowingRun(entry)
          return
        }
        case 'replace':
          // Coalesce overlapping replace events into a single immediate rerun.
          this.pendingReplace.add(name)
          return
      }
    }

    entry.running = true
    entry.lastRun = new Date()
    let thrownError: unknown = null

    try {
      if (this.onTrigger) {
        await this.onTrigger(entry.config)
      }
    } catch (error) {
      thrownError = error
    } finally {
      entry.running = false
    }

    // Schedule was removed during execution (e.g. agent cancelled it in onTrigger)
    if (!this.entries.has(name)) return

    // oneShot: remove after single execution
    if (entry.config.oneShot) {
      this.remove(name)
      if (this.onRemoved) {
        this.onRemoved(name)
      }
    } else if (this.pendingReplace.delete(name)) {
      this.launchFire(name, entry)
    } else {
      // Process queued executions
      const queue = this.queued.get(name)
      if (queue && queue.length > 0) {
        queue.shift()
        if (queue.length === 0) {
          this.queued.delete(name)
        }

        // Re-fire immediately for the queued item we just consumed
        this.launchFire(name, entry)
      } else {
        // Schedule next run
        this.scheduleFollowingRun(entry)
      }
    }

    if (thrownError) {
      throw thrownError
    }
  }

  private scheduleFollowingRun(entry: ScheduleEntry): void {
    const interval = parser.parseExpression(entry.config.cron)
    entry.nextRun = interval.next().toDate()
    this.scheduleNext(entry.config.name, entry)
  }
}
