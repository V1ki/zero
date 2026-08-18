import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@zero-os/shared'
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
})
