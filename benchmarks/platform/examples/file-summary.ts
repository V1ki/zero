import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hash } from '../src/data'
import type { BenchmarkPlugin, Evidence } from '../src/types'

const input = [{ stage: 'FEED' }, { stage: 'FEED' }, { stage: 'execution' }]
const free = { amount: 0, currency: 'USD', basis: 'declared-free' as const }

/** A real local-file task; the intentionally bad variant calibrates the evaluator. */
const plugin: BenchmarkPlugin = {
  apiVersion: 1,
  id: 'file-summary-control',
  version: '1',
  environment: { mode: 'controlled', fingerprint: hash(['local-file-io', input]) },
  evaluator: { id: 'independent-count-check', version: '1' },
  cases: [
    {
      id: 'stage-count',
      family: 'file-processing',
      sourceGroup: 'synthetic-control',
      inputHash: hash(input),
      contractHash: hash({ required: { total: 3, FEED: 2, execution: 1 } }),
    },
  ],
  variants: [
    { id: 'correct', fingerprint: hash('count-all-v1') },
    { id: 'known-bad', fingerprint: hash('skip-first-v1') },
  ],
  targets: ['local'],
  async setup(context) {
    await writeFile(join(context.workspace, 'input.json'), JSON.stringify(input))
  },
  async execute(context) {
    const rows = await context.tool('read-json', { path: 'input.json' }, async () => ({
      value: JSON.parse(
        await readFile(join(context.workspace, 'input.json'), 'utf8'),
      ) as typeof input,
      cost: free,
    }))
    const selected = context.variant.id === 'correct' ? rows : rows.slice(1)
    const summary = {
      total: rows.length,
      FEED: selected.filter((r) => r.stage === 'FEED').length,
      execution: selected.filter((r) => r.stage === 'execution').length,
    }
    const evidence = await context.tool('write-summary', { summary }, async () => ({
      value: context.artifact('summary.json', JSON.stringify(summary)),
      cost: free,
    }))
    return { outcome: 'completed', value: evidence }
  },
  async evaluate(context, execution) {
    const evidence = execution.value as Evidence
    const summary = await context.tool('verify-file', { path: 'summary.json' }, async () => ({
      value: JSON.parse(await readFile(join(context.workspace, 'summary.json'), 'utf8')) as Record<
        string,
        number
      >,
      cost: free,
    }))
    const correct = summary.total === 3 && summary.FEED === 2 && summary.execution === 1
    return {
      evaluator: 'independent-count-check',
      version: '1',
      verdict: correct ? 'passed' : 'failed',
      checks: [{ id: 'exact-counts', passed: correct, evidenceIds: [evidence.id] }],
      metrics: [
        {
          id: 'matched-fields',
          value:
            Number(summary.total === 3) +
            Number(summary.FEED === 2) +
            Number(summary.execution === 1),
          unit: 'fields',
          direction: 'higher',
        },
      ],
    }
  },
}
export default plugin
