import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { CASES, estimateModelCalls } from './cases'
import { runTrial, sha } from './harness'
import { renderReport, renderReview, summarize } from './report'
import { type AnyCase, type CaseSets, JUDGEMENTS, type Judgement, type TrialResult } from './types'

export interface BenchOptions {
  outDir: string
  reps: number
  concurrency: number
  judgements: Judgement[]
  caseIds?: string[]
  resume: boolean
}

/** Where model answers come from. The real one is resolved from ZeRo's config; tests script it. */
export interface BenchRuntime {
  dryRun: boolean
  /** The exact `provider/model` requested, or the dry-run script's name. */
  model: string
  modelId?: string
  modelFingerprint?: string
  adapterFor(judgement: Judgement, c: AnyCase): ProviderAdapter
  filter(text: string): string
}

/** The shipped files whose prompts, input composition, budgets and parsers are under test. */
const SOURCES = [
  'event-agent.ts',
  'router-write-check.ts',
  'router-job-report.ts',
  'mandate-investigation.ts',
]
const sourceDir = join(import.meta.dir, '../../../../apps/server/src/triggers')

export function sourceFingerprint() {
  const files = Object.fromEntries(
    SOURCES.map((file) => [file, sha(readFileSync(join(sourceDir, file), 'utf8')).slice(0, 12)]),
  )
  return { files, hash: sha(JSON.stringify(files)).slice(0, 12) }
}

export function selectCases(sets: CaseSets, judgements: Judgement[], ids?: string[]): CaseSets {
  const all = JUDGEMENTS.flatMap((judgement) => sets[judgement].map((c) => c.id))
  const unknown = ids?.filter((id) => !all.includes(id)) ?? []
  if (unknown.length) throw new Error(`Unknown case: ${unknown.join(', ')}`)
  const pick = <T extends AnyCase>(judgement: Judgement, list: T[]) =>
    judgements.includes(judgement) ? list.filter((c) => !ids || ids.includes(c.id)) : []
  return {
    write_check: pick('write_check', sets.write_check),
    triage: pick('triage', sets.triage),
    job_report: pick('job_report', sets.job_report),
    investigation: pick('investigation', sets.investigation),
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, limit: number, done: (value: T) => void) {
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      done(await task())
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

function key(row: Pick<TrialResult, 'judgement' | 'caseId' | 'rep'>) {
  return `${row.judgement}/${row.caseId}/${row.rep}`
}

export async function runRouterPromptBenchmark(options: BenchOptions, runtime: BenchRuntime) {
  const sets = selectCases(CASES, options.judgements, options.caseIds)
  const source = sourceFingerprint()
  const casesHash = sha(JSON.stringify(sets)).slice(0, 12)
  const manifestPath = join(options.outDir, 'manifest.json')
  const resultsPath = join(options.outDir, 'results.jsonl')
  let previous: TrialResult[] = []
  if (options.resume) {
    if (!existsSync(manifestPath)) throw new Error('--resume needs an earlier run in --out')
    const earlier = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    if (
      earlier.model !== runtime.model ||
      earlier.dryRun !== runtime.dryRun ||
      earlier.casesHash !== casesHash ||
      (earlier.sourceFingerprint as { hash?: string })?.hash !== source.hash ||
      earlier.reps !== options.reps
    )
      throw new Error(
        'The earlier run used a different model, case set, repetitions or prompt version; start a new --out',
      )
    previous = existsSync(resultsPath)
      ? readFileSync(resultsPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as TrialResult)
          .filter((row) => row.status === 'ok')
      : []
  } else if (existsSync(options.outDir) && readdirSync(options.outDir).length) {
    throw new Error('Output directory is not empty; choose a new --out or pass --resume')
  }
  mkdirSync(options.outDir, { recursive: true })

  const planned = JUDGEMENTS.flatMap((judgement) =>
    sets[judgement].flatMap((c: AnyCase) =>
      Array.from({ length: options.reps }, (_, index) => ({ judgement, c, rep: index + 1 })),
    ),
  )
  const manifest = {
    schema: 1,
    startedAt: new Date().toISOString(),
    dryRun: runtime.dryRun,
    model: runtime.model,
    ...(runtime.modelId && { modelId: runtime.modelId }),
    ...(runtime.modelFingerprint && { modelFingerprint: runtime.modelFingerprint }),
    reps: options.reps,
    concurrency: options.concurrency,
    judgements: options.judgements,
    ...(options.caseIds && { caseIds: options.caseIds }),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceFingerprint: source,
    casesHash,
    cases: Object.fromEntries(JUDGEMENTS.map((judgement) => [judgement, sets[judgement].length])),
    plannedTrials: planned.length,
    estimatedModelCalls: estimateModelCalls(sets, options.reps),
  }
  writeFileSync(manifestPath, `${runtime.filter(JSON.stringify(manifest, null, 2))}\n`)

  const reused = new Set(previous.map(key))
  writeFileSync(
    resultsPath,
    previous.map((row) => `${runtime.filter(JSON.stringify(row))}\n`).join(''),
  )
  const results = [...previous]
  const tasks = planned
    .filter(({ judgement, c, rep }) => !reused.has(key({ judgement, caseId: c.id, rep })))
    .map(
      ({ judgement, c, rep }) =>
        () =>
          runTrial(judgement, c, rep, runtime.adapterFor(judgement, c), { filter: runtime.filter }),
    )
  await pool(tasks, options.concurrency, (row) => {
    // Every persisted line passes the secret filter, like the shipped notification text does.
    const line = runtime.filter(JSON.stringify(row))
    results.push(JSON.parse(line) as TrialResult)
    appendFileSync(resultsPath, `${line}\n`)
    console.log(
      `[router-prompt] ${results.length}/${planned.length} ${row.judgement} ${row.caseId} rep=${row.rep} ${row.status === 'ok' ? (row.passed ? 'pass' : row.dangerous ? 'FAIL(dangerous)' : 'fail') : `error: ${runtime.filter(row.error ?? '')}`}`,
    )
  })

  const order = new Map(planned.map((p, index) => [key({ ...p, caseId: p.c.id }), index]))
  results.sort((a, b) => (order.get(key(a)) ?? 0) - (order.get(key(b)) ?? 0))
  const summary = summarize(sets, results)
  const context = { manifest, runtime: { dryRun: runtime.dryRun, model: runtime.model } }
  writeFileSync(
    join(options.outDir, 'summary.json'),
    `${runtime.filter(JSON.stringify({ manifest, summary }, null, 2))}\n`,
  )
  writeFileSync(
    join(options.outDir, 'report.md'),
    runtime.filter(renderReport(sets, results, summary, context)),
  )
  writeFileSync(
    join(options.outDir, 'review.md'),
    runtime.filter(renderReview(sets, results, context)),
  )
  return { manifest, summary, results }
}
