import { randomUUID } from 'node:crypto'
import {
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export interface RestartTrigger {
  source: string
  sessionId?: string
  channelName?: string
  channelId?: string
}

interface RestartTriggerFile extends RestartTrigger {
  id: string
  ts: string
}

const RESTART_TRIGGER_FILE = 'restart-trigger.json'
const RESTART_TRIGGER_ARTIFACT_PREFIX = `.${RESTART_TRIGGER_FILE}.`
const STALE_ARTIFACT_AGE_MS = 5 * 60_000
const ARTIFACT_NAME_PATTERN =
  /^\.restart-trigger\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|consume-claim|clear-claim)$/

type ClaimKind = 'consume' | 'clear'

function getRestartTriggerPath(zeroDir: string): string {
  return join(zeroDir, RESTART_TRIGGER_FILE)
}

export function writeRestartTrigger(zeroDir: string, trigger: RestartTrigger): RestartTriggerFile {
  const payload: RestartTriggerFile = {
    id: randomUUID(),
    source: trigger.source,
    sessionId: trigger.sessionId,
    channelName: trigger.channelName,
    channelId: trigger.channelId,
    ts: new Date().toISOString(),
  }

  cleanupStaleArtifacts(zeroDir)
  const tempPath = getArtifactPath(zeroDir, payload.id, 'tmp')
  try {
    writeFileSync(tempPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
    renameSync(tempPath, getRestartTriggerPath(zeroDir))
  } finally {
    tryUnlink(tempPath)
  }
  return payload
}

export function clearRestartTriggerIfMatch(zeroDir: string, expectedId: string): boolean {
  const claimPath = claimRestartTrigger(zeroDir, 'clear')
  if (!claimPath) return false

  try {
    const payload = JSON.parse(readFileSync(claimPath, 'utf-8')) as unknown
    if (!hasRestartTriggerId(payload, expectedId)) {
      restoreOrDiscardClearClaim(zeroDir, claimPath)
      return false
    }

    return markClaimConsumed(zeroDir, claimPath)
  } catch {
    restoreOrDiscardClearClaim(zeroDir, claimPath)
    return false
  }
}

export function consumeRestartTrigger(zeroDir: string): RestartTrigger | undefined {
  const claimPath = claimRestartTrigger(zeroDir, 'consume')
  if (!claimPath) return undefined

  try {
    const payload = JSON.parse(readFileSync(claimPath, 'utf-8')) as unknown
    if (!isRestartTrigger(payload)) return undefined

    return {
      source: payload.source,
      sessionId: payload.sessionId,
      channelName: payload.channelName,
      channelId: payload.channelId,
    }
  } catch {
    return undefined
  } finally {
    tryUnlink(claimPath)
  }
}

export function formatRestartTriggerLog(trigger: RestartTrigger): string {
  return `[ZeRo OS] Restart was triggered by ${trigger.source}${trigger.channelName ? ` (${trigger.channelName})` : ''}${trigger.sessionId ? ` session=${trigger.sessionId}` : ''}`
}

function getArtifactPath(
  zeroDir: string,
  id: string,
  kind: 'tmp' | 'consume-claim' | 'clear-claim',
): string {
  return join(zeroDir, `${RESTART_TRIGGER_ARTIFACT_PREFIX}${id}.${kind}`)
}

function claimRestartTrigger(zeroDir: string, kind: ClaimKind): string | undefined {
  cleanupStaleArtifacts(zeroDir)
  const claimPath = getArtifactPath(zeroDir, randomUUID(), `${kind}-claim`)

  try {
    renameSync(getRestartTriggerPath(zeroDir), claimPath)
    return claimPath
  } catch {
    return undefined
  }
}

function restoreOrDiscardClearClaim(zeroDir: string, claimPath: string): void {
  try {
    linkSync(claimPath, getRestartTriggerPath(zeroDir))
  } catch (error) {
    if (!isFileExistsError(error)) return
  }

  tryUnlink(claimPath)
}

function markClaimConsumed(zeroDir: string, clearClaimPath: string): boolean {
  const consumedClaimPath = clearClaimPath.replace(/\.clear-claim$/, '.consume-claim')
  try {
    renameSync(clearClaimPath, consumedClaimPath)
    tryUnlink(consumedClaimPath)
    return true
  } catch {
    try {
      unlinkSync(clearClaimPath)
      return true
    } catch {
      restoreOrDiscardClearClaim(zeroDir, clearClaimPath)
      return false
    }
  }
}

function cleanupStaleArtifacts(zeroDir: string, now = Date.now()): void {
  let artifacts: Array<{ name: string; mtimeMs: number }>
  try {
    artifacts = readdirSync(zeroDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ARTIFACT_NAME_PATTERN.test(entry.name))
      .map((entry) => {
        const path = join(zeroDir, entry.name)
        return { name: entry.name, mtimeMs: statSync(path).mtimeMs }
      })
      .filter((entry) => now - entry.mtimeMs >= STALE_ARTIFACT_AGE_MS)
  } catch {
    return
  }

  const staleClearClaims = artifacts
    .filter((entry) => entry.name.endsWith('.clear-claim'))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  for (const artifact of artifacts) {
    if (artifact.name.endsWith('.clear-claim')) continue
    tryUnlink(join(zeroDir, artifact.name))
  }

  for (const artifact of staleClearClaims) {
    restoreOrDiscardClearClaim(zeroDir, join(zeroDir, artifact.name))
  }
}

function isRestartTrigger(value: unknown): value is RestartTrigger {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.source === 'string' &&
    payload.source.length > 0 &&
    isOptionalString(payload.sessionId) &&
    isOptionalString(payload.channelName) &&
    isOptionalString(payload.channelId)
  )
}

function hasRestartTriggerId(value: unknown, expectedId: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).id === expectedId
  )
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Cleanup is best-effort. A stale artifact is retried by the next operation.
  }
}
