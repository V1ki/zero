import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AgentControl,
  BashTool,
  CloseAgentTool,
  EditTool,
  FetchTool,
  ReadTool,
  SendInputTool,
  SpawnAgentTool,
  TaskTool,
  ToolRegistry,
  WaitAgentTool,
  WriteTool,
  loadConfig,
} from '@zero-os/core'
import { ModelRouter } from '@zero-os/model'
import { Tracer } from '@zero-os/observe'
import { OutputSecretFilter, Vault, getMasterKey } from '@zero-os/secrets'
import type { ToolContext, ToolLogger } from '@zero-os/shared'

const BENCHMARK_ROOT = resolve(import.meta.dir, '..')
const PROJECT_ROOT = resolve(BENCHMARK_ROOT, '..', '..')
const ZERO_ROOT = join(PROJECT_ROOT, '.zero')
const CONFIG_PATH = join(ZERO_ROOT, 'config.yaml')
const SECRETS_PATH = join(ZERO_ROOT, 'secrets.enc')

const logger: ToolLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface BenchmarkToolContext extends ToolContext {
  currentModel: string
  projectRoot: string
  tracer: Tracer
  secretResolver: (ref: string) => string | undefined
  secretFilter: OutputSecretFilter
  agentControl: AgentControl
}

export interface BenchmarkHarness {
  modelRouter: ModelRouter
  taskTool: TaskTool
  spawnTool: SpawnAgentTool
  waitTool: WaitAgentTool
  closeTool: CloseAgentTool
  sendInputTool: SendInputTool
  agentControl: AgentControl
  buildToolContext(model: string): BenchmarkToolContext
  cleanup(): void
}

export async function createBenchmarkHarness(): Promise<BenchmarkHarness> {
  const config = loadConfig(CONFIG_PATH)
  const masterKey = await getMasterKey()
  const vault = new Vault(masterKey, SECRETS_PATH)
  vault.load()

  const secrets = new Map(vault.entries())
  const modelRouter = new ModelRouter(config, secrets)
  const init = modelRouter.init()
  if (!init.success) {
    throw new Error(`Failed to initialize model router: ${init.message}`)
  }

  const registry = new ToolRegistry()
  registry.register(new ReadTool())
  registry.register(new WriteTool())
  registry.register(new EditTool())
  registry.register(new BashTool(config.fuseList))
  registry.register(new FetchTool())

  const taskTool = new TaskTool(modelRouter, registry)
  const spawnTool = new SpawnAgentTool(modelRouter, registry)
  const waitTool = new WaitAgentTool()
  const closeTool = new CloseAgentTool()
  const sendInputTool = new SendInputTool()

  const tempDirs: string[] = []

  const harness: BenchmarkHarness = {
    modelRouter,
    taskTool,
    spawnTool,
    waitTool,
    closeTool,
    sendInputTool,
    agentControl: new AgentControl(),
    buildToolContext(model: string): BenchmarkToolContext {
      const resolvedModel = modelRouter.resolveModel(model)
      if (!resolvedModel) {
        throw new Error(`Unknown benchmark model: ${model}`)
      }

      harness.agentControl = new AgentControl()

      const workDir = mkdtempSync(join(tmpdir(), 'zero-subagent-benchmark-'))
      tempDirs.push(workDir)

      const tracer = new Tracer()
      const secretFilter = new OutputSecretFilter(vault.entries())
      const currentModel = modelRouter.getModelLabel(resolvedModel)
      const sessionSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      return {
        sessionId: `bench_${sessionSuffix}`,
        currentModel,
        currentRequestId: `req_${sessionSuffix}`,
        workDir,
        projectRoot: PROJECT_ROOT,
        logger,
        tracer,
        secretFilter,
        secretResolver: (ref: string) => secrets.get(ref),
        agentControl: harness.agentControl,
      }
    },
    cleanup(): void {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }

  return harness
}
