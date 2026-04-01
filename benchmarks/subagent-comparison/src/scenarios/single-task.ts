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
  const targetDir = join(ctx.projectRoot, 'packages/core/src/agent')
  return `Using the repository rooted at "${ctx.projectRoot}", list all TypeScript files in "${targetDir}" and count them. Report the file names and the total count.`
}

export const singleTaskScenario = {
  name: 'single-task',
  description: 'One sub-agent performs a simple file listing and count.',
  async runLegacy(ctx: BenchmarkToolContext, taskTool: TaskTool, runIndex?: number) {
    return measureScenario(ctx, {
      scenario: 'single-task',
      path: 'legacy',
      runIndex,
      execute: () =>
        taskTool.run(ctx, {
          tasks: [
            {
              id: 'single_task',
              preset: 'explorer',
              instruction: buildInstruction(ctx),
              tools: ['bash'],
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
        scenario: 'single-task',
        path: 'async',
        runIndex,
        execute: async () => {
          const spawnResult = await tools.spawn.run(ctx, {
            instruction: buildInstruction(ctx),
            role: 'explorer',
            label: 'single-task',
            tools: ['bash'],
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
            output: status?.output ?? waitResult.output,
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
