import type { BenchmarkPlugin } from '../../types'

export default function create(config: { hang?: boolean }): BenchmarkPlugin {
  return {
    apiVersion: 1,
    id: 'process-fixture',
    version: '1',
    environment: { mode: 'controlled', fingerprint: 'process-fixture' },
    evaluator: { id: 'fixture', version: '1' },
    cases: [
      {
        id: 'fixture',
        family: 'fixture',
        sourceGroup: 'fixture',
        inputHash: 'input',
        contractHash: 'contract',
      },
    ],
    variants: [{ id: 'v1', fingerprint: 'v1' }],
    targets: ['local'],
    async execute(ctx) {
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      await ctx.model('fixture', { marker: 'first' }, async () => ({ value: 'ok', usage }))
      if (config.hang) {
        await ctx.model('fixture', { marker: 'second' }, async () => {
          setInterval(() => {}, 1000)
          return new Promise<never>(() => {})
        })
      }
      return { outcome: 'completed', value: ctx.artifact('result.json', '{"ok":true}') }
    },
    async evaluate(_ctx, execution) {
      return {
        evaluator: 'fixture',
        version: '1',
        verdict: 'passed',
        checks: [{ id: 'ok', passed: true, evidenceIds: [(execution.value as { id: string }).id] }],
        metrics: [],
      }
    },
  }
}
