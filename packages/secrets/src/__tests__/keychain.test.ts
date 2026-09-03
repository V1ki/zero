import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { deleteMasterKey, generateMasterKey, getMasterKey, setMasterKey } from '../keychain'
import {
  expectProductionMasterKeyUnchanged,
  snapshotProductionMasterKey,
} from './helpers/keychain-canary'

describe('macOS Keychain integration', () => {
  const testTarget = {
    service: `com.zero-os.vault.test.${process.pid}.${Date.now()}`,
    account: 'master-key',
  }
  const testKey = generateMasterKey()
  let previousMasterKeyEnv: string | undefined
  let productionKeyDigest: string | null

  beforeAll(async () => {
    productionKeyDigest = await snapshotProductionMasterKey()
    previousMasterKeyEnv = process.env.ZERO_MASTER_KEY_BASE64
    delete process.env.ZERO_MASTER_KEY_BASE64
    await deleteMasterKey(testTarget)
  })

  afterAll(async () => {
    await deleteMasterKey(testTarget)
    if (previousMasterKeyEnv === undefined) {
      delete process.env.ZERO_MASTER_KEY_BASE64
    } else {
      process.env.ZERO_MASTER_KEY_BASE64 = previousMasterKeyEnv
    }
    await expectProductionMasterKeyUnchanged(productionKeyDigest)
  })

  test('set and get master key round-trip', async () => {
    await setMasterKey(testKey, testTarget)
    const retrieved = await getMasterKey(testTarget)
    expect(retrieved).toEqual(testKey)
  })

  test('delete removes the key', async () => {
    await setMasterKey(testKey, testTarget)
    await deleteMasterKey(testTarget)
    await expect(getMasterKey(testTarget)).rejects.toThrow('Master key not found')
  })

  test('generateMasterKey produces 32-byte key', () => {
    const key = generateMasterKey()
    expect(key.length).toBe(32)
  })

  test('generateMasterKey produces unique keys', () => {
    const key1 = generateMasterKey()
    const key2 = generateMasterKey()
    expect(key1).not.toEqual(key2)
  })
})
