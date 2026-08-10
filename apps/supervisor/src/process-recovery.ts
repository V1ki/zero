import { spawnSync } from 'node:child_process'
import type { HeartbeatCheckResult, HeartbeatChecker } from '@zero-os/supervisor'

type ProcessSignal = 0 | NodeJS.Signals

export interface ProcessRecoveryControl {
  signal(pid: number, signal: ProcessSignal): boolean
  fingerprint(pid: number): string | undefined
  now(): number
  sleep(ms: number): Promise<void>
}

export type StaleOwnerTerminationResult =
  | 'not_running'
  | 'terminated'
  | 'recovered'
  | 'identity_changed'

export interface SpawnedReplacementProcess {
  readonly pid: number
  readonly exited: Promise<number>
  readonly killed: boolean
  kill(signal?: NodeJS.Signals | number): void
}

const defaultProcessControl: ProcessRecoveryControl = {
  signal: (pid, signal) => process.kill(pid, signal),
  fingerprint: readProcessFingerprint,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export async function terminateStaleHeartbeatOwner(options: {
  checker: HeartbeatChecker
  staleResult: HeartbeatCheckResult
  gracefulWaitMs?: number
  forceWaitMs?: number
  pollIntervalMs?: number
  control?: ProcessRecoveryControl
}): Promise<StaleOwnerTerminationResult> {
  const pid = options.staleResult.pid
  if (!Number.isInteger(pid) || !pid || pid <= 0) return 'not_running'
  if (pid === process.pid) {
    throw new Error('Supervisor refused to terminate itself as a stale server owner')
  }

  const latest = options.checker.check()
  if (!isSameHeartbeatOwner(options.staleResult, latest)) return 'identity_changed'
  const readinessLeaseStillExpired =
    options.staleResult.alive &&
    options.staleResult.ready === false &&
    latest.ready !== true &&
    latest.stage !== 'shutting_down'
  if (latest.alive && !readinessLeaseStillExpired) return 'recovered'

  const control = options.control ?? defaultProcessControl
  if (!isProcessRunning(pid, control)) return 'not_running'

  const expectedFingerprint = control.fingerprint(pid)
  if (!expectedFingerprint) {
    return isProcessRunning(pid, control) ? 'identity_changed' : 'not_running'
  }

  const termSignal = signalIfIdentityMatches(pid, 'SIGTERM', expectedFingerprint, control)
  if (termSignal !== 'signaled') return termSignal
  const gracefulExit = await waitUntilProcessStops({
    pid,
    expectedFingerprint,
    timeoutMs: options.gracefulWaitMs ?? 45_000,
    pollIntervalMs: options.pollIntervalMs ?? 250,
    control,
  })
  if (gracefulExit === 'stopped') return 'terminated'
  if (gracefulExit === 'identity_changed') return 'identity_changed'

  const killSignal = signalIfIdentityMatches(pid, 'SIGKILL', expectedFingerprint, control)
  if (killSignal === 'not_running') return 'terminated'
  if (killSignal === 'identity_changed') return 'identity_changed'
  const forcedExit = await waitUntilProcessStops({
    pid,
    expectedFingerprint,
    timeoutMs: options.forceWaitMs ?? 5_000,
    pollIntervalMs: options.pollIntervalMs ?? 250,
    control,
  })
  if (forcedExit === 'identity_changed') return 'identity_changed'
  if (forcedExit === 'timed_out') {
    throw new Error(`Stale server PID ${pid} did not exit after SIGKILL`)
  }
  return 'terminated'
}

export function isSameHeartbeatOwner(
  expected: Pick<HeartbeatCheckResult, 'pid' | 'bootId'>,
  actual: Pick<HeartbeatCheckResult, 'pid' | 'bootId'>,
): boolean {
  if (expected.pid !== actual.pid) return false
  if (expected.bootId === undefined && actual.bootId === undefined) return true
  return expected.bootId !== undefined && expected.bootId === actual.bootId
}

const VERIFY_PROGRESS_WINDOW_MS = 120_000
const VERIFY_MAX_WAIT_MS = 300_000
const VERIFY_POLL_INTERVAL_MS = 1_000

export async function verifySpawnedReplacement(options: {
  checker: HeartbeatChecker
  child: SpawnedReplacementProcess
  bootId: string
  notBefore: number
  timeoutMs?: number
  maxTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  if (options.child.killed) return false

  // A slow boot is not a failed boot: while the child keeps publishing fresh
  // heartbeat progress (advancing sequence/stage), the readiness deadline
  // keeps moving. It only fails after a full window without progress, or when
  // the hard cap is reached.
  const progressWindowMs = options.timeoutMs ?? VERIFY_PROGRESS_WINDOW_MS
  const maxWaitMs = Math.max(progressWindowMs, options.maxTimeoutMs ?? VERIFY_MAX_WAIT_MS)
  const pollIntervalMs = options.pollIntervalMs ?? VERIFY_POLL_INTERVAL_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let childExitCode: number | undefined
  void options.child.exited.then((exitCode) => {
    childExitCode = exitCode
  })

  const hardDeadline = Date.now() + maxWaitMs
  let progressDeadline = Date.now() + progressWindowMs
  let lastProgressMarker: string | undefined

  while (Date.now() < hardDeadline) {
    if (options.child.killed || childExitCode !== undefined) return false

    const result = options.checker.check()
    const matchesChild = result.pid === options.child.pid && result.bootId === options.bootId
    const isRecentEnough = result.lastBeat !== undefined && result.lastBeat.getTime() >= options.notBefore

    if (matchesChild) {
      if (result.alive && result.ready && isRecentEnough) return true

      const progressMarker = `${result.sequence ?? ''}:${result.stage ?? ''}`
      if (progressMarker !== lastProgressMarker) {
        lastProgressMarker = progressMarker
        progressDeadline = Date.now() + progressWindowMs
      }
    }

    if (Date.now() >= progressDeadline) return false
    await sleep(Math.min(pollIntervalMs, Math.max(1, hardDeadline - Date.now())))
  }

  return false
}

export async function stopUnreadyReplacement(options: {
  child: SpawnedReplacementProcess
  gracefulWaitMs?: number
  forceWaitMs?: number
}): Promise<void> {
  if (!options.child.killed) {
    options.child.kill('SIGTERM')
  }
  const exited = await waitForSpawnedProcessExit(options.child, options.gracefulWaitMs ?? 5_000)
  if (exited) return

  options.child.kill('SIGKILL')
  const forcedExit = await waitForSpawnedProcessExit(options.child, options.forceWaitMs ?? 5_000)
  if (!forcedExit) {
    throw new Error(`Unready replacement PID ${options.child.pid} did not exit after SIGKILL`)
  }
}

function waitForSpawnedProcessExit(
  child: SpawnedReplacementProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void child.exited.then(() => finish(true))
  })
}

function isProcessRunning(pid: number, control: ProcessRecoveryControl): boolean {
  try {
    control.signal(pid, 0)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false
    if (hasErrorCode(error, 'EPERM')) return true
    throw error
  }
}

type ProcessIdentityState = 'same' | 'not_running' | 'identity_changed'
type ProcessSignalResult = 'signaled' | 'not_running' | 'identity_changed'
type ProcessWaitResult = 'stopped' | 'timed_out' | 'identity_changed'

function signalIfIdentityMatches(
  pid: number,
  signal: NodeJS.Signals,
  expectedFingerprint: string,
  control: ProcessRecoveryControl,
): ProcessSignalResult {
  const identity = inspectProcessIdentity(pid, expectedFingerprint, control)
  if (identity === 'not_running') return 'not_running'
  if (identity === 'identity_changed') return 'identity_changed'

  try {
    control.signal(pid, signal)
    return 'signaled'
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return 'not_running'
    throw error
  }
}

async function waitUntilProcessStops(options: {
  pid: number
  expectedFingerprint: string
  timeoutMs: number
  pollIntervalMs: number
  control: ProcessRecoveryControl
}): Promise<ProcessWaitResult> {
  const deadline = options.control.now() + options.timeoutMs
  while (options.control.now() < deadline) {
    const identity = inspectProcessIdentity(
      options.pid,
      options.expectedFingerprint,
      options.control,
    )
    if (identity === 'not_running') return 'stopped'
    if (identity === 'identity_changed') return 'identity_changed'
    await options.control.sleep(options.pollIntervalMs)
  }

  const identity = inspectProcessIdentity(options.pid, options.expectedFingerprint, options.control)
  if (identity === 'not_running') return 'stopped'
  if (identity === 'identity_changed') return 'identity_changed'
  return 'timed_out'
}

function inspectProcessIdentity(
  pid: number,
  expectedFingerprint: string,
  control: ProcessRecoveryControl,
): ProcessIdentityState {
  const fingerprint = control.fingerprint(pid)
  if (fingerprint === expectedFingerprint) return 'same'
  if (fingerprint !== undefined) return 'identity_changed'
  return isProcessRunning(pid, control) ? 'identity_changed' : 'not_running'
}

function readProcessFingerprint(pid: number): string | undefined {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return undefined

  const fingerprint = result.stdout.trim()
  return fingerprint || undefined
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
