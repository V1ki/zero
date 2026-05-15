import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import { BaseTool } from './base'
import { buildToolProcessEnv } from './process-env'

/**
 * Event and item types from Codex CLI's JSONL output.
 * Simplified from @openai/codex-sdk's type definitions.
 */
interface CodexThreadEvent {
  type: string
  thread_id?: string
  item?: CodexThreadItem
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number }
  error?: { message: string }
  message?: string
}

interface CodexThreadItem {
  id: string
  type: string
  // agent_message
  text?: string
  // command_execution
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  // file_change
  changes?: Array<{ path: string; kind: string }>
  // reasoning
  // (uses text)
  // error
  message?: string
  // todo_list
  items?: Array<{ text: string; completed: boolean }>
}

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

/**
 * CodexTool — delegates code engineering tasks to the OpenAI Codex CLI.
 *
 * This tool spawns `codex exec --experimental-json` as a subprocess,
 * sends the instruction via stdin, and collects structured JSONL events.
 * The result includes the agent's response, file changes, and command executions.
 *
 * Requirements:
 * - `codex` CLI must be installed and available in PATH (npm i -g @openai/codex)
 * - OPENAI_API_KEY (or CODEX_API_KEY) must be set in environment
 */
export class CodexTool extends BaseTool {
  name = 'codex'
  description =
    'Delegate a code engineering task to the Codex agent. Codex can read code, make file changes, run commands, and verify its work. Best for multi-file refactors, bug fixes, feature implementation, and code migrations. Provide a clear instruction of what to change.'
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

  private codexPath: string
  private profile: string | undefined

  constructor(options?: { codexPath?: string; profile?: string }) {
    super()
    this.codexPath = options?.codexPath ?? 'codex'
    this.profile = options?.profile ?? process.env['CODEX_PROFILE']
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const {
      instruction,
      workingDirectory,
      model,
      additionalDirectories,
      resumeThreadId,
    } = input as CodexInput

    const cwd = workingDirectory ?? ctx.projectRoot ?? ctx.workDir

    // Build command args
    const args: string[] = ['exec', '--json']

    if (model) {
      args.push('--model', model)
    }

    // Full auto approval — delegates approval to model + sandboxes writes to workspace
    args.push('--full-auto')

    if (this.profile) {
      args.push('--profile', this.profile)
    }

    if (additionalDirectories?.length) {
      for (const dir of additionalDirectories) {
        args.push('--add-dir', dir)
      }
    }

    // Resume mode: append `resume <threadId> <prompt>` subcommand.
    // In this mode the prompt goes via CLI args, not stdin.
    const isResume = !!resumeThreadId
    if (isResume) {
      args.push('resume', resumeThreadId, instruction)
    }

    ctx.logger.info('codex_start', {
      instruction: instruction.slice(0, 200),
      cwd,
      model: model ?? 'default',
      resumeThreadId: resumeThreadId ?? null,
    })

    try {
      const result = await this.runCodex(args, isResume ? null : instruction, cwd, ctx)
      ctx.logger.info('codex_complete', {
        fileChanges: result.fileChanges.length,
        commands: result.commands.length,
        hasResponse: !!result.response,
      })
      return this.formatResult(result)
    } catch (error) {
      const message = toErrorMessage(error)
      return {
        success: false,
        output: `Codex execution failed: ${message}`,
        outputSummary: `Codex failed: ${message.slice(0, 100)}`,
      }
    }
  }

  private runCodex(
    args: string[],
    instruction: string | null,
    cwd: string,
    ctx: ToolContext,
  ): Promise<CodexResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexPath, args, {
        cwd,
        env: buildToolProcessEnv(ctx),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const result: CodexResult = {
        threadId: null,
        response: '',
        fileChanges: [],
        commands: [],
        reasoning: [],
        todos: [],
        errors: [],
        usage: null,
      }

      const stderrChunks: string[] = []
      let settled = false

      child.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data.toString())
      })

      const rl = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY })

      rl.on('line', (line: string) => {
        try {
          const event = JSON.parse(line) as CodexThreadEvent
          this.processEvent(event, result)
        } catch {
          // Non-JSON line, ignore
        }
      })

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          reject(new Error(`Failed to spawn codex: ${err.message}`))
        }
      })

      child.on('exit', (code: number | null, signal: string | null) => {
        if (settled) return
        settled = true

        if (signal) {
          reject(new Error(`Codex killed by signal ${signal}`))
        } else if (code !== 0) {
          const stderr = stderrChunks.join('')
          reject(new Error(`Codex exited with code ${code}: ${stderr.slice(0, 500)}`))
        } else {
          resolve(result)
        }
      })

      // Send instruction via stdin (new session) or skip (resume — prompt is in CLI args)
      if (instruction !== null) {
        child.stdin!.write(instruction)
      }
      child.stdin!.end()
    })
  }

  private processEvent(event: CodexThreadEvent, result: CodexResult): void {
    switch (event.type) {
      case 'thread.started':
        result.threadId = event.thread_id ?? null
        break

      case 'turn.completed':
        if (event.usage) {
          result.usage = event.usage
        }
        break

      case 'turn.failed':
        if (event.error) {
          result.errors.push(event.error.message)
        }
        break

      case 'error':
        if (event.message) {
          result.errors.push(event.message)
        }
        break

      case 'item.completed':
        if (event.item) {
          this.processItem(event.item, result)
        }
        break
    }
  }

  private processItem(item: CodexThreadItem, result: CodexResult): void {
    switch (item.type) {
      case 'agent_message':
        if (item.text) {
          result.response = item.text
        }
        break

      case 'file_change':
        if (item.changes) {
          for (const change of item.changes) {
            result.fileChanges.push({ path: change.path, kind: change.kind })
          }
        }
        break

      case 'command_execution':
        result.commands.push({
          command: item.command ?? '',
          output: item.aggregated_output ?? '',
          exitCode: item.exit_code ?? null,
          status: item.status ?? 'completed',
        })
        break

      case 'reasoning':
        if (item.text) {
          result.reasoning.push(item.text)
        }
        break

      case 'todo_list':
        if (item.items) {
          result.todos = item.items
        }
        break

      case 'error':
        if (item.message) {
          result.errors.push(item.message)
        }
        break
    }
  }

  private formatResult(result: CodexResult): ToolResult {
    const sections: string[] = []

    // Agent response
    if (result.response) {
      sections.push(`## Response\n${result.response}`)
    }

    // File changes
    if (result.fileChanges.length > 0) {
      const changeLines = result.fileChanges.map((c) => `- [${c.kind}] ${c.path}`)
      sections.push(`## File Changes\n${changeLines.join('\n')}`)
    }

    // Commands executed
    if (result.commands.length > 0) {
      const cmdLines = result.commands.map((c) => {
        const status = c.exitCode === 0 ? '✓' : c.exitCode !== null ? `✗ (exit ${c.exitCode})` : '…'
        const output = c.output ? `\n${c.output.slice(0, 500)}` : ''
        return `- ${status} \`${c.command}\`${output}`
      })
      sections.push(`## Commands\n${cmdLines.join('\n')}`)
    }

    // Errors
    if (result.errors.length > 0) {
      sections.push(`## Errors\n${result.errors.join('\n')}`)
    }

    // Thread ID — enables resume in subsequent calls
    if (result.threadId) {
      sections.push(`## Thread\nthreadId: ${result.threadId}`)
    }

    // Usage
    if (result.usage) {
      sections.push(
        `## Token Usage\nInput: ${result.usage.input_tokens} (cached: ${result.usage.cached_input_tokens}), Output: ${result.usage.output_tokens}`,
      )
    }

    const output = sections.join('\n\n')
    const artifacts = result.fileChanges.map((c) => c.path)

    // Build summary
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
    const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'Codex completed'

    return {
      success: result.errors.length === 0,
      output,
      outputSummary: summary,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    }
  }
}

interface CodexResult {
  threadId: string | null
  response: string
  fileChanges: Array<{ path: string; kind: string }>
  commands: Array<{ command: string; output: string; exitCode: number | null; status: string }>
  reasoning: string[]
  todos: Array<{ text: string; completed: boolean }>
  errors: string[]
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null
}
