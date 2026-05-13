import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { BashTool, FetchTool, ReadTool, Session, ToolRegistry, WriteTool } from '@zero-os/core'
import { ModelRouter, type UsageRecorder } from '@zero-os/model'
import {
  MetricsDB,
  ObservabilityStore,
  SessionDB,
  type TraceEntry,
  Tracer,
  isUsagePurpose,
} from '@zero-os/observe'
import { OutputSecretFilter, Vault, getMasterKey } from '@zero-os/secrets'
import { type SystemConfig, collectAssistantReply, generateId, now } from '@zero-os/shared'
import { buildPromptVars, interpolateTemplate } from './cases'
import { loadBenchmarkConfig, slugify } from './config'
import type { BenchmarkCase, CaseRunResult, CliOptions, ModelTarget, SecretSource } from './types'
import { collectTraceMetrics, validateCase } from './validators'

interface SecretBundle {
  entries: [string, string][]
  get(ref: string): string | undefined
}

export async function runCaseForModel(
  benchCase: BenchmarkCase,
  model: ModelTarget,
  options: CliOptions,
): Promise<CaseRunResult> {
  const startedAt = now()
  const startedMs = Date.now()
  const modelDir = join(options.outDir, benchCase.id, model.id)
  const agentName = `bench-${slugify(benchCase.id)}`
  const vars = buildPromptVars(modelDir, agentName)
  mkdirSync(vars.artifactDir, { recursive: true })

  const logsDir = join(modelDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const sessionDbPath = join(logsDir, 'sessions.db')
  const metricsDbPath = join(logsDir, 'metrics.db')
  const tracer = new Tracer(logsDir)
  const sessionDb = new SessionDB(sessionDbPath)
  const metrics = new MetricsDB(metricsDbPath)
  metrics.attachSessionsDb(sessionDbPath)
  const observability = new ObservabilityStore(logsDir)

  const config = loadBenchmarkConfig(options)
  const secrets = await loadSecrets(options.secretSource, options.dataDir, config)
  const secretFilter = new OutputSecretFilter(secrets.entries)
  const router = new ModelRouter(config, new Map(secrets.entries), {
    secretGetter: secrets.get,
    usageRecorder: createUsageRecorder(metrics),
  })

  const resolved = router.resolveModel(model.model)
  if (!resolved) {
    const endedAt = now()
    return {
      caseId: benchCase.id,
      model,
      status: 'error',
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      runDir: modelDir,
      workspace: vars.workspace,
      finalText: '',
      messages: [],
      trace: emptyTraceMetrics(),
      validation: {
        ok: false,
        checks: [{ name: 'model_resolved', passed: false, detail: model.model }],
      },
      error: `Model not found: ${model.model}`,
    }
  }

  const session = new Session(
    'web',
    router,
    createToolRegistry(benchCase.allowedTools, config.fuseList),
    {
      observability,
      metrics,
      tracer,
      secretFilter,
      secretResolver: secrets.get,
      sessionDb,
      projectRoot: modelDir,
      taskClosureModel: model.taskClosureModel,
    },
    model.model,
  )

  session.initAgent({
    name: agentName,
    agentInstruction: `${benchCase.agentInstruction}

Benchmark constraints:
- You are running inside an isolated benchmark workspace.
- Use only the tools made available to you.
- Do not claim a file exists unless you created or inspected it.
- Keep the final response concise and evidence-based.`,
  })

  const prompt = interpolateTemplate(benchCase.userPrompt, vars)
  let status: CaseRunResult['status'] = 'success'
  let error: string | undefined

  try {
    await withTimeout(
      session.handleMessage(prompt),
      options.timeoutMs ?? benchCase.timeoutMs ?? 180_000,
    )
  } catch (caught) {
    status = 'error'
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const messages = session.getMessages()
  const finalText = collectAssistantReply(messages)
  const rawEntries = readRawTraceEntries(logsDir, session.data.id)
  const trace = collectTraceMetrics(rawEntries)
  const validation = validateCase(benchCase, finalText, messages, rawEntries, vars)
  const endedAt = now()
  const result: CaseRunResult = {
    caseId: benchCase.id,
    model,
    sessionId: session.data.id,
    status,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    runDir: modelDir,
    workspace: vars.workspace,
    tracePath: relative(process.cwd(), getTracePath(logsDir, session.data.id)),
    runLogPath: relative(process.cwd(), getRunLogPath(logsDir, session.data.id)),
    finalText,
    messages,
    trace,
    validation,
    ...(error ? { error } : {}),
  }

  writeJson(join(modelDir, 'result.json'), result)
  return result
}

export function createPlan(
  cases: BenchmarkCase[],
  models: ModelTarget[],
): Array<{
  caseId: string
  caseTitle: string
  phase: BenchmarkCase['phase']
  category: string
  modelId: string
  model: string
  label: string
}> {
  return cases.flatMap((benchCase) =>
    models.map((model) => ({
      caseId: benchCase.id,
      caseTitle: benchCase.title,
      phase: benchCase.phase,
      category: benchCase.category,
      modelId: model.id,
      model: model.model,
      label: model.label,
    })),
  )
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function createToolRegistry(
  tools: BenchmarkCase['allowedTools'],
  fuseList: SystemConfig['fuseList'],
): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) {
    switch (tool) {
      case 'bash':
        registry.register(new BashTool(fuseList))
        break
      case 'fetch':
        registry.register(new FetchTool())
        break
      case 'read':
        registry.register(new ReadTool())
        break
      case 'write':
        registry.register(new WriteTool())
        break
    }
  }
  return registry
}

async function loadSecrets(
  source: SecretSource,
  dataDir: string,
  config: SystemConfig,
): Promise<SecretBundle> {
  if (source === 'vault') {
    const masterKey = await getMasterKey()
    const vault = new Vault(masterKey, join(dataDir, 'secrets.enc'))
    vault.load()
    return {
      entries: vault.entries(),
      get: (ref) => vault.get(ref) ?? undefined,
    }
  }

  const entries: [string, string][] = []
  for (const ref of collectSecretRefs(config)) {
    const value = process.env[secretEnvName(ref)] ?? process.env[ref]
    if (value) entries.push([ref, value])
  }
  return {
    entries,
    get: (ref) => entries.find(([key]) => key === ref)?.[1],
  }
}

function collectSecretRefs(config: SystemConfig): string[] {
  const refs = new Set<string>()
  for (const provider of Object.values(config.providers)) {
    if (provider.auth.apiKeyRef) refs.add(provider.auth.apiKeyRef)
    if (provider.auth.oauthTokenRef) refs.add(provider.auth.oauthTokenRef)
  }
  return Array.from(refs).sort()
}

function secretEnvName(ref: string): string {
  return `ZERO_BENCH_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

function createUsageRecorder(metrics: MetricsDB): UsageRecorder {
  return {
    record(entry) {
      if (!isUsagePurpose(entry.purpose)) return
      metrics.recordUsage({
        id: generateId(),
        sessionId: entry.sessionId,
        category: 'completion',
        purpose: entry.purpose,
        parentSessionId: entry.parentSessionId,
        model: entry.model,
        provider: entry.provider,
        inputTokens: entry.usage.input,
        outputTokens: entry.usage.output,
        cacheWriteTokens: entry.usage.cacheWrite,
        cacheReadTokens: entry.usage.cacheRead,
        reasoningTokens: entry.usage.reasoning,
        cost: entry.cost,
        durationMs: entry.durationMs,
        createdAt: now(),
      })
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Benchmark case timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function readRawTraceEntries(logsDir: string, sessionId: string): TraceEntry[] {
  const tracePath = getTracePath(logsDir, sessionId)
  try {
    return readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry)
  } catch {
    return []
  }
}

function getTracePath(logsDir: string, sessionId: string): string {
  const parts = sessionId.split('_')
  const date = parts[1]
  const day = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : 'unknown'
  return join(logsDir, 'sessions', day, sessionId, 'trace.jsonl')
}

function getRunLogPath(logsDir: string, sessionId: string): string {
  const parts = sessionId.split('_')
  const date = parts[1]
  const day = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : 'unknown'
  return join(logsDir, 'sessions', day, sessionId, 'run.log')
}

function emptyTraceMetrics() {
  return {
    rawEntryCount: 0,
    collapsedEntryCount: 0,
    llmRequestCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    closureFailedCount: 0,
    turnSuccessCount: 0,
    stopReasons: {},
    toolNames: {},
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  }
}
