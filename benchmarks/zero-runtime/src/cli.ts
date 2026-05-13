#!/usr/bin/env bun

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { selectCases } from './cases'
import { parseCliOptions } from './config'
import { writeMarkdownReport } from './report'
import { createPlan, runCaseForModel, writeJson } from './runtime'
import type { BenchmarkSummary } from './types'

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const cases = selectCases(options.cases)
  const plan = createPlan(cases, options.models)
  mkdirSync(options.outDir, { recursive: true })
  writeJson(join(options.outDir, 'plan.json'), {
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    command: options.command,
    config: {
      base: options.configPath,
      modelOverlay: options.modelConfigPath ?? null,
    },
    cases: cases.map((benchCase) => ({
      id: benchCase.id,
      title: benchCase.title,
      phase: benchCase.phase,
      category: benchCase.category,
      allowedTools: benchCase.allowedTools,
      tags: benchCase.tags ?? [],
    })),
    models: options.models,
    matrix: plan,
  })

  if (options.command === 'plan') {
    printPlan(options.outDir, plan)
    return
  }

  const results = []
  for (const benchCase of cases) {
    for (const model of options.models) {
      console.log(`[zero-runtime-bench] running case=${benchCase.id} model=${model.model}`)
      const result = await runCaseForModel(benchCase, model, options)
      results.push(result)
      console.log(
        `[zero-runtime-bench] ${result.validation.ok ? 'PASS' : 'FAIL'} case=${benchCase.id} model=${model.model} session=${result.sessionId ?? 'n/a'}`,
      )
    }
  }

  const summary: BenchmarkSummary = {
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    plan,
    results,
  }
  writeJson(join(options.outDir, 'summary.json'), summary)
  writeMarkdownReport(join(options.outDir, 'report.md'), summary)
  console.log(`[zero-runtime-bench] wrote ${options.outDir}`)
}

function printPlan(outDir: string, plan: ReturnType<typeof createPlan>): void {
  console.log(`[zero-runtime-bench] plan written to ${outDir}`)
  console.log('| case | phase | model |')
  console.log('| --- | --- | --- |')
  for (const entry of plan) {
    console.log(`| ${entry.caseId} | ${entry.phase} | ${entry.model} |`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
