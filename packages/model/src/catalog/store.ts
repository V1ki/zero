import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ModelCatalogEntry, ModelCatalogSnapshot } from './types'

const EMPTY_SNAPSHOT: ModelCatalogSnapshot = {
  version: 1,
  generation: 0,
  updatedAt: new Date(0).toISOString(),
  entries: [],
}

export class ModelCatalogStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ModelCatalogSnapshot> {
    if (!existsSync(this.path)) return structuredClone(EMPTY_SNAPSHOT)

    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      return normalizeSnapshot(parsed)
    } catch {
      return structuredClone(EMPTY_SNAPSHOT)
    }
  }

  async save(snapshot: ModelCatalogSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.path)
  }
}

function normalizeSnapshot(value: unknown): ModelCatalogSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return structuredClone(EMPTY_SNAPSHOT)
  }

  const entries = value.entries.filter(isCatalogEntry)
  return {
    version: 1,
    generation:
      typeof value.generation === 'number' && Number.isFinite(value.generation)
        ? Math.max(0, Math.floor(value.generation))
        : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    entries,
  }
}

function isCatalogEntry(value: unknown): value is ModelCatalogEntry {
  if (!isRecord(value) || !isRecord(value.modelConfig) || !isRecord(value.provenance)) return false
  const modelConfig = value.modelConfig
  return (
    typeof value.providerName === 'string' &&
    typeof value.providerKind === 'string' &&
    typeof value.accountFingerprint === 'string' &&
    typeof value.transport === 'string' &&
    isApiType(value.apiType) &&
    typeof value.modelName === 'string' &&
    typeof value.modelId === 'string' &&
    isCatalogStatus(value.status) &&
    isCatalogSource(value.source) &&
    Object.values(value.provenance).every(isFieldSource) &&
    typeof value.metadataHash === 'string' &&
    isTimestamp(value.discoveredAt) &&
    isTimestamp(value.lastSeenAt) &&
    (value.verifiedAt === undefined || isTimestamp(value.verifiedAt)) &&
    typeof modelConfig.modelId === 'string' &&
    isPositiveNumber(modelConfig.maxContext) &&
    isPositiveNumber(modelConfig.maxOutput) &&
    isStringArray(modelConfig.capabilities) &&
    isStringArray(modelConfig.tags)
  )
}

function isApiType(value: unknown): boolean {
  return (
    value === 'anthropic_messages' ||
    value === 'anthropic-deepseek' ||
    value === 'openai_chat_completions' ||
    value === 'openai_responses' ||
    value === 'x_responses'
  )
}

function isCatalogStatus(value: unknown): value is ModelCatalogEntry['status'] {
  return (
    value === 'discovered' ||
    value === 'verifying' ||
    value === 'verified' ||
    value === 'unavailable' ||
    value === 'stale' ||
    value === 'deprecated'
  )
}

function isCatalogSource(value: unknown): value is ModelCatalogEntry['source'] {
  return value === 'provider' || value === 'trusted_catalog' || value === 'system_default'
}

function isFieldSource(value: unknown): boolean {
  return isCatalogSource(value) || value === 'manual_override' || value === 'runtime_probe'
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
