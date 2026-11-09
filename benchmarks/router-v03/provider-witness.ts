import assert from 'node:assert/strict'
import type { RouterLedgerStore } from '@zero-os/observe'
import type { CompletionRequest, RouterTraceEntry } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'

/** Capture the adapter boundary independently of AgentLoop's trace hooks, then compare like-for-like redacted requests. */
export function captureProvider(
  deps: AgentDependencies,
  limits?: { maxContext: number; maxOutput: number },
) {
  const current = deps.modelRouter.getDefaultModel() ?? deps.modelRouter.getCurrentModel()
  assert(current)
  const boundary: CompletionRequest[] = []
  const model = {
    ...current,
    modelConfig: { ...current.modelConfig, ...limits },
    adapter: {
      apiType: current.adapter.apiType,
      stream: current.adapter.stream.bind(current.adapter),
      healthCheck: current.adapter.healthCheck.bind(current.adapter),
      complete: async (req: CompletionRequest) => {
        boundary.push(structuredClone(req))
        return current.adapter.complete(req)
      },
    },
  }
  return {
    model,
    boundary,
    compare(ledger: RouterLedgerStore, sessionId: string, entries: RouterTraceEntry[]) {
      const run = ledger.getRun(entries[0].runId)
      assert(run)
      const previousCount = ledger
        .listRuns({ sessionId, before: run.ordinal })
        .reduce(
          (count, previous) =>
            count + ledger.entries(previous.id).filter((e) => e.kind === 'model_request').length,
          0,
        )
      const requests = entries.filter((entry) => entry.kind === 'model_request')
      const captured = boundary
        .filter((req) => req.meta?.sessionId === sessionId)
        .slice(previousCount, previousCount + requests.length)
      assert(captured.length && captured.length === requests.length)
      const witness = createRouterTraceSink(ledger, (text) => deps.secretFilter.filter(text))
      const id = witness.begin('acceptance-provider-boundary', '适配器实际收到的请求', {
        sessionId,
      })
      for (const request of captured) witness.append(id, 'model_request', { request })
      witness.end(id, 'completed')
      const records = ledger.entries(id).filter((e) => e.kind === 'model_request')
      for (const [i, record] of records.entries())
        assert.deepEqual(
          (record.data as { request: CompletionRequest }).request,
          (requests[i].data as { request: CompletionRequest }).request,
        )
      return id
    },
  }
}
