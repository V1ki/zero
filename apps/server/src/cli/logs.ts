import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const LOGS_USAGE = 'Usage: bun zero logs [supervisor|error|all] [--lines <n>] [--follow]'

export class LogsUsageError extends Error {
  constructor() {
    super(LOGS_USAGE)
    this.name = 'LogsUsageError'
  }
}

export interface LogsRequest {
  follow: boolean
  lines: number
  logFiles: string[]
}

export async function runLogsCommand(options: {
  zeroDir: string
  args: string[]
}): Promise<void> {
  const request = getLogsRequest(options)

  const existingFiles = request.logFiles.filter((file) => existsSync(file))

  if (existingFiles.length === 0) {
    console.log('[ZeRo OS] No supervisor log files found yet.')
    for (const file of request.logFiles) {
      console.log(`  - ${file}`)
    }
    return
  }

  const tailArgs = ['-n', String(request.lines), ...existingFiles]

  if (request.follow) {
    console.log(`[ZeRo OS] Following ${existingFiles.length} log file(s)...`)
    const proc = Bun.spawn(['tail', '-f', ...tailArgs], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    })
    await proc.exited
    return
  }

  const result = spawnSync('tail', tailArgs, {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    console.error('[ZeRo OS] Failed to read logs.')
    process.exit(result.status ?? 1)
  }
}

export function resolveLogsRequest(options: { zeroDir: string; args: string[] }): LogsRequest {
  const follow = options.args.includes('--follow') || options.args.includes('-f')
  const lines = resolveLogsLineCount(options.args)
  const target = options.args.find((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg)) ?? 'all'

  return {
    follow,
    lines,
    logFiles: resolveLogFiles(options.zeroDir, target),
  }
}

function getLogsRequest(options: { zeroDir: string; args: string[] }) {
  try {
    return resolveLogsRequest(options)
  } catch (error) {
    if (!(error instanceof LogsUsageError)) throw error
    console.error(LOGS_USAGE)
    process.exit(1)
  }
}

function resolveLogsLineCount(args: string[]) {
  const lineFlagIndex = args.findIndex((arg) => arg === '--lines' || arg === '-n')
  if (lineFlagIndex === -1) return 100

  const rawValue = args[lineFlagIndex + 1]
  const parsedValue = Number(rawValue)
  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new LogsUsageError()
  }

  return parsedValue
}

function resolveLogFiles(zeroDir: string, target: string) {
  const stdoutPath = join(zeroDir, 'logs', 'supervisor.log')
  const stderrPath = join(zeroDir, 'logs', 'supervisor.error.log')

  switch (target) {
    case 'supervisor':
    case 'out':
      return [stdoutPath]
    case 'error':
    case 'err':
      return [stderrPath]
    case 'all':
      return [stdoutPath, stderrPath]
    default:
      throw new LogsUsageError()
  }
}
