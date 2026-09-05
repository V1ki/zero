import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@zero-os/shared'
import { SessionRunningToolRegistry } from '../../session/running-tool-registry'
import { BashTool } from '../bash'

const makeCtx = () =>
  ({
    sessionId: 'test_session',
    workDir: process.cwd(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }) as unknown as ToolContext

describe('BashTool output capture', () => {
  const tool = new BashTool([])

  test('small output passes through unchanged', async () => {
    const result = await tool.run(makeCtx(), { command: 'echo hello' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello')
  })

  test('huge stdout is truncated while head and tail are retained', async () => {
    // ~2.6 MB of predictable numbered lines
    const result = await tool.run(makeCtx(), {
      command: `awk 'BEGIN { for (i = 1; i <= 200000; i++) printf "%012d\\n", i }'`,
    })
    expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThan(150_000)
    expect(result.output).toContain('output truncated')
    expect(result.output).toContain('000000000001') // head preserved
    expect(result.output.trimEnd().endsWith('000000200000')).toBe(true) // tail preserved
  })

  test('stderr is captured and failures keep their exit code context', async () => {
    const result = await tool.run(makeCtx(), { command: 'echo oops >&2; exit 3' })
    expect(result.success).toBe(false)
    expect(result.output).toContain('[stderr]')
    expect(result.output).toContain('oops')
  })

  test('streams live output progress to the background task sink', async () => {
    const reports: Array<{ toolUseId: string; totalOutputChars: number; outputTail: string }> = []
    const ctx = {
      ...makeCtx(),
      currentToolUseId: 'toolu_progress_1',
      backgroundToolTasks: {
        thresholdMs: 60_000,
        run: async () => ({ success: true, output: '', outputSummary: '' }),
        reportProgress: (input: {
          toolUseId: string
          totalOutputChars: number
          outputTail: string
        }) => {
          reports.push(input)
        },
      },
    } as unknown as ToolContext

    const result = await tool.run(ctx, { command: 'echo building; echo warnings >&2' })

    expect(result.success).toBe(true)
    expect(reports.length).toBeGreaterThanOrEqual(1)
    const last = reports.at(-1)
    expect(last?.toolUseId).toBe('toolu_progress_1')
    expect(last?.totalOutputChars).toBeGreaterThan(0)
    expect(last?.outputTail).toContain('building')
    expect(last?.outputTail).toContain('warnings')
  }, 5000)

  test('command timeout kills the process and reports the failure result', async () => {
    const registry = new SessionRunningToolRegistry()
    const handle = registry.register({
      toolUseId: 'toolu_timeout_1',
      toolName: 'bash',
      abortable: true,
    })
    const ctx = {
      ...makeCtx(),
      currentToolUseId: 'toolu_timeout_1',
      runningToolRegistry: registry,
    } as unknown as ToolContext

    const result = await tool.run(ctx, { command: 'sleep 2', timeout: 150 })
    // The ToolResult reports the killed exit code; the timeout cause and its
    // summary are recorded on the running-tool handle.
    expect(result.success).toBe(false)
    expect(result.outputSummary).toContain('Command failed')
    expect(result.output).not.toContain('[abort]')
    expect(handle.getTerminalMetadata()?.cause).toBe('timeout')
    expect(handle.getTerminalMetadata()?.outputSummary).toContain('Command timed out')
  }, 5000)

  test('abort request kills the command and returns the abort result', async () => {
    const registry = new SessionRunningToolRegistry()
    const handle = registry.register({
      toolUseId: 'toolu_abort_1',
      toolName: 'bash',
      abortable: true,
    })
    const ctx = {
      ...makeCtx(),
      currentToolUseId: 'toolu_abort_1',
      runningToolRegistry: registry,
    } as unknown as ToolContext

    const pending = tool.run(ctx, { command: 'sleep 2' })
    await Bun.sleep(150)
    expect(handle.requestAbort('stopped from Session Detail')).toBe('accepted')
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.outputSummary).toContain('Command aborted')
    expect(result.output).toContain('[abort]')
    expect(result.output).toContain('stopped from Session Detail')
    expect(handle.getTerminalMetadata()?.cause).toBe('abort')
  }, 5000)
})
