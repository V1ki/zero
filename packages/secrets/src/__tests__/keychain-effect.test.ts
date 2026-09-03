import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Layer } from 'effect'
import {
  Keychain,
  KeychainTestGuardError,
  MasterKeyMissingError,
  deleteMasterKey,
  generateMasterKey,
  getMasterKey,
  setMasterKey,
} from '../keychain'
import {
  expectProductionMasterKeyUnchanged,
  snapshotProductionMasterKey,
} from './helpers/keychain-canary'

describe('Keychain Effect adapter', () => {
  let previousMasterKeyEnv: string | undefined
  let productionKeyDigest: string | null
  // Defense in depth: every test below passes this isolated target, so even if
  // the env bypass is unexpectedly inactive, writes can never reach the real
  // `com.zero-os.vault` entry.
  const isolatedTarget = {
    service: `com.zero-os.vault.effect-test.${process.pid}.${Date.now()}`,
    account: 'master-key',
  }

  beforeAll(async () => {
    productionKeyDigest = await snapshotProductionMasterKey()
    previousMasterKeyEnv = process.env.ZERO_MASTER_KEY_BASE64
  })

  afterAll(async () => {
    if (previousMasterKeyEnv === undefined) {
      delete process.env.ZERO_MASTER_KEY_BASE64
    } else {
      process.env.ZERO_MASTER_KEY_BASE64 = previousMasterKeyEnv
    }
    await expectProductionMasterKeyUnchanged(productionKeyDigest)
  })

  test('env bypass: getMasterKey returns the env key without touching the Keychain', async () => {
    const envKey = generateMasterKey()
    process.env.ZERO_MASTER_KEY_BASE64 = envKey.toString('base64')
    try {
      const retrieved = await getMasterKey(isolatedTarget)
      expect(retrieved).toEqual(envKey)
    } finally {
      delete process.env.ZERO_MASTER_KEY_BASE64
    }
  })

  test('env bypass: setMasterKey rewrites the env key when the bypass is active', async () => {
    const envKey = generateMasterKey()
    const replacementKey = generateMasterKey()
    process.env.ZERO_MASTER_KEY_BASE64 = envKey.toString('base64')
    try {
      await setMasterKey(replacementKey, isolatedTarget)
      expect(process.env.ZERO_MASTER_KEY_BASE64).toBe(replacementKey.toString('base64'))
      const retrieved = await getMasterKey(isolatedTarget)
      expect(retrieved).toEqual(replacementKey)
    } finally {
      delete process.env.ZERO_MASTER_KEY_BASE64
    }
  })

  test('env bypass: deleteMasterKey removes the env key', async () => {
    const envKey = generateMasterKey()
    process.env.ZERO_MASTER_KEY_BASE64 = envKey.toString('base64')
    await deleteMasterKey(isolatedTarget)
    expect(process.env.ZERO_MASTER_KEY_BASE64).toBeUndefined()
  })

  test('missing entry rejects with the original MasterKeyMissingError and the exact legacy message', async () => {
    const absentTarget = {
      service: `com.zero-os.vault.absent.${process.pid}.${Date.now()}`,
      account: 'no-such-account',
    }
    const err = await getMasterKey(absentTarget).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(MasterKeyMissingError)
    expect(err).toBeInstanceOf(Error)
    expect(err._tag).toBe('MasterKeyMissing')
    expect(err.message).toBe(
      `Master key not found in Keychain (service: ${absentTarget.service}, account: ${absentTarget.account})`,
    )
  })

  // Exact incident replay from 2026-09-03 (docs/effect-pilot.md): env bypass
  // inactive + default target. The guard must reject before any `security`
  // spawn touches the real entry.
  test('test guard: setMasterKey on the production target is refused while NODE_ENV=test', async () => {
    const previous = process.env.ZERO_MASTER_KEY_BASE64
    delete process.env.ZERO_MASTER_KEY_BASE64
    try {
      const err = await setMasterKey(generateMasterKey()).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(KeychainTestGuardError)
      expect(err?._tag).toBe('KeychainTestGuard')
      expect(err?.message).toContain('Refusing to modify the production Keychain entry')
    } finally {
      if (previous !== undefined) process.env.ZERO_MASTER_KEY_BASE64 = previous
    }
  })

  test('test guard: deleteMasterKey on the production target is refused while NODE_ENV=test', async () => {
    const previous = process.env.ZERO_MASTER_KEY_BASE64
    delete process.env.ZERO_MASTER_KEY_BASE64
    try {
      const err = await deleteMasterKey().then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(KeychainTestGuardError)
    } finally {
      if (previous !== undefined) process.env.ZERO_MASTER_KEY_BASE64 = previous
    }
  })
})

describe('Keychain layer substitution (dependency injection)', () => {
  const stubKey = generateMasterKey()
  const StubKeychain = Layer.succeed(Keychain, {
    get: () => Effect.succeed(stubKey),
    set: () => Effect.void,
    delete: () => Effect.void,
  })
  const stubProgram = Effect.flatMap(Keychain, (keychain) => keychain.get())

  test('a program requiring Keychain runs against a stub layer', async () => {
    const result = await Effect.runPromise(Effect.provide(stubProgram, StubKeychain))
    expect(result).toEqual(stubKey)
  })

  test('errors surface typed from the provided layer', async () => {
    const FailingKeychain = Layer.succeed(Keychain, {
      get: () =>
        new MasterKeyMissingError({
          service: 'svc',
          account: 'acct',
          message: 'Master key not found in Keychain (service: svc, account: acct)',
        }),
      set: () => Effect.void,
      delete: () => Effect.void,
    })
    const exit = await Effect.runPromiseExit(Effect.provide(stubProgram, FailingKeychain))
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
    expect(err).toBeInstanceOf(MasterKeyMissingError)
    expect(err instanceof Error ? err.message : '').toBe(
      'Master key not found in Keychain (service: svc, account: acct)',
    )
  })
})
