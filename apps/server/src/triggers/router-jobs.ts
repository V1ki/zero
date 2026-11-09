import {
  type RouterJob,
  RouterJobConflictError,
  type RouterJobScope,
  type RouterJobStep,
  type TriggerStore,
} from '@zero-os/observe'
import {
  type RouterEventWork,
  type RouterJobReceipt,
  type RouterTraceSink,
  isPublicGithubFact,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import type { createRouterEventWorker } from './router-event-worker'

/** The worker may already have changed its checkout. Never automatically re-run this attempt. */
export class RouterJobExecutionUncertainError extends TriggerAgentError {}

type ReturnStatus = 'delivered' | 'unavailable' | 'unknown'

interface NewJob {
  executor: string
  instruction: string
  repository?: string
  /** Opaque origin pinned by the server, never supplied by the model. */
  audience?: string
}

export interface RouterExecutorAdapter {
  name: string
  description: string
  execute: Dependencies['execute']
}

interface Dependencies {
  executors?: readonly RouterExecutorAdapter[]
  trace?: RouterTraceSink
  unifiedExecution?: boolean
  current?(job: RouterJob): boolean
  handoffAuthorized?(job: RouterJob): boolean
  authorized(scope: RouterJobScope, audience: string | null, repository: string | null): boolean
  execute(
    job: RouterJob,
    history: RouterJobStep[],
    signal: AbortSignal,
    onThreadReady?: (threadId: string) => void,
  ): Promise<{ result: string; threadId?: string }>
  completed?(job: RouterJob, signal: AbortSignal): Promise<ReturnStatus | { recheckAt: string }>
  filter?(text: string): string
  tracking?: ReturnType<typeof createRouterEventWorker>
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

  private readonly adapters = new Map<string, RouterExecutorAdapter>()

  constructor(
    private readonly store: TriggerStore['jobs'],
    private readonly deps: Dependencies,
  ) {
    for (const adapter of deps.executors ?? []) {
      if (
        !adapter.name.trim() ||
        !adapter.description.trim() ||
        ['zero', 'codex'].includes(adapter.name) ||
        this.adapters.has(adapter.name)
      )
        throw Error(`执行器名称重复或缺少能力说明：${adapter.name}`)
      this.adapters.set(adapter.name, adapter)
    }
  }

  executorCatalog(engineering: boolean) {
    return [
      { name: 'zero', description: '负责通用分析和处理。' },
      ...(engineering ? [{ name: 'codex', description: '使用已授权的工程工作区。' }] : []),
      ...Array.from(this.adapters.values(), ({ name, description }) => ({ name, description })),
    ]
  }

  private executor(name: string): Dependencies['execute'] {
    if (name === 'codex' || name === 'zero') return this.deps.execute.bind(this.deps)
    const adapter = this.adapters.get(name)
    if (!adapter) throw new TriggerAgentError(`执行器 ${name} 未接入。`)
    return adapter.execute.bind(adapter)
  }

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

  submit(
    scope: RouterJobScope,
    requestId: string,
    input: NewJob,
    registered?: (job: RouterJob) => void,
  ): RouterJobReceipt {
    this.requireAccess(scope, input.audience ?? null, input.repository ?? null)
    this.executor(input.executor)
    const job = this.operation(() => this.store.submit(scope, requestId, input, registered))
    this.requireOwner(job, scope, input.audience)
    this.wake()
    return routerJobReceipt(job)
  }

  get(scope: RouterJobScope, id: number, audience?: string, attempt?: number): RouterJobReceipt {
    const job = this.store.get(scope, id, attempt)
    this.requireOwner(job, scope, audience)
    return routerJobReceipt(job)
  }

  findAttempts(scope: RouterJobScope, id: number, audience: string, query: string) {
    this.get(scope, id, audience)
    return this.store.matchingAttempts(scope, id, audience, query).map(({ attempt }) => {
      const receipt = this.get(scope, id, audience, attempt)
      return { attempt, status: receipt.status }
    })
  }

  continue(
    scope: RouterJobScope,
    id: number,
    requestId: string,
    instruction: string,
    audience?: string,
    registered?: (job: RouterJob) => void,
  ): RouterJobReceipt {
    this.executor(this.get(scope, id, audience).executor)
    const job = this.operation(() =>
      this.store.continue(scope, id, requestId, instruction, undefined, true, registered),
    )
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
    if (this.deps.handoffAuthorized && !this.deps.handoffAuthorized(job))
      throw new TriggerAgentError('原 Worker 的资料授权已变更。')
    if (job.kind && !this.deps.tracking?.authorized(job))
      throw new TriggerAgentError('事件来源已停用，或已无权读取这条事件。')
  }

  private requireAccess(scope: RouterJobScope, audience: string | null, repository: string | null) {
    if (!this.started || this.stop.signal.aborted)
      throw new TriggerAgentError('Router 工作任务服务尚未就绪。')
    if (!this.deps.authorized(scope, audience, repository))
      throw new TriggerAgentError('当前身份或仓库授权已变更，无法访问这个工作任务。')
  }

  /** Intake inserts watch jobs atomically with the event and wakes this existing queue after commit. */
  notify() {
    this.wake()
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
    return (
      this.deps.authorized(job.scope, job.audience, job.repository) &&
      (this.deps.current?.(job) ?? true) &&
      (this.deps.handoffAuthorized?.(job) ?? true) &&
      (!job.kind || !!this.deps.tracking?.authorized(job))
    )
  }

  private async run(job: RouterJob) {
    if (!this.mayUse(job)) {
      this.store.finish(job.id, job.attempt, { status: 'failed', result: '执行前任务授权已失效。' })
      return
    }
    const access = new AbortController()
    const signal = AbortSignal.any([this.stop.signal, access.signal])
    const check = setInterval(() => {
      try {
        if (!this.mayUse(job)) access.abort()
      } catch (error) {
        this.reportQueueFailure(error)
        access.abort()
      }
    }, 1000)
    check.unref()
    const extension = job.executor !== 'zero' && job.executor !== 'codex'
    const trace = extension ? this.deps.trace : undefined
    let runId: string | undefined
    let outcome: Parameters<TriggerStore['jobs']['finish']>[2]
    try {
      let result: {
        result: string
        threadId?: string
        attentionQuestion?: string
        work?: RouterEventWork
      }
      const history = this.store.history(job.scope, job.id)
      if (trace) {
        runId = trace.begin(`router-job-${job.id}`, `Worker · ${job.executor}`, {
          transport: 'registered-executor',
          executor: job.executor,
          context: { workerId: job.id, attempt: job.attempt },
          instruction: job.instruction,
          threadId: job.threadId,
          history: history.map(({ attempt, instruction, result, status }) => ({
            attempt,
            instruction,
            result,
            status,
          })),
        })
      }
      if (job.kind && !this.deps.unifiedExecution) {
        if (!this.deps.tracking) throw new TriggerAgentError('事件 Worker 尚未就绪。')
        result = await this.deps.tracking.execute(job, signal)
      } else
        result = await this.executor(job.executor)(job, history, signal, (threadId) =>
          this.store.attachThread(job.id, job.attempt, threadId),
        )
      if (!this.mayUse(job)) access.abort()
      signal.throwIfAborted()
      if (!result.result.trim()) throw new TriggerAgentError('执行器没有返回任务结果。')
      outcome = {
        ...result,
        status: 'completed',
        result: this.safeText(result.result),
        ...(result.attentionQuestion && {
          attentionQuestion: this.safeText(result.attentionQuestion),
        }),
        ...(result.work && { work: this.workReceipt(job, result.work) }),
      }
    } catch (error) {
      const uncertain =
        error instanceof RouterJobExecutionUncertainError ||
        ((job.executor === 'codex' || extension) &&
          (signal.aborted || !(error instanceof TriggerAgentError)))
      const description = access.signal.aborted
        ? '执行期间任务授权已失效。'
        : this.stop.signal.aborted
          ? 'Router 停止期间执行被中断。'
          : error instanceof TriggerAgentError
            ? this.safeText(error.message)
            : '执行器未返回有效结果。'
      outcome = {
        status: uncertain ? 'unknown' : 'failed',
        result: uncertain
          ? `${description} 请先核对${job.kind === 'github-watch' ? '原讨论' : '工作区'}，任务未自动重试。`
          : description,
      }
    } finally {
      clearInterval(check)
    }
    this.store.finish(job.id, job.attempt, outcome)
    if (runId && trace) {
      trace.append(runId, outcome.status === 'completed' ? 'result' : 'error', {
        text: outcome.result,
        status: outcome.status,
        threadId: outcome.threadId ?? job.threadId,
      })
      trace.end(runId, outcome.status === 'completed' ? 'completed' : 'failed')
    }
  }

  private workReceipt(job: RouterJob, work: RouterEventWork): RouterEventWork {
    if (
      !job.kind ||
      (job.kind === 'github-watch' && !job.repository) ||
      (work.outcome === 'resolved' && (!work.sources.length || !work.steps.some((s) => s.ok)))
    )
      throw new TriggerAgentError('Worker 未提供可核实的办理回执。')
    const archive = job.kind === 'event-followup'
    const key = archive && this.store.followups.step(job.id, job.attempt)?.eventKey
    const inbox = key && /^inbox:([1-9]\d*)$/u.exec(key)?.[1]
    if (
      archive &&
      (!inbox || work.publicFacts || work.steps.some((s) => s.tool !== 'inspect_archive'))
    )
      throw new TriggerAgentError('归档 Worker 的办理回执与来源不符。')
    if (!archive && work.steps.some((s) => s.tool === 'inspect_archive'))
      throw new TriggerAgentError('GitHub Worker 的办理回执与来源不符。')
    const prefix = job.repository && `https://github.com/${job.repository.toLowerCase()}/`
    const sources = work.sources.map(({ label, url }) => {
      // Only server-verified links in this repository may be persisted as evidence.
      if (
        this.safeText(url) !== url ||
        (archive
          ? url !== `/router?event=${inbox}`
          : !prefix ||
            !URL.canParse(url) ||
            new URL(url).href !== url ||
            !url.toLowerCase().startsWith(prefix))
      )
        throw new TriggerAgentError('Worker 的证据链接与本次仓库不符。')
      return { label: this.safeText(label), url }
    })
    return {
      outcome: work.outcome,
      ...(work.followup && {
        followup: {
          kind: work.followup.kind,
          decision: work.followup.decision,
          reason: this.safeText(work.followup.reason),
        },
      }),
      steps: work.steps.map(({ tool, ok }) => ({ tool, ok })),
      ...(work.publicFacts && {
        publicFacts: work.publicFacts.filter(isPublicGithubFact),
      }),
      sources,
    }
  }

  private safeText(text: string) {
    return this.deps.filter?.(text) ?? text
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
