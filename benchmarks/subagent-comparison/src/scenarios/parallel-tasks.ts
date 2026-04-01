import { join } from 'node:path'
import type { TaskTool, CloseAgentTool, SpawnAgentTool, WaitAgentTool } from '@zero-os/core'
import type { BenchmarkToolContext } from '../harness'
import {
  closeAgentIfPresent,
  extractSpawnAgentId,
  extractWaitPayload,
  measureScenario,
} from '../metrics'

function buildTaskDefinitions(ctx: BenchmarkToolContext) {
  return [
    {
      id: 'count_tool_ts',
      label: 'count-tool-ts',
      instruction: `Count all .ts files under "${join(ctx.projectRoot, 'packages/core/src/tool')}". Report the total count and the file names.`,
    },
    {
      id: 'count_agent_ts',
      label: 'count-agent-ts',
      instruction: `Count all .ts files under "${join(ctx.projectRoot, 'packages/core/src/agent')}". Report the total count and the file names.`,
    },
    {
      id: 'count_shared_ts',
      label: 'count-shared-ts',
      instruction: `Count all .ts files under "${join(ctx.projectRoot, 'packages/shared/src')}". Report the total count and the file names.`,
    },
  ]
}

export const parallelTasksScenario = {
  name: 'parallel-tasks',
  description: 'Three independent sub-agent tasks run concurrently.',
  async runLegacy(ctx: BenchmarkToolContext, taskTool: TaskTool, runIndex?: number) {
    const tasks = buildTaskDefinitions(ctx)

    return measureScenario(ctx, {
      scenario: 'parallel-tasks',
      path: 'legacy',
      runIndex,
      execute: () =>
        taskTool.run(ctx, {
          tasks: tasks.map((task) => ({
            id: task.id,
            preset: 'explorer',
            instruction: task.instruction,
            tools: ['bash'],
          })),
        }),
    })
  },
  async runAsync(
    ctx: BenchmarkToolContext,
    tools: { spawn: SpawnAgentTool; wait: WaitAgentTool; close: CloseAgentTool },
    runIndex?: number,
  ) {
    const agentIds: string[] = []

    try {
      return await measureScenario(ctx, {
        scenario: 'parallel-tasks',
        path: 'async',
        runIndex,
        execute: async () => {
          const spawnResults = await Promise.all(
            buildTaskDefinitions(ctx).map((task) =>
              tools.spawn.run(ctx, {
                instruction: task.instruction,
                role: 'explorer',
                label: task.label,
                tools: ['bash'],
                model: ctx.currentModel,
              }),
            ),
          )

          for (const spawnResult of spawnResults) {
            if (!spawnResult.success) {
              return spawnResult
            }
            agentIds.push(extractSpawnAgentId(spawnResult))
          }

          const waitResult = await tools.wait.run(ctx, { ids: agentIds, waitAll: true })
          const payload = extractWaitPayload(waitResult)
          const statuses = agentIds.map((id) => payload.statuses[id])
          const success =
            waitResult.success &&
            !payload.timedOut &&
            statuses.every((status) => status?.state === 'completed')
          const output = agentIds
            .map((id) => {
              const status = payload.statuses[id]
              return `## ${id}\n${status?.output ?? JSON.stringify(status, null, 2)}`
            })
            .join('\n\n')

          return {
            success,
            output,
            outputSummary: waitResult.outputSummary,
            artifacts: [],
          }
        },
      })
    } finally {
      await Promise.all(agentIds.map((agentId) => closeAgentIfPresent(ctx, tools.close, agentId)))
    }
  },
}
