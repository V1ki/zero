import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import filePlugin from '../../examples/file-summary'
import { digest, hash, measure, unknownUsage } from '../data'
import { compare, exportRecords, summarize } from '../report'
import { plan, runBenchmark } from '../runner'
import type { BenchmarkPlugin, RunOptions } from '../types'

const roots: string[] = []
function options(): RunOptions {
  const root = mkdtempSync(join(tmpdir(), 'zero-benchmark-platform-'))
  roots.push(root)
  return {
    out: join(root, 'run'),
    reps: 1,
    seed: 'test',
    limits: { timeoutMs: 1000, maxModelCalls: 10, maxToolCalls: 10 },
  }
}
function single(patch: Partial<BenchmarkPlugin> = {}): BenchmarkPlugin {
  return { ...filePlugin, variants: [filePlugin.variants[0]], ...patch }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('real file execution detects a known bad result and keeps evaluator costs separate', async () => {
  const opts = options()
  const rows = await runBenchmark(filePlugin, { ...opts, reps: 2 })
  expect(rows).toHaveLength(4)
  expect(rows.filter((r) => r.evaluation?.verdict === 'passed')).toHaveLength(2)
  expect(rows.filter((r) => r.evaluation?.verdict === 'failed')).toHaveLength(2)
  for (const row of rows) {
    expect(row.status).toBe('ok')
    expect(row.measurements.execution.toolCalls).toBe(2)
    expect(row.measurements.evaluation.toolCalls).toBe(1)
    expect(row.measurements.execution.modelCalls).toBe(0)
    expect(row.measurements.execution.unknownCostOperations).toBe(0)
    expect(row.provenance.sha256).toBe(digest(readFileSync(row.provenance.source)))
    expect(existsSync(row.evidence[0].ref)).toBe(true)
  }
  expect(new Set(rows.map((r) => r.evidence[0].ref)).size).toBe(4)
  expect(compare(rows, 'known-bad', 'correct').map((p) => p.result)).toEqual(['win', 'win'])
  const summary = summarize(rows)
  expect(summary[0].trials).toBe(2)
  expect(summary[0].cases).toBe(1)
  expect(summary[0].qualityMetrics[0].values.known).toBe(2)
  expect(readFileSync(join(opts.out, 'report.md'), 'utf8')).toContain('执行异常')
})

test('plan is repeatable, includes fingerprints and never runs lifecycle hooks', () => {
  const opts = options()
  const plugin = single({
    setup: async () => {
      throw new Error('must not execute')
    },
  })
  const jobs = plan(plugin, opts)
  expect(plan(plugin, opts)).toEqual(jobs)
  expect(existsSync(opts.out)).toBe(false)
  expect(
    plan({ ...plugin, environment: { ...plugin.environment, fingerprint: 'changed' } }, opts)[0]
      .comparisonKey,
  ).not.toBe(jobs[0].comparisonKey)
  expect(() => plan(plugin, { ...opts, reps: 0 })).toThrow()
  expect(() => plan({ ...plugin, targets: ['same', 'same'] }, opts)).toThrow()
})

test('refuses overwriting a run and duplicated imported trials', async () => {
  const opts = options()
  const rows = await runBenchmark(single(), opts)
  await expect(runBenchmark(single(), opts)).rejects.toThrow()
  expect(() => exportRecords(join(opts.out, 'import'), [rows[0], rows[0]])).toThrow(
    'Duplicate trial',
  )
  expect(existsSync(join(opts.out, 'import'))).toBe(false)
})

test('model failure preserves earlier use, marks incomplete totals unknown and hides raw payloads', async () => {
  const opts = options()
  const rows = await runBenchmark(
    single({
      async execute(ctx) {
        await ctx.model('test-model', { token: 'sensitive-test-marker' }, async () => ({
          value: 'private-result-marker',
          usage: { ...unknownUsage(), input: 7, output: 3 },
          cost: { amount: 0.1, currency: 'USD', basis: 'billed' },
        }))
        await ctx.model('test-model', {}, async () => {
          throw new Error('credential-in-error-marker')
        })
        return { outcome: 'completed' }
      },
    }),
    opts,
  )
  const row = rows[0]
  expect(row.status).toBe('error')
  expect(row.failureStage).toBe('execution')
  expect(row.operations[0].usage?.input).toBe(7)
  expect(row.measurements.execution.modelCalls).toBe(2)
  expect(row.measurements.execution.usage.input).toBeNull()
  expect(row.measurements.execution.costs[0].amount).toBe(0.1)
  expect(row.measurements.execution.unknownCostOperations).toBe(1)
  const events = readFileSync(row.provenance.source, 'utf8')
  expect(events).not.toContain('sensitive-test-marker')
  expect(events).not.toContain('private-result-marker')
  expect(events).not.toContain('credential-in-error-marker')
})

test('budgets prevent the next call even if plugin catches the exception', async () => {
  let calls = 0
  let cleanups = 0
  const opts = options()
  opts.limits.maxToolCalls = 1
  const rows = await runBenchmark(
    single({
      async execute(ctx) {
        await ctx.tool('first', {}, async () => {
          calls++
          return { value: true }
        })
        try {
          await ctx.tool('second', {}, async () => {
            calls++
            return { value: true }
          })
        } catch {
          /* Intentional plugin recovery attempt. */
        }
        return { outcome: 'completed' }
      },
      async cleanup() {
        cleanups++
      },
    }),
    opts,
  )
  expect(calls).toBe(1)
  expect(cleanups).toBe(1)
  expect(rows[0].status).toBe('budget_exceeded')
  expect(rows[0].evaluation).toBeNull()
})

test('cooperative timeout waits for cancellation and performs cleanup', async () => {
  let cleaned = false
  const opts = options()
  opts.limits.timeoutMs = 25
  const rows = await runBenchmark(
    single({
      async execute(ctx) {
        await ctx.tool(
          'waiting',
          {},
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
            }),
        )
        return { outcome: 'completed' }
      },
      async cleanup() {
        cleaned = true
      },
    }),
    opts,
  )
  expect(rows[0].status).toBe('timeout')
  expect(cleaned).toBe(true)
  expect(rows[0].measurements.execution.toolErrors).toBe(1)
})

test('setup, evaluator and cleanup failures remain distinguishable', async () => {
  let cleaned = 0
  const setup = await runBenchmark(
    single({
      async setup() {
        throw new Error('setup')
      },
      async cleanup() {
        cleaned++
      },
    }),
    options(),
  )
  const evaluation = await runBenchmark(
    single({
      async evaluate() {
        throw new Error('judge')
      },
    }),
    options(),
  )
  const cleanup = await runBenchmark(
    single({
      async cleanup() {
        throw new Error('cleanup')
      },
    }),
    options(),
  )
  expect(setup[0].failureStage).toBe('setup')
  expect(cleaned).toBe(1)
  expect(evaluation[0].failureStage).toBe('evaluation')
  expect(evaluation[0].measurements.execution.toolCalls).toBe(2)
  expect(cleanup[0].failureStage).toBe('cleanup')
  expect(summarize(cleanup)[0].accepted).toBe(0)
})

test('missing evidence cannot pass; path traversal cannot write an artifact', async () => {
  const invalid = await runBenchmark(
    single({
      async evaluate() {
        return {
          evaluator: 'independent-count-check',
          version: '1',
          verdict: 'passed',
          checks: [{ id: 'fake', passed: true, evidenceIds: ['missing'] }],
          metrics: [],
        }
      },
    }),
    options(),
  )
  expect(invalid[0].failureStage).toBe('evaluation')
  const opts = options()
  const escaped = await runBenchmark(
    single({
      async execute(ctx) {
        ctx.artifact('../escape.txt', 'bad')
        return { outcome: 'completed' }
      },
    }),
    opts,
  )
  expect(escaped[0].status).toBe('error')
  expect(existsSync(join(opts.out, 'trials', 'escape.txt'))).toBe(false)
})

test('environment and evaluator drift, missing pairs and pending reviews are not ties', async () => {
  const rows = await runBenchmark(filePlugin, options())
  const changed = structuredClone(rows)
  changed[0].environment.fingerprint = 'different'
  expect(compare(changed, 'known-bad', 'correct').every((p) => p.result === 'unresolved')).toBe(
    true,
  )
  const pending = structuredClone(rows)
  if (pending[0].evaluation) pending[0].evaluation.verdict = 'needs_review'
  expect(compare(pending, 'known-bad', 'correct')[0].result).toBe('unresolved')
  const drift = structuredClone(rows)
  if (drift[0].evaluation) drift[0].evaluation.version = '2'
  expect(compare(drift, 'known-bad', 'correct')[0].result).toBe('unresolved')
})

test('failed trials stay in denominator; missing measurements remain explicit', async () => {
  const rows = await runBenchmark(single(), options())
  const failure = structuredClone(rows[0])
  failure.id = 'failure'
  failure.status = 'error'
  failure.evaluation = null
  failure.measurements.execution.usage.input = null
  const group = summarize([...rows, failure])[0]
  expect(group.trials).toBe(2)
  expect(group.accepted).toBe(1)
  expect(group.execution.usage.input.missing).toBe(1)
})

test('token accounting does not double-count reasoning; costs keep currency and basis separate', async () => {
  const rows = await runBenchmark(single(), options())
  const example = rows[0].operations[0]
  const usage = { input: 10, cacheRead: 5, cacheWrite: 0, output: 20, reasoning: 12 }
  const result = measure([
    { ...example, kind: 'model', usage, cost: { amount: 1, currency: 'USD', basis: 'billed' } },
    {
      ...example,
      kind: 'model',
      usage,
      cost: { amount: 2, currency: 'CNY', basis: 'estimated', rateCard: 'test-v1' },
    },
  ])
  expect(result.usage.output).toBe(40)
  expect(result.usage.reasoning).toBe(24)
  expect(result.costs).toHaveLength(2)
  expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }))
  expect(() => hash(Number.NaN)).toThrow()
})
