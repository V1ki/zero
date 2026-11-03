import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'
import { runCodexWorker } from './worker/codex-worker'

const workerTypes = ['codex', 'dsh'] as const

export class WorkerTool extends BaseTool {
  name = 'worker'
  description =
    'Delegate an engineering task to a worker. Use type "codex" to inspect a workspace, edit files, and run commands. Pass the returned thread ID to continue the same task.'
  parameters = {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: workerTypes,
        description: 'codex is available. dsh is reserved.',
      },
      instruction: { type: 'string', description: 'Task and expected outcome for the worker.' },
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

  constructor(private readonly options: { codexPath?: string } = {}) {
    super()
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null) throw new Error('Expected a worker request.')
    const args = input as Record<string, unknown>
    if (args.type === 'dsh') throw new Error('Worker type "dsh" is not implemented. Use "codex".')
    if (args.type !== 'codex') throw new Error('Unknown worker type. Available worker: codex.')
    if (!isNonEmptyString(args.instruction))
      throw new Error('instruction must be a non-empty string.')

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
      this.options.codexPath,
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
