#!/usr/bin/env bun

import {
  parseCompactionQualityArgs,
  renderCompactionQualityMarkdown,
  runCompactionQualityEval,
} from './src/compaction-quality'

async function main() {
  const options = parseCompactionQualityArgs(process.argv.slice(2))
  const report = await runCompactionQualityEval(options)
  console.log(renderCompactionQualityMarkdown(report))
  console.log(`[compaction-quality] wrote ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
