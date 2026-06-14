import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface WaitAgentInput {
  ids: string[]
  timeoutMs?: number
  waitAll?: boolean
  resolveOn?: 'terminal' | 'ready'
}

interface CloseAgentInput {
  agent_id?: string
}

interface SendInputInput {
  id: string
  message: string
  interrupt?: boolean
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

    const { ids, timeoutMs, waitAll, resolveOn } = input as WaitAgentInput
    const shouldWaitAll = waitAll ?? false
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

export class CloseAgentTool extends BaseTool {
  name = 'close_agent'
  description = 'Close a spawned sub-agent and release its controller state.'
  parameters = {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The spawned agent_id to close.',
      },
    },
    required: ['agent_id'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    if (!ctx.agentControl) {
      return {
        success: false,
        output: 'Agent control is not available in this session.',
        outputSummary: 'Agent control unavailable',
      }
    }

    const { agent_id } = input as CloseAgentInput
    const resolvedAgentId = agent_id
    if (!resolvedAgentId?.trim()) {
      return {
        success: false,
        output: 'agent_id is required.',
        outputSummary: 'Missing agent_id',
      }
    }
    const traceSpanId = ctx.agentControl.getTraceSpanId(resolvedAgentId)
    const status = ctx.agentControl.close(resolvedAgentId)

    if (ctx.currentTraceSpanId) {
      ctx.tracer?.updateSpan(ctx.currentTraceSpanId, {
        data: {
          targetAgentId: resolvedAgentId,
          targetSubAgentSpanId: traceSpanId,
          closeSucceeded: Boolean(status),
          resultingState: status?.state,
        },
        metadata: {
          targetAgentId: resolvedAgentId,
          targetSubAgentSpanId: traceSpanId,
          closeSucceeded: Boolean(status),
          resultingState: status?.state,
        },
      })
    }

    if (!status) {
      return {
        success: false,
        output: `Sub-agent "${resolvedAgentId}" was not found.`,
        outputSummary: 'Sub-agent not found',
      }
    }

    return {
      success: true,
      output: JSON.stringify(status, null, 2),
      outputSummary: `Closed sub-agent "${resolvedAgentId}"`,
    }
  }
}

export class SendInputTool extends BaseTool {
  name = 'send_input'
  description =
    'Send a message to a running or waiting sub-agent. For interactive agents in the waiting state, this wakes the agent to process the message as a new turn. For running agents, the message is queued.'
  parameters = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Agent ID to send the message to.',
      },
      message: {
        type: 'string',
        description: 'Additional message text for the running sub-agent.',
      },
      interrupt: {
        type: 'boolean',
        description:
          'If true, request that the sub-agent cooperatively interrupt at the next safe point before handling the new message.',
      },
    },
    required: ['id', 'message'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    if (!ctx.agentControl) {
      return {
        success: false,
        output: 'Agent control is not available in this session.',
        outputSummary: 'Agent control unavailable',
      }
    }

    const { id, message, interrupt } = input as SendInputInput
    const traceSpanId = ctx.agentControl.getTraceSpanId(id)
    const result = ctx.agentControl.sendInput(id, message, { interrupt })

    if (ctx.currentTraceSpanId) {
      ctx.tracer?.updateSpan(ctx.currentTraceSpanId, {
        data: {
          targetAgentId: id,
          targetSubAgentSpanId: traceSpanId,
          interruptRequested: interrupt ?? false,
        },
        metadata: {
          targetAgentId: id,
          targetSubAgentSpanId: traceSpanId,
          interruptRequested: interrupt ?? false,
        },
      })
    }

    if (!result.success) {
      return {
        success: false,
        output: result.error ?? 'Failed to send input to sub-agent.',
        outputSummary: 'send_input failed',
      }
    }

    return {
      success: true,
      output: `Queued message for sub-agent "${id}".${interrupt ? ' Interrupt requested.' : ''}`,
      outputSummary: `Queued input for "${id}"`,
    }
  }
}
