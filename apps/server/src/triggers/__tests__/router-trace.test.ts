import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { RouterLedgerStore } from '@zero-os/observe'
import type { CompletionResponse } from '@zero-os/shared'
import { runTriggerModel } from '../event-agent'
import { createRouterTraceSink } from '../router-trace'

test('records the actual model requests including tool feedback and filters nested secrets', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const trace = createRouterTraceSink(ledger, (text) =>
      text.replaceAll('test-secret', '[REDACTED]'),
    )
    let calls = 0
    const adapter: ProviderAdapter = {
      apiType: 'test',
      healthCheck: async () => true,
      stream() {
        throw Error('unexpected')
      },
      async complete(request): Promise<CompletionResponse> {
        calls++
        if (calls === 2) expect(JSON.stringify(request.messages)).toContain('核实的结果')
        return {
          id: `response-${calls}`,
          model: 'test',
          usage: { input: 10, output: 4 },
          stopReason: calls === 1 ? 'tool_use' : 'end_turn',
          content:
            calls === 1
              ? [
                  {
                    type: 'tool_use',
                    name: 'inspect',
                    id: 'call-1',
                    input: { password: 'hidden-value', text: 'test-secret' },
                  },
                ]
              : [
                  { type: 'thinking', thinking: 'private-reasoning' },
                  { type: 'text', text: '已核实。' },
                ],
        }
      },
    }
    const output = await runTriggerModel(
      { trace, getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
      {
        sessionId: 'owner-main',
        label: 'Router',
        system: 'role',
        prompt: '请核实',
        toolset: {
          definitions: [{ name: 'inspect', description: '核实', parameters: { type: 'object' } }],
          execute: async () => '核实的结果 test-secret',
        },
      },
    )
    expect(output).toBe('已核实。')
    const run = ledger.listRuns()[0]
    expect(run.status).toBe('completed')
    const entries = ledger.entries(run.id)
    expect(entries.filter((e) => e.kind === 'model_request')).toHaveLength(2)
    expect(entries.map((e) => e.kind)).toEqual([
      'input',
      'model_request',
      'model_response',
      'tool_start',
      'tool_result',
      'model_request',
      'model_response',
      'result',
    ])
    const encoded = JSON.stringify(entries)
    expect(encoded).toContain('核实的结果')
    for (const secret of ['test-secret', 'hidden-value', 'private-reasoning'])
      expect(encoded).not.toContain(secret)
  } finally {
    db.close()
  }
})

test('explicit Worker cancellation preserves evidence and prevents later effects', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const controller = new AbortController()
    let calls = 0
    let effects = 0
    const adapter: ProviderAdapter = {
      apiType: 'test',
      healthCheck: async () => true,
      stream() {
        throw Error('unexpected')
      },
      async complete(): Promise<CompletionResponse> {
        calls++
        if (calls === 2) controller.abort()
        return {
          id: `response-${calls}`,
          model: 'fixture',
          usage: { input: 10, output: 10 },
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', name: 'read_evidence', id: `call-${calls}`, input: {} }],
        }
      },
    }
    await expect(
      runTriggerModel(
        {
          trace: createRouterTraceSink(ledger, (s) => s),
          getDefaultModel: () => ({ adapter }),
          getCurrentModel: () => undefined,
        },
        {
          sessionId: 'router-job-7',
          label: 'Worker',
          system: '核查',
          prompt: '核查公开事实',
          traceContext: { workerId: 7 },
          signal: controller.signal,
          toolset: {
            definitions: [
              { name: 'read_evidence', description: 'read', parameters: { type: 'object' } },
            ],
            execute: async () => {
              effects++
              return '原始资料已取得'
            },
          },
        },
      ),
    ).rejects.toThrow('已保存 1 条工具结果')
    expect(effects).toBe(1)
    const run = ledger.listRuns()[0]
    expect(run.status).toBe('failed')
    expect(ledger.entries(run.id).filter((e) => e.kind === 'tool_result')).toHaveLength(1)
  } finally {
    db.close()
  }
})

test.each(['worker', 'router'])(
  '%s keeps tools available beyond former iteration, call, token and cost quotas',
  async (role) => {
    const db = new Database(':memory:')
    try {
      const ledger = new RouterLedgerStore(db)
      let calls = 0
      let effects = 0
      const definitions = [{ name: 'read', description: 'read', parameters: { type: 'object' } }]
      const adapter: ProviderAdapter = {
        apiType: 'test',
        healthCheck: async () => true,
        stream() {
          throw Error('unexpected')
        },
        async complete(request): Promise<CompletionResponse> {
          calls++
          expect(request.tools).toEqual(definitions)
          expect(request.maxTokens).toBeUndefined()
          expect(request.system).toBe('核实证据，直到完成目标。')
          return {
            id: `response-${calls}`,
            model: 'fixture',
            usage: { input: 500_000, output: 10 },
            stopReason: calls <= 40 ? 'tool_use' : 'end_turn',
            content:
              calls <= 40
                ? Array.from({ length: 2 }, (_, index) => ({
                    type: 'tool_use' as const,
                    name: 'read',
                    id: `read-${calls}-${index}`,
                    input: {},
                  }))
                : [{ type: 'text', text: '全部核查已完成。' }],
          }
        },
      }
      const result = await runTriggerModel(
        {
          trace: createRouterTraceSink(ledger, (s) => s),
          getDefaultModel: () => ({ adapter, modelConfig: { pricing: { input: 10, output: 30 } } }),
          getCurrentModel: () => undefined,
        },
        {
          sessionId: `${role}-no-quota`,
          label: role,
          traceContext: role === 'worker' ? { workerId: 7 } : {},
          system: '核实证据，直到完成目标。',
          prompt: '核实证据',
          toolset: {
            definitions,
            execute: async () => {
              effects++
              return '已取得一项证据'
            },
          },
        },
      )
      expect(result).toBe('全部核查已完成。')
      expect(calls).toBe(41)
      expect(effects).toBe(80)
      const run = ledger.listRuns()[0]
      expect(run.status).toBe('completed')
      const response = ledger.entries(run.id).find((entry) => entry.kind === 'model_response')
      expect(response?.data).toMatchObject({
        usageTotals: { usedTokens: 500_010, estimatedCostUsd: 5.0003 },
      })
    } finally {
      db.close()
    }
  },
)
