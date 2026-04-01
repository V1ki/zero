import type { TaskTool, CloseAgentTool, SendInputTool, SpawnAgentTool, WaitAgentTool } from '@zero-os/core'
import type { BenchmarkToolContext } from '../harness'
import type { BenchmarkResult } from '../metrics'
import { dependencyChainScenario } from './dependency-chain'
import { errorRecoveryScenario } from './error-recovery'
import { midFlightInputScenario } from './mid-flight-input'
import { parallelTasksScenario } from './parallel-tasks'
import { singleTaskScenario } from './single-task'

export interface BenchmarkScenario {
  name: string
  description: string
  runLegacy(ctx: BenchmarkToolContext, taskTool: TaskTool, runIndex?: number): Promise<BenchmarkResult>
  runAsync(
    ctx: BenchmarkToolContext,
    tools: {
      spawn: SpawnAgentTool
      wait: WaitAgentTool
      close: CloseAgentTool
      sendInput: SendInputTool
    },
    runIndex?: number,
  ): Promise<BenchmarkResult>
}

export const scenarios: BenchmarkScenario[] = [
  singleTaskScenario,
  parallelTasksScenario,
  dependencyChainScenario,
  midFlightInputScenario,
  errorRecoveryScenario,
]

export const scenariosByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]))
