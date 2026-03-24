import { describe, expect, test } from 'bun:test'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from '../base'

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'No-op test tool'
  parameters = {}

  protected async execute(): Promise<ToolResult> {
    return {
      success: true,
      output: 'done',
      outputSummary: 'done',
    }
  }
}

describe('BaseTool observability', () => {
  test('records metrics without writing event logs', async () => {
    const tool = new NoopTool()
    const calls = {
      logEvent: 0,
      recordOperation: 0,
    }

    const ctx: ToolContext = {
      sessionId: 'sess_test',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      observability: {
        logEvent: () => {
          calls.logEvent++
        },
        recordOperation: () => {
          calls.recordOperation++
        },
      },
    }

    const result = await tool.run(ctx, {})

    expect(result.success).toBe(true)
    expect(calls.logEvent).toBe(0)
    expect(calls.recordOperation).toBe(1)
  })

  test('defaults tool definitions to kind=tool', () => {
    const tool = new NoopTool()

    expect(tool.toDefinition().kind).toBe('tool')
  })
})
