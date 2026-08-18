import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toErrorMessage } from '@zero-os/shared'
import { clearRestartTriggerIfMatch, writeRestartTrigger } from '../system/restart-trigger'
import { rebuildWebBundle } from '../system/runtime'

interface RestartHeartbeat {
  pid: number
  bootId?: string
  sequence?: number
  timestamp?: string
  uptime?: number
}

const RESTART_HEARTBEAT_WAIT_MS = 10_000
const RESTART_HEARTBEAT_POLL_MS = 250
const RESTART_HEARTBEAT_FRESHNESS_MS = 10_000

type RestartHeartbeatUpdate =
  | { status: 'ready'; heartbeat: RestartHeartbeat }
  | { status: 'handoff'; heartbeat: RestartHeartbeat }
  | { status: 'unavailable'; heartbeat?: RestartHeartbeat }

export async function runRestartCommand(options: {
  zeroDir: string
  gracePeriodSeconds: number
}): Promise<void> {
  const heartbeatPath = join(options.zeroDir, 'heartbeat.json')
  if (!existsSync(heartbeatPath)) {
    console.error('[ZeRo OS] No heartbeat file found. Is the server running?')
    process.exit(1)
  }

  try {
    const data = readRestartHeartbeat(heartbeatPath)

    if (typeof data.uptime === 'number' && data.uptime < options.gracePeriodSeconds) {
      console.error(
        `[ZeRo OS] Refusing restart: process just started and is still in the startup grace period (${data.uptime.toFixed(1)}s < ${options.gracePeriodSeconds}s).`,
      )
      process.exit(1)
    }

    console.log('[ZeRo OS] Rebuilding web UI before restart...')
    const build = rebuildWebBundle()
    if (!build.ok) {
      console.error('[ZeRo OS] Web rebuild failed:', build.error)
      process.exit(1)
    }

    const heartbeatUpdate = await waitForRestartHeartbeatUpdate({
      baseline: data,
      readHeartbeat: () => readRestartHeartbeat(heartbeatPath),
    })
    if (heartbeatUpdate.status === 'handoff') {
      const latest = heartbeatUpdate.heartbeat
      console.log(
        `[ZeRo OS] Server changed during web rebuild (PID ${data.pid} → ${latest.pid}); restart already handed off.`,
      )
      return
    }
    if (heartbeatUpdate.status === 'unavailable') {
      throw new Error(
        `refusing restart: PID ${data.pid} did not publish a fresh heartbeat after the web rebuild`,
      )
    }

    const trigger = writeRestartTrigger(options.zeroDir, {
      source: 'cli',
      sessionId: process.env.ZERO_SESSION_ID,
      channelName: process.env.ZERO_CHANNEL_NAME,
      channelId: process.env.ZERO_CHANNEL_ID,
    })
    try {
      const signalResult = signalRestartTarget(heartbeatUpdate.heartbeat.pid)
      if (signalResult === 'already_exited') {
        clearRestartTriggerIfMatch(options.zeroDir, trigger.id)
        console.log(
          `[ZeRo OS] PID ${data.pid} already exited during restart; supervisor handoff will continue.`,
        )
        return
      }
    } catch (error) {
      clearRestartTriggerIfMatch(options.zeroDir, trigger.id)
      throw error
    }
    console.log(
      `[ZeRo OS] Sent SIGTERM to PID ${heartbeatUpdate.heartbeat.pid}. Supervisor will restart the process.`,
    )
  } catch (err) {
    console.error('[ZeRo OS] Failed to restart:', toErrorMessage(err))
    process.exit(1)
  }
}

export function signalRestartTarget(
  pid: number,
  signal: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
): 'signaled' | 'already_exited' {
  try {
    signal(pid, 'SIGTERM')
    return 'signaled'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return 'already_exited'
    }
    throw error
  }
}

export function isSameHeartbeatOwner(
  expected: Pick<RestartHeartbeat, 'pid' | 'bootId'>,
  actual: Pick<RestartHeartbeat, 'pid' | 'bootId'>,
): boolean {
  if (expected.pid !== actual.pid) return false
  if (expected.bootId === undefined && actual.bootId === undefined) return true
  return expected.bootId !== undefined && expected.bootId === actual.bootId
}

export function classifyRestartHeartbeatUpdate(
  baseline: RestartHeartbeat,
  heartbeat: RestartHeartbeat,
  options: { nowMs: number; freshnessMs: number },
): 'ready' | 'handoff' | 'waiting' {
  if (!isSameHeartbeatOwner(baseline, heartbeat)) return 'handoff'

  const timestampMs = parseHeartbeatTimestamp(heartbeat.timestamp)
  const ageMs = timestampMs === undefined ? undefined : options.nowMs - timestampMs
  const fresh = ageMs !== undefined && ageMs >= 0 && ageMs <= Math.max(0, options.freshnessMs)
  if (!fresh) return 'waiting'

  const sequenceAdvanced =
    typeof baseline.sequence === 'number' &&
    Number.isFinite(baseline.sequence) &&
    typeof heartbeat.sequence === 'number' &&
    Number.isFinite(heartbeat.sequence) &&
    heartbeat.sequence > baseline.sequence
  const baselineTimestampMs = parseHeartbeatTimestamp(baseline.timestamp)
  const timestampAdvanced =
    baselineTimestampMs !== undefined &&
    timestampMs !== undefined &&
    timestampMs > baselineTimestampMs

  return sequenceAdvanced || timestampAdvanced ? 'ready' : 'waiting'
}

export async function waitForRestartHeartbeatUpdate(options: {
  baseline: RestartHeartbeat
  readHeartbeat: () => RestartHeartbeat
  now?: () => number
  wait?: (delayMs: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
  freshnessMs?: number
}): Promise<RestartHeartbeatUpdate> {
  const now = options.now ?? Date.now
  const wait =
    options.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const timeoutMs = Math.max(0, options.timeoutMs ?? RESTART_HEARTBEAT_WAIT_MS)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? RESTART_HEARTBEAT_POLL_MS)
  const freshnessMs = Math.max(0, options.freshnessMs ?? RESTART_HEARTBEAT_FRESHNESS_MS)
  const deadline = now() + timeoutMs
  let lastHeartbeat: RestartHeartbeat | undefined

  while (true) {
    try {
      lastHeartbeat = options.readHeartbeat()
      const status = classifyRestartHeartbeatUpdate(options.baseline, lastHeartbeat, {
        nowMs: now(),
        freshnessMs,
      })
      if (status !== 'waiting') {
        return { status, heartbeat: lastHeartbeat }
      }
    } catch {
      // A concurrent atomic heartbeat replacement can briefly make the file unreadable.
      // A bounded retry is safer than signaling from the old snapshot.
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      return { status: 'unavailable', heartbeat: lastHeartbeat }
    }
    await wait(Math.min(pollIntervalMs, remainingMs))
  }
}

function parseHeartbeatTimestamp(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readRestartHeartbeat(heartbeatPath: string): RestartHeartbeat {
  const data = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as Partial<RestartHeartbeat>
  if (!Number.isInteger(data.pid) || !data.pid || data.pid <= 0) {
    throw new Error('heartbeat does not contain a valid server PID')
  }
  return data as RestartHeartbeat
}
