import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterLedgerStore } from '@zero-os/observe'
import type { CompletionRequest } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import {
  type RouterAgentInput,
  createRouterAgent,
} from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { captureProvider } from './provider-witness'

/** Use a real provider with a smaller declared window and an isolated source. */
export async function verifyContextWindow(
  output: string,
  deps: AgentDependencies,
  ledger: RouterLedgerStore,
  base: RouterAgentInput,
) {
  const { model, boundary, compare } = captureProvider(deps, { maxContext: 12000, maxOutput: 1500 })
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => model,
      getCurrentModel: () => model,
      trace: createRouterTraceSink(ledger, (text) => deps.secretFilter.filter(text)),
    },
  })
  const code = randomUUID().slice(0, 8)
  const rows = Array.from({ length: 3200 }, (_, i) => `货架 ${i}：已登记，无交接。`)
  rows.splice(2600, 0, `最终签收柜位 Q7，封条编号 ${code}。`)
  let reads = 0
  const answer = await ask({
    ...base,
    sessionId: 'context-window',
    question: '查看交接清册，找出“最终签收柜位”这一行，告诉我柜位和封条编号。只回复我。',
    actions: {
      capabilities: [
        {
          definition: {
            name: 'read_manifest',
            description: '读取本次交接清册的原始记录。',
            parameters: { type: 'object' },
          },
          execute() {
            reads++
            return rows.join('\n')
          },
        },
      ],
    },
  })
  const run = ledger.listRuns({ sessionId: 'context-window' })[0]
  const entries = ledger.entries(run.id)
  const requests = entries
    .filter((e) => e.kind === 'model_request')
    .map(
      (e) =>
        e.data as {
          request: CompletionRequest
          projection?: {
            inputTokenEstimate: number
            projectedTokenEstimate: number
            availableInputTokens: number
            originals: string[]
          }
        },
    )
  assert.equal(requests.length, boundary.length)
  const index = requests.findIndex((r) => r.projection)
  assert(index >= 0)
  const projected = requests[index].projection
  assert(projected)
  assert(
    projected.inputTokenEstimate > projected.availableInputTokens &&
      projected.projectedTokenEstimate <= projected.availableInputTokens,
  )
  const visible = (request: CompletionRequest) =>
    request.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_result').map((b) => b.content),
    )
  const witnessId = compare(ledger, 'context-window', entries)
  assert(!visible(boundary[index]).some((text) => text.includes(code)))
  assert(boundary.slice(index + 1).some((req) => visible(req).some((text) => text.includes(code))))
  assert(
    entries.some((e) => e.kind === 'tool_result' && JSON.stringify(e.data).includes(rows[2600])),
  )
  assert.equal(reads, 1)
  assert(answer.text.includes(code) && answer.text.includes('Q7'))
  writeFileSync(
    join(output, 'context-window.json'),
    JSON.stringify(
      {
        runId: run.id,
        providerWitness: witnessId,
        model: model.modelConfig.modelId,
        window: 12000,
        outputReservation: 1500,
        providerCalls: boundary.length,
        reads,
        projection: projected,
        answer: answer.text,
      },
      null,
      2,
    ),
  )
}
