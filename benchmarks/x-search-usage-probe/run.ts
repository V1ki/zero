#!/usr/bin/env bun

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Vault, getMasterKey } from '@zero-os/secrets'
import { XPremiumTokenManager } from '../../apps/server/src/x-premium-oauth'
import {
  getXPremiumBaseUrl,
  getXPremiumOAuthSessionRef,
} from '../../apps/server/src/x-premium-provider'
import {
  type ProbeRecord,
  buildXSearchProbePayload,
  parseProbeResponse,
  shouldStopAfterRecord,
  summarizeProbeRecords,
} from './probe'

interface CliOptions {
  maxRequests: number
  delayMs: number
  model: string
  query: string
  maxOutputTokens: number
  outputDir: string
  timeoutMs: number
  stopOnLimit: boolean
  dryRun: boolean
  enableImageUnderstanding: boolean
  enableVideoUnderstanding: boolean
}

interface Credential {
  authorization: string
  source: string
}

const args = process.argv.slice(2)
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const options: CliOptions = {
  maxRequests: readIntArg('max-requests', 10),
  delayMs: readIntArg('delay-ms', 30_000),
  model: readArg('model', 'grok-4.3'),
  query: readArg('query', 'X Premium Grok usage limits x_search'),
  maxOutputTokens: readIntArg('max-output-tokens', 120),
  outputDir: readArg(
    'out',
    join(process.cwd(), '.zero', 'benchmarks', 'x-search-usage-probe', runId),
  ),
  timeoutMs: readIntArg('timeout-ms', 180_000),
  stopOnLimit: !hasFlag('no-stop-on-limit'),
  dryRun: hasFlag('dry-run'),
  enableImageUnderstanding: hasFlag('image-understanding'),
  enableVideoUnderstanding: hasFlag('video-understanding'),
}

async function main() {
  validateOptions(options)
  await mkdir(options.outputDir, { recursive: true })

  const jsonlPath = join(options.outputDir, 'requests.jsonl')
  const summaryPath = join(options.outputDir, 'summary.json')
  const configPath = join(options.outputDir, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...options,
        outputDir: options.outputDir,
        startedAt,
      },
      null,
      2,
    ),
  )

  console.log('[x-search-usage-probe] starting')
  console.log(`[x-search-usage-probe] output: ${options.outputDir}`)
  console.log(
    `[x-search-usage-probe] model=${options.model} maxRequests=${options.maxRequests} delayMs=${options.delayMs} maxOutputTokens=${options.maxOutputTokens}`,
  )

  if (options.dryRun) {
    const payload = buildXSearchProbePayload(options, 1, new Date(startedAt))
    console.log(JSON.stringify({ dryRun: true, payload }, null, 2))
    await writeSummary([], summaryPath)
    return
  }

  const credential = await loadCredential()
  console.log(`[x-search-usage-probe] credentialSource=${credential.source}`)

  const records: ProbeRecord[] = []
  for (let index = 1; index <= options.maxRequests; index++) {
    const record = await runOne(index, credential)
    records.push(record)
    await appendJsonl(jsonlPath, record)
    await writeSummary(records, summaryPath)

    const usage = record.usage
    console.log(
      [
        `[x-search-usage-probe] #${index}`,
        `status=${record.status}`,
        `ok=${record.ok}`,
        `elapsedMs=${record.elapsedMs}`,
        `xSearchCalls=${usage?.xSearchCalls ?? 0}`,
        `tokens=${usage?.totalTokens ?? 0}`,
        typeof record.rateLimit?.remaining === 'number'
          ? `rateRemaining=${record.rateLimit.remaining}`
          : '',
        record.rateLimit?.resetAt ? `rateResetAt=${record.rateLimit.resetAt}` : '',
        record.limit?.isLimit ? `limit=${record.limit.reason ?? 'detected'}` : '',
        record.limit?.resetAt ? `resetAt=${record.limit.resetAt}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )

    if (shouldStopAfterRecord(record, options.stopOnLimit)) {
      console.log('[x-search-usage-probe] stopping after limit signal')
      break
    }

    if (index < options.maxRequests && options.delayMs > 0) {
      await sleep(options.delayMs)
    }
  }

  await writeSummary(records, summaryPath)
  console.log(`[x-search-usage-probe] summary: ${summaryPath}`)
}

async function runOne(index: number, credential: Credential): Promise<ProbeRecord> {
  const requestStartedAt = new Date()
  const payload = buildXSearchProbePayload(options, index, requestStartedAt)
  const response = await fetch(`${getXPremiumBaseUrl().replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: credential.authorization,
      'Content-Type': 'application/json',
      'User-Agent': 'Zero-OS/x-search-usage-probe',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  return parseProbeResponse(index, requestStartedAt.toISOString(), response, new Date())
}

async function loadCredential(): Promise<Credential> {
  const vault = new Vault(await getMasterKey(), join(process.cwd(), '.zero', 'secrets.enc'))
  vault.load()

  if (vault.get(getXPremiumOAuthSessionRef())?.trim()) {
    const session = await new XPremiumTokenManager(vault).ensureFreshSession()
    return {
      authorization: `${session.tokenType || 'Bearer'} ${session.accessToken}`,
      source: 'x-premium-oauth',
    }
  }

  const apiKey = vault.get('xai_api_key')?.trim()
  if (apiKey) {
    return {
      authorization: `Bearer ${apiKey}`,
      source: 'xai-api-key',
    }
  }

  throw new Error('No xAI credentials available. Run `bun zero provider login x-premium` first.')
}

async function writeSummary(records: ProbeRecord[], path: string) {
  await writeFile(path, JSON.stringify(summarizeProbeRecords(records, startedAt), null, 2))
}

async function appendJsonl(path: string, value: unknown) {
  await appendFile(path, `${JSON.stringify(value)}\n`)
}

function readArg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function readIntArg(name: string, fallback: number): number {
  const raw = readArg(name, String(fallback))
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

function validateOptions(value: CliOptions) {
  if (value.maxRequests < 1) throw new Error('--max-requests must be >= 1')
  if (value.delayMs < 0) throw new Error('--delay-ms must be >= 0')
  if (value.maxOutputTokens < 16) throw new Error('--max-output-tokens must be >= 16')
  if (value.timeoutMs < 1_000) throw new Error('--timeout-ms must be >= 1000')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

await main()
