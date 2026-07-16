#!/usr/bin/env bun

import {
  parseCompactionHarnessEvalArgs,
  renderCompactionHarnessEvalMarkdown,
  runCompactionHarnessEval,
} from './src/compaction-harness-eval'

async function main() {
  const options = parseCompactionHarnessEvalArgs(process.argv.slice(2))
  const report = await runCompactionHarnessEval(options)
  console.log(renderCompactionHarnessEvalMarkdown(report))
  console.log(`[compaction-harness] wrote ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
