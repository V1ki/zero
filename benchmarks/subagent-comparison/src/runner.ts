import { createBenchmarkHarness } from './harness'
import { printSummary, reportProgress, writeReports } from './reporter'
import { scenarios, scenariosByName } from './scenarios'

export const DEFAULT_MODELS = ['claude-opus-4-6', 'chatgpt/gpt-5.4']

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const selectedScenarios = resolveScenarios(args.scenarios)
  const totalRuns = args.models.length * selectedScenarios.length * 2 * args.runs
  const results = []

  const harness = await createBenchmarkHarness()

  try {
    let current = 0

    for (const model of args.models) {
      for (const scenario of selectedScenarios) {
        for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
          const legacyCtx = harness.buildToolContext(model)
          const legacyResult = await scenario.runLegacy(legacyCtx, harness.taskTool, runIndex)
          current += 1
          results.push(legacyResult)
          reportProgress(legacyResult, { current, total: totalRuns })

          const asyncCtx = harness.buildToolContext(model)
          const asyncResult = await scenario.runAsync(
            asyncCtx,
            {
              spawn: harness.spawnTool,
              wait: harness.waitTool,
              close: harness.closeTool,
              sendInput: harness.sendInputTool,
            },
            runIndex,
          )
          current += 1
          results.push(asyncResult)
          reportProgress(asyncResult, { current, total: totalRuns })
        }
      }
    }
  } finally {
    harness.cleanup()
  }

  const summary = printSummary(results)
  const artifacts = writeReports(results, {
    models: args.models,
    scenarios: selectedScenarios.map((scenario) => scenario.name),
    runs: args.runs,
  })

  console.log(`Saved raw results to ${artifacts.jsonPath}`)
  console.log(`Saved markdown summary to ${artifacts.markdownPath}`)
  console.log(`Generated ${summary.length} summary row(s).`)
}

export function parseArgs(argv: string[]): {
  models: string[]
  scenarios: string
  runs: number
} {
  let models = [...DEFAULT_MODELS]
  let scenarioArg = 'all'
  let runs = 1

  for (const arg of argv) {
    if (arg.startsWith('--models=')) {
      models = splitCsv(arg.slice('--models='.length))
      continue
    }

    if (arg.startsWith('--scenarios=')) {
      scenarioArg = arg.slice('--scenarios='.length)
      continue
    }

    if (arg.startsWith('--runs=')) {
      const parsed = Number.parseInt(arg.slice('--runs='.length), 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --runs value: ${arg}`)
      }
      runs = parsed
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (models.length === 0) {
    throw new Error('At least one model must be provided.')
  }

  return { models, scenarios: scenarioArg, runs }
}

export function resolveScenarios(scenarioArg: string) {
  if (scenarioArg === 'all') {
    return scenarios
  }

  const selected = splitCsv(scenarioArg).map((name) => {
    const scenario = scenariosByName.get(name)
    if (!scenario) {
      throw new Error(
        `Unknown scenario "${name}". Available scenarios: ${scenarios.map((item) => item.name).join(', ')}`,
      )
    }
    return scenario
  })

  if (selected.length === 0) {
    throw new Error('At least one scenario must be selected.')
  }

  return selected
}

export function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

if (import.meta.main) {
  await main()
}
