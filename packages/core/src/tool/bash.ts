import type { FuseRule, ToolContext, ToolResult } from '@zero-os/shared'
import { FuseListChecker } from '../config/fuse-list'
import { BaseTool } from './base'
import { buildToolProcessEnv } from './process-env'

interface BashInput {
  command: string
  description?: string
  timeout?: number
}

export class BashTool extends BaseTool {
  kind = 'built-in' as const
  name = 'bash'
  description = 'Execute a shell command and return output.'
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      description: { type: 'string', description: 'Brief description of what this command does' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
  }

  private fuseChecker: FuseListChecker

  constructor(fuseRules: FuseRule[]) {
    super()
    this.fuseChecker = new FuseListChecker(fuseRules)
  }

  protected async fuseCheck(input: unknown): Promise<void> {
    const { command } = input as BashInput
    this.fuseChecker.check(command)
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { command, timeout = 120_000 } = input as BashInput

    const proc = Bun.spawn(['bash', '-c', command], {
      cwd: ctx.workDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildToolProcessEnv(ctx),
    })

    const timeoutId = setTimeout(() => {
      proc.kill()
    }, timeout)

    const exitCode = await proc.exited
    clearTimeout(timeoutId)

    // Read pipes with a grace period — background child processes may hold
    // inherited fds open indefinitely (e.g. `cmd &`), so we don't wait forever.
    const PIPE_GRACE_MS = 1000
    const stdout = await Promise.race([
      new Response(proc.stdout).text(),
      Bun.sleep(PIPE_GRACE_MS).then(() => ''),
    ])
    const stderr = await Promise.race([
      new Response(proc.stderr).text(),
      Bun.sleep(PIPE_GRACE_MS).then(() => ''),
    ])

    const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')

    if (exitCode !== 0) {
      return {
        success: false,
        output: output || `Exit code: ${exitCode}`,
        outputSummary: `Command failed (exit ${exitCode}): ${command.slice(0, 80)}`,
      }
    }

    return {
      success: true,
      output: output || '(no output)',
      outputSummary: `Executed: ${command.slice(0, 80)}`,
    }
  }
}
