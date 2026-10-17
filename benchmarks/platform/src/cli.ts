import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type LegacyFormat, importLegacy, legacyFormats } from './adapters/legacy'
import { compare, exportRecords } from './report'
import { plan, runBenchmark } from './runner'
import type { BenchmarkPlugin, RunOptions, TrialRecord } from './types'

function parse(argv: string[]) {
  const options = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--') || options.has(key))
      throw new Error('Expected distinct --option value pairs')
    options.set(key, argv[i + 1])
  }
  return options
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  if (!command || command === 'help') {
    console.log(
      'ZeRo benchmark platform\nplan --plugin FILE --out NEW_FILE\nrun --plugin FILE --out NEW_DIR [--reps 3 --seed zero-v1 --timeout-ms 60000 --model-calls 100 --tool-calls 100]\nimport --format prompt|runtime|compaction --input FILE --out NEW_DIR\nreport --input results.jsonl --out NEW_DIR\ncompare --input results.jsonl --baseline ID --candidate ID --out NEW_FILE\nPlugins are trusted local modules. plan imports metadata only; plugins must have no top-level side effects.',
    )
    return
  }
  const allowed: Record<string, string[]> = {
    plan: [
      '--plugin',
      '--out',
      '--reps',
      '--seed',
      '--timeout-ms',
      '--model-calls',
      '--tool-calls',
    ],
    run: ['--plugin', '--out', '--reps', '--seed', '--timeout-ms', '--model-calls', '--tool-calls'],
    import: ['--format', '--input', '--out'],
    report: ['--input', '--out'],
    compare: ['--input', '--baseline', '--candidate', '--out'],
  }
  if (!allowed[command]) throw new Error('Unknown command')
  const args = parse(rest)
  for (const key of args.keys())
    if (!allowed[command].includes(key)) throw new Error(`Unknown option ${key}`)
  const required = (key: string) => {
    const value = args.get(key)
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const out = resolve(required('--out'))
  if (command === 'run' || command === 'plan') {
    const module = await import(pathToFileURL(resolve(required('--plugin'))).href)
    const plugin: BenchmarkPlugin = module.default
    const options: RunOptions = {
      out,
      reps: Number(args.get('--reps') ?? 3),
      seed: args.get('--seed') ?? 'zero-v1',
      limits: {
        timeoutMs: Number(args.get('--timeout-ms') ?? 60000),
        maxModelCalls: Number(args.get('--model-calls') ?? 100),
        maxToolCalls: Number(args.get('--tool-calls') ?? 100),
      },
    }
    if (command === 'plan') {
      const jobs = plan(plugin, options)
      // The output is an exclusive file for plan, a directory for run.
      writeFileSync(out, JSON.stringify({ plugin: plugin.id, options, jobs }, null, 2), {
        flag: 'wx',
      })
    } else await runBenchmark(plugin, options)
  } else if (command === 'import') {
    const format = required('--format')
    if (!legacyFormats.includes(format as LegacyFormat)) throw new Error('Unknown legacy format')
    exportRecords(out, importLegacy(format as LegacyFormat, resolve(required('--input'))))
  } else {
    const rows = readFileSync(resolve(required('--input')), 'utf8')
      .split('\n')
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as TrialRecord)
    if (command === 'report') exportRecords(out, rows)
    else
      writeFileSync(
        out,
        JSON.stringify(compare(rows, required('--baseline'), required('--candidate')), null, 2),
        { flag: 'wx' },
      )
  }
  console.log(`Benchmark output: ${out}`)
}

if (import.meta.main)
  main().catch(() => {
    // File/provider errors may contain raw data; do not publish them to shared logs.
    console.error(
      'Benchmark command failed. Check options, plugin contract and local event records.',
    )
    process.exitCode = 1
  })
