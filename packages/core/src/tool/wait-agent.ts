import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface WaitAgentInput {
  ids: string[]
  timeoutMs?: number
  waitAll?: boolean
  wait_all?: boolean
  resolveOn?: 'terminal' | 'ready'
}

export class WaitAgentTool extends BaseTool {
  name = 'wait_agent'
  description =
    'Wait for spawned sub-agents to finish. By default returns when any one finishes. Set waitAll=true to wait for all.'
  parameters = {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to observe.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional timeout in milliseconds.',
      },
      waitAll: {
        type: 'boolean',
        description:
          'If true, waits for all agents. Otherwise returns when any requested agent reaches a terminal state.',
      },
      wait_all: {
        type: 'boolean',
        description: 'Backward-compatible alias for waitAll.',
      },
      resolveOn: {
        type: 'string',
        enum: ['terminal', 'ready'],
        description:
          'When to resolve. "terminal" waits for completion, failure, or close. "ready" also resolves when interactive agents enter the waiting state.',
      },
    },
    required: ['ids'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const control = ctx.agentControl
    if (!control) {
      return {
        success: false,
        output: 'Agent control is not available in this session.',
        outputSummary: 'Agent control unavailable',
      }
    }

    const { ids, timeoutMs, waitAll, wait_all, resolveOn } = input as WaitAgentInput
    const shouldWaitAll = waitAll ?? wait_all ?? false
    const resolveCondition = resolveOn ?? 'terminal'
    const traceSpanIds = Object.fromEntries(ids.map((id) => [id, control.getTraceSpanId(id)]))
    const result =
      resolveCondition === 'ready'
        ? await control.waitReady(ids, timeoutMs, shouldWaitAll)
        : shouldWaitAll
          ? await control.waitAll(ids, timeoutMs)
          : await control.waitAny(ids, timeoutMs)

    if (ctx.currentTraceSpanId) {
      ctx.tracer?.updateSpan(ctx.currentTraceSpanId, {
        data: {
          observedAgentIds: ids,
          observedSubAgentSpanIds: traceSpanIds,
          waitAll: shouldWaitAll,
          resolveOn: resolveCondition,
          timedOut: result.timedOut,
        },
        metadata: {
          observedAgentIds: ids,
          observedSubAgentSpanIds: traceSpanIds,
          waitAll: shouldWaitAll,
          resolveOn: resolveCondition,
          timedOut: result.timedOut,
        },
      })
    }

    return {
      success: true,
      output: JSON.stringify(result, null, 2),
      outputSummary: result.timedOut
        ? `Timed out waiting for ${ids.length} sub-agent(s)`
        : `Observed ${ids.length} sub-agent(s)`,
    }
  }
}
