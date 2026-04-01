import { join } from 'node:path'
import type { TaskTool, CloseAgentTool, SpawnAgentTool, WaitAgentTool } from '@zero-os/core'
import type { BenchmarkToolContext } from '../harness'
import {
  closeAgentIfPresent,
  extractSpawnAgentId,
  extractWaitPayload,
  measureScenario,
} from '../metrics'

function buildInstruction(ctx: BenchmarkToolContext): string {
  const missingFile = join(ctx.projectRoot, 'packages/core/src/nonexistent-file.ts')
  return `Read the file "${missingFile}" and summarize it. If the file cannot be read, explain what failed.`
}

export const errorRecoveryScenario = {
  name: 'error-recovery',
  description: 'A sub-agent is asked to read a missing file.',
  async runLegacy(ctx: BenchmarkToolContext, taskTool: TaskTool, runIndex?: number) {
    return measureScenario(ctx, {
      scenario: 'error-recovery',
      path: 'legacy',
      runIndex,
      execute: () =>
        taskTool.run(ctx, {
          tasks: [
            {
              id: 'error_recovery',
              preset: 'explorer',
              instruction: buildInstruction(ctx),
              tools: ['read'],
            },
          ],
        }),
    })
  },
  async runAsync(
    ctx: BenchmarkToolContext,
    tools: { spawn: SpawnAgentTool; wait: WaitAgentTool; close: CloseAgentTool },
    runIndex?: number,
  ) {
    let agentId: string | undefined

    try {
      return await measureScenario(ctx, {
        scenario: 'error-recovery',
        path: 'async',
        runIndex,
        execute: async () => {
          const spawnResult = await tools.spawn.run(ctx, {
            instruction: buildInstruction(ctx),
            role: 'explorer',
            label: 'error-recovery',
            tools: ['read'],
            model: ctx.currentModel,
          })
          if (!spawnResult.success) {
            return spawnResult
          }

          agentId = extractSpawnAgentId(spawnResult)
          const waitResult = await tools.wait.run(ctx, { ids: [agentId], waitAll: true })
          const payload = extractWaitPayload(waitResult)
          const status = payload.statuses[agentId]

          return {
            success: waitResult.success && !payload.timedOut && status?.state === 'completed',
            output: status?.output ?? status?.error ?? waitResult.output,
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
