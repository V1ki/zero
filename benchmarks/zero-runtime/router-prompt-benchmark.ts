#!/usr/bin/env bun

import { main } from './src/router-prompt-bench/cli'

main().catch((error: unknown) => {
  // Setup errors only; per-trial provider errors are recorded without their raw text.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
