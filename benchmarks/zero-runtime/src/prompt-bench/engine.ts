import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import { ModelCatalogStore, ModelRegistry, type ProviderAdapter } from '@zero-os/model'
import { OutputSecretFilter, Vault, getMasterKey } from '@zero-os/secrets'
import type {
  ContentBlock,
  Message,
  ReasoningEffort,
  TokenUsage,
  ToolUseBlock,
} from '@zero-os/shared'
import { parseTaskClosureDecision } from '../../../../packages/core/src/agent/task-closure'
import { TOOLS } from './cases'
import { type Grade, Sandbox, gradeAgent, textOf } from './sandbox'
import { type Snapshot, hash } from './snapshot'
import { getSuite } from './suites'

export interface Settings {
  root: string
  config: string
  catalog: string
  secretSource: 'env' | 'vault'
  model: string
  reasoning: ReasoningEffort
  maxTokens: number
  maxSteps: number
  emptyResponseRetries?: 0 | 1
}

export interface Trial {
  id: string
  model: string
  variant: string
  snapshotHash: string
  caseId: string
  rep: number
  status: 'ok' | 'error' | 'timeout'
  passed: boolean
  durationMs: number
  usage: TokenUsage
  requests: number
  responseModels: string[]
  emptyResponses?: number
  emptyRetries?: number
  emptyRecovered?: number
  grade?: Grade
  decision?: string
  expected?: string
  messages: Message[]
  observations: Sandbox['observations']
  error?: string
}

export async function resolveRuntime(settings: Settings, credentials: boolean) {
  const config = loadConfig(settings.config)
  const entries = (await new ModelCatalogStore(settings.catalog).load()).entries
  const secrets = new Map<string, string>()
  const providerName = settings.model.split('/')[0]
  const provider = config.providers[providerName]
  if (!provider || settings.model.split('/').length !== 2 || providerName === 'pool')
    throw new Error('Use an exact configured provider/model, not a pool or route')
  if (credentials) {
    const refs = [provider.auth.apiKeyRef, provider.auth.oauthTokenRef].filter(
      (r): r is string => !!r,
    )
    let vault: Vault | undefined
    if (refs.length && settings.secretSource === 'vault') {
      vault = new Vault(await getMasterKey(), join(settings.root, '.zero/secrets.enc'))
      vault.load()
    }
    for (const ref of refs) {
      const value =
        settings.secretSource === 'vault'
          ? vault?.get(ref)
          : (process.env[`ZERO_BENCH_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] ??
            process.env[ref])
      if (!value) throw new Error(`Missing benchmark credential reference: ${ref}`)
      secrets.set(ref, value)
    }
  }
  const router = new ModelRegistry(config, secrets, { catalogEntries: entries })
  const resolved = router.resolvePhysicalModel(settings.model)
  if (!resolved || `${resolved.providerName}/${resolved.modelName}` !== settings.model)
    throw new Error('Exact model unavailable; benchmark never falls back')
  const filter = new OutputSecretFilter([...secrets.entries()])
  // Also redact fields inside serialized OAuth sessions if an upstream error echoes them.
  for (const [ref, value] of [...secrets.entries()]) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      for (const [key, token] of Object.entries(parsed))
        if (typeof token === 'string' && /token|secret/i.test(key))
          secrets.set(`${ref}.${key}`, token)
    } catch {
      /* A plain API key is already covered. */
    }
  }
  const secretFilter = new OutputSecretFilter([...secrets.entries()])
  const fingerprint = hash({
    model: settings.model,
    modelConfig: resolved.modelConfig,
    apiType: resolved.providerConfig.apiType,
    baseUrl: resolved.providerConfig.baseUrl,
    authType: provider.auth.type,
  })
  return {
    adapter: resolved.adapter,
    modelId: resolved.modelConfig.modelId,
    fingerprint,
    filter: (s: string) => secretFilter.filter(filter.filter(s)),
  }
}

function message(role: 'user' | 'assistant', content: ContentBlock[], index: number): Message {
  return {
    id: `bench_${index}`,
    sessionId: 'benchmark',
    role,
    messageType: 'message',
    content,
    createdAt: '2026-01-01T00:00:00Z',
  }
}

export interface TaskExecution {
  trial: Trial
  finished: boolean
  evaluate(): Trial
}

/** Execution and scoring are separate so the platform owns the evaluation phase. */
export async function executeTask(
  settings: Settings,
  snapshot: Snapshot,
  caseId: string,
  rep: number,
  adapter: Pick<ProviderAdapter, 'complete'>,
  tool: (call: ToolUseBlock, run: () => ContentBlock) => Promise<ContentBlock> = async (
    _call,
    run,
  ) => run(),
): Promise<TaskExecution> {
  const started = Date.now()
  const trial: Trial = {
    id: `${settings.model}/${caseId}/${rep}/${snapshot.label}`,
    model: settings.model,
    variant: snapshot.label,
    snapshotHash: snapshot.hash,
    caseId,
    rep,
    status: 'ok',
    passed: false,
    durationMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    requests: 0,
    responseModels: [],
    emptyResponses: 0,
    emptyRetries: 0,
    emptyRecovered: 0,
    messages: [],
    observations: [],
  }
  let finished = false
  let evaluate = () => trial
  const request = async (system: string, tools?: typeof TOOLS) => {
    trial.requests++
    const response = await adapter.complete({
      system,
      tools,
      messages: trial.messages,
      stream: false,
      reasoningEffort: settings.reasoning,
      maxTokens: settings.maxTokens,
    })
    const requestedModel = settings.model.split('/')[1]
    if (response.model !== requestedModel && !response.model.startsWith(`${requestedModel}-`)) {
      throw new Error(`Unexpected response model: ${response.model}`)
    }
    trial.usage.input += response.usage.input
    trial.usage.output += response.usage.output
    trial.usage.cacheRead = (trial.usage.cacheRead ?? 0) + (response.usage.cacheRead ?? 0)
    trial.usage.cacheWrite = (trial.usage.cacheWrite ?? 0) + (response.usage.cacheWrite ?? 0)
    trial.usage.reasoning = (trial.usage.reasoning ?? 0) + (response.usage.reasoning ?? 0)
    trial.responseModels.push(response.model)
    return response
  }
  const complete = async (system: string, tools?: typeof TOOLS) => {
    let response = await request(system, tools)
    let retries = 0
    while (response.content.length === 0 && response.stopReason === 'end_turn') {
      trial.emptyResponses = (trial.emptyResponses ?? 0) + 1
      if (retries >= (settings.emptyResponseRetries ?? 0) || trial.requests >= settings.maxSteps)
        break
      retries++
      trial.emptyRetries = (trial.emptyRetries ?? 0) + 1
      // Match AgentLoop's bounded same-request retry: no fabricated assistant/user message.
      response = await request(system, tools)
    }
    if (retries && response.content.length) trial.emptyRecovered = (trial.emptyRecovered ?? 0) + 1
    trial.messages.push(message('assistant', response.content, trial.messages.length))
    return response
  }
  try {
    const suite = getSuite(snapshot.suite)
    const fixture = suite.agent.find((c) => c.id === caseId)
    if (fixture) {
      const sandbox = new Sandbox(fixture)
      trial.observations = sandbox.observations
      trial.messages.push(message('user', [{ type: 'text', text: fixture.prompt }], 0))
      for (let step = 0; step < settings.maxSteps && trial.requests < settings.maxSteps; step++) {
        const response = await complete(
          snapshot.systems[fixture.mode === 'minimal' ? 'minimal' : 'full'].replaceAll(
            'BENCH_MODEL',
            settings.model,
          ),
          TOOLS,
        )
        const calls = response.content.filter((b) => b.type === 'tool_use')
        if (response.stopReason === 'max_tokens') break
        if (calls.length) {
          const results: ContentBlock[] = []
          // Preserve the original sequential side-effect order for a multi-call response.
          for (const call of calls) results.push(await tool(call, () => sandbox.execute(call)))
          trial.messages.push(message('user', results, trial.messages.length))
          const followUp = sandbox.takeFollowUp()
          if (followUp)
            trial.messages.push(
              message('user', [{ type: 'text', text: followUp }], trial.messages.length),
            )
        } else if (response.stopReason === 'end_turn' && sandbox.pending) {
          trial.messages.push(
            message(
              'user',
              [{ type: 'text', text: sandbox.completeBackground() }],
              trial.messages.length,
            ),
          )
        } else {
          finished = response.stopReason === 'end_turn'
          break
        }
      }
      evaluate = () => {
        trial.grade = gradeAgent(fixture, sandbox, trial.messages, finished)
        trial.passed = trial.grade.passed
        return trial
      }
    } else {
      const closure = suite.closure.find((c) => c.id === caseId)
      if (!closure) throw new Error(`Unknown case: ${caseId}`)
      trial.messages.push(
        message('user', [{ type: 'text', text: snapshot.closurePrompts[caseId] }], 0),
      )
      const response = await complete(snapshot.closureSystem)
      finished = response.stopReason === 'end_turn'
      evaluate = () => {
        const decision = parseTaskClosureDecision(textOf(response.content))
        trial.decision = decision?.action ?? 'invalid'
        trial.expected = closure.expected
        trial.passed = finished && decision?.action === closure.expected
        return trial
      }
    }
  } catch (error) {
    trial.status = 'error'
    trial.error = error instanceof Error ? error.message : String(error)
  }
  trial.durationMs = Date.now() - started
  return { trial, finished, evaluate }
}

/** Compatibility API for existing callers and frozen grading tests. */
export async function executeTrial(
  settings: Settings,
  snapshot: Snapshot,
  caseId: string,
  rep: number,
  adapter: Pick<ProviderAdapter, 'complete'>,
): Promise<Trial> {
  return (await executeTask(settings, snapshot, caseId, rep, adapter)).evaluate()
}

// Runs in a disposable OS process. The parent kills the whole trial on deadline.
if (import.meta.main) {
  const payload = JSON.parse(readFileSync(0, 'utf8')) as {
    settings: Settings
    snapshot: Snapshot
    caseId: string
    rep: number
    fingerprint: string
  }
  let clean = (_text: string) =>
    'Benchmark provider initialization failed (details withheld to protect credentials)'
  try {
    const runtime = await resolveRuntime(payload.settings, true)
    clean = runtime.filter
    if (runtime.fingerprint !== payload.fingerprint)
      throw new Error('Model configuration changed during run')
    const result = await executeTrial(
      payload.settings,
      payload.snapshot,
      payload.caseId,
      payload.rep,
      runtime.adapter,
    )
    process.stdout.write(clean(JSON.stringify(result)))
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: clean(error instanceof Error ? error.message : String(error)) }),
    )
    process.exitCode = 1
  }
}
