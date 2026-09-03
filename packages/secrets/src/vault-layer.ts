import { Cause, Context, Data, Effect, Exit, Layer } from 'effect'
import { Keychain, KeychainLive, type MasterKeyMissingError } from './keychain'
import { Vault } from './vault'

/**
 * Raised when the encrypted secrets vault cannot be decrypted with the
 * master key obtained from the Keychain. The original throw is kept in
 * `cause` for callers that need the underlying detail.
 */
export class VaultLoadError extends Data.TaggedError('VaultLoad')<{
  readonly secretsPath: string
  readonly cause: unknown
  readonly message: string
}> {}

/**
 * Tag for the decrypted vault. (`Vault` itself is the implementation class,
 * so the tag takes the `...Service` name to avoid the collision.)
 */
export class VaultService extends Context.Tag('VaultService')<VaultService, Vault>() {}

/**
 * Live vault assembly: consume the `Keychain` service for the master key,
 * construct the `Vault`, and load (decrypt) it. Parameterized by the
 * secrets.enc path so each entrypoint (server composition root, CLI
 * commands, channel setup) provides its own.
 */
export function VaultLive(
  secretsPath: string,
): Layer.Layer<VaultService, VaultLoadError | MasterKeyMissingError, Keychain> {
  return Layer.effect(
    VaultService,
    Effect.gen(function* () {
      const keychain = yield* Keychain
      const masterKey = yield* keychain.get()
      const vault = new Vault(masterKey, secretsPath)
      yield* Effect.try({
        try: () => vault.load(),
        catch: (cause) => {
          const detail = cause instanceof Error ? cause.message : String(cause)
          return new VaultLoadError({
            secretsPath,
            cause,
            message: `Failed to load secrets vault (${secretsPath}): ${detail}`,
          })
        },
      })
      return vault
    }),
  )
}

/**
 * Promise adapter for non-Effect callers: build `VaultLive` against
 * `keychainLayer` (default `KeychainLive`) and return the loaded vault.
 * Rejects with the original error instance (not a FiberFailure wrapper), the
 * same contract as `getMasterKey`/`setMasterKey`.
 */
export async function loadVault(
  secretsPath: string,
  keychainLayer: Layer.Layer<Keychain> = KeychainLive,
): Promise<Vault> {
  const assembled = Layer.provide(VaultLive(secretsPath), keychainLayer)
  const exit = await Effect.runPromiseExit(Effect.provide(VaultService, assembled))
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause)
  }
  return exit.value
}
