#!/usr/bin/env bun

import {
  parseTaskClosurePromptBenchmarkArgs,
  renderTaskClosurePromptBenchmarkMarkdown,
  runTaskClosurePromptBenchmark,
} from './src/task-closure-prompt-benchmark'

async function main() {
  const options = parseTaskClosurePromptBenchmarkArgs(process.argv.slice(2))
  const report = await runTaskClosurePromptBenchmark(options)
  console.log(renderTaskClosurePromptBenchmarkMarkdown(report))
  console.log(`[task-closure-prompt] wrote ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
