import type { ScheduleConfig, SessionSource, ToolContext, ToolResult } from '@zero-os/shared'
import { generateId, toErrorMessage } from '@zero-os/shared'
import { BaseTool } from './base'

interface ScheduleInput {
  action: 'create' | 'list' | 'cancel'
  name?: string
  cron?: string
  instruction?: string
  oneShot?: boolean
}

/**
 * ScheduleTool — lets agents create, list, and cancel scheduled tasks.
 * Schedules created from a channel conversation are automatically bound
 * to that conversation's channel context.
 */
export class ScheduleTool extends BaseTool {
  name = 'schedule'
  description =
    'Create, list, or cancel scheduled tasks. ' +
    'Schedules created here are bound to the current conversation — results will be delivered back to this channel. ' +
    'Before creating a schedule from a relative request such as "in 2 minutes", "tonight", or "tomorrow morning", first obtain the current local time from the runtime, then convert the request into an exact cron expression. ' +
    'After creating the schedule, verify that the returned cron and planned fire time match the user intent before telling the user it is set.'
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'cancel'],
        description: 'Action to perform.',
      },
      name: {
        type: 'string',
        description: 'Unique schedule name (required for create/cancel).',
      },
      cron: {
        type: 'string',
        description:
          'Cron expression, e.g. "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am (required for create). For relative-time user requests, first check the current local time and only then derive this cron expression.',
      },
      instruction: {
        type: 'string',
        description: 'What the scheduled task should do (required for create).',
      },
      oneShot: {
        type: 'boolean',
        description:
          'If true, the schedule fires once and is automatically removed. Default: false.',
      },
    },
    required: ['action'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { action, name, cron, instruction, oneShot } = input as ScheduleInput

    if (!ctx.schedulerHandle) {
      return {
        success: false,
        output: 'Scheduler is not available in this context.',
        outputSummary: 'Scheduler unavailable',
      }
    }
    const schedulerHandle = ctx.schedulerHandle

    switch (action) {
      case 'create':
        return this.handleCreate(ctx, schedulerHandle, { name, cron, instruction, oneShot })
      case 'list':
        return this.handleList(schedulerHandle)
      case 'cancel':
        return this.handleCancel(schedulerHandle, ctx, name)
      default:
        return {
          success: false,
          output: `Unknown action: ${action}. Use create, list, or cancel.`,
          outputSummary: `Unknown action: ${action}`,
        }
    }
  }

  private handleCreate(
    ctx: ToolContext,
    schedulerHandle: NonNullable<ToolContext['schedulerHandle']>,
    opts: { name?: string; cron?: string; instruction?: string; oneShot?: boolean },
  ): ToolResult {
    const { cron, instruction, oneShot } = opts
    const name = opts.name || `sched-${generateId().slice(0, 8)}`

    if (!cron) {
      return {
        success: false,
        output: 'Missing required field: cron',
        outputSummary: 'Missing cron',
      }
    }
    if (!instruction) {
      return {
        success: false,
        output: 'Missing required field: instruction',
        outputSummary: 'Missing instruction',
      }
    }

    const config: ScheduleConfig = {
      name,
      cron,
      instruction,
      oneShot: oneShot ?? false,
      createdBy: 'runtime',
    }

    // Bind to the current channel if available
    if (ctx.channelBinding) {
      config.channel = {
        source: ctx.channelBinding.source as SessionSource,
        channelName: ctx.channelBinding.channelName,
        channelId: ctx.channelBinding.channelId,
        participantId: ctx.channelBinding.participantId,
        deliveryChannelId: ctx.channelBinding.deliveryChannelId ?? ctx.channelBinding.channelId,
      }
    }

    try {
      schedulerHandle.addAndStart(config)
      ctx.scheduleStore?.save(config)
    } catch (err) {
      const msg = toErrorMessage(err)
      return {
        success: false,
        output: `Failed to create schedule: ${msg}`,
        outputSummary: `Create failed: ${msg}`,
      }
    }

    const binding = config.channel
      ? ` → will deliver to ${config.channel.channelName}:${config.channel.channelId}`
      : ' (no channel binding — results will not be delivered to a channel)'

    return {
      success: true,
      output: `Schedule "${name}" created.\nCron: ${cron}\nOne-shot: ${oneShot ? 'yes' : 'no'}${binding}`,
      outputSummary: `Created schedule "${name}"`,
    }
  }

  private handleList(schedulerHandle: NonNullable<ToolContext['schedulerHandle']>): ToolResult {
    const statuses = schedulerHandle.getStatus()
    if (statuses.length === 0) {
      return { success: true, output: 'No active schedules.', outputSummary: '0 schedules' }
    }

    const lines = statuses.map((s) => {
      const next = s.nextRun.toISOString()
      const last = s.lastRun ? s.lastRun.toISOString() : 'never'
      const status = s.running ? '⏳ running' : '✅ idle'
      return `- ${s.name}  ${status}  next=${next}  last=${last}`
    })

    return {
      success: true,
      output: `Active schedules (${statuses.length}):\n${lines.join('\n')}`,
      outputSummary: `${statuses.length} schedule(s)`,
    }
  }

  private handleCancel(
    schedulerHandle: NonNullable<ToolContext['schedulerHandle']>,
    ctx: ToolContext,
    name?: string,
  ): ToolResult {
    if (!name) {
      return {
        success: false,
        output: 'Missing required field: name',
        outputSummary: 'Missing name',
      }
    }

    const removed = schedulerHandle.remove(name)
    if (removed) {
      ctx.scheduleStore?.delete(name)
      return {
        success: true,
        output: `Schedule "${name}" cancelled.`,
        outputSummary: `Cancelled "${name}"`,
      }
    }

    return {
      success: false,
      output: `Schedule "${name}" not found.`,
      outputSummary: `Not found: "${name}"`,
    }
  }
}
