import { join } from 'node:path'
import type {
  TaskTool,
  CloseAgentTool,
  SendInputTool,
  SpawnAgentTool,
  WaitAgentTool,
} from '@zero-os/core'
import type { BenchmarkToolContext } from '../harness'
import {
  buildSkippedResult,
  closeAgentIfPresent,
  extractSpawnAgentId,
  extractWaitPayload,
  measureScenario,
} from '../metrics'

function buildInstruction(ctx: BenchmarkToolContext): string {
  const filePath = join(ctx.projectRoot, 'packages/core/src/agent/agent-control.ts')
  return `Read and analyze "${filePath}". Produce a structured report covering the public API, state transitions, wait semantics, output extraction, and edge cases.`
}

const EXTRA_INPUT =
  'Also check if there are any TODO comments related to this file or its nearby agent-control tests, and mention the result explicitly.'

export const midFlightInputScenario = {
  name: 'mid-flight-input',
  description: 'Async-only scenario that sends extra input while the sub-agent is running.',
  async runLegacy(ctx: BenchmarkToolContext, _taskTool: TaskTool, runIndex?: number) {
    return buildSkippedResult(ctx, {
      scenario: 'mid-flight-input',
      path: 'legacy',
      output: 'N/A: legacy task tool has no equivalent to send_input during execution.',
      runIndex,
    })
  },
  async runAsync(
    ctx: BenchmarkToolContext,
    tools: {
      spawn: SpawnAgentTool
      wait: WaitAgentTool
      close: CloseAgentTool
      sendInput: SendInputTool
    },
    runIndex?: number,
  ) {
    let agentId: string | undefined

    try {
      return await measureScenario(ctx, {
        scenario: 'mid-flight-input',
        path: 'async',
        runIndex,
        execute: async () => {
          const spawnResult = await tools.spawn.run(ctx, {
            instruction: buildInstruction(ctx),
            role: 'explorer',
            label: 'mid-flight-input',
            tools: ['read', 'bash'],
            model: ctx.currentModel,
          })
          if (!spawnResult.success) {
            return spawnResult
          }

          agentId = extractSpawnAgentId(spawnResult)
          await Bun.sleep(2000)

          const sendResult = await tools.sendInput.run(ctx, {
            id: agentId,
            message: EXTRA_INPUT,
          })

          const waitResult = await tools.wait.run(ctx, { ids: [agentId], waitAll: true })
          const payload = extractWaitPayload(waitResult)
          const status = payload.statuses[agentId]
          const output = [sendResult.output, '', status?.output ?? waitResult.output].join('\n')
          const mentionsTodo = /\btodo\b/i.test(output) || /no todo/i.test(output)

          return {
            success:
              sendResult.success &&
              waitResult.success &&
              !payload.timedOut &&
              status?.state === 'completed' &&
              mentionsTodo,
            output,
            outputSummary: waitResult.outputSummary,
            artifacts: [],
          }
        },
      })
    } finally {
      await closeAgentIfPresent(ctx, tools.close, agentId)
    }
  },
}
