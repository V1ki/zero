import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemoryUsageKind, MemoryUsageRecorder } from '@zero-os/shared'
import { Effect, Exit, Fiber } from 'effect'

interface UsageRecord {
  /** 指数衰减计数:每次访问 count = count * 0.5^(Δt/halfLife) + 1 */
  injected: number
  read: number
  used: number
  harmful: number
  unused: number
  /** 终身累计(只增,不衰减),给 UI/治理看原始热度 */
  total: number
  lastAccessedAt: string
}

interface UsageStatsFile {
  version: 1
  records: Record<string, UsageRecord>
}

/** 全量快照的单条记录:衰减视图 + 原始热度 + 时间戳 + 得分,给 UI/治理消费。 */
export interface MemoryUsageSnapshotEntry {
  id: string
  injected: number
  read: number
  used: number
  harmful: number
  unused: number
  total: number
  lastAccessedAt: string
  score: number
}

export interface MemoryUsageTrackerOptions {
  /** 统计文件路径,建议 .zero/memory/usage-stats.json */
  statsPath: string
  /** 衰减半衰期(天),与新近度半衰期一致;默认 30 */
  halfLifeDays?: number
  /** usageScore 线性饱和常数:近期正向信号折算和达到该值即满分;默认 5 */
  saturation?: number
  /** 脏后自动落盘的防抖间隔 ms;默认 30_000 */
  flushIntervalMs?: number
}

const USAGE_KINDS: MemoryUsageKind[] = ['injected', 'read', 'used', 'harmful', 'unused']

function positiveScore(view: Pick<UsageRecord, 'read' | 'used'>, saturation: number): number {
  const positive = 2 * view.read + view.used
  return Math.min(1, positive / saturation)
}

function emptyRecord(): UsageRecord {
  return {
    injected: 0,
    read: 0,
    used: 0,
    harmful: 0,
    unused: 0,
    total: 0,
    lastAccessedAt: new Date(0).toISOString(),
  }
}

function decayedRecord(record: UsageRecord, nowMs: number, halfLifeMs: number): UsageRecord {
  const elapsed = nowMs - new Date(record.lastAccessedAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return record
  const factor = 0.5 ** (elapsed / halfLifeMs)
  return {
    injected: record.injected * factor,
    read: record.read * factor,
    used: record.used * factor,
    harmful: record.harmful * factor,
    unused: record.unused * factor,
    total: record.total,
    lastAccessedAt: record.lastAccessedAt,
  }
}

/**
 * 记忆使用反馈统计。旁路 sidecar 存储,与记忆正文完全解耦:
 * 不写 frontmatter、不碰 updatedAt,因此不会触发 re-embed、不污染新近度语义。
 * 任何一层失败(文件损坏→从空开始,flush 失败→保持脏标记重试)都不影响记忆主链路。
 */
export class MemoryUsageTracker implements MemoryUsageRecorder {
  private readonly records = new Map<string, UsageRecord>()
  // 同 (kind, sessionId, memory) 只计一次,防单会话内重复动作刷分;
  // injected 另有 injectedMemoryIds 天然去重,这里是统一保险。
  private readonly seenSessionEvents = new Set<string>()
  private readonly statsPath: string
  private readonly halfLifeMs: number
  private readonly saturation: number
  private readonly flushIntervalMs: number
  private dirty = false
  private flushFiber: Fiber.RuntimeFiber<void> | null = null

  constructor(options: MemoryUsageTrackerOptions) {
    this.statsPath = options.statsPath
    this.halfLifeMs = (options.halfLifeDays ?? 30) * 86_400_000
    this.saturation = options.saturation ?? 5
    this.flushIntervalMs = options.flushIntervalMs ?? 30_000
  }

  /** 从 sidecar 文件加载既有统计;文件缺失/损坏一律从空开始,不抛错。 */
  load(): void {
    if (!existsSync(this.statsPath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.statsPath, 'utf-8')) as Partial<UsageStatsFile>
      if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object') return
      for (const [id, raw] of Object.entries(parsed.records)) {
        const record = this.toRecord(raw)
        if (record) this.records.set(id, record)
      }
    } catch (error) {
      // 统计只是排序提示,损坏即弃;下次落盘自然覆盖重建。
      console.warn('[memory] usage stats file unreadable, starting empty', {
        path: this.statsPath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private toRecord(raw: unknown): UsageRecord | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const source = raw as Record<string, unknown>
    const record = emptyRecord()
    let hasValue = false
    for (const kind of USAGE_KINDS) {
      const value = source[kind]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        record[kind] = value
        hasValue = true
      }
    }
    if (typeof source.total === 'number' && Number.isFinite(source.total)) {
      record.total = source.total
    }
    const rawAccessedAt =
      typeof source.lastAccessedAt === 'string' ? Date.parse(source.lastAccessedAt) : Number.NaN
    if (!Number.isNaN(rawAccessedAt)) {
      record.lastAccessedAt = source.lastAccessedAt as string
    } else {
      // 时间戳缺失/非法时视为"最近访问":按 epoch 衰减会把整份计数清零,
      // 对提示性信号而言宁可保守给分也不销毁数据。
      record.lastAccessedAt = new Date().toISOString()
    }
    return hasValue ? record : undefined
  }

  record(id: string, kind: MemoryUsageKind, sessionId?: string): void {
    if (!id) return
    if (sessionId) {
      const key = `${kind}|${sessionId}|${id}`
      if (this.seenSessionEvents.has(key)) return
      this.seenSessionEvents.add(key)
    }

    const nowMs = Date.now()
    const current = decayedRecord(this.records.get(id) ?? emptyRecord(), nowMs, this.halfLifeMs)
    current[kind] += 1
    current.total += 1
    current.lastAccessedAt = new Date(nowMs).toISOString()
    this.records.set(id, current)

    this.dirty = true
    this.scheduleFlush()
  }

  /**
   * 使用度得分 ∈ [0,1]:近期正向信号(read 权重 2、used 权重 1)线性饱和。
   * harmful/unused 不进评分——它们留给治理回路,避免"帮倒忙"的记忆只是静默降权被埋。
   */
  score(id: string): number {
    const view = this.decayedView(id)
    if (!view) return 0
    return positiveScore(view, this.saturation)
  }

  /** 当前衰减视图(不修改已存状态);给测试与后续治理队列用。 */
  decayedView(id: string): Record<MemoryUsageKind | 'total', number> | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    const view = decayedRecord(record, Date.now(), this.halfLifeMs)
    return {
      injected: view.injected,
      read: view.read,
      used: view.used,
      harmful: view.harmful,
      unused: view.unused,
      total: view.total,
    }
  }

  get size(): number {
    return this.records.size
  }

  /** 全库衰减快照(不修改已存状态);给 /api/memory/usage 与治理视图消费。 */
  snapshot(): MemoryUsageSnapshotEntry[] {
    const nowMs = Date.now()
    const entries: MemoryUsageSnapshotEntry[] = []
    for (const [id, record] of this.records) {
      const view = decayedRecord(record, nowMs, this.halfLifeMs)
      entries.push({
        id,
        injected: view.injected,
        read: view.read,
        used: view.used,
        harmful: view.harmful,
        unused: view.unused,
        total: view.total,
        lastAccessedAt: record.lastAccessedAt,
        score: positiveScore(view, this.saturation),
      })
    }
    return entries
  }

  private scheduleFlush(): void {
    if (this.flushFiber) return
    const fiber = Effect.runFork(Effect.sleep(this.flushIntervalMs))
    this.flushFiber = fiber
    fiber.addObserver((exit) => {
      // 到期先让位再触发落盘：sleep 完成后 flushFiber 清空，期间新 record() 可排下一轮
      // （与旧 setTimeout 回调"先清 timer 再 void flush"逐字等价）；flush 失败吞掉、
      // 保持脏标记等下次 record() 或 shutdown 重试。
      if (this.flushFiber === fiber) this.flushFiber = null
      if (Exit.isSuccess(exit)) {
        void this.flush().catch(() => {})
      }
    })
  }

  /**
   * 取消尚未到期的后台落盘 fiber（shutdown 先 stop 再显式 flush）。
   * 旧实现用 unref 的 setTimeout 保证后台落盘不阻止进程退出；fiber 的 sleep
   * 持有普通定时器引用，优雅退出路径因此必须经 shutdown 调 stop()——tracker
   * 只在 server 运行时内存活，服务 socket 本就持有事件循环，实际暴露面仅此。
   */
  stop(): void {
    const fiber = this.flushFiber
    this.flushFiber = null
    if (fiber) {
      void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {})
    }
  }

  /** 立即落盘(tmp+rename 原子写)。shutdown 与测试调用;失败时保持脏标记等下次重试。 */
  async flush(): Promise<void> {
    if (!this.dirty || this.records.size === 0) return
    const payload: UsageStatsFile = { version: 1, records: Object.fromEntries(this.records) }
    const dir = dirname(this.statsPath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = join(dir, '.usage-stats.tmp')
    writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8')
    renameSync(tmpPath, this.statsPath)
    this.dirty = false
  }
}
