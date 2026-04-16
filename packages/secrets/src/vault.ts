import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

export interface SecretStore {
  [key: string]: string
}

/**
 * Encrypt a secrets store object and write to file.
 */
export function encryptSecrets(secrets: SecretStore, masterKey: Buffer, filePath: string): void {
  const plaintext = JSON.stringify(secrets)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Format: [iv (16 bytes)] [authTag (16 bytes)] [encrypted data]
  const output = Buffer.concat([iv, authTag, encrypted])
  writeFileSync(filePath, output)
}

/**
 * Read and decrypt a secrets file.
 */
export function decryptSecrets(masterKey: Buffer, filePath: string): SecretStore {
  if (!existsSync(filePath)) {
    return {}
  }

  const data = readFileSync(filePath)
  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid secrets file: too short')
  }

  const iv = data.subarray(0, IV_LENGTH)
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return JSON.parse(decrypted.toString('utf-8'))
}

/**
 * In-memory vault that manages the secret store lifecycle.
 */
export class Vault {
  private secrets: SecretStore = {}
  private filePath: string
  private masterKey: Buffer
  private fileVersion: string | null = null

  constructor(masterKey: Buffer, filePath: string) {
    this.masterKey = masterKey
    this.filePath = filePath
  }

  /**
   * Load secrets from encrypted file into memory.
   */
  load(): void {
    this.secrets = decryptSecrets(this.masterKey, this.filePath)
    this.fileVersion = this.readFileVersion()
  }

  /**
   * Persist current in-memory secrets to encrypted file.
   */
  save(): void {
    encryptSecrets(this.secrets, this.masterKey, this.filePath)
    this.fileVersion = this.readFileVersion()
  }

  /**
   * Get a secret value by key.
   */
  get(key: string): string | undefined {
    this.syncFromDiskIfChanged()
    return this.secrets[key]
  }

  /**
   * Set a secret value.
   */
  set(key: string, value: string): void {
    this.syncFromDiskIfChanged()
    this.secrets[key] = value
    this.save()
  }

  /**
   * Delete a secret.
   */
  delete(key: string): void {
    this.syncFromDiskIfChanged()
    delete this.secrets[key]
    this.save()
  }

  /**
   * List all secret keys (values are never exposed).
   */
  keys(): string[] {
    this.syncFromDiskIfChanged()
    return Object.keys(this.secrets)
  }

  /**
   * Get all secret key-value pairs (for SecretFilter initialization).
   */
  entries(): [string, string][] {
    this.syncFromDiskIfChanged()
    return Object.entries(this.secrets)
  }

  private syncFromDiskIfChanged(): void {
    const nextVersion = this.readFileVersion()
    if (nextVersion === this.fileVersion) {
      return
    }

    this.secrets = nextVersion ? decryptSecrets(this.masterKey, this.filePath) : {}
    this.fileVersion = nextVersion
  }

  private readFileVersion(): string | null {
    if (!existsSync(this.filePath)) {
      return null
    }

    const stats = statSync(this.filePath)
    return `${stats.mtimeMs}:${stats.size}`
  }
}
