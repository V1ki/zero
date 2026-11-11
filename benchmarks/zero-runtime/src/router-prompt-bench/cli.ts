import { join, resolve } from 'node:path'
import { resolveRuntime } from '../prompt-bench/engine'
import { CASES, JUDGEMENT_LABELS, estimateModelCalls } from './cases'
import { DRY_RUN_MODEL, scriptedAdapter } from './dry-run'
import {
  type BenchOptions,
  type BenchRuntime,
  runRouterPromptBenchmark,
  selectCases,
} from './runner'
import { JUDGEMENTS, type Judgement } from './types'

export interface CliOptions extends BenchOptions {
  model?: string
  dryRun: boolean
  secretSource: 'vault' | 'env'
  config: string
  catalog: string
}

export const HELP = `Usage: bun run router:prompt-bench --model provider/model [options]
       bun run router:prompt-bench --dry-run [options]

Runs the shipped Router judgements (write check, triage, job report, GitHub investigation) on the
labelled cases in benchmarks/zero-runtime/src/router-prompt-bench/ and writes report.md,
review.md, results.jsonl, summary.json and manifest.json.

Options:
  --model <provider/model>   exact configured model, never a pool or route (required unless --dry-run)
  --reps <n>                 repetitions per case (default 3)
  --concurrency <n>          trials in flight (default 3)
  --out <dir>                output directory (default .zero/benchmarks/router-prompt-bench/<time>)
  --only <list>              judgements: ${JUDGEMENTS.join(',')}
  --cases <ids>              comma-separated case ids
  --secret-source <vault|env>  where the provider credential is read (default vault)
  --config <file>            ZeRo config (default .zero/config.yaml)
  --catalog <file>           model catalog (default .zero/cache/model-catalog/catalog.json)
  --dry-run                  scripted answers, no provider and no credentials
  --resume                   reuse finished trials in --out and retry the rest
`

function positive(value: string | undefined, name: string, max: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`Invalid ${name}`)
  return parsed
}

export function parseRouterPromptBenchArgs(argv: string[], now = new Date()): CliOptions | null {
  const options: CliOptions = {
    outDir: '',
    reps: 3,
    concurrency: 3,
    judgements: [...JUDGEMENTS],
    resume: false,
    dryRun: false,
    secretSource: 'vault',
    config: resolve('.zero/config.yaml'),
    catalog: resolve('.zero/cache/model-catalog/catalog.json'),
  }
  let out: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') return null
    if (arg === '--model') options.model = value()
    else if (arg === '--reps') options.reps = positive(value(), arg, 20)
    else if (arg === '--concurrency') options.concurrency = positive(value(), arg, 12)
    else if (arg === '--out') out = value()
    else if (arg === '--only') {
      const list = value().split(',')
      if (list.some((item) => !JUDGEMENTS.includes(item as Judgement)))
        throw new Error(`--only accepts ${JUDGEMENTS.join(',')}`)
      options.judgements = list as Judgement[]
    } else if (arg === '--cases') options.caseIds = value().split(',')
    else if (arg === '--secret-source') {
      const source = value()
      if (source !== 'vault' && source !== 'env') throw new Error('--secret-source is vault or env')
      options.secretSource = source
    } else if (arg === '--config') options.config = resolve(value())
    else if (arg === '--catalog') options.catalog = resolve(value())
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--resume') options.resume = true
    else throw new Error(`Unknown option ${arg}`)
  }
  if (!options.dryRun && !options.model) throw new Error('--model provider/model is required')
  if (options.resume && !out) throw new Error('--resume needs the --out of the earlier run')
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  options.outDir = resolve(
    out ??
      join(
        '.zero',
        'benchmarks',
        'router-prompt-bench',
        `${stamp}${options.dryRun ? '-dry-run' : ''}`,
      ),
  )
  return options
}

export async function createRuntime(options: CliOptions): Promise<BenchRuntime> {
  if (options.dryRun)
    return {
      dryRun: true,
      model: DRY_RUN_MODEL,
      adapterFor: scriptedAdapter,
      filter: (text) => text,
    }
  const model = options.model as string
  // Same exact-model and credential resolution as `prompt:bench`. reasoning, maxTokens and
  // maxSteps only satisfy its settings type: the shipped Router code sets its own per request.
  const runtime = await resolveRuntime(
    {
      root: process.cwd(),
      config: options.config,
      catalog: options.catalog,
      secretSource: options.secretSource,
      model,
      reasoning: 'low',
      maxTokens: 2048,
      maxSteps: 6,
    },
    true,
  )
  return {
    dryRun: false,
    model,
    modelId: runtime.modelId,
    modelFingerprint: runtime.fingerprint,
    adapterFor: () => runtime.adapter,
    filter: runtime.filter,
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseRouterPromptBenchArgs(argv)
  if (!options) {
    console.log(HELP)
    return
  }
  const sets = selectCases(CASES, options.judgements, options.caseIds)
  const estimate = estimateModelCalls(sets, options.reps)
  console.log(
    options.dryRun
      ? '[router-prompt] 演练模式：不调用任何模型，回答来自脚本。'
      : `[router-prompt] 模型 ${options.model}，预计模型调用 ${estimate.min}–${estimate.max} 次（通常约 ${estimate.typical} 次）。`,
  )
  const runtime = await createRuntime(options)
  const { summary } = await runRouterPromptBenchmark(options, runtime)
  for (const judgement of JUDGEMENTS) {
    const s = summary[judgement]
    if (!s.cases) continue
    console.log(
      `[router-prompt] ${JUDGEMENT_LABELS[judgement]}：通过 ${s.passed}/${s.graded}，危险错误 ${s.dangerous}，未评分 ${s.errors}`,
    )
  }
  if (options.dryRun)
    console.log('[router-prompt] 演练结束：没有调用任何模型，以上数字不代表模型表现。')
  console.log(`[router-prompt] 报告：${join(options.outDir, 'report.md')}`)
  if (JUDGEMENTS.some((judgement) => summary[judgement].errors)) process.exitCode = 2
}
