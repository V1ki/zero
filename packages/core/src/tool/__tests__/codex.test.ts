import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@zero-os/shared'
import { SessionRunningToolRegistry } from '../../session/running-tool-registry'
import { CodexTool } from '../codex'

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

const USAGE_EVENT =
  '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}'

const tempDirs: string[] = []

/** Writes a fake codex binary that the SDK spawns through codexPathOverride. */
function writeFakeCodex(name: string, script: string): string {
  const fixtureDir = mkdtempSync(join(tmpdir(), `codex-tool-${name}-`))
  tempDirs.push(fixtureDir)
  const scriptPath = join(fixtureDir, name)
  writeFileSync(scriptPath, script, 'utf-8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

describe('CodexTool', () => {
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('has correct tool definition', () => {
    const tool = new CodexTool()
    const def = tool.toDefinition()
    expect(def.name).toBe('codex')
    expect(def.description).toContain('code engineering')
    expect(def.parameters.required).toEqual(['instruction'])
    expect(def.parameters.properties).toHaveProperty('instruction')
    expect(def.parameters.properties).toHaveProperty('workingDirectory')
    expect(def.parameters.properties).toHaveProperty('model')
    expect(def.parameters.properties).toHaveProperty('resumeThreadId')
  })

  test('validates required instruction field', async () => {
    const tool = new CodexTool()
    const result = await tool.run(makeCtx(), {})
    expect(result.success).toBe(false)
    expect(result.output).toContain('missing required fields')
    expect(result.output).toContain('instruction')
  })

  test('handles missing codex binary gracefully', async () => {
    const tool = new CodexTool({ codexPath: '/nonexistent/codex-binary' })
    const result = await tool.run(makeCtx(), { instruction: 'test' })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Codex execution failed')
  })

  test('runs a turn through the SDK and maps events into result sections', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex',
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread_test"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"Applied fake codex change"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"file_1","type":"file_change","changes":[{"path":"src/example.ts","kind":"update"}],"status":"completed"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","command":"bun test","aggregated_output":"ok","exit_code":0,"status":"completed"}}'
printf '%s\\n' '${USAGE_EVENT}'
`,
    )

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(makeCtx(), { instruction: 'Apply a fake codex change' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('## Response\nApplied fake codex change')
    expect(result.output).toContain('- [update] src/example.ts')
    expect(result.output).toContain('`bun test`')
    expect(result.output).toContain('## Thread\nthreadId: thread_test')
    expect(result.output).toContain('Input: 1 (cached: 0), Output: 2')
    expect(result.outputSummary).toBe('1 file(s) changed, 1 command(s) run')
    expect(result.artifacts).toEqual(['src/example.ts'])
  })

  test('injects session and channel env vars into codex subprocesses', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex-env',
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread_env"}'
printf '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"%s|%s|%s|%s|%s"}}\\n' "$ZERO_WORKSPACE" "$ZERO_PROJECT_ROOT" "$ZERO_SESSION_ID" "$ZERO_CHANNEL_NAME" "$ZERO_CHANNEL_ID"
printf '%s\\n' '${USAGE_EVENT}'
`,
    )
    const projectRoot = mkdtempSync(join(tmpdir(), 'codex-project-'))
    tempDirs.push(projectRoot)
    const baseCtx = makeCtx()

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(
      {
        ...baseCtx,
        projectRoot,
        channelBinding: {
          source: 'feishu',
          channelName: 'feishu:ops',
          channelId: 'chat-99',
        },
      } as unknown as ToolContext,
      { instruction: 'Check env injection' },
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain(
      `${baseCtx.workDir}|${projectRoot}|test_session|feishu:ops|chat-99`,
    )
  })

  test('resumes a previous thread when resumeThreadId is provided', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex-resume',
      `#!/bin/sh
cat >/dev/null
case "$*" in
  *"resume thread_resume_123"*)
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread_resume_123"}'
    printf '%s\\n' '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"resumed the thread"}}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
    ;;
  *)
    printf '%s\\n' '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"started a new thread"}}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
    ;;
esac
`,
    )

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(makeCtx(), {
      instruction: 'Continue the fix',
      resumeThreadId: 'thread_resume_123',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('resumed the thread')
    expect(result.output).toContain('## Thread\nthreadId: thread_resume_123')
  })

  test('maps turn.failed into the Errors section and a failed result', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex-fail',
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread_fail"}'
printf '%s\\n' '{"type":"turn.failed","error":{"message":"model unavailable"}}'
`,
    )

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(makeCtx(), { instruction: 'Do something' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('## Errors\nmodel unavailable')
    expect(result.outputSummary).toBe('1 error(s)')
  })

  test('surfaces non-zero codex exit codes with stderr detail', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex-exit',
      `#!/bin/sh
cat >/dev/null
echo "codex exploded" >&2
exit 3
`,
    )

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(makeCtx(), { instruction: 'Do something' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Codex execution failed')
    expect(result.output).toContain('code 3')
    expect(result.output).toContain('codex exploded')
  })

  test('streams command output progress to the background task sink', async () => {
    const scriptPath = writeFakeCodex(
      'fake-codex-progress',
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread_progress"}'
printf '%s\\n' '{"type":"item.updated","item":{"id":"cmd_1","type":"command_execution","command":"bun run build","aggregated_output":"building...","status":"in_progress"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","command":"bun run build","aggregated_output":"building... done","exit_code":0,"status":"completed"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
`,
    )
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

    const tool = new CodexTool({ codexPath: scriptPath })
    const result = await tool.run(ctx, { instruction: 'Run the build' })

    expect(result.success).toBe(true)
    expect(reports.length).toBeGreaterThanOrEqual(2)
    const last = reports.at(-1)
    expect(last?.toolUseId).toBe('toolu_progress_1')
    expect(last?.totalOutputChars).toBe('building... done'.length)
    expect(last?.outputTail).toContain('building... done')
  }, 5000)

  test('abort request interrupts the running turn', async () => {
    // `exec sleep` keeps SIGTERM lethal for the whole process; a plain
    // `sleep` grandchild would inherit stdout and hold the pipe open.
    const scriptPath = writeFakeCodex(
      'fake-codex-abort',
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread_abort"}'
exec sleep 30
`,
    )

    const registry = new SessionRunningToolRegistry()
    const handle = registry.register({
      toolUseId: 'toolu_abort_1',
      toolName: 'codex',
      abortable: true,
    })
    const ctx = {
      ...makeCtx(),
      currentToolUseId: 'toolu_abort_1',
      runningToolRegistry: registry,
    } as unknown as ToolContext

    const tool = new CodexTool({ codexPath: scriptPath })
    const pending = tool.run(ctx, { instruction: 'Long running change' })
    await Bun.sleep(300)
    expect(handle.requestAbort('stopped from Session Detail')).toBe('accepted')
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.output).toContain('stopped from Session Detail')
    expect(result.outputSummary).toContain('aborted')
    expect(handle.getTerminalMetadata()?.cause).toBe('abort')
  }, 10_000)

  test('accepts custom codex path', () => {
    const tool = new CodexTool({ codexPath: '/usr/local/bin/codex' })
    expect(tool.toDefinition().name).toBe('codex')
  })
})
