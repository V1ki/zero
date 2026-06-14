export interface RecentMessageTrackerOptions {
  maxSize?: number
  ttlMs?: number
  now?: () => number
}

export class RecentMessageTracker {
  private readonly seenMessageIds = new Map<string, number>()

  constructor(private readonly options: RecentMessageTrackerOptions = {}) {}

  shouldProcess(messageId?: string): boolean {
    if (!messageId) return true

    this.sweepExpired()
    if (this.seenMessageIds.has(messageId)) return false

    this.seenMessageIds.set(messageId, this.now())
    this.trimToCapacity()
    return true
  }

  clear(): void {
    this.seenMessageIds.clear()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private sweepExpired(): void {
    if (this.options.ttlMs === undefined) return

    const cutoff = this.now() - this.options.ttlMs
    for (const [messageId, timestamp] of this.seenMessageIds.entries()) {
      if (timestamp < cutoff) this.seenMessageIds.delete(messageId)
    }
  }

  private trimToCapacity(): void {
    if (this.options.maxSize === undefined) return

    while (this.seenMessageIds.size > this.options.maxSize) {
      const first = this.seenMessageIds.keys().next().value
      if (first === undefined) return
      this.seenMessageIds.delete(first)
    }
  }
}
