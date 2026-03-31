import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface SendInputInput {
  id: string
  message: string
  interrupt?: boolean
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
