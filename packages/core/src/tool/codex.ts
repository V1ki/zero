import {
  Codex,
  type CommandExecutionItem,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from '@openai/codex-sdk'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import { BACKGROUND_TOOL_PROGRESS_TAIL_CHARS } from '../session/background-tool-tasks'
import { BaseTool } from './base'
import { buildToolProcessEnv } from './process-env'

interface CodexInput {
  /** The instruction for Codex to execute — what code change to make. */
  instruction: string
  /** Working directory for the codex session. Defaults to projectRoot. */
  workingDirectory?: string
  /** Model slug to use (e.g. "gpt-5.5"). Defaults to ~/.codex/config.toml setting. */
  model?: string
  /** Additional directories to allow codex to access beyond the working directory. */
  additionalDirectories?: string[]
  /** Thread ID from a previous codex call to resume the conversation. Enables multi-turn workflows. */
  resumeThreadId?: string
}

interface CodexResult {
  threadId: string | null
  response: string
  fileChanges: Array<{ path: string; kind: string }>
  commands: Array<{ command: string; output: string; exitCode: number | null; status: string }>
  errors: string[]
  usage: Usage | null
}

const ABORT_MESSAGE = 'Codex turn aborted by user from Session Detail.'

/**
 * CodexTool — delegates code engineering tasks to the OpenAI Codex CLI.
 *
 * Runs each turn through the official @openai/codex-sdk, which spawns the
 * vendored `codex` binary (`codex exec --experimental-json`), sends the
 * instruction via stdin, and streams structured JSONL events back. The SDK's
 * `env` fully replaces process.env, so the session env built by
 * buildToolProcessEnv is the complete child environment.
 *
 * Threads persist in ~/.codex/sessions; multi-turn workflows resume via the
 * resumeThreadId input echoed back in every result.
 *
 * Requirements:
 * - No global codex install needed — @openai/codex-sdk vendors a matching binary
 * - Auth from ~/.codex (auth.json) or ambient env (OPENAI_API_KEY / CODEX_API_KEY)
 */
export class CodexTool extends BaseTool {
  name = 'codex'
  description =
    'Delegate a code engineering task to the Codex agent. Codex can read code, make file changes, run commands, and verify its work. Best for multi-file refactors, bug fixes, feature implementation, and code migrations. Provide a clear instruction of what code change to make.'
  parameters = {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description:
          'Clear instruction of the code change to make. Be specific about what files/functions to modify and what the desired outcome is.',
      },
      workingDirectory: {
        type: 'string',
        description: 'Working directory for the codex session. Defaults to project root.',
      },
      model: {
        type: 'string',
        description:
          'Model slug to use (e.g. "gpt-5.5"). Defaults to the model configured in ~/.codex/config.toml. Only override when you need a specific model.',
      },
      additionalDirectories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directories to allow codex to access.',
      },
      resumeThreadId: {
        type: 'string',
        description:
          'Thread ID from a previous codex call to resume the conversation. Use this for multi-turn workflows like "fix → verify → fix again".',
      },
    },
    required: ['instruction'],
  }

  private codexPath: string | undefined

  constructor(options?: { codexPath?: string }) {
    super()
    this.codexPath = options?.codexPath
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { instruction, workingDirectory, model, additionalDirectories, resumeThreadId } =
      input as CodexInput

    const cwd = workingDirectory ?? ctx.projectRoot ?? ctx.workDir

    ctx.logger.info('codex_start', {
      instruction: instruction.slice(0, 200),
      cwd,
      model: model ?? 'default',
      resumeThreadId: resumeThreadId ?? null,
    })

    const abortController = new AbortController()
    let abortMessage: string | undefined
    const runningHandle = ctx.currentToolUseId
      ? ctx.runningToolRegistry?.get(ctx.currentToolUseId)
      : undefined
    runningHandle?.setAbortHandler((reason) => {
      abortMessage = reason?.trim() || ABORT_MESSAGE
      abortController.abort()
    })

    try {
      const result = await this.runTurn(ctx, {
        instruction,
        cwd,
        model,
        additionalDirectories,
        resumeThreadId,
        abortController,
      })
      ctx.logger.info('codex_complete', {
        fileChanges: result.fileChanges.length,
        commands: result.commands.length,
        errors: result.errors.length,
        hasResponse: !!result.response,
      })
      return formatCodexToolResult(result)
    } catch (error) {
      if (abortController.signal.aborted) {
        runningHandle?.markFinished({
          finishedAt: now(),
          cause: 'abort',
          success: false,
          outputSummary: abortMessage,
        })
        return {
          success: false,
          output: abortMessage ?? ABORT_MESSAGE,
          outputSummary: 'Codex turn aborted',
        }
      }
      const message = toErrorMessage(error)
      return {
        success: false,
        output: `Codex execution failed: ${message}`,
        outputSummary: `Codex failed: ${message.slice(0, 100)}`,
      }
    }
  }

  private async runTurn(
    ctx: ToolContext,
    args: {
      instruction: string
      cwd: string
      model?: string
      additionalDirectories?: string[]
      resumeThreadId?: string
      abortController: AbortController
    },
  ): Promise<CodexResult> {
    const codex = new Codex({
      env: buildToolProcessEnv(ctx),
      ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
    })

    const threadOptions: ThreadOptions = {
      workingDirectory: args.cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      ...(args.model ? { model: args.model } : {}),
      ...(args.additionalDirectories?.length
        ? { additionalDirectories: args.additionalDirectories }
        : {}),
    }
    const thread = args.resumeThreadId
      ? codex.resumeThread(args.resumeThreadId, threadOptions)
      : codex.startThread(threadOptions)

    const result = createEmptyCodexResult()

    // Rolling tail of command output for background progress reports; the
    // SDK only surfaces per-item aggregates, so deltas are tracked per item id.
    // Throttling lives in the background task manager, as with BashTool.
    let progressChars = 0
    let progressTail = ''
    const reportedOutputLength = new Map<string, number>()
    const onCommandOutput = (item: CommandExecutionItem) => {
      const previouslyReported = reportedOutputLength.get(item.id) ?? 0
      if (item.aggregated_output.length <= previouslyReported) return
      const delta = item.aggregated_output.slice(previouslyReported)
      reportedOutputLength.set(item.id, item.aggregated_output.length)
      progressChars += delta.length
      progressTail = (progressTail + delta).slice(-BACKGROUND_TOOL_PROGRESS_TAIL_CHARS)
      if (!ctx.currentToolUseId) return
      ctx.backgroundToolTasks?.reportProgress?.({
        toolUseId: ctx.currentToolUseId,
        totalOutputChars: progressChars,
        outputTail: progressTail,
      })
    }

    const { events } = await thread.runStreamed(args.instruction, {
      signal: args.abortController.signal,
    })

    try {
      for await (const event of events) {
        processCodexEvent(event, result, onCommandOutput)
      }
    } catch (error) {
      // `codex exec` exits non-zero on turn failure, and the SDK then throws
      // past the stream end — discarding the turn.failed/error events it
      // already yielded. When those events were collected they carry the real
      // failure, so return them instead of the exit-code error; otherwise
      // (spawn failure, mid-stream crash) let the error propagate.
      if (args.abortController.signal.aborted || result.errors.length === 0) throw error
    }

    result.threadId = result.threadId ?? thread.id ?? args.resumeThreadId ?? null
    return result
  }
}

function createEmptyCodexResult(): CodexResult {
  return {
    threadId: null,
    response: '',
    fileChanges: [],
    commands: [],
    errors: [],
    usage: null,
  }
}

function processCodexEvent(
  event: ThreadEvent,
  result: CodexResult,
  onCommandOutput?: (item: CommandExecutionItem) => void,
): void {
  switch (event.type) {
    case 'thread.started':
      result.threadId = event.thread_id
      break

    case 'item.updated':
      if (event.item.type === 'command_execution') {
        onCommandOutput?.(event.item)
      }
      break

    case 'item.completed':
      if (event.item.type === 'command_execution') {
        onCommandOutput?.(event.item)
      }
      processCodexItem(event.item, result)
      break

    case 'turn.completed':
      result.usage = event.usage
      break

    case 'turn.failed':
      result.errors.push(event.error.message)
      break

    case 'error':
      result.errors.push(event.message)
      break
  }
}

function processCodexItem(item: ThreadItem, result: CodexResult): void {
  switch (item.type) {
    case 'agent_message':
      result.response = item.text
      break

    case 'file_change':
      for (const change of item.changes) {
        result.fileChanges.push({ path: change.path, kind: change.kind })
      }
      break

    case 'command_execution':
      result.commands.push({
        command: item.command,
        output: item.aggregated_output,
        exitCode: item.exit_code ?? null,
        status: item.status,
      })
      break

    case 'error':
      result.errors.push(item.message)
      break

    default:
      // reasoning / todo_list / web_search / mcp_tool_call are not rendered
      break
  }
}

function formatCodexToolResult(result: CodexResult): ToolResult {
  const sections: string[] = []

  if (result.response) {
    sections.push(`## Response\n${result.response}`)
  }

  if (result.fileChanges.length > 0) {
    const changeLines = result.fileChanges.map((change) => `- [${change.kind}] ${change.path}`)
    sections.push(`## File Changes\n${changeLines.join('\n')}`)
  }

  if (result.commands.length > 0) {
    const cmdLines = result.commands.map((command) => {
      const status =
        command.exitCode === 0
          ? '✓'
          : command.exitCode !== null
            ? `✗ (exit ${command.exitCode})`
            : '…'
      const output = command.output ? `\n${command.output.slice(0, 500)}` : ''
      return `- ${status} \`${command.command}\`${output}`
    })
    sections.push(`## Commands\n${cmdLines.join('\n')}`)
  }

  if (result.errors.length > 0) {
    sections.push(`## Errors\n${result.errors.join('\n')}`)
  }

  if (result.threadId) {
    sections.push(`## Thread\nthreadId: ${result.threadId}`)
  }

  if (result.usage) {
    sections.push(
      `## Token Usage\nInput: ${result.usage.input_tokens} (cached: ${result.usage.cached_input_tokens}), Output: ${result.usage.output_tokens}`,
    )
  }

  const output = sections.join('\n\n')
  const artifacts = result.fileChanges.map((change) => change.path)

  return {
    success: result.errors.length === 0,
    output,
    outputSummary: buildCodexSummary(result),
    artifacts: artifacts.length > 0 ? artifacts : undefined,
  }
}

function buildCodexSummary(result: CodexResult): string {
  const summaryParts: string[] = []
  if (result.fileChanges.length > 0) {
    summaryParts.push(`${result.fileChanges.length} file(s) changed`)
  }
  if (result.commands.length > 0) {
    summaryParts.push(`${result.commands.length} command(s) run`)
  }
  if (result.errors.length > 0) {
    summaryParts.push(`${result.errors.length} error(s)`)
  }
  return summaryParts.length > 0 ? summaryParts.join(', ') : 'Codex completed'
}
