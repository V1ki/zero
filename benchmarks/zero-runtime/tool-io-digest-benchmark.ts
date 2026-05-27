#!/usr/bin/env bun

import {
  parseToolIoDigestBenchmarkArgs,
  renderToolIoDigestMarkdown,
  runToolIoDigestBenchmark,
} from './src/tool-io-digest-benchmark'

async function main() {
  const options = parseToolIoDigestBenchmarkArgs(process.argv.slice(2))
  const report = await runToolIoDigestBenchmark(options)
  console.log(renderToolIoDigestMarkdown(report))
  console.log(`[tool-io-digest] wrote ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
