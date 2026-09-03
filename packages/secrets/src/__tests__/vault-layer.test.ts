import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, Effect, Exit, Layer } from 'effect'
import { Keychain, MasterKeyMissingError, generateMasterKey } from '../keychain'
import { decryptSecrets, encryptSecrets } from '../vault'
import { VaultLive, VaultLoadError, VaultService, loadVault } from '../vault-layer'
import {
  expectProductionMasterKeyUnchanged,
  snapshotProductionMasterKey,
} from './helpers/keychain-canary'

const stubKeychainWith = (key: Buffer) =>
  Layer.succeed(Keychain, {
    get: () => Effect.succeed(key),
    set: () => Effect.void,
    delete: () => Effect.void,
  })

const failingKeychain = Layer.succeed(Keychain, {
  get: () =>
    new MasterKeyMissingError({
      service: 'svc',
      account: 'acct',
      message: 'Master key not found in Keychain (service: svc, account: acct)',
    }),
  set: () => Effect.void,
  delete: () => Effect.void,
})

describe('Vault layer assembly', () => {
  let previousMasterKeyEnv: string | undefined
  let productionKeyDigest: string | null
  const dir = mkdtempSync(join(tmpdir(), 'zero-vault-layer-'))

  beforeAll(async () => {
    // Defense in depth: every test below provides a stub layer (or relies on
    // the env bypass, which never spawns `security`), so the production
    // master-key entry is never touched — the canary proves it.
    productionKeyDigest = await snapshotProductionMasterKey()
    previousMasterKeyEnv = process.env.ZERO_MASTER_KEY_BASE64
  })

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true })
    if (previousMasterKeyEnv === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
      delete process.env.ZERO_MASTER_KEY_BASE64
    } else {
      process.env.ZERO_MASTER_KEY_BASE64 = previousMasterKeyEnv
    }
    await expectProductionMasterKeyUnchanged(productionKeyDigest)
  })

  test('loadVault returns a working vault for the stub keychain layer', async () => {
    const key = generateMasterKey()
    const path = join(dir, 'roundtrip.enc')
    encryptSecrets({ existing: 'value' }, key, path)

    const vault = await loadVault(path, stubKeychainWith(key))
    expect(vault.get('existing')).toBe('value')

    vault.set('added', 'other')
    expect(decryptSecrets(key, path)).toEqual({ existing: 'value', added: 'other' })
  })

  test('loadVault tolerates a missing secrets file (fresh-install path)', async () => {
    const key = generateMasterKey()
    const vault = await loadVault(join(dir, 'absent.enc'), stubKeychainWith(key))
    expect(vault.get('anything')).toBeUndefined()
    expect(vault.keys()).toEqual([])
  })

  test('VaultLive resolves the master key through the Keychain tag', async () => {
    const path = join(dir, 'di.enc')
    const keyA = generateMasterKey()
    const keyB = generateMasterKey()
    encryptSecrets({ owner: 'A' }, keyA, path)

    const viaA = await Effect.runPromise(
      Effect.provide(VaultService, Layer.provide(VaultLive(path), stubKeychainWith(keyA))),
    )
    expect(viaA.get('owner')).toBe('A')

    // Same file, different injected key: decryption must fail, proving the
    // vault really resolved its master key through the provided layer.
    const exit = await Effect.runPromiseExit(
      Effect.provide(VaultService, Layer.provide(VaultLive(path), stubKeychainWith(keyB))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(VaultLoadError)
    }
  })

  test('loadVault rejects typed VaultLoadError when the file cannot be decrypted', async () => {
    const key = generateMasterKey()
    const path = join(dir, 'corrupt.enc')
    writeFileSync(path, Buffer.alloc(8)) // shorter than iv+authTag → deterministic 'too short'

    try {
      await loadVault(path, stubKeychainWith(key))
      throw new Error('expected loadVault to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(VaultLoadError)
      const vaultError = error as VaultLoadError
      expect(vaultError.secretsPath).toBe(path)
      expect(vaultError.message).toContain('Failed to load secrets vault')
      expect(vaultError.message).toContain('too short')
      expect(vaultError.cause).toBeInstanceOf(Error)
    }
  })

  test('loadVault surfaces MasterKeyMissingError from the keychain layer', async () => {
    await expect(loadVault(join(dir, 'missing-key.enc'), failingKeychain)).rejects.toBeInstanceOf(
      MasterKeyMissingError,
    )
  })

  test('env bypass: loadVault with KeychainLive uses ZERO_MASTER_KEY_BASE64 without the Keychain', async () => {
    const envKey = generateMasterKey()
    process.env.ZERO_MASTER_KEY_BASE64 = envKey.toString('base64')
    const path = join(dir, 'env-bypass.enc')
    encryptSecrets({ via: 'env' }, envKey, path)
    try {
      const vault = await loadVault(path)
      expect(vault.get('via')).toBe('env')
    } finally {
      if (previousMasterKeyEnv === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
        delete process.env.ZERO_MASTER_KEY_BASE64
      } else {
        process.env.ZERO_MASTER_KEY_BASE64 = previousMasterKeyEnv
      }
    }
  })
})
