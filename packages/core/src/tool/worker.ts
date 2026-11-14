import { isAbsolute } from 'node:path'
import type { SecretFilter, ToolContext, ToolLogger, ToolResult } from '@zero-os/shared'
import { generatePrefixedId, toErrorMessage } from '@zero-os/shared'
import { type AgentLoopJournal, journalToolCall, journalToolResult } from '../agent/agent-loop'
import { SessionRunningToolRegistry, steerRunningWorker } from '../session/running-tool-registry'
import { BaseTool } from './base'
import { type CodexWorkerInput, runCodexWorker } from './worker/codex-worker'
import { CodexWorkerServer } from './worker/codex-worker-server'
import type { CodexWorkerUsageRecord } from './worker/codex-worker-usage'

export type { CodexWorkerUsageRecord } from './worker/codex-worker-usage'

import { RouterCodexError } from './worker/router-job-policy'

export { RouterCodexError }

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
  private readonly routerServer: CodexWorkerServer
  private readonly fallbackServer?: CodexWorkerServer
  private readonly secretFilter?: SecretFilter
  private readonly recordUsage?: (entry: CodexWorkerUsageRecord) => void

  constructor(
    options: {
      codexPath?: string
      codexCommand?: [string, ...string[]]
      codexFallbackCommand?: [string, ...string[]]
      secretFilter?: SecretFilter
      recordUsage?: (entry: CodexWorkerUsageRecord) => void
    } = {},
  ) {
    super()
    this.server = new CodexWorkerServer(options)
    this.recordUsage = options.recordUsage
    this.secretFilter = options.secretFilter
    this.routerServer = new CodexWorkerServer({ ...options, experimentalApi: true })
    if (options.codexFallbackCommand)
      this.fallbackServer = new CodexWorkerServer({
        codexCommand: options.codexFallbackCommand,
        secretFilter: options.secretFilter,
        experimentalApi: true,
      })
  }

  async close(): Promise<void> {
    await Promise.all([
      this.server.close(),
      this.routerServer.close(),
      this.fallbackServer?.close(),
    ])
  }

  private async runWithQuotaFallback(ctx: ToolContext, input: CodexWorkerInput) {
    const primary = await runCodexWorker(
      ctx,
      input,
      input.routerJob ? this.routerServer : this.server,
      this.recordUsage,
    )
    const handle = ctx.currentToolUseId
      ? ctx.runningToolRegistry?.get(ctx.currentToolUseId)
      : undefined
    if (!primary.codexOutcome.quotaExceeded || !this.fallbackServer || handle?.getAbortReason())
      return primary
    const resumeThreadId = primary.codexOutcome.threadId ?? input.resumeThreadId
    ctx.logger.info('worker_account_fallback', {
      reason: 'usageLimitExceeded',
      threadId: resumeThreadId,
      from: 'primary',
      to: 'fallback',
    })
    const result = await runCodexWorker(
      ctx,
      {
        ...input,
        resumeThreadId,
        instruction: resumeThreadId
          ? `原账号额度已用尽，现切换到备用账号继续同一任务。请先承接本线程已完成的操作和结果，再处理剩余工作，不要重复已经完成的写入。原始请求：\n${input.instruction}`
          : input.instruction,
      },
      this.fallbackServer,
      this.recordUsage,
    )
    return { ...result, outputSummary: `${result.outputSummary} (quota fallback)` }
  }

  /**
   * Host-only entrypoint. Workspace and continuation IDs come from the authorized Router job.
   * The run is one tool call in the job's event file: `tool/call` when it starts and `tool/result`
   * with the final outcome, written by the same functions as the loop's. Codex's intermediate
   * steps are not logged.
   */
  async runRouterJob(input: {
    sessionId: string
    workingDirectory: string
    instruction: string
    resumeThreadId?: string
    onThreadReady?(threadId: string): void
    onPublicEvent?: CodexWorkerInput['onPublicEvent']
    signal: AbortSignal
    /** Events of this job run, written to the file of `sessionId`. */
    journal: AgentLoopJournal
    logger: ToolLogger
  }): Promise<{ result: string; threadId: string }> {
    if (!isAbsolute(input.workingDirectory) || !input.instruction.trim() || input.signal.aborted)
      throw new RouterCodexError('Codex 任务已取消或缺少有效工作区和指令。', false)
    const registry = new SessionRunningToolRegistry()
    const handle = registry.register({
      toolName: this.name,
      toolUseId: generatePrefixedId('router_job'),
      abortable: true,
    })
    const onAbort = () => handle.requestAbort('Router job cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const call = {
      id: handle.toolUseId,
      name: this.name,
      input: {
        type: 'codex',
        instruction: input.instruction,
        workingDirectory: input.workingDirectory,
        ...(input.resumeThreadId && { resumeThreadId: input.resumeThreadId }),
      },
    }
    journalToolCall(input.journal, input.sessionId, call)
    const startedAt = Date.now()
    try {
      const completed = await this.runWithQuotaFallback(
        {
          sessionId: input.sessionId,
          currentToolUseId: handle.toolUseId,
          workDir: input.workingDirectory,
          runningToolRegistry: registry,
          secretFilter: this.secretFilter,
          logger: input.logger,
        },
        {
          instruction: input.instruction,
          resumeThreadId: input.resumeThreadId,
          onThreadReady: input.onThreadReady,
          onPublicEvent: input.onPublicEvent,
          routerJob: true,
        },
      ).catch((error: unknown) => {
        const message = toErrorMessage(error)
        journalToolResult(
          input.journal,
          input.sessionId,
          call,
          {
            success: false,
            output: message,
            outputSummary: `Tool execution failed: ${message.slice(0, 100)}`,
          },
          Date.now() - startedAt,
        )
        throw error
      })
      journalToolResult(input.journal, input.sessionId, call, completed, Date.now() - startedAt)
      const outcome = completed.routerJob
      if (!completed.success || !outcome?.text.trim() || !outcome.threadId) {
        const submitted = outcome?.outcomeUnknown ?? true
        throw new RouterCodexError(
          submitted
            ? 'Codex 任务未能返回确认结果，请检查工作区后再继续。'
            : (outcome?.reason ?? 'Codex 任务未启动，请检查 Codex 服务、工作区和权限配置。'),
          submitted,
        )
      }
      return {
        threadId: outcome.threadId,
        result: (this.secretFilter?.filter(outcome.text) ?? outcome.text).trim(),
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
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
    return this.runWithQuotaFallback(ctx, {
      instruction: args.instruction,
      workingDirectory: optionalString(args, 'workingDirectory'),
      model: optionalString(args, 'model'),
      additionalDirectories: directories,
      resumeThreadId: optionalString(args, 'resumeThreadId'),
    })
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
