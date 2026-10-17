import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ReasoningEffort } from '@zero-os/shared'
import { createProcessExecutor } from '../../../platform/src/process-executor'
import { plan as platformPlan, runBenchmark } from '../../../platform/src/runner'
import type { RunOptions } from '../../../platform/src/types'
import { type Settings, type Trial, resolveRuntime } from './engine'
import createPromptPlugin, {
  legacyTrialFromRecord,
  type PromptPluginConfig,
} from './platform-plugin'
import { blindReview, renderReport } from './report'
import { captureSnapshot, hash, loadSnapshot, suiteHash } from './snapshot'
import { type SuiteName, getSuite } from './suites'

function args(argv: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(`Expected --name value: ${argv[i]}`)
    if (result.has(argv[i])) throw new Error(`Duplicate option: ${argv[i]}`)
    result.set(argv[i], argv[i + 1])
  }
  return result
}

function numberArg(
  options: Map<string, string>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = Number(options.get(name) ?? fallback)
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`)
  return value
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0]
  if (!command || command === 'help') {
    console.log(
      'snapshot --label NAME --out FILE [--ref working-tree|GIT_REF --suite basic|advanced|real]\nrun --baseline FILE --candidate FILE --models provider/model,... --out DIR [--reps 3 --concurrency 3 --reasoning medium --secret-source vault --cases id,... --timeout-ms 120000 --max-steps 8 --max-tokens 2048 --empty-retries 0 --max-tool-calls 256 --seed zero-prompt-v1]\nrun/plan 自动使用快照所属题库。plan 使用与 run 相同参数，只生成计划，不读取密钥或调用模型。',
    )
    return
  }
  if (!['snapshot', 'run', 'plan'].includes(command)) throw new Error('Unknown command')
  const options = args(argv.slice(1))
  const accepted = new Set([
    '--label',
    '--out',
    '--ref',
    '--baseline',
    '--candidate',
    '--models',
    '--reps',
    '--concurrency',
    '--reasoning',
    '--secret-source',
    '--cases',
    '--timeout-ms',
    '--max-steps',
    '--max-tokens',
    '--config',
    '--catalog',
    '--suite',
    '--empty-retries',
    '--seed',
    '--max-tool-calls',
  ])
  for (const key of options.keys()) if (!accepted.has(key)) throw new Error(`Unknown option ${key}`)
  const root = process.cwd()
  const requestedSuite = options.get('--suite')
  if (requestedSuite && !['basic', 'advanced', 'real'].includes(requestedSuite))
    throw new Error('Unknown suite')
  const outArg = options.get('--out')
  if (!outArg) throw new Error('--out is required')
  const out = resolve(outArg)
  if (existsSync(out))
    throw new Error('Output already exists; choose a new path to preserve previous evidence')
  if (command === 'snapshot') {
    const snapshot = await captureSnapshot(
      root,
      options.get('--label') ?? 'candidate',
      options.get('--ref'),
      requestedSuite as SuiteName | undefined,
    )
    mkdirSync(resolve(out, '..'), { recursive: true })
    writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify({ out, label: snapshot.label, hash: snapshot.hash }))
    return
  }
  const baseline = loadSnapshot(resolve(options.get('--baseline') ?? ''))
  const candidate = loadSnapshot(resolve(options.get('--candidate') ?? ''))
  const suite = baseline.suite ?? 'basic'
  if (suite !== (candidate.suite ?? 'basic') || (requestedSuite && requestedSuite !== suite))
    throw new Error('Baseline and candidate must use the same suite')
  if (baseline.label === candidate.label || baseline.hash === candidate.hash)
    throw new Error('Use distinct snapshot labels and hashes')
  const models = options.get('--models')?.split(',') ?? []
  if (!models.length || new Set(models).size !== models.length)
    throw new Error('Provide distinct exact --models')
  const cases = getSuite(suite)
  const ids = [...cases.agent, ...cases.closure].map((c) => c.id)
  const selected = options.get('--cases')?.split(',') ?? ids
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !ids.includes(id))
  )
    throw new Error('Unknown or duplicate case')
  const reps = numberArg(options, '--reps', 3, 20)
  const concurrency = numberArg(options, '--concurrency', 3, 12)
  const timeoutMs = numberArg(options, '--timeout-ms', 120000, 600000)
  const reasoning = options.get('--reasoning') ?? 'medium'
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoning))
    throw new Error('Unsupported reasoning effort')
  const secretSource = options.get('--secret-source') ?? 'vault'
  if (!['env', 'vault'].includes(secretSource)) throw new Error('Invalid secret source')
  const common = {
    root,
    config: resolve(options.get('--config') ?? '.zero/config.yaml'),
    catalog: resolve(options.get('--catalog') ?? '.zero/cache/model-catalog/catalog.json'),
    secretSource: secretSource as Settings['secretSource'],
    reasoning: reasoning as ReasoningEffort,
    maxTokens: numberArg(options, '--max-tokens', 2048, 32768),
    maxSteps: numberArg(options, '--max-steps', 8, 30),
    emptyResponseRetries: Number(options.get('--empty-retries') ?? 0) as 0 | 1,
  }
  if (![0, 1].includes(common.emptyResponseRetries))
    throw new Error('--empty-retries must be 0 or 1')
  const resolved = await Promise.all(
    models.map(async (model) => {
      const runtime = await resolveRuntime({ ...common, model }, false)
      return { model, fingerprint: runtime.fingerprint, modelId: runtime.modelId }
    }),
  )
  const pluginConfig: PromptPluginConfig = {
    settings: common,
    snapshots: [baseline, candidate],
    targets: resolved,
    caseIds: selected,
  }
  const plugin = createPromptPlugin(pluginConfig)
  const platformOptions: RunOptions = {
    out: join(out, 'platform'),
    reps,
    concurrency,
    seed: options.get('--seed') ?? 'zero-prompt-v1',
    limits: {
      timeoutMs,
      maxModelCalls: common.maxSteps,
      maxToolCalls: numberArg(options, '--max-tool-calls', 256, 4096),
    },
  }
  const jobs = platformPlan(plugin, platformOptions)
  mkdirSync(out, { recursive: true })
  const codeFiles = [
    'cases.ts',
    'advanced.ts',
    'real.ts',
    'freeze-real-v1.py',
    'suites.ts',
    'sandbox.ts',
    'snapshot.ts',
    'engine.ts',
    'platform-plugin.ts',
    'report.ts',
    'cli.ts',
  ]
  const manifest = {
    schema: 1,
    startedAt: new Date().toISOString(),
    command,
    suite,
    suiteHash: suiteHash(suite),
    reps,
    concurrency,
    timeoutMs,
    reasoning,
    maxTokens: common.maxTokens,
    maxSteps: common.maxSteps,
    emptyResponseRetries: common.emptyResponseRetries,
    models: resolved,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessHashes: Object.fromEntries(
      codeFiles.map((file) => [file, hash(readFileSync(join(import.meta.dir, file), 'utf8'))]),
    ),
    snapshots: [baseline, candidate].map((s) => ({ label: s.label, hash: s.hash })),
    plannedTrials: jobs.length,
    platform: {
      plugin: plugin.id,
      version: plugin.version,
      environment: plugin.environment,
      options: platformOptions,
    },
    plan: jobs.map((job) => ({
      model: job.target,
      fingerprint: resolved.find((m) => m.model === job.target)?.fingerprint,
      caseId: job.case.id,
      rep: job.rep,
      variant: job.variant.id,
      platformTrialId: job.id,
    })),
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(out, 'suite.json'), JSON.stringify(cases, null, 2))
  writeFileSync(join(out, 'baseline.json'), JSON.stringify(baseline, null, 2))
  writeFileSync(join(out, 'candidate.json'), JSON.stringify(candidate, null, 2))
  if (command === 'plan') {
    console.log(JSON.stringify({ out, plannedTrials: jobs.length }))
    return
  }
  const results: Trial[] = []
  await runBenchmark(plugin, platformOptions, {
    executor: createProcessExecutor({
      modulePath: join(import.meta.dir, 'platform-plugin.ts'),
      config: pluginConfig,
      cwd: root,
    }),
    onTrial(native) {
      const row = legacyTrialFromRecord(native)
      results.push(row)
      appendFileSync(join(out, 'results.jsonl'), `${JSON.stringify(row)}\n`)
      console.log(
        `${results.length}/${jobs.length} ${row.model} ${row.variant} ${row.caseId} ${native.status} ${row.passed ? 'pass' : 'fail'}`,
      )
    },
  })
  writeFileSync(join(out, 'report.md'), renderReport(results, baseline.label, candidate.label))
  writeFileSync(
    join(out, 'review.jsonl'),
    blindReview(results)
      .map((r) => JSON.stringify(r))
      .join('\n'),
  )
  writeFileSync(
    join(out, 'review-key.json'),
    JSON.stringify(
      Object.fromEntries(
        results.map((r) => [hash(r.id).slice(0, 16), { variant: r.variant, trialId: r.id }]),
      ),
    ),
  )
  writeFileSync(
    join(out, 'completion.json'),
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        planned: jobs.length,
        completed: results.length,
        infrastructureErrors: results.filter((r) => r.status !== 'ok').length,
      },
      null,
      2,
    ),
  )
  console.log(`Report: ${join(out, 'report.md')}`)
  if (results.some((r) => r.status !== 'ok')) process.exitCode = 2
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
