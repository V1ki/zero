#!/usr/bin/env bun

import {
  parsePromptBenchmarkArgs,
  renderPromptBenchmarkMarkdown,
  runPromptBenchmark,
} from './src/compaction-prompt-benchmark'

async function main() {
  const options = parsePromptBenchmarkArgs(process.argv.slice(2))
  const report = await runPromptBenchmark(options)
  console.log(renderPromptBenchmarkMarkdown(report))
  console.log(`[compaction-prompt] wrote ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
