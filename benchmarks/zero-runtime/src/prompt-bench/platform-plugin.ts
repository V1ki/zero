import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { hash as platformHash } from '../../../platform/src/data'
import type { BenchmarkPlugin, Context, TrialRecord } from '../../../platform/src/types'
import { TOOLS } from './cases'
import {
  type Settings,
  type TaskExecution,
  type Trial,
  executeTask,
  resolveRuntime,
} from './engine'
import { type Snapshot, hash, suiteHash } from './snapshot'
import { getSuite } from './suites'

export interface PromptPluginConfig {
  settings: Omit<Settings, 'model'>
  snapshots: Snapshot[]
  targets: Array<{ model: string; fingerprint: string }>
  caseIds: string[]
}
type Runtime = {
  adapter: Pick<ProviderAdapter, 'complete'>
  fingerprint: string
  filter(text: string): string
}
type RuntimeFactory = (settings: Settings, credentials: boolean) => Promise<Runtime>
type State = { task: TaskExecution; clean(text: string): string }

const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const free = { amount: 0, currency: 'USD', basis: 'declared-free' as const }

/** Factory performs no credential reads or model calls. Those occur only in execute. */
export default function createPromptPlugin(
  config: PromptPluginConfig,
  runtimeFactory: RuntimeFactory = resolveRuntime,
): BenchmarkPlugin {
  const snapshots = config.snapshots
  if (!snapshots.length) throw new Error('Snapshots required')
  const suiteName = snapshots[0].suite ?? 'basic'
  for (const snapshot of snapshots) {
    const { hash: checksum, ...body } = snapshot
    if (
      snapshot.schema !== 1 ||
      hash(body) !== checksum ||
      (snapshot.suite ?? 'basic') !== suiteName ||
      snapshot.suiteHash !== suiteHash(suiteName)
    )
      throw new Error('Snapshot or suite drift')
  }
  if (!config.caseIds.length || new Set(config.caseIds).size !== config.caseIds.length)
    throw new Error('Invalid case selection')
  const suite = getSuite(suiteName)
  const cases = [...suite.agent, ...suite.closure]
  const harness = [
    'platform-plugin.ts',
    'engine.ts',
    'sandbox.ts',
    'cases.ts',
    'advanced.ts',
    'real.ts',
    'suites.ts',
    'snapshot.ts',
  ].map((name) => [name, hash(readFileSync(join(import.meta.dir, name), 'utf8'))])
  const platformHarness = [
    'runner.ts',
    'process-executor.ts',
    'process-worker.ts',
    'data.ts',
    'types.ts',
  ].map((name) => [
    name,
    hash(readFileSync(join(import.meta.dir, '../../../platform/src', name), 'utf8')),
  ])
  const environment = platformHash({
    suiteHash: suiteHash(suiteName),
    harness,
    platformHarness,
    tools: TOOLS,
    targets: config.targets,
    reasoning: config.settings.reasoning,
    maxTokens: config.settings.maxTokens,
    maxSteps: config.settings.maxSteps,
    emptyResponseRetries: config.settings.emptyResponseRetries ?? 0,
  })
  const persist = (context: Context, trial: Trial, clean: State['clean']) =>
    context.artifact('legacy-trial.json', clean(JSON.stringify(trial)))
  return {
    apiVersion: 1,
    id: `zero-prompt-${suiteName}`,
    version: 'native-v1',
    environment: { mode: 'simulated', fingerprint: environment },
    evaluator: {
      id: 'prompt-mechanical',
      version: hash(readFileSync(join(import.meta.dir, 'sandbox.ts'), 'utf8')),
    },
    cases: config.caseIds.map((id) => {
      const fixture = cases.find((c) => c.id === id)
      if (!fixture) throw new Error('Unknown case')
      return {
        id,
        family: suite.closure.some((c) => c.id === id) ? 'closure-classification' : 'agent-task',
        sourceGroup: suiteName === 'real' ? 'frozen-real-replay-v1' : id,
        inputHash: platformHash(fixture),
        contractHash: platformHash({
          fixture,
          grader: harness.find(([name]) => name === 'sandbox.ts'),
        }),
      }
    }),
    variants: snapshots.map((s) => ({ id: s.label, fingerprint: s.hash })),
    targets: config.targets.map((t) => t.model),
    async execute(context) {
      const snapshot = snapshots.find((s) => s.label === context.variant.id)
      const target = config.targets.find((t) => t.model === context.target)
      if (!snapshot || !target) throw new Error('Unknown variant or target')
      const settings = { ...config.settings, model: context.target }
      const runtime = await runtimeFactory(settings, true)
      if (runtime.fingerprint !== target.fingerprint)
        throw new Error('Model configuration changed during run')
      const adapter: Pick<ProviderAdapter, 'complete'> = {
        complete: (request) =>
          context.model(context.target, jsonValue(request), async () => {
            const response = await runtime.adapter.complete(request)
            return {
              value: JSON.parse(JSON.stringify(response)) as typeof response,
              actualModel: response.model,
              usage: {
                input: response.usage.input,
                output: response.usage.output,
                cacheRead: response.usage.cacheRead ?? null,
                cacheWrite: response.usage.cacheWrite ?? null,
                reasoning: response.usage.reasoning ?? null,
              },
            }
          }),
      }
      const task = await executeTask(
        settings,
        snapshot,
        context.case.id,
        context.rep,
        adapter,
        (call, run) =>
          context.tool(call.name, call.input, async () => {
            const value = run()
            return {
              value,
              status: value.type === 'tool_result' && value.isError ? 'error' : 'ok',
              cost: free,
            }
          }),
      )
      if (task.trial.status !== 'ok') {
        persist(context, task.trial, runtime.filter)
        throw new Error('Prompt execution failed; see filtered trial evidence')
      }
      const state: State = { task, clean: runtime.filter }
      return { outcome: task.finished ? 'completed' : 'partial', value: state }
    },
    async evaluate(context, execution) {
      const state = execution.value as State
      const trial = state.task.evaluate()
      const evidence = persist(context, trial, state.clean)
      const checks = [
        ['task-pass', trial.passed],
        ...Object.entries(trial.grade?.checks ?? {}),
      ] as Array<[string, boolean]>
      return {
        evaluator: 'prompt-mechanical',
        version: hash(readFileSync(join(import.meta.dir, 'sandbox.ts'), 'utf8')),
        verdict: trial.passed ? 'passed' : 'failed',
        checks: checks.map(([id, passed]) => ({ id, passed, evidenceIds: [evidence.id] })),
        metrics: [
          {
            id: 'empty-responses',
            value: trial.emptyResponses ?? 0,
            unit: 'responses',
            direction: 'lower',
          },
          {
            id: 'empty-retries',
            value: trial.emptyRetries ?? 0,
            unit: 'requests',
            direction: 'lower',
          },
          {
            id: 'empty-recovered',
            value: trial.emptyRecovered ?? 0,
            unit: 'responses',
            direction: 'none',
          },
        ],
      }
    },
  }
}

/** Compatibility reports are derived from the native run, never imported back into it. */
export function legacyTrialFromRecord(row: TrialRecord): Trial {
  const evidence = row.evidence.find((e) => basename(e.ref) === 'legacy-trial.json')
  if (evidence) {
    const trial = JSON.parse(readFileSync(evidence.ref, 'utf8')) as Trial
    if (
      trial.caseId !== row.case.id ||
      trial.model !== row.target ||
      trial.snapshotHash !== row.variant.fingerprint ||
      trial.rep !== row.rep
    )
      throw new Error('Legacy artifact identity mismatch')
    if (row.status !== 'ok') {
      trial.status = row.status === 'timeout' ? 'timeout' : 'error'
      trial.passed = false
    }
    return trial
  }
  const m = row.measurements.execution
  return {
    id: `${row.target}/${row.case.id}/${row.rep}/${row.variant.id}`,
    model: row.target,
    variant: row.variant.id,
    snapshotHash: row.variant.fingerprint,
    caseId: row.case.id,
    rep: row.rep,
    status: row.status === 'timeout' ? 'timeout' : 'error',
    passed: false,
    durationMs: row.durationMs ?? 0,
    usage: { input: m.usage.input ?? 0, output: m.usage.output ?? 0 },
    requests: m.modelCalls ?? 0,
    responseModels: row.operations.flatMap((o) => (o.actualModel ? [o.actualModel] : [])),
    messages: [],
    observations: [],
    error: `Native trial ${row.status}; incomplete legacy fields. Use platform events and nullable usage as authoritative.`,
  }
}
