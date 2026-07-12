import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderConfig, SystemConfig } from '@zero-os/shared'
import { ModelCatalogCoordinator } from '../catalog/coordinator'
import { mergeCatalogIntoConfig } from '../catalog/merge'
import { ModelCatalogStore } from '../catalog/store'
import type {
  DiscoveredModel,
  ModelDiscoveryContext,
  ModelDiscoveryDriver,
  ModelDiscoveryResult,
  ModelDiscoveryScope,
  ModelVerificationResult,
} from '../catalog/types'
import { ModelRouter } from '../router'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

const provider: ProviderConfig = {
  apiType: 'openai_responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  auth: { type: 'oauth2', oauthTokenRef: 'oauth' },
  models: {},
  discovery: { enabled: true, refreshIntervalMs: 1000 },
}

const config: SystemConfig = {
  providers: { chatgpt: provider },
  defaultModel: 'route/coding-latest',
  fallbackChain: [],
  schedules: [],
  fuseList: [],
}

class FakeDiscoveryDriver implements ModelDiscoveryDriver {
  readonly kind = 'fake'
  readonly defaultEnabled = true
  accountFingerprint = 'account-a'
  discoverCalls = 0
  verifyCalls: string[] = []
  failDiscovery = false
  waitForDiscovery: Promise<void> | undefined
  models: DiscoveredModel[] = [
    {
      modelName: 'gpt-5.6-sol',
      modelId: 'gpt-5.6-sol',
      family: 'gpt',
      version: '5.6',
      lane: 'sol',
      maxContext: 372000,
      maxOutput: 128000,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['codex', 'frontier'],
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      modelName: 'gpt-5.6-luna',
      modelId: 'gpt-5.6-luna',
      family: 'gpt',
      version: '5.6',
      lane: 'luna',
      maxContext: 372000,
      capabilities: ['tools', 'reasoning'],
      tags: ['codex', 'fast'],
    },
  ]

  supports(providerName: string): boolean {
    return providerName === 'chatgpt'
  }

  resolveScope(context: Omit<ModelDiscoveryContext, 'signal'>): ModelDiscoveryScope {
    return this.scope(context.providerName, context.provider)
  }

  async discover(context: ModelDiscoveryContext): Promise<ModelDiscoveryResult> {
    this.discoverCalls++
    const scope = this.scope(context.providerName, context.provider)
    await this.waitForDiscovery
    if (this.failDiscovery) throw new Error('temporary discovery failure')
    return { scope, models: this.models }
  }

  async verify(
    _context: ModelDiscoveryContext,
    _scope: ModelDiscoveryScope,
    model: DiscoveredModel,
  ): Promise<ModelVerificationResult> {
    this.verifyCalls.push(model.modelId)
    return model.modelId.endsWith('luna') ? { ok: false, reason: 'http_404' } : { ok: true }
  }

  private scope(providerName: string, value: ProviderConfig): ModelDiscoveryScope {
    return {
      providerName,
      providerKind: 'chatgpt',
      accountFingerprint: this.accountFingerprint,
      transport: `openai_responses:${value.baseUrl}`,
      apiType: value.apiType,
    }
  }
}

async function createCoordinator(
  driver = new FakeDiscoveryDriver(),
  now: () => Date = () => new Date(),
  sourceConfig: SystemConfig = config,
) {
  const directory = await mkdtemp(join(tmpdir(), 'zero-model-catalog-'))
  temporaryDirectories.push(directory)
  const coordinator = new ModelCatalogCoordinator({
    config: sourceConfig,
    secretGetter: () => 'unused',
    store: new ModelCatalogStore(join(directory, 'catalog.json')),
    drivers: [driver],
    now,
  })
  await coordinator.initialize()
  return { coordinator, driver }
}

describe('ModelCatalogCoordinator', () => {
  test('activates only models that pass a transport-scoped canary', async () => {
    const { coordinator } = await createCoordinator()
    const result = await coordinator.refresh({ reason: 'manual', force: true })

    expect(result).toMatchObject({ discovered: 2, verified: 1, unavailable: 1, errors: [] })
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-sol'])
    expect(
      coordinator.getScopedEntries().find((entry) => entry.modelId === 'gpt-5.6-luna'),
    ).toMatchObject({ status: 'unavailable', lastError: 'http_404' })
  })

  test('keeps last-known-good data when discovery fails', async () => {
    const { coordinator, driver } = await createCoordinator()
    await coordinator.refresh({ reason: 'manual', force: true })
    const generation = coordinator.getSnapshot().generation
    driver.failDiscovery = true

    const failed = await coordinator.refresh({ reason: 'manual', force: true })

    expect(failed.errors).toEqual([
      { providerName: 'chatgpt', message: 'temporary discovery failure' },
    ])
    expect(coordinator.getSnapshot().generation).toBe(generation)
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-sol'])
  })

  test('loads verified last-known-good entries before network refresh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zero-model-catalog-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'catalog.json')
    const driver = new FakeDiscoveryDriver()
    const first = new ModelCatalogCoordinator({
      config,
      secretGetter: () => 'unused',
      store: new ModelCatalogStore(path),
      drivers: [driver],
    })
    await first.initialize()
    await first.refresh({ reason: 'manual', force: true })

    const restored = new ModelCatalogCoordinator({
      config,
      secretGetter: () => 'unused',
      store: new ModelCatalogStore(path),
      drivers: [driver],
    })
    await restored.initialize()

    expect(restored.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-sol'])
  })

  test('isolates availability by provider account and transport scope', async () => {
    const { coordinator, driver } = await createCoordinator()
    await coordinator.refresh({ reason: 'manual', force: true })
    driver.accountFingerprint = 'account-b'
    driver.models = [{ ...driver.models[0], modelId: 'gpt-5.6-terra', modelName: 'gpt-5.6-terra' }]

    await coordinator.refresh({ reason: 'oauth_connected', force: true })

    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-terra'])
    expect(coordinator.getSnapshot().entries.map((entry) => entry.accountFingerprint)).toEqual([
      'account-a',
      'account-a',
      'account-b',
    ])
  })

  test('deduplicates concurrent refreshes for the same provider', async () => {
    const { coordinator, driver } = await createCoordinator()
    let release: (() => void) | undefined
    driver.waitForDiscovery = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = coordinator.refresh({ reason: 'manual', force: true })
    const second = coordinator.refresh({ reason: 'oauth_connected', force: true })
    await Promise.resolve()
    release?.()
    await Promise.all([first, second])

    expect(driver.discoverCalls).toBe(1)
  })

  test('starts a separate refresh when the OAuth account changes during discovery', async () => {
    const { coordinator, driver } = await createCoordinator()
    let release: (() => void) | undefined
    driver.waitForDiscovery = new Promise<void>((resolve) => {
      release = resolve
    })

    const accountA = coordinator.refresh({ reason: 'startup', force: true })
    driver.accountFingerprint = 'account-b'
    driver.models = [{ ...driver.models[0], modelId: 'gpt-5.6-terra', modelName: 'gpt-5.6-terra' }]
    const accountB = coordinator.refresh({ reason: 'oauth_connected', force: true })
    release?.()
    await Promise.all([accountA, accountB])

    expect(driver.discoverCalls).toBe(2)
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-terra'])
    expect(
      coordinator.getSnapshot().entries.every((entry) => entry.accountFingerprint === 'account-b'),
    ).toBe(true)
  })

  test('respects TTL and does not probe again before refresh is due', async () => {
    let timestamp = new Date('2026-07-10T00:00:00.000Z')
    const { coordinator, driver } = await createCoordinator(
      new FakeDiscoveryDriver(),
      () => timestamp,
    )
    await coordinator.refresh({ reason: 'startup', force: true })

    timestamp = new Date('2026-07-10T00:00:00.500Z')
    await coordinator.refresh({ reason: 'ttl' })
    expect(driver.discoverCalls).toBe(1)

    timestamp = new Date('2026-07-10T00:00:01.001Z')
    await coordinator.refresh({ reason: 'ttl' })
    expect(driver.discoverCalls).toBe(2)
  })

  test('applies allow and deny filters immediately on reconfiguration', async () => {
    const { coordinator, driver } = await createCoordinator()
    await coordinator.refresh({ reason: 'manual', force: true })
    driver.verifyCalls = []
    coordinator.reconfigure({
      ...config,
      providers: {
        chatgpt: {
          ...provider,
          discovery: { ...provider.discovery, allow: ['gpt-5.6-*'], deny: ['*-sol'] },
        },
      },
    })

    const result = await coordinator.refresh({ reason: 'config_reload', force: true })

    expect(result.errors).toEqual([])
    expect(driver.verifyCalls).toEqual(['gpt-5.6-luna'])
    expect(
      coordinator.getScopedEntries().find((entry) => entry.modelId === 'gpt-5.6-sol'),
    ).toMatchObject({ status: 'deprecated', lastError: 'filtered_by_config' })
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).not.toContain(
      'gpt-5.6-sol',
    )
  })

  test('keeps removed models as stale during the grace period', async () => {
    let timestamp = new Date('2026-07-10T00:00:00.000Z')
    const { coordinator, driver } = await createCoordinator(
      new FakeDiscoveryDriver(),
      () => timestamp,
    )
    await coordinator.refresh({ reason: 'manual', force: true })
    driver.models = [driver.models[1]]

    await coordinator.refresh({ reason: 'manual', force: true })

    expect(
      coordinator.getScopedEntries().find((entry) => entry.modelId === 'gpt-5.6-sol'),
    ).toMatchObject({ status: 'stale' })
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toContain('gpt-5.6-sol')

    timestamp = new Date('2026-07-11T01:00:00.000Z')
    await coordinator.refresh({ reason: 'manual', force: true })
    expect(
      coordinator.getScopedEntries().find((entry) => entry.modelId === 'gpt-5.6-sol'),
    ).toMatchObject({ status: 'deprecated' })
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).not.toContain(
      'gpt-5.6-sol',
    )
  })

  test('treats an empty provider payload as schema failure and keeps LKG data', async () => {
    const { coordinator, driver } = await createCoordinator()
    await coordinator.refresh({ reason: 'manual', force: true })
    driver.models = []

    const result = await coordinator.refresh({ reason: 'manual', force: true })

    expect(result.errors[0]?.message).toContain('returned no models')
    expect(coordinator.getActiveEntries().map((entry) => entry.modelId)).toEqual(['gpt-5.6-sol'])
  })

  test('falls back to an empty snapshot when the cache is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zero-model-catalog-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'catalog.json')
    await writeFile(path, '{invalid json', 'utf8')

    const restored = new ModelCatalogCoordinator({
      config,
      secretGetter: () => 'unused',
      store: new ModelCatalogStore(path),
      drivers: [new FakeDiscoveryDriver()],
    })
    await restored.initialize()

    expect(restored.getSnapshot()).toMatchObject({ generation: 0, entries: [] })
  })
})

describe('mergeCatalogIntoConfig', () => {
  test('adds verified models while preserving manual model overrides', async () => {
    const { coordinator } = await createCoordinator()
    await coordinator.refresh({ reason: 'manual', force: true })
    const manualConfig: SystemConfig = {
      ...config,
      providers: {
        chatgpt: {
          ...provider,
          models: {
            'gpt-5.6-sol': {
              modelId: 'gpt-5.6-sol',
              maxContext: 123456,
              maxOutput: 7777,
              capabilities: ['tools'],
              tags: ['manual'],
            },
          },
        },
      },
    }

    const merged = mergeCatalogIntoConfig(manualConfig, coordinator.getActiveEntries())

    expect(merged.providers.chatgpt.models['gpt-5.6-sol']).toMatchObject({
      maxContext: 123456,
      maxOutput: 7777,
      tags: ['manual'],
    })
    expect(manualConfig.providers.chatgpt.models['gpt-5.6-sol'].maxContext).toBe(123456)
  })
})

describe('ModelRouter catalog activation', () => {
  test('atomically exposes verified models without switching the active model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zero-model-catalog-'))
    temporaryDirectories.push(directory)
    const driver = new FakeDiscoveryDriver()
    driver.models = [driver.models[0]]
    const routeConfig: SystemConfig = {
      ...config,
      providers: {
        chatgpt: {
          ...provider,
          models: {
            'gpt-5.5': {
              modelId: 'gpt-5.5',
              maxContext: 400000,
              maxOutput: 128000,
              capabilities: ['tools', 'reasoning'],
              tags: ['manual'],
            },
          },
        },
      },
      modelRoutes: {
        'coding-latest': {
          providers: ['chatgpt'],
          family: 'gpt',
          lanes: ['sol'],
          requires: ['tools', 'reasoning'],
          prefer: 'newest',
        },
      },
      fallbackChain: ['chatgpt/gpt-5.5'],
    }
    const catalog = new ModelCatalogCoordinator({
      config: routeConfig,
      secretGetter: () => 'unused',
      store: new ModelCatalogStore(join(directory, 'catalog.json')),
      drivers: [driver],
    })
    await catalog.initialize()
    const router = new ModelRouter(routeConfig, new Map(), { catalog })
    const providerHealth = router.getRegistry().getProviderHealth()

    expect(router.init().model?.modelName).toBe('gpt-5.5')
    await router.refreshCatalog({ reason: 'manual', force: true })

    expect(router.getRegistry().getProviderHealth()).toBe(providerHealth)
    expect(router.getCurrentModel()?.modelName).toBe('gpt-5.5')
    expect(router.getDefaultModel()?.modelName).toBe('gpt-5.6-sol')
    expect(
      router
        .getRegistry()
        .listModels()
        .map((model) => `${model.providerName}/${model.modelName}`),
    ).toEqual(['pool/gpt-5.6-sol', 'chatgpt/gpt-5.5', 'chatgpt/gpt-5.6-sol'])
    expect(router.getRegistry().listModelPools()).toMatchObject([
      {
        name: 'pool/gpt-5.6-sol',
        source: 'catalog',
        members: [{ model: 'chatgpt/gpt-5.6-sol', priority: 0 }],
      },
    ])
    expect(router.resolveModel('gpt-5.6-sol')).toMatchObject({
      providerName: 'pool',
      modelName: 'gpt-5.6-sol',
    })

    router.reload(routeConfig, new Map())
    expect(router.resolveModel('chatgpt/gpt-5.6-sol')?.modelName).toBe('gpt-5.6-sol')

    providerHealth.markTemporaryUnavailable({
      providerName: 'chatgpt',
      modelName: 'gpt-5.6-sol',
      reason: 'unsupported_model',
    })
    await catalog.markModelUnavailable('chatgpt', 'gpt-5.6-sol', 'unsupported_model')
    await router.refreshCatalog({
      reason: 'runtime_model_error',
      providerNames: ['chatgpt'],
      force: true,
    })

    expect(
      router.getCatalogEntries().find((entry) => entry.modelName === 'gpt-5.6-sol'),
    ).toMatchObject({
      status: 'verified',
    })
    expect(providerHealth.get('chatgpt', 'gpt-5.6-sol')?.state).toBe('healthy')
  })
})
