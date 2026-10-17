import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginIdentity } from './process-executor'
import { runTrial } from './runner'
import type { BenchmarkPlugin, Limits, TrialJob } from './types'

export async function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8')) as {
    modulePath: string
    config: unknown
    identity: string
    job: TrialJob
    workspace: string
    limits: Limits
  }
  const module = await import(pathToFileURL(payload.modulePath).href)
  const plugin: BenchmarkPlugin =
    typeof module.default === 'function' ? await module.default(payload.config) : module.default
  if (pluginIdentity(plugin) !== payload.identity) throw new Error('Plugin changed after planning')
  const row = await runTrial(plugin, payload.job, payload.workspace, payload.limits)
  const temp = join(payload.workspace, 'worker-result.pending')
  writeFileSync(temp, JSON.stringify(row), { flag: 'wx' })
  renameSync(temp, join(payload.workspace, 'worker-result.json'))
}

if (import.meta.main)
  main().catch(() => {
    process.exitCode = 1
  })
