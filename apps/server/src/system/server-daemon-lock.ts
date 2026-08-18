import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ServerDaemonLockDependencies {
  pid: number
  createTokenId(): string
  isProcessAlive(pid: number): boolean
  registerExitHandler(handler: () => void): () => void
}

interface ServerDaemonLockOwner {
  pid: number
  token: string
  acquiredAt: string
}

const OWNER_FILE = 'owner.json'
const MAX_ACQUIRE_ATTEMPTS = 20

const DEFAULT_DEPENDENCIES: ServerDaemonLockDependencies = {
  pid: process.pid,
  createTokenId: randomUUID,
  isProcessAlive,
  registerExitHandler: (handler) => {
    process.once('exit', handler)
    return () => process.off('exit', handler)
  },
}

/**
 * Acquire the ZeRo OS server daemon lock.
 *
 * Ownership is represented by one fixed directory installed with an atomic
 * rename. The owner PID, rather than a renewable mtime lease, determines
 * whether the lock is still valid. This prevents an event-loop stall from
 * making a live server's lock stealable.
 */
export async function acquireServerDaemonLock(
  lockPath: string,
  dependencies: Partial<ServerDaemonLockDependencies> = {},
): Promise<() => Promise<void>> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const token = createOwnerToken(deps.pid, deps.createTokenId())
  const ownerDirectory = `${lockPath}.owner`
  const candidateDirectory = `${lockPath}.candidate-${token.pid}-${token.token}`
  const claimDirectory = `${lockPath}.claim-${token.pid}-${token.token}`

  await mkdir(dirname(lockPath), { recursive: true })
  await createOwnerDirectory(candidateDirectory, token)

  try {
    await installOwnerDirectory({
      lockPath,
      ownerDirectory,
      candidateDirectory,
      claimDirectory,
      isProcessAlive: deps.isProcessAlive,
    })
  } catch (error) {
    await removeDirectory(candidateDirectory)
    throw error
  }

  let released = false
  const removeExitHandler = deps.registerExitHandler(() => {
    releaseOwnerDirectorySync(ownerDirectory, claimDirectory, token)
  })

  return async () => {
    if (released) return
    released = true
    removeExitHandler()
    await releaseOwnerDirectory(ownerDirectory, claimDirectory, token)
  }
}

interface InstallOwnerDirectoryOptions {
  lockPath: string
  ownerDirectory: string
  candidateDirectory: string
  claimDirectory: string
  isProcessAlive(pid: number): boolean
}

async function installOwnerDirectory({
  lockPath,
  ownerDirectory,
  candidateDirectory,
  claimDirectory,
  isProcessAlive,
}: InstallOwnerDirectoryOptions): Promise<void> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      await rename(candidateDirectory, ownerDirectory)
      return
    } catch (error) {
      if (!isDestinationOccupiedError(error)) {
        if (isErrorWithCode(error, 'ENOENT') && existsSync(ownerDirectory)) {
          continue
        }
        throw error
      }
    }

    const observedOwner = await readOwner(ownerDirectory)
    if (!observedOwner) {
      throw createAlreadyLockedError(lockPath)
    }
    if (isProcessAlive(observedOwner.pid)) {
      throw createAlreadyLockedError(lockPath, observedOwner.pid)
    }

    const claimed = await claimObservedOwner({
      ownerDirectory,
      claimDirectory,
      observedOwner,
    })
    if (!claimed) continue

    await removeDirectory(claimDirectory)
  }

  throw createAlreadyLockedError(lockPath)
}

interface ClaimObservedOwnerOptions {
  ownerDirectory: string
  claimDirectory: string
  observedOwner: ServerDaemonLockOwner
}

async function claimObservedOwner({
  ownerDirectory,
  claimDirectory,
  observedOwner,
}: ClaimObservedOwnerOptions): Promise<boolean> {
  await removeDirectory(claimDirectory)

  try {
    await rename(ownerDirectory, claimDirectory)
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT') || isDestinationOccupiedError(error)) {
      return false
    }
    throw error
  }

  const claimedOwner = await readOwner(claimDirectory)
  if (claimedOwner && claimedOwner.token === observedOwner.token) {
    return true
  }

  await restoreClaimedOwner(ownerDirectory, claimDirectory)
  return false
}

async function restoreClaimedOwner(ownerDirectory: string, claimDirectory: string): Promise<void> {
  try {
    await rename(claimDirectory, ownerDirectory)
  } catch (error) {
    if (!isDestinationOccupiedError(error)) throw error
  }
}

async function releaseOwnerDirectory(
  ownerDirectory: string,
  claimDirectory: string,
  owner: ServerDaemonLockOwner,
): Promise<void> {
  const observedOwner = await readOwner(ownerDirectory)
  if (!observedOwner || observedOwner.token !== owner.token) return

  await removeDirectory(claimDirectory)
  try {
    await rename(ownerDirectory, claimDirectory)
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return
    throw error
  }

  const claimedOwner = await readOwner(claimDirectory)
  if (claimedOwner?.token === owner.token) {
    await removeDirectory(claimDirectory)
    return
  }

  await restoreClaimedOwner(ownerDirectory, claimDirectory)
}

function releaseOwnerDirectorySync(
  ownerDirectory: string,
  claimDirectory: string,
  owner: ServerDaemonLockOwner,
): void {
  try {
    const observedOwner = readOwnerSync(ownerDirectory)
    if (!observedOwner || observedOwner.token !== owner.token) return

    removeDirectorySync(claimDirectory)
    renameSync(ownerDirectory, claimDirectory)

    const claimedOwner = readOwnerSync(claimDirectory)
    if (claimedOwner?.token === owner.token) {
      removeDirectorySync(claimDirectory)
      return
    }

    try {
      renameSync(claimDirectory, ownerDirectory)
    } catch (error) {
      if (!isDestinationOccupiedError(error)) throw error
    }
  } catch (error) {
    if (!isErrorWithCode(error, 'ENOENT')) {
      console.warn(`[ZeRo OS] Failed to release server daemon lock ${ownerDirectory}:`, error)
    }
  }
}

async function createOwnerDirectory(
  directory: string,
  owner: ServerDaemonLockOwner,
): Promise<void> {
  await removeDirectory(directory)
  await mkdir(directory)
  await writeFile(join(directory, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
}

async function readOwner(directory: string): Promise<ServerDaemonLockOwner | undefined> {
  try {
    return parseOwner(await readFile(join(directory, OWNER_FILE), 'utf8'))
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function readOwnerSync(directory: string): ServerDaemonLockOwner | undefined {
  try {
    return parseOwner(readFileSync(join(directory, OWNER_FILE), 'utf8'))
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function parseOwner(content: string): ServerDaemonLockOwner | undefined {
  try {
    const value = JSON.parse(content) as Partial<ServerDaemonLockOwner>
    if (
      !Number.isInteger(value.pid) ||
      !value.pid ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token
    ) {
      return undefined
    }
    return {
      pid: value.pid,
      token: value.token,
      acquiredAt: typeof value.acquiredAt === 'string' ? value.acquiredAt : '',
    }
  } catch {
    return undefined
  }
}

function createOwnerToken(pid: number, token: string): ServerDaemonLockOwner {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid daemon lock PID: ${pid}`)
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error('Invalid daemon lock token ID')
  }
  return {
    pid,
    token,
    acquiredAt: new Date().toISOString(),
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrorWithCode(error, 'ESRCH')
  }
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

function removeDirectorySync(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

function createAlreadyLockedError(lockPath: string, ownerPid?: number): Error {
  const owner = ownerPid ? ` by PID ${ownerPid}` : ''
  return Object.assign(new Error(`Server daemon lock is already held${owner}`), {
    code: 'ELOCKED',
    file: lockPath,
  })
}

function isDestinationOccupiedError(error: unknown): boolean {
  return (
    isErrorWithCode(error, 'EEXIST') ||
    isErrorWithCode(error, 'ENOTEMPTY') ||
    isErrorWithCode(error, 'EPERM')
  )
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
