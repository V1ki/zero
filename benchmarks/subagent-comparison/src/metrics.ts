import type { CloseAgentTool } from '@zero-os/core'
import type { TraceSpan } from '@zero-os/observe'
import type { ToolResult } from '@zero-os/shared'
import type { BenchmarkToolContext } from './harness'

export interface BenchmarkResult {
  scenario: string
  path: 'legacy' | 'async'
  model: string
  wallTimeMs: number
  success: boolean
  output: string
  error?: string
  llmCalls?: number
  totalTokens?: number
  estimatedCost?: number
  skipped?: boolean
  runIndex?: number
}

export interface WaitAgentPayload {
  statuses: Record<string, WaitAgentStatus>
  timedOut: boolean
}

export interface WaitAgentStatus {
  state: string
  output?: string
  error?: string
  label?: string
  elapsedMs?: number
  [key: string]: unknown
}

export async function measureScenario(
  ctx: BenchmarkToolContext,
  input: {
    scenario: string
    path: 'legacy' | 'async'
    runIndex?: number
    execute: () => Promise<ToolResult>
  },
): Promise<BenchmarkResult> {
  const start = Date.now()

  try {
    const result = await input.execute()
    const traceMetrics = extractTraceMetrics(ctx)

    return {
      scenario: input.scenario,
      path: input.path,
      model: ctx.currentModel,
      wallTimeMs: Date.now() - start,
      success: result.success,
      output: result.output,
      error: result.success ? undefined : result.output,
      llmCalls: traceMetrics.llmCalls,
      totalTokens: traceMetrics.totalTokens,
      estimatedCost: traceMetrics.estimatedCost,
      runIndex: input.runIndex,
    }
  } catch (error) {
    const traceMetrics = extractTraceMetrics(ctx)
    const message = error instanceof Error ? error.message : String(error)

    return {
      scenario: input.scenario,
      path: input.path,
      model: ctx.currentModel,
      wallTimeMs: Date.now() - start,
      success: false,
      output: message,
      error: message,
      llmCalls: traceMetrics.llmCalls,
      totalTokens: traceMetrics.totalTokens,
      estimatedCost: traceMetrics.estimatedCost,
      runIndex: input.runIndex,
    }
  }
}

export function buildSkippedResult(
  ctx: BenchmarkToolContext,
  input: {
    scenario: string
    path: 'legacy' | 'async'
    output: string
    runIndex?: number
  },
): BenchmarkResult {
  return {
    scenario: input.scenario,
    path: input.path,
    model: ctx.currentModel,
    wallTimeMs: 0,
    success: false,
    output: input.output,
    llmCalls: 0,
    totalTokens: 0,
    estimatedCost: 0,
    skipped: true,
    runIndex: input.runIndex,
  }
}

export function extractSpawnAgentId(result: ToolResult): string {
  const parsed = parseJson<{ agent_id?: string }>(result.output)
  if (!parsed.agent_id) {
    throw new Error(`spawn_agent did not return an agent_id. Output:\n${result.output}`)
  }
  return parsed.agent_id
}

export function extractWaitPayload(result: ToolResult): WaitAgentPayload {
  return parseJson<WaitAgentPayload>(result.output)
}

export function extractWaitStatus(result: ToolResult, agentId: string): WaitAgentStatus | undefined {
  return extractWaitPayload(result).statuses[agentId]
}

export async function closeAgentIfPresent(
  ctx: BenchmarkToolContext,
  closeTool: CloseAgentTool,
  agentId: string | undefined,
): Promise<void> {
  if (!agentId) return
  await closeTool.run(ctx, { agentId })
}

function extractTraceMetrics(ctx: BenchmarkToolContext): {
  llmCalls: number
  totalTokens: number
  estimatedCost: number
} {
  const spans = flattenSpans(ctx.tracer.exportSession(ctx.sessionId))
  const llmSpans = spans.filter((span) => span.kind === 'llm_request')

  let totalTokens = 0
  let estimatedCost = 0

  for (const span of llmSpans) {
    const request = span.data?.request as
      | {
          tokens?: {
            input?: number
            output?: number
            cacheWrite?: number
            cacheRead?: number
            reasoning?: number
          }
          cost?: number
        }
      | undefined

    if (request?.tokens) {
      totalTokens +=
        (request.tokens.input ?? 0) +
        (request.tokens.output ?? 0) +
        (request.tokens.cacheWrite ?? 0) +
        (request.tokens.cacheRead ?? 0) +
        (request.tokens.reasoning ?? 0)
    }

    estimatedCost += request?.cost ?? 0
  }

  return {
    llmCalls: llmSpans.length,
    totalTokens,
    estimatedCost,
  }
}

function flattenSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((span) => [span, ...flattenSpans(span.children)])
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}
