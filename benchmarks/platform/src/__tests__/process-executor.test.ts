import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessExecutor } from '../process-executor'
import { runBenchmark } from '../runner'
import createPlugin from './fixtures/process-plugin'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function run(hang: boolean, reps = 1) {
  const root = mkdtempSync(join(tmpdir(), 'zero-bench-process-'))
  roots.push(root)
  return runBenchmark(
    createPlugin({ hang }),
    {
      out: join(root, 'run'),
      reps,
      concurrency: 2,
      seed: 'test',
      limits: { timeoutMs: hang ? 800 : 5000, maxModelCalls: 5, maxToolCalls: 5 },
    },
    {
      executor: createProcessExecutor({
        modulePath: join(import.meta.dir, 'fixtures/process-plugin.ts'),
        config: { hang },
        cwd: process.cwd(),
      }),
    },
  )
}

test('process executor runs the same native lifecycle with isolated parallel trials', async () => {
  const rows = await run(false, 2)
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((r) => r.evidence[0].ref)).size).toBe(2)
  for (const row of rows) {
    expect(row.status).toBe('ok')
    expect(row.provenance.kind).toBe('native')
    expect(row.measurements.execution.usage.input).toBe(10)
    expect(row.evaluation?.verdict).toBe('passed')
    expect(readFileSync(row.provenance.source, 'utf8')).toContain('operation-start')
  }
})

test('hard deadline kills a non-cooperative worker and retains completed and in-flight calls', async () => {
  const rows = await run(true)
  const row = rows[0]
  expect(row.status).toBe('timeout')
  expect(row.operations).toHaveLength(2)
  expect(row.operations[0].usage?.input).toBe(10)
  expect(row.operations[1].usage).toBeNull()
  expect(row.measurements.execution.modelCalls).toBe(2)
  expect(row.measurements.execution.usage.input).toBeNull()
  expect(row.evaluation).toBeNull()
  expect(row.durationMs).toBeLessThan(4000)
})
