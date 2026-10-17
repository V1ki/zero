import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonical, digest, hash, measure, validateEvaluation } from './data'
import { writeReports } from './report'
import type {
  BenchmarkPlugin,
  Context,
  Evidence,
  Limits,
  Operation,
  OperationResult,
  Phase,
  RunHooks,
  RunOptions,
  TrialJob,
  TrialRecord,
} from './types'

export class BudgetExceeded extends Error {}

export function plan(plugin: BenchmarkPlugin, options: Omit<RunOptions, 'out'>) {
  if (
    plugin.apiVersion !== 1 ||
    !plugin.id ||
    !plugin.version ||
    !plugin.environment.fingerprint ||
    !plugin.evaluator.id ||
    !plugin.evaluator.version
  )
    throw new Error('Invalid plugin metadata')
  if (!['offline', 'simulated', 'controlled', 'live'].includes(plugin.environment.mode))
    throw new Error('Invalid environment mode')
  for (const ids of [
    plugin.cases.map((c) => c.id),
    plugin.variants.map((v) => v.id),
    plugin.targets,
  ]) {
    if (!ids.length || ids.some((s) => !s) || new Set(ids).size !== ids.length)
      throw new Error('Empty or duplicate matrix identifiers')
  }
  if (
    plugin.cases.some((c) => !c.inputHash || !c.contractHash || !c.family || !c.sourceGroup) ||
    plugin.variants.some((v) => !v.fingerprint)
  )
    throw new Error('Missing fixture, contract or variant fingerprint')
  if (!Number.isInteger(options.reps) || options.reps < 1 || options.reps > 100 || !options.seed)
    throw new Error('Invalid repetitions or seed')
  for (const [name, value] of Object.entries(options.limits)) {
    if (!Number.isInteger(value) || value < (name === 'timeoutMs' ? 1 : 0))
      throw new Error('Invalid limits')
  }
  if (
    !Number.isInteger(options.concurrency ?? 1) ||
    (options.concurrency ?? 1) < 1 ||
    (options.concurrency ?? 1) > 32
  )
    throw new Error('Invalid concurrency')
  const jobs: TrialJob[] = []
  for (let rep = 1; rep <= options.reps; rep++) {
    for (const task of plugin.cases) {
      for (const target of plugin.targets) {
        const block = hash([options.seed, task.id, target, rep]).slice(0, 16)
        const variants = [...plugin.variants].sort((a, b) =>
          hash([block, a.id]).localeCompare(hash([block, b.id])),
        )
        for (const variant of variants) {
          const comparisonKey = hash({
            platform: 1,
            suite: plugin.id,
            version: plugin.version,
            task,
            target,
            environment: plugin.environment,
            evaluator: plugin.evaluator,
            limits: options.limits,
          })
          jobs.push({
            id: hash([plugin.id, block, variant]).slice(0, 24),
            case: task,
            variant,
            target,
            rep,
            block,
            comparisonKey,
          })
        }
      }
    }
  }
  return jobs
}

/** Plugins are trusted local code. Cancellation is cooperative, not a process sandbox. */
export async function runBenchmark(
  plugin: BenchmarkPlugin,
  options: RunOptions,
  hooks: RunHooks = {},
): Promise<TrialRecord[]> {
  const jobs = plan(plugin, options)
  const out = resolve(options.out)
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(out) // Refuse overwrite, including an existing empty directory.
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify(
      { schemaVersion: 1, plugin: { id: plugin.id, version: plugin.version }, options, jobs },
      null,
      2,
    ),
    { flag: 'wx' },
  )
  const results: TrialRecord[] = []
  let next = 0
  let failure: Error | undefined
  try {
    await Promise.all(
      Array.from({ length: options.concurrency ?? 1 }, async () => {
        while (!failure && next < jobs.length) {
          const job = jobs[next++]
          try {
            const workspace = join(out, 'trials', job.id)
            const row = hooks.executor
              ? await hooks.executor.execute(plugin, job, workspace, options.limits)
              : await runTrial(plugin, job, workspace, options.limits)
            results.push(row)
            appendFileSync(join(out, 'results.jsonl'), `${JSON.stringify(row)}\n`)
            await hooks.onTrial?.(row)
          } catch {
            failure = new Error(
              'Platform executor or result persistence failed; inspect the local run directory',
            )
            hooks.executor?.dispose?.()
          }
        }
      }),
    )
  } finally {
    hooks.executor?.dispose?.()
  }
  if (failure) throw failure
  writeReports(out, results)
  return results
}

/** One lifecycle, reused by the in-process and disposable-process executors. */
export async function runTrial(
  plugin: BenchmarkPlugin,
  job: TrialJob,
  workspace: string,
  limits: Limits,
): Promise<TrialRecord> {
  const started = Date.now()
  mkdirSync(workspace, { recursive: true })
  const eventsPath = join(workspace, 'events.jsonl')
  const emit = (event: Record<string, unknown>) =>
    appendFileSync(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  emit({ event: 'trial-start', id: job.id, at: new Date().toISOString() })
  const operations: Operation[] = []
  const evidence: Evidence[] = []
  const controller = new AbortController()
  let timedOut = false
  let budgetExceeded = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    emit({ event: 'deadline', at: new Date().toISOString() })
  }, limits.timeoutMs)
  let phase: Phase = 'execution'
  let stage: NonNullable<TrialRecord['failureStage']> = 'setup'
  let failureStage: TrialRecord['failureStage'] = null
  let execution: Awaited<ReturnType<BenchmarkPlugin['execute']>> | null = null
  let evaluation: TrialRecord['evaluation'] = null
  let sequence = 0
  const counts = { model: 0, tool: 0 }
  const invoke = async <T>(
    kind: Operation['kind'],
    name: string,
    input: unknown,
    action: (signal: AbortSignal) => Promise<OperationResult<T>>,
  ): Promise<T> => {
    if (controller.signal.aborted) throw new Error('Trial cancelled')
    if (counts[kind] >= limits[kind === 'model' ? 'maxModelCalls' : 'maxToolCalls']) {
      budgetExceeded = true
      controller.abort()
      throw new BudgetExceeded('Operation budget exceeded')
    }
    const encoded = canonical(input)
    counts[kind]++ // Reserve before awaiting: parallel calls cannot evade the budget.
    const op: Operation = {
      id: String(++sequence),
      phase,
      kind,
      name,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status: 'error',
      inputHash: digest(encoded),
      inputBytes: Buffer.byteLength(encoded),
      outputHash: null,
      outputBytes: null,
      usage: null,
      cost: null,
      actualModel: null,
    }
    const begin = Date.now()
    emit({ event: 'operation-start', operation: op })
    try {
      const result = await action(controller.signal)
      const output = canonical(result.value)
      if (
        result.usage &&
        Object.values(result.usage).some((v) => v !== null && (!Number.isFinite(v) || v < 0))
      )
        throw new Error('Invalid usage')
      if (kind === 'tool' && result.usage)
        throw new Error('Record token usage on model operations only')
      if (
        result.cost &&
        (!Number.isFinite(result.cost.amount) ||
          result.cost.amount < 0 ||
          !result.cost.currency ||
          !['billed', 'estimated', 'declared-free'].includes(result.cost.basis) ||
          (result.cost.basis === 'declared-free' && result.cost.amount !== 0) ||
          (result.cost.basis === 'estimated' && !result.cost.rateCard))
      )
        throw new Error('Invalid cost or missing rate card')
      op.status = result.status ?? 'ok'
      op.outputHash = digest(output)
      op.outputBytes = Buffer.byteLength(output)
      op.usage = result.usage ?? null
      op.cost = result.cost ?? null
      op.actualModel = result.actualModel ?? null
      return result.value
    } finally {
      op.durationMs = Date.now() - begin
      operations.push(op)
      emit({ event: 'operation-end', operation: op })
    }
  }
  const context: Context = {
    ...structuredClone(job),
    workspace,
    signal: controller.signal,
    model: (name, input, action) => invoke('model', name, input, action),
    tool: (name, input, action) => invoke('tool', name, input, action),
    artifact: (name, content) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
        throw new Error('Artifact requires a plain filename')
      const path = join(workspace, name)
      writeFileSync(path, content, { flag: 'wx' })
      const entry: Evidence = {
        id: `artifact-${evidence.length + 1}`,
        kind: 'artifact',
        ref: path,
        sha256: digest(content),
      }
      evidence.push(entry)
      emit({ event: 'artifact', evidence: entry })
      return entry
    },
  }
  try {
    emit({ event: 'stage', stage: 'setup' })
    await plugin.setup?.(context)
    if (controller.signal.aborted) throw new Error('Trial cancelled')
    stage = 'execution'
    emit({ event: 'stage', stage })
    execution = await plugin.execute(context)
    if (controller.signal.aborted) throw new Error('Trial cancelled')
    if (!['completed', 'partial', 'blocked', 'stopped'].includes(execution.outcome))
      throw new Error('Invalid outcome')
    stage = 'evaluation'
    emit({ event: 'stage', stage })
    phase = 'evaluation'
    const candidate = await plugin.evaluate(context, execution)
    validateEvaluation(
      candidate,
      evidence.map((e) => e.id),
    )
    if (
      candidate.evaluator !== plugin.evaluator.id ||
      candidate.version !== plugin.evaluator.version
    )
      throw new Error('Evaluator version drift')
    evaluation = candidate
  } catch {
    failureStage = stage
    // No raw exception strings: providers can put credentials and payloads in errors.
    emit({
      event: 'failure',
      stage,
      reason: timedOut ? 'timeout' : budgetExceeded ? 'budget' : 'plugin-error',
    })
  } finally {
    phase = 'execution'
    emit({ event: 'stage', stage: 'cleanup' })
    try {
      await plugin.cleanup?.(context)
    } catch {
      failureStage ??= 'cleanup'
      emit({ event: 'failure', stage: 'cleanup', reason: 'plugin-error' })
    }
    clearTimeout(timer)
    if (Date.now() - started >= limits.timeoutMs) timedOut = true
    if (timedOut) failureStage ??= stage
  }
  const row: TrialRecord = {
    schemaVersion: 1,
    ...job,
    suite: plugin.id,
    suiteVersion: plugin.version,
    environment: { ...plugin.environment },
    status: timedOut
      ? 'timeout'
      : budgetExceeded
        ? 'budget_exceeded'
        : failureStage
          ? 'error'
          : 'ok',
    failureStage,
    outcome: execution?.outcome ?? null,
    durationMs: Date.now() - started,
    evaluation,
    evidence,
    operations,
    measurements: {
      execution: measure(operations.filter((o) => o.phase === 'execution')),
      evaluation: measure(operations.filter((o) => o.phase === 'evaluation')),
    },
    provenance: { kind: 'native', source: eventsPath, sha256: digest(readFileSync(eventsPath)) },
    limitations: [
      'Timeout requests cooperative cancellation; awaited operations and cleanup must settle. Plugin must instrument all billable calls.',
    ],
  }
  return row
}
