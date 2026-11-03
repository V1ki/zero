import type { SecretFilter, ToolContext, ToolResult } from '@zero-os/shared'
import { steerRunningWorker } from '../session/running-tool-registry'
import { BaseTool } from './base'
import { runCodexWorker } from './worker/codex-worker'
import { CodexWorkerServer } from './worker/codex-worker-server'
import type { CodexWorkerUsageRecord } from './worker/codex-worker-usage'

export type { CodexWorkerUsageRecord } from './worker/codex-worker-usage'

const workerTypes = ['codex', 'dsh'] as const

export class WorkerTool extends BaseTool {
  name = 'worker'
  description =
    'Delegate an engineering task to a Codex worker. Use action "steer" to send new instructions to an active run. To continue a finished run, use resumeThreadId.'
  parameters = {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: workerTypes,
        description: 'codex is available. dsh is reserved.',
      },
      action: {
        type: 'string',
        enum: ['run', 'steer'],
        description: 'Defaults to run. Use steer to adjust work in the same active Codex turn.',
      },
      instruction: {
        type: 'string',
        description: 'Task for run, or the additional instruction for steer.',
      },
      targetToolUseId: {
        type: 'string',
        description:
          'Required for steer. Original worker tool call ID (tool_use_id in the background task notice).',
      },
      workingDirectory: {
        type: 'string',
        description: 'Working directory. Defaults to the project root.',
      },
      model: {
        type: 'string',
        description: 'Optional override for the worker’s configured model.',
      },
      additionalDirectories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directories the worker may write to.',
      },
      resumeThreadId: { type: 'string', description: 'Continue a previous Codex thread by ID.' },
    },
    required: ['type', 'instruction'],
  }

  private readonly server: CodexWorkerServer
  private readonly recordUsage?: (entry: CodexWorkerUsageRecord) => void

  constructor(
    options: {
      codexPath?: string
      secretFilter?: SecretFilter
      recordUsage?: (entry: CodexWorkerUsageRecord) => void
    } = {},
  ) {
    super()
    this.server = new CodexWorkerServer(options)
    this.recordUsage = options.recordUsage
  }

  close(): Promise<void> {
    return this.server.close()
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null) throw new Error('Expected a worker request.')
    const args = input as Record<string, unknown>
    if (args.type === 'dsh') throw new Error('Worker type "dsh" is not implemented. Use "codex".')
    if (args.type !== 'codex') throw new Error('Unknown worker type. Available worker: codex.')
    if (!isNonEmptyString(args.instruction))
      throw new Error('instruction must be a non-empty string.')

    if (args.action === 'steer') {
      if (!isNonEmptyString(args.targetToolUseId))
        throw new Error('steer requires targetToolUseId.')
      if (
        ['workingDirectory', 'additionalDirectories', 'model', 'resumeThreadId'].some(
          (key) => args[key] !== undefined,
        )
      ) {
        throw new Error(
          'workingDirectory, additionalDirectories, model and resumeThreadId are only available for run.',
        )
      }
      await steerRunningWorker(ctx.runningToolRegistry, args.targetToolUseId, args.instruction)
      return {
        success: true,
        output: 'Codex accepted the additional instruction for the active turn.',
        outputSummary: 'Worker instruction accepted',
      }
    }
    if (args.action !== undefined && args.action !== 'run')
      throw new Error('Unknown worker action. Use run or steer.')
    if (args.targetToolUseId !== undefined)
      throw new Error('targetToolUseId requires action "steer".')

    const directories = args.additionalDirectories
    if (
      directories !== undefined &&
      !(Array.isArray(directories) && directories.every(isNonEmptyString))
    ) {
      throw new Error('additionalDirectories must be an array of non-empty paths.')
    }
    return runCodexWorker(
      ctx,
      {
        instruction: args.instruction,
        workingDirectory: optionalString(args, 'workingDirectory'),
        model: optionalString(args, 'model'),
        additionalDirectories: directories,
        resumeThreadId: optionalString(args, 'resumeThreadId'),
      },
      this.server,
      this.recordUsage,
    )
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || isNonEmptyString(value)) return value
  throw new Error(`${key} must be a non-empty string.`)
}
