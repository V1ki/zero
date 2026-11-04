import {
  type RouterJob,
  RouterJobConflictError,
  type RouterJobScope,
  type RouterJobStep,
  type TriggerStore,
} from '@zero-os/observe'
import type { RouterJobReceipt } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'

/** The worker may already have changed its checkout. Never automatically re-run this attempt. */
export class RouterJobExecutionUncertainError extends TriggerAgentError {}

type ReturnStatus = 'delivered' | 'unavailable' | 'unknown'

interface NewJob {
  executor: 'zero' | 'codex'
  instruction: string
  repository?: string
  /** Opaque origin pinned by the server, never supplied by the model. */
  audience?: string
}

interface Dependencies {
  authorized(scope: RouterJobScope, audience: string | null, repository: string | null): boolean
  execute(
    job: RouterJob,
    history: RouterJobStep[],
    signal: AbortSignal,
  ): Promise<{ result: string; threadId?: string }>
  completed?(job: RouterJob, signal: AbortSignal): Promise<ReturnStatus | { recheckAt: string }>
  filter?(text: string): string
}

export function routerJobReceipt(job: RouterJob): RouterJobReceipt {
  return {
    id: job.id,
    executor: job.executor,
    status: job.status,
    attempt: job.attempt,
    ...(job.repository && { repository: job.repository }),
    ...(job.result && { result: job.result }),
  }
}

export class RouterJobs {
  private readonly stop = new AbortController()
  private started = false
  private running?: Promise<void>
  private executing?: Promise<void>
  private requested = false
  private retry?: ReturnType<typeof setTimeout>

  constructor(
    private readonly store: TriggerStore['jobs'],
    private readonly deps: Dependencies,
  ) {}

  start() {
    if (this.started || this.stop.signal.aborted) return
    this.store.recoverInterrupted()
    this.started = true
    this.wake()
  }

  async close() {
    this.stop.abort()
    clearTimeout(this.retry)
    await Promise.all([this.running, this.executing])
  }

  submit(scope: RouterJobScope, requestId: string, input: NewJob): RouterJobReceipt {
    this.requireAccess(scope, input.audience ?? null, input.repository ?? null)
    const job = this.operation(() => this.store.submit(scope, requestId, input))
    this.requireOwner(job, scope, input.audience)
    this.wake()
    return routerJobReceipt(job)
  }

  get(scope: RouterJobScope, id: number, audience?: string, attempt?: number): RouterJobReceipt {
    const job = this.store.get(scope, id, attempt)
    this.requireOwner(job, scope, audience)
    return routerJobReceipt(job)
  }

  continue(
    scope: RouterJobScope,
    id: number,
    requestId: string,
    instruction: string,
    audience?: string,
  ): RouterJobReceipt {
    this.get(scope, id, audience)
    const job = this.operation(() => this.store.continue(scope, id, requestId, instruction))
    this.wake()
    return routerJobReceipt(job)
  }

  private operation<T>(action: () => T): T {
    try {
      return action()
    } catch (error) {
      if (error instanceof RouterJobConflictError) throw new TriggerAgentError(error.message)
      throw error
    }
  }

  private requireOwner(
    job: RouterJob | null,
    scope: RouterJobScope,
    audience?: string,
  ): asserts job is RouterJob {
    if (!job || job.audience !== (audience ?? null))
      throw new TriggerAgentError('在当前 Router 对话中找不到这个工作任务。')
    this.requireAccess(scope, job.audience, job.repository)
  }

  private requireAccess(scope: RouterJobScope, audience: string | null, repository: string | null) {
    if (!this.started || this.stop.signal.aborted)
      throw new TriggerAgentError('Router 工作任务服务尚未就绪。')
    if (!this.deps.authorized(scope, audience, repository))
      throw new TriggerAgentError('当前身份或仓库授权已变更，无法访问这个工作任务。')
  }

  private wake() {
    if (!this.started || this.stop.signal.aborted) return
    this.requested = true
    if (this.running) return
    clearTimeout(this.retry)
    this.running = Promise.resolve()
      .then(async () => {
        while (this.requested && !this.stop.signal.aborted) {
          this.requested = false
          // Keep deferred notifications responsive even while a long-running worker is busy.
          if (!this.executing) {
            const next = this.store.claimNext()
            if (next) {
              this.executing = this.run(next)
                .catch((error: unknown) => this.reportQueueFailure(error))
                .finally(() => {
                  this.executing = undefined
                  this.wake()
                })
            }
          }
          const completed = this.store.claimReturn()
          if (!completed) {
            const nextDate = this.store.nextReturnAt()
            if (nextDate) this.schedule(Date.parse(nextDate) - Date.now())
            continue
          }
          await this.returnResult(completed)
          this.requested = true
        }
      })
      .catch((error: unknown) => {
        this.reportQueueFailure(error)
        this.requested = false
        this.schedule(5000)
      })
      .finally(() => {
        this.running = undefined
        if (this.requested) this.wake()
      })
  }

  private reportQueueFailure(error: unknown) {
    // A database failure does not authorize replay of an external invocation.
    console.error(
      '[Router jobs] Worker queue unavailable.',
      error instanceof Error ? error.name : '',
    )
  }

  private schedule(delay: number) {
    if (this.stop.signal.aborted) return
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.wake(), Math.min(2_147_483_647, Math.max(1, delay)))
    this.retry.unref()
  }

  private mayUse(job: RouterJob) {
    return this.deps.authorized(job.scope, job.audience, job.repository)
  }

  private async run(job: RouterJob) {
    if (!this.mayUse(job)) {
      this.store.finish(job.id, job.attempt, { status: 'failed', result: '执行前任务授权已失效。' })
      return
    }
    const access = new AbortController()
    const deadline = AbortSignal.timeout(10 * 60_000)
    const signal = AbortSignal.any([this.stop.signal, access.signal, deadline])
    const check = setInterval(() => {
      try {
        if (!this.mayUse(job)) access.abort()
      } catch (error) {
        this.reportQueueFailure(error)
        access.abort()
      }
    }, 1000)
    check.unref()
    let outcome: Parameters<TriggerStore['jobs']['finish']>[2]
    try {
      const result = await this.deps.execute(job, this.store.history(job.scope, job.id), signal)
      if (!this.mayUse(job)) access.abort()
      signal.throwIfAborted()
      if (!result.result.trim()) throw new TriggerAgentError('执行器没有返回任务结果。')
      outcome = { ...result, status: 'completed', result: this.safeText(result.result) }
    } catch (error) {
      const uncertain =
        error instanceof RouterJobExecutionUncertainError ||
        (job.executor === 'codex' && (signal.aborted || !(error instanceof TriggerAgentError)))
      const description = access.signal.aborted
        ? '执行期间任务授权已失效。'
        : this.stop.signal.aborted
          ? 'Router 停止期间执行被中断。'
          : deadline.aborted
            ? '任务超时。'
            : error instanceof TriggerAgentError
              ? this.safeText(error.message)
              : '执行器未返回有效结果。'
      outcome = {
        status: uncertain ? 'unknown' : 'failed',
        result: uncertain ? `${description} 请先核对工作区，任务未自动重试。` : description,
      }
    } finally {
      clearInterval(check)
    }
    this.store.finish(job.id, job.attempt, outcome)
  }

  private safeText(text: string) {
    return (this.deps.filter?.(text) ?? text).slice(0, 12000)
  }

  private async returnResult(job: RouterJob) {
    let status: ReturnStatus | { recheckAt: string } = 'unavailable'
    if (this.deps.completed && this.mayUse(job)) {
      try {
        status = await this.deps.completed(job, this.stop.signal)
      } catch {
        // Sending may already have succeeded. The user can still look up the durable result.
        status = 'unknown'
      }
    }
    if (typeof status === 'object') {
      const timestamp = Date.parse(status.recheckAt)
      if (Number.isFinite(timestamp)) {
        const due = new Date(Math.max(Date.now() + 1000, timestamp)).toISOString()
        this.store.deferReturn(job.id, job.attempt, due)
        return
      }
      status = 'unavailable'
    }
    this.store.settleReturn(job.id, job.attempt, status)
  }
}
