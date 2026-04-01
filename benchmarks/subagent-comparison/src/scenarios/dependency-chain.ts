import { join } from 'node:path'
import type { TaskTool, CloseAgentTool, SpawnAgentTool, WaitAgentTool } from '@zero-os/core'
import type { BenchmarkToolContext } from '../harness'
import {
  closeAgentIfPresent,
  extractSpawnAgentId,
  extractWaitPayload,
  measureScenario,
} from '../metrics'

function buildTaskAInstruction(ctx: BenchmarkToolContext): string {
  const filePath = join(ctx.projectRoot, 'packages/core/src/agent/agent-control.ts')
  return `Read "${filePath}" and summarize its public API. Focus on the methods, their purpose, and the exposed agent lifecycle behavior.`
}

function buildTaskBInstruction(summary: string): string {
  return `Here is the upstream summary of packages/core/src/agent/agent-control.ts:\n\n${summary}\n\nBased on that summary, list potential improvements or risks in the public API and lifecycle behavior.`
}

export const dependencyChainScenario = {
  name: 'dependency-chain',
  description: 'Task B depends on task A output.',
  async runLegacy(ctx: BenchmarkToolContext, taskTool: TaskTool, runIndex?: number) {
    return measureScenario(ctx, {
      scenario: 'dependency-chain',
      path: 'legacy',
      runIndex,
      execute: () =>
        taskTool.run(ctx, {
          tasks: [
            {
              id: 'task_a',
              preset: 'explorer',
              instruction: buildTaskAInstruction(ctx),
              tools: ['read'],
            },
            {
              id: 'task_b',
              preset: 'explorer',
              instruction:
                'Based on the summary from the previous task, list potential improvements or risks in the public API and lifecycle behavior.',
              dependsOn: ['task_a'],
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
    let agentAId: string | undefined
    let agentBId: string | undefined

    try {
      return await measureScenario(ctx, {
        scenario: 'dependency-chain',
        path: 'async',
        runIndex,
        execute: async () => {
          const spawnA = await tools.spawn.run(ctx, {
            instruction: buildTaskAInstruction(ctx),
            role: 'explorer',
            label: 'dependency-chain-a',
            tools: ['read'],
            model: ctx.currentModel,
          })
          if (!spawnA.success) {
            return spawnA
          }

          agentAId = extractSpawnAgentId(spawnA)
          const waitA = await tools.wait.run(ctx, { ids: [agentAId], waitAll: true })
          const payloadA = extractWaitPayload(waitA)
          const statusA = payloadA.statuses[agentAId]

          if (!waitA.success || payloadA.timedOut || statusA?.state !== 'completed') {
            return {
              success: false,
              output: statusA?.error ?? waitA.output,
              outputSummary: waitA.outputSummary,
              artifacts: [],
            }
          }

          const spawnB = await tools.spawn.run(ctx, {
            instruction: buildTaskBInstruction(statusA.output ?? ''),
            role: 'explorer',
            label: 'dependency-chain-b',
            tools: ['read'],
            model: ctx.currentModel,
          })
          if (!spawnB.success) {
            return spawnB
          }

          agentBId = extractSpawnAgentId(spawnB)
          const waitB = await tools.wait.run(ctx, { ids: [agentBId], waitAll: true })
          const payloadB = extractWaitPayload(waitB)
          const statusB = payloadB.statuses[agentBId]

          return {
            success: waitB.success && !payloadB.timedOut && statusB?.state === 'completed',
            output: [`## Task A`, statusA.output ?? '', ``, `## Task B`, statusB?.output ?? waitB.output].join(
              '\n',
            ),
            outputSummary: waitB.outputSummary,
            artifacts: [],
          }
        },
      })
    } finally {
      await closeAgentIfPresent(ctx, tools.close, agentAId)
      await closeAgentIfPresent(ctx, tools.close, agentBId)
    }
  },
}
