import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keychain, MasterKeyMissingError, Vault, generateMasterKey } from '@zero-os/secrets'
import { Effect, Layer } from 'effect'
import { createSecretsRuntime } from '../runtime/core'

// Stub layers only: these tests never assemble KeychainLive, so the real
// Keychain entry cannot be touched from here.
const stubKey = generateMasterKey()

const StubKeychain = Layer.succeed(Keychain, {
  get: () => Effect.succeed(stubKey),
  set: () => Effect.void,
  delete: () => Effect.void,
})

const makeFailingKeychain = (onSet: (key: Buffer) => void) =>
  Layer.succeed(Keychain, {
    get: () =>
      new MasterKeyMissingError({
        service: 'stub',
        account: 'stub',
        message: 'Master key not found in Keychain (service: stub, account: stub)',
      }),
    set: (key) => Effect.sync(() => onSet(key)),
    delete: () => Effect.void,
  })

const tempDirs: string[] = []

function freshZeroDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zero-secrets-runtime-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createSecretsRuntime (Keychain layer injection)', () => {
  test('builds the vault with the key provided by the injected layer', async () => {
    const zeroDir = freshZeroDir()

    const runtime = await createSecretsRuntime(zeroDir, StubKeychain)

    runtime.vault.set('probe_ref', 'probe_value')
    runtime.vault.save()

    const reopened = new Vault(stubKey, join(zeroDir, 'secrets.enc'))
    reopened.load()
    expect(reopened.get('probe_ref')).toBe('probe_value')
  })

  test('first run generates a key, stores it via the layer, and uses it for the vault', async () => {
    const zeroDir = freshZeroDir()
    let storedKey: Buffer | undefined

    const runtime = await createSecretsRuntime(
      zeroDir,
      makeFailingKeychain((key) => {
        storedKey = key
      }),
    )

    expect(storedKey).toHaveLength(32)
    expect(runtime.vault.get('anything')).toBeUndefined()

    runtime.vault.set('first_run_ref', 'first_run_value')
    runtime.vault.save()

    const reopened = new Vault(storedKey ?? Buffer.alloc(0), join(zeroDir, 'secrets.enc'))
    reopened.load()
    expect(reopened.get('first_run_ref')).toBe('first_run_value')
  })

  test('missing key with an existing vault file is a fatal startup error', async () => {
    const zeroDir = freshZeroDir()

    const existing = new Vault(generateMasterKey(), join(zeroDir, 'secrets.enc'))
    existing.set('already_there', 'value')
    existing.save()

    const noopSet = makeFailingKeychain(() => {})
    await expect(createSecretsRuntime(zeroDir, noopSet)).rejects.toThrow(
      'Master key missing in Keychain for existing .zero/secrets.enc',
    )
  })
})
