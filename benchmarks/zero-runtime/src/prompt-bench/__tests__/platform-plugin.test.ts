import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompletionRequest, CompletionResponse, ToolUseBlock } from '@zero-os/shared'
import { runBenchmark } from '../../../../platform/src/runner'
import type { RunOptions } from '../../../../platform/src/types'
import { executeTask, executeTrial } from '../engine'
import createPromptPlugin, {
  type PromptPluginConfig,
  legacyTrialFromRecord,
} from '../platform-plugin'
import { loadSnapshot } from '../snapshot'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function config(caseId = 'no-memory'): PromptPluginConfig {
  return {
    settings: {
      root: process.cwd(),
      config: '',
      catalog: '',
      secretSource: 'env',
      reasoning: 'medium',
      maxTokens: 1000,
      maxSteps: 6,
      emptyResponseRetries: 1,
    },
    snapshots: [
      loadSnapshot(join(import.meta.dir, '../../../fixtures/prompt-bench/before-20260905.json')),
    ],
    targets: [{ model: 'fixture/test', fingerprint: 'fixture' }],
    caseIds: [caseId],
  }
}
function options(): RunOptions {
  const root = mkdtempSync(join(tmpdir(), 'zero-native-prompt-'))
  roots.push(root)
  return {
    out: join(root, 'run'),
    reps: 1,
    seed: 'native-test',
    limits: { timeoutMs: 5000, maxModelCalls: 6, maxToolCalls: 20 },
  }
}
function scripted(responses: Array<Partial<CompletionResponse>>) {
  const requests: CompletionRequest[] = []
  return {
    requests,
    complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
      const response = responses[requests.length]
      requests.push(structuredClone(request))
      if (!response) throw new Error('fixture-provider-error')
      return {
        id: 'fixture',
        model: 'test',
        content: [],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
        ...response,
      }
    },
  }
}
const call = (name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: 'tool_use',
  id: name,
  name,
  input,
})
const runtime = (adapter: ReturnType<typeof scripted>) => async () => ({
  adapter,
  fingerprint: 'fixture',
  filter: (text: string) => text.replaceAll('PRIVATE_CANARY', '[redacted]'),
})

test('native plugin preserves requests, tool order and grades; scoring occurs in evaluation phase', async () => {
  const cfg = config('authorized-edit')
  const responses: Array<Partial<CompletionResponse>> = [
    { stopReason: 'tool_use', content: [call('read', { path: '/benchmark/config.json' })] },
    {
      stopReason: 'tool_use',
      content: [
        call('write', { path: '/benchmark/config.json', content: '{"retries":4}' }),
        call('bash', { command: 'bun test' }),
      ],
    },
    { content: [{ type: 'text', text: '已改为4，测试通过。' }] },
  ]
  const legacyAdapter = scripted(responses)
  const nativeAdapter = scripted(responses)
  const legacy = await executeTrial(
    { ...cfg.settings, model: 'fixture/test' },
    cfg.snapshots[0],
    cfg.caseIds[0],
    1,
    legacyAdapter,
  )
  const rows = await runBenchmark(createPromptPlugin(cfg, runtime(nativeAdapter)), options())
  const row = rows[0]
  expect(row.status).toBe('ok')
  expect(row.provenance.kind).toBe('native')
  expect(row.evaluation?.verdict).toBe('passed')
  expect(legacyTrialFromRecord(row).grade).toEqual(legacy.grade)
  expect(nativeAdapter.requests).toEqual(legacyAdapter.requests)
  expect(row.operations.map((o) => (o.kind === 'model' ? 'model' : o.name))).toEqual([
    'model',
    'read',
    'model',
    'write',
    'bash',
    'model',
  ])
  expect(row.measurements.execution).toMatchObject({
    modelCalls: 3,
    toolCalls: 3,
    usage: { input: 30, output: 15, cacheRead: 9, cacheWrite: 6, reasoning: 3 },
  })
  expect(row.measurements.evaluation.modelCalls).toBe(0)
  const events = readFileSync(row.provenance.source, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s))
  expect(events.findIndex((e) => e.event === 'stage' && e.stage === 'evaluation')).toBeLessThan(
    events.findIndex((e) => e.event === 'artifact'),
  )
})

test('standalone engine can defer its grader without changing compatibility API', async () => {
  const cfg = config()
  const task = await executeTask(
    { ...cfg.settings, model: 'fixture/test' },
    cfg.snapshots[0],
    'no-memory',
    1,
    scripted([{ content: [{ type: 'text', text: '42' }] }]),
  )
  expect(task.trial.grade).toBeUndefined()
  expect(task.trial.passed).toBe(false)
  expect(task.evaluate().passed).toBe(true)
})

test('empty retry is a second physical model operation with the identical request', async () => {
  const adapter = scripted([
    { content: [] },
    { content: [{ type: 'text', text: '42 PRIVATE_CANARY' }] },
  ])
  const row = (await runBenchmark(createPromptPlugin(config(), runtime(adapter)), options()))[0]
  expect(row.evaluation?.verdict).toBe('passed')
  expect(row.operations).toHaveLength(2)
  expect(row.operations[0].inputHash).toBe(row.operations[1].inputHash)
  expect(row.measurements.execution.modelCalls).toBe(2)
  expect(legacyTrialFromRecord(row).emptyRecovered).toBe(1)
  expect(readFileSync(row.evidence[0].ref, 'utf8')).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(row.provenance.source, 'utf8')).not.toContain('PRIVATE_CANARY')
})

test('recoverable tool errors are recorded, not silently counted as successes', async () => {
  const adapter = scripted([
    {
      stopReason: 'tool_use',
      content: [
        call('read', { path: '/benchmark/missing' }),
        call('read', { path: '/benchmark/config.json' }),
      ],
    },
    { content: [{ type: 'text', text: '2' }] },
  ])
  const row = (
    await runBenchmark(createPromptPlugin(config('minimal-analysis'), runtime(adapter)), options())
  )[0]
  expect(row.evaluation?.verdict).toBe('passed')
  expect(row.measurements.execution.toolErrors).toBe(1)
  expect(row.measurements.execution.tools.read).toMatchObject({ calls: 2, errors: 1 })
})

test('platform tool budget aborts a batch without performing remaining effects', async () => {
  const adapter = scripted([
    {
      stopReason: 'tool_use',
      content: [
        call('read', { path: '/benchmark/config.json' }),
        call('write', { path: '/benchmark/config.json', content: 'bad' }),
      ],
    },
  ])
  const opts = options()
  opts.limits.maxToolCalls = 1
  const row = (
    await runBenchmark(createPromptPlugin(config('authorized-edit'), runtime(adapter)), opts)
  )[0]
  expect(row.status).toBe('budget_exceeded')
  expect(row.measurements.execution.toolCalls).toBe(1)
  expect(legacyTrialFromRecord(row).observations.some((o) => o.name === 'write')).toBe(false)
})

test('physical model mismatch fails but retains actual billed usage; provider failure stays unknown', async () => {
  const mismatch = (
    await runBenchmark(
      createPromptPlugin(
        config(),
        runtime(scripted([{ model: 'unexpected', content: [{ type: 'text', text: '42' }] }])),
      ),
      options(),
    )
  )[0]
  expect(mismatch.status).toBe('error')
  expect(mismatch.operations[0].actualModel).toBe('unexpected')
  expect(mismatch.measurements.execution.usage.input).toBe(10)
  const failure = (
    await runBenchmark(createPromptPlugin(config(), runtime(scripted([]))), options())
  )[0]
  expect(failure.status).toBe('error')
  expect(failure.measurements.execution.usage.input).toBeNull()
  expect(failure.measurements.execution.modelCalls).toBe(1)
})

test('closure task model use is execution cost, not evaluator cost', async () => {
  const row = (
    await runBenchmark(
      createPromptPlugin(
        config('closure-summary'),
        runtime(
          scripted([{ content: [{ type: 'text', text: '{"action":"finish","reason":"完成"}' }] }]),
        ),
      ),
      options(),
    )
  )[0]
  expect(row.case.family).toBe('closure-classification')
  expect(row.evaluation?.verdict).toBe('passed')
  expect(row.measurements.execution.modelCalls).toBe(1)
  expect(row.measurements.evaluation.modelCalls).toBe(0)
})

test('planning checks snapshots without reading credentials; changed fixtures fail closed', () => {
  let calls = 0
  const cfg = config()
  createPromptPlugin(cfg, async () => {
    calls++
    throw new Error('should not initialize')
  })
  expect(calls).toBe(0)
  cfg.snapshots[0].systems.full += 'changed'
  expect(() => createPromptPlugin(cfg, runtime(scripted([])))).toThrow('Snapshot or suite drift')
})
