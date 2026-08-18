#!/usr/bin/env bun

import {
  analyzeLogStorage,
  parseLogStorageAuditArgs,
  renderLogStorageAudit,
  renderLogStorageAuditHelp,
  renderLogStorageAuditJson,
} from './src/log-storage-audit'

async function main(): Promise<void> {
  const options = parseLogStorageAuditArgs(process.argv.slice(2))
  if (options.help) {
    console.log(renderLogStorageAuditHelp())
    return
  }

  let lastProgressAt = 0
  let progressShown = false
  const report = await analyzeLogStorage({
    ...options,
    onProgress: process.stderr.isTTY
      ? (progress) => {
          const currentTime = Date.now()
          if (
            currentTime - lastProgressAt < 250 &&
            progress.completedFiles < progress.selectedFiles
          ) {
            return
          }
          lastProgressAt = currentTime
          progressShown = true
          const percent =
            progress.discoveredSelectedBytes > 0
              ? Math.min(100, (progress.analyzedBytes / progress.discoveredSelectedBytes) * 100)
              : 100
          process.stderr.write(
            `\rScanning ${progress.completedFiles}/${progress.selectedFiles} files, ${percent.toFixed(1)}%`.padEnd(
              72,
            ),
          )
        }
      : undefined,
  })
  if (progressShown) process.stderr.write('\n')
  console.log(
    options.format === 'json'
      ? renderLogStorageAuditJson(report)
      : renderLogStorageAudit(report, options.top),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
