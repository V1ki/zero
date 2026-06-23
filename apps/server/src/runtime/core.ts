import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, type ToolRegistry, loadConfig } from '@zero-os/core'
import {
  OutputSecretFilter,
  Vault,
  generateMasterKey,
  getMasterKey,
  setMasterKey,
} from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import { RepairEngine } from '@zero-os/supervisor'
import type { EventBus } from './bus'
import { type MemoryRuntime, createMemoryRuntime } from './memory'
import { type ModelRouterRuntime, createModelRouterRuntime } from './model-providers/router'
import { type ObservabilityRuntime, createObservabilityRuntime } from './observability'
import { type SchedulerRuntime, createSchedulerRuntime } from './scheduler'
import { createRuntimeToolRegistry } from './tools'

interface CreateCoreRuntimeOptions {
  zeroDir: string
  projectRoot: string
  bus: EventBus
}

export async function createCoreRuntime({ zeroDir, projectRoot, bus }: CreateCoreRuntimeOptions) {
  const { configPath, config, secretsRuntime, observabilityRuntime } =
    await createCoreInfrastructureRuntime(zeroDir)
  const { vault, secretFilter } = secretsRuntime
  const agentRuntime = await createAgentRuntimeComponents({
    zeroDir,
    projectRoot,
    config,
    vault,
    secretsRuntime,
    observabilityRuntime,
    bus,
  })

  return {
    configPath,
    config,
    vault,
    secretFilter,
    ...observabilityRuntime,
    ...agentRuntime,
    repairEngine: new RepairEngine(),
  }
}

export type CoreRuntime = Awaited<ReturnType<typeof createCoreRuntime>>

interface SecretsRuntime {
  vault: Vault
  secretFilter: OutputSecretFilter
  secretResolver(ref: string): string | undefined
}

interface CoreInfrastructureRuntime {
  configPath: string
  config: SystemConfig
  secretsRuntime: SecretsRuntime
  observabilityRuntime: ObservabilityRuntime
}

async function createCoreInfrastructureRuntime(
  zeroDir: string,
): Promise<CoreInfrastructureRuntime> {
  ensureRuntimeDirectories(zeroDir)
  const secretsRuntime = await createSecretsRuntime(zeroDir)
  const configPath = join(zeroDir, 'config.yaml')
  const config = loadConfig(configPath)
  console.log(`[ZeRo OS] Config loaded (${Object.keys(config.providers).length} providers)`)

  return {
    configPath,
    config,
    secretsRuntime,
    observabilityRuntime: createObservabilityRuntime(zeroDir),
  }
}

function ensureRuntimeDirectories(zeroDir: string): void {
  const dirs = [
    zeroDir,
    join(zeroDir, 'channels'),
    join(zeroDir, 'tools'),
    join(zeroDir, 'skills'),
    join(zeroDir, 'skills', 'browser'),
    join(zeroDir, 'logs'),
    join(zeroDir, 'memory'),
    join(zeroDir, 'memory/preferences'),
    join(zeroDir, 'memory/preferences/agents'),
    join(zeroDir, 'memory/sessions'),
    join(zeroDir, 'memory/incidents'),
    join(zeroDir, 'memory/runbooks'),
    join(zeroDir, 'memory/decisions'),
    join(zeroDir, 'memory/notes'),
    join(zeroDir, 'memory/inbox'),
    join(zeroDir, 'memory/archive'),
    join(zeroDir, 'cache'),
    join(zeroDir, 'workspace'),
    join(zeroDir, 'workspace/shared'),
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

async function createSecretsRuntime(zeroDir: string): Promise<SecretsRuntime> {
  const secretsPath = join(zeroDir, 'secrets.enc')
  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
    console.log('[ZeRo OS] Master key loaded from Keychain')
  } catch {
    if (existsSync(secretsPath)) {
      throw new Error(
        '[ZeRo OS] Master key missing in Keychain for existing .zero/secrets.enc. Restore the original Keychain item or recover the vault before starting.',
      )
    }
    console.log('[ZeRo OS] First run — generating master key...')
    masterKey = generateMasterKey()
    await setMasterKey(masterKey)
    console.log('[ZeRo OS] Master key stored in Keychain')
  }

  const vault = new Vault(masterKey, secretsPath)
  try {
    vault.load()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[ZeRo OS] Failed to decrypt secrets vault: ${detail}. The Keychain master key may not match .zero/secrets.enc; restore a matching Keychain item or vault backup.`,
    )
  }
  console.log(`[ZeRo OS] Secrets loaded (${vault.keys().length} keys)`)

  return {
    vault,
    secretFilter: new OutputSecretFilter(vault.entries()),
    secretResolver: (ref) => vault.get(ref) ?? undefined,
  }
}

interface CreateAgentRuntimeComponentsOptions {
  zeroDir: string
  projectRoot: string
  config: SystemConfig
  vault: Vault
  secretsRuntime: SecretsRuntime
  observabilityRuntime: ObservabilityRuntime
  bus: EventBus
}

async function createAgentRuntimeComponents({
  zeroDir,
  projectRoot,
  config,
  vault,
  secretsRuntime,
  observabilityRuntime,
  bus,
}: CreateAgentRuntimeComponentsOptions) {
  const { metrics, sessionDb, heartbeat } = observabilityRuntime
  const modelRuntime = await createModelRouterRuntime({
    zeroDir,
    config,
    vault,
    metrics,
  })

  const toolRegistry = createRuntimeToolRegistry({
    zeroDir,
    config,
    vault,
    modelRouter: modelRuntime.modelRouter,
    metrics,
  })
  console.log(`[ZeRo OS] ${toolRegistry.list().length} tools registered`)

  const memoryRuntime = await createMemoryRuntime({
    zeroDir,
    config,
    vault,
    metrics,
    heartbeat,
  })

  const schedulerRuntime = createSchedulerRuntime(sessionDb)
  const sessionManager = createRuntimeSessionManager({
    config,
    projectRoot,
    bus,
    toolRegistry,
    secrets: secretsRuntime,
    observability: observabilityRuntime,
    modelRuntime,
    memoryRuntime,
    schedulerRuntime,
  })

  return {
    ...modelRuntime,
    toolRegistry,
    ...memoryRuntime,
    scheduler: schedulerRuntime.scheduler,
    startSchedulerRuntime: schedulerRuntime.start,
    sessionManager,
  }
}

interface CreateRuntimeSessionManagerOptions {
  config: SystemConfig
  projectRoot: string
  bus: EventBus
  toolRegistry: ToolRegistry
  secrets: SecretsRuntime
  observability: ObservabilityRuntime
  modelRuntime: ModelRouterRuntime
  memoryRuntime: MemoryRuntime
  schedulerRuntime: SchedulerRuntime
}

function createRuntimeSessionManager({
  config,
  projectRoot,
  bus,
  toolRegistry,
  secrets,
  observability,
  modelRuntime,
  memoryRuntime,
  schedulerRuntime,
}: CreateRuntimeSessionManagerOptions): SessionManager {
  const sessionManager = new SessionManager(
    modelRuntime.modelRouter,
    toolRegistry,
    {
      observability: observability.observability,
      metrics: observability.metrics,
      tracer: observability.tracer,
      secretFilter: secrets.secretFilter,
      secretResolver: secrets.secretResolver,
      memoryRetriever: memoryRuntime.memoryRetriever,
      memoryStore: memoryRuntime.memoryStore,
      identityReader: memoryRuntime.identityReader,
      bus,
      sessionDb: observability.sessionDb,
      schedulerHandle: schedulerRuntime.schedulerHandle,
      scheduleStore: schedulerRuntime.scheduleStore,
      taskClosureModel: config.taskClosureModel,
      contextCompactionModel: config.contextCompactionModel,
      projectRoot,
    },
    observability.sessionDb,
  )

  observability.heartbeat.setReady(false, 'restoring_sessions')
  const restoredCount = sessionManager.restoreFromDB()
  if (restoredCount > 0) {
    console.log(`[ZeRo OS] Restored ${restoredCount} sessions from DB`)
  }

  return sessionManager
}
