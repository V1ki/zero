export interface LoopToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface LoopToolCallRecord {
  name: string
  input: Record<string, unknown>
  output: string
}

export interface LoopRunnerUsage {
  input: number
  output: number
}

export interface LoopToolHandlerResult {
  output: string
  isError?: boolean
}

export type LoopToolHandler = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<LoopToolHandlerResult>

export interface LoopRunnerConfig {
  system: string
  userMessage: string
  tools: LoopToolSpec[]
  toolHandler: LoopToolHandler
  maxIterations?: number
  maxTokens?: number
}

export interface LoopRunnerResult {
  finalText: string
  toolCalls: LoopToolCallRecord[]
  usage: LoopRunnerUsage
  durationMs: number
}

export type LoopRunner = (config: LoopRunnerConfig) => Promise<LoopRunnerResult>
