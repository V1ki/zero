import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest, hash, measure } from './data'
import { validateRecords } from './report'
import type {
  BenchmarkPlugin,
  Evidence,
  Limits,
  Operation,
  TrialExecutor,
  TrialJob,
  TrialRecord,
} from './types'

export function pluginIdentity(plugin: BenchmarkPlugin): string {
  return hash({
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    version: plugin.version,
    environment: plugin.environment,
    evaluator: plugin.evaluator,
    cases: plugin.cases,
    variants: plugin.variants,
    targets: plugin.targets,
  })
}

/** Recover completed calls and explicitly mark an interrupted request's usage unknown. */
export function recoverTrial(
  plugin: BenchmarkPlugin,
  job: TrialJob,
  workspace: string,
  status: 'error' | 'timeout',
  started: number,
): TrialRecord {
  const path = join(workspace, 'events.jsonl')
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const operations = new Map<string, Operation>()
  const evidence: Evidence[] = []
  let stage: TrialRecord['failureStage'] = 'setup'
  const lines = raw.split('\n')
  // A process may die during its last append. Never interpret a partial last record.
  lines.pop()
  for (const line of lines) {
    if (!line) continue
    const event = JSON.parse(line) as {
      event: string
      operation?: Operation
      evidence?: Evidence
      stage?: TrialRecord['failureStage']
    }
    if (event.event === 'stage' && event.stage) stage = event.stage
    if (event.event === 'artifact' && event.evidence) evidence.push(event.evidence)
    if (event.operation) {
      const op = event.operation
      operations.set(
        op.id,
        event.event === 'operation-end'
          ? op
          : {
              ...op,
              status: 'error',
              usage: null,
              cost: null,
              outputHash: null,
              outputBytes: null,
              durationMs: Math.max(0, Date.now() - Date.parse(op.startedAt)),
            },
      )
    }
  }
  const observed = [...operations.values()]
  return {
    schemaVersion: 1,
    ...job,
    suite: plugin.id,
    suiteVersion: plugin.version,
    environment: { ...plugin.environment },
    status,
    failureStage: stage,
    outcome: null,
    durationMs: Date.now() - started,
    evaluation: null,
    evidence,
    operations: observed,
    measurements: {
      execution: measure(observed.filter((o) => o.phase === 'execution')),
      evaluation: measure(observed.filter((o) => o.phase === 'evaluation')),
    },
    provenance: { kind: 'native', source: path, sha256: digest(raw) },
    limitations: [
      'Disposable worker did not finish. Completed operations retained; in-flight usage unknown. Local process termination does not cancel work already accepted by an external service.',
    ],
  }
}

export function createProcessExecutor(options: {
  modulePath: string
  config?: unknown
  cwd: string
}): TrialExecutor {
  const active = new Set<ReturnType<typeof Bun.spawn>>()
  let disposed = false
  const dispose = () => {
    disposed = true
    for (const child of active) child.kill('SIGKILL')
    process.off('SIGINT', dispose)
    process.off('SIGTERM', dispose)
  }
  process.once('SIGINT', dispose)
  process.once('SIGTERM', dispose)
  return {
    dispose,
    async execute(plugin: BenchmarkPlugin, job: TrialJob, workspace: string, limits: Limits) {
      if (disposed) throw new Error('Executor disposed')
      const started = Date.now()
      mkdirSync(workspace, { recursive: true })
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'process-worker.ts')], {
        cwd: options.cwd,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      active.add(child)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, limits.timeoutMs)
      try {
        child.stdin.write(
          JSON.stringify({
            modulePath: options.modulePath,
            config: options.config ?? null,
            identity: pluginIdentity(plugin),
            job,
            workspace,
            limits,
          }),
        )
        child.stdin.end()
        const code = await child.exited
        const path = join(workspace, 'worker-result.json')
        if (!timedOut && !disposed && code === 0 && existsSync(path)) {
          const row = JSON.parse(readFileSync(path, 'utf8')) as TrialRecord
          validateRecords([row])
          if (
            row.id !== job.id ||
            row.comparisonKey !== job.comparisonKey ||
            row.target !== job.target ||
            row.variant.fingerprint !== job.variant.fingerprint
          )
            throw new Error('Worker identity mismatch')
          row.limitations = [
            'Executed in a disposable process with a parent-enforced deadline. The environment is still defined by the plugin; process isolation is not a network or filesystem sandbox.',
          ]
          row.durationMs = Date.now() - started
          return row
        }
        return recoverTrial(plugin, job, workspace, timedOut ? 'timeout' : 'error', started)
      } finally {
        clearTimeout(timer)
        active.delete(child)
        if (child.exitCode === null) {
          child.kill('SIGKILL')
          await child.exited
        }
      }
    },
  }
}
