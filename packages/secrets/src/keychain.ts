import { randomBytes } from 'node:crypto'
import { Cause, Context, Data, Effect, Exit, Layer } from 'effect'

const DEFAULT_SERVICE = 'com.zero-os.vault'
const DEFAULT_ACCOUNT = 'master-key'

export interface KeychainTarget {
  service?: string
  account?: string
}

/** Raised when the master key is absent from the macOS Keychain. */
export class MasterKeyMissingError extends Data.TaggedError('MasterKeyMissing')<{
  readonly service: string
  readonly account: string
  readonly message: string
}> {}

/** Raised when storing the master key in the macOS Keychain fails. */
export class KeychainWriteError extends Data.TaggedError('KeychainWrite')<{
  readonly stderr: string
  readonly message: string
}> {}

/**
 * Raised when a test run tries to set or delete the production master-key
 * entry. `bun test` sets `NODE_ENV=test` automatically; tests must pass an
 * isolated `KeychainTarget` or provide a stub `Keychain` layer instead.
 */
export class KeychainTestGuardError extends Data.TaggedError('KeychainTestGuard')<{
  readonly service: string
  readonly account: string
  readonly message: string
}> {}

export interface KeychainService {
  readonly get: (options?: KeychainTarget) => Effect.Effect<Buffer, MasterKeyMissingError>
  readonly set: (
    key: Buffer,
    options?: KeychainTarget,
  ) => Effect.Effect<void, KeychainWriteError | KeychainTestGuardError>
  readonly delete: (options?: KeychainTarget) => Effect.Effect<void, KeychainTestGuardError>
}

export class Keychain extends Context.Tag('Keychain')<Keychain, KeychainService>() {}

function resolveKeychainTarget(options: KeychainTarget = {}): Required<KeychainTarget> {
  return {
    service: options.service ?? DEFAULT_SERVICE,
    account: options.account ?? DEFAULT_ACCOUNT,
  }
}

function getEnvMasterKey(): Buffer | undefined {
  const encoded = process.env.ZERO_MASTER_KEY_BASE64?.trim()
  if (!encoded) return undefined
  return Buffer.from(encoded, 'base64')
}

function testGuardBlocked(service: string, account: string): boolean {
  return (
    process.env.NODE_ENV === 'test' && service === DEFAULT_SERVICE && account === DEFAULT_ACCOUNT
  )
}

function testGuardError(service: string, account: string): KeychainTestGuardError {
  return new KeychainTestGuardError({
    service,
    account,
    message: `Refusing to modify the production Keychain entry (service: ${service}, account: ${account}) while NODE_ENV=test. Pass an isolated KeychainTarget to set/delete, or provide a stub Keychain layer.`,
  })
}

/**
 * Spawn the macOS `security` CLI, guaranteeing the child process is killed if
 * the surrounding Effect is interrupted before it exits.
 */
const spawnSecurity = (args: readonly string[]) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(['security', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    ),
    (proc) =>
      Effect.sync(() => {
        if (proc.exitCode === null) proc.kill()
      }),
  )

const securityFind = (
  service: string,
  account: string,
): Effect.Effect<Buffer, MasterKeyMissingError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* spawnSecurity([
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ])
      const exitCode = yield* Effect.promise(() => proc.exited)
      if (exitCode !== 0) {
        return yield* new MasterKeyMissingError({
          service,
          account,
          message: `Master key not found in Keychain (service: ${service}, account: ${account})`,
        })
      }
      const stdout = yield* Effect.promise(() => new Response(proc.stdout).text())
      return Buffer.from(stdout.trim(), 'base64')
    }),
  )

const securitySet = (
  key: Buffer,
  service: string,
  account: string,
): Effect.Effect<void, KeychainWriteError | KeychainTestGuardError> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (getEnvMasterKey()) {
        yield* Effect.sync(() => {
          process.env.ZERO_MASTER_KEY_BASE64 = key.toString('base64')
        })
        return
      }

      if (testGuardBlocked(service, account)) {
        return yield* testGuardError(service, account)
      }

      const encoded = key.toString('base64')
      // First try to delete existing entry (ignore errors)
      yield* spawnSecurity(['delete-generic-password', '-s', service, '-a', account]).pipe(
        Effect.flatMap((proc) => Effect.promise(() => proc.exited)),
        Effect.ignore,
      )

      // Then add the new key
      const proc = yield* spawnSecurity([
        'add-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
        encoded,
      ])
      const exitCode = yield* Effect.promise(() => proc.exited)
      if (exitCode !== 0) {
        const stderr = yield* Effect.promise(() => new Response(proc.stderr).text())
        return yield* new KeychainWriteError({
          stderr,
          message: `Failed to store master key in Keychain: ${stderr}`,
        })
      }
    }),
  )

const securityDelete = (
  service: string,
  account: string,
): Effect.Effect<void, KeychainTestGuardError> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (testGuardBlocked(service, account)) {
        return yield* testGuardError(service, account)
      }
      const proc = yield* spawnSecurity(['delete-generic-password', '-s', service, '-a', account])
      yield* Effect.promise(() => proc.exited)
    }),
  )

/**
 * Live keychain: `ZERO_MASTER_KEY_BASE64` wins over the macOS Keychain on
 * every call (same precedence as the pre-Effect implementation).
 */
export const KeychainLive = Layer.succeed(Keychain, {
  get: (options) =>
    Effect.gen(function* () {
      const envKey = getEnvMasterKey()
      if (envKey) return envKey
      const { service, account } = resolveKeychainTarget(options)
      return yield* securityFind(service, account)
    }),
  set: (key, options) => {
    const { service, account } = resolveKeychainTarget(options)
    return securitySet(key, service, account)
  },
  delete: (options) =>
    Effect.gen(function* () {
      if (getEnvMasterKey()) {
        yield* Effect.sync(() => {
          delete process.env.ZERO_MASTER_KEY_BASE64
        })
        return
      }
      const { service, account } = resolveKeychainTarget(options)
      yield* securityDelete(service, account)
    }),
})

/**
 * Runs a Keychain program against `KeychainLive` and rejects with the original
 * error instance (not a FiberFailure wrapper), so existing `catch` blocks and
 * `.message` consumers keep seeing the exact legacy error shapes.
 */
const runWithLiveKeychain = async <A, E>(program: Effect.Effect<A, E, Keychain>): Promise<A> => {
  const exit = await Effect.runPromiseExit(Effect.provide(program, KeychainLive))
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause)
  }
  return exit.value
}

/**
 * Read the master key from macOS Keychain.
 */
export function getMasterKey(options: KeychainTarget = {}): Promise<Buffer> {
  return runWithLiveKeychain(Effect.flatMap(Keychain, (keychain) => keychain.get(options)))
}

/**
 * Store the master key in macOS Keychain.
 * Uses -U flag to update if already exists.
 */
export function setMasterKey(key: Buffer, options: KeychainTarget = {}): Promise<void> {
  return runWithLiveKeychain(Effect.flatMap(Keychain, (keychain) => keychain.set(key, options)))
}

/**
 * Delete the master key from macOS Keychain.
 */
export function deleteMasterKey(options: KeychainTarget = {}): Promise<void> {
  return runWithLiveKeychain(Effect.flatMap(Keychain, (keychain) => keychain.delete(options)))
}

/**
 * Generate a new random 256-bit master key.
 */
export function generateMasterKey(): Buffer {
  return randomBytes(32)
}
