import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundToolProgressInput, ToolContext } from '@zero-os/shared'
import { SessionRunningToolRegistry } from '../../session/running-tool-registry'
import { WorkerTool } from '../worker'

const workspaces: string[] = []

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'zero-worker-test-'))
  workspaces.push(workspace)
  const binary = join(workspace, 'fake-codex.mjs')
  copyFileSync(join(import.meta.dir, '__fixtures__/worker-app-server.mjs'), binary)
  chmodSync(binary, 0o755)
  const projectRoot = join(workspace, 'project')
  mkdirSync(projectRoot)
  const ctx: ToolContext = {
    workDir: workspace,
    projectRoot,
    sessionId: 'test-worker-session',
    channelBinding: { source: 'web', channelName: 'control', channelId: 'channel-test' },
    logger: { info() {}, warn() {}, error() {} },
  }
  const tracePath = join(workspace, 'wire.jsonl')
  function trace(): Record<string, unknown>[] {
    if (!existsSync(tracePath)) return []
    return readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }
  return { workspace, ctx, trace, tool: new WorkerTool({ codexPath: binary }) }
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('WorkerTool', () => {
  test('requires type and instruction and declines the reserved dsh backend without starting Codex', async () => {
    const { tool, ctx, trace } = setup()
    const definition = tool.toDefinition()
    expect(definition.name).toBe('worker')
    expect(definition.parameters.required).toEqual(expect.arrayContaining(['type', 'instruction']))
    for (const input of [
      { instruction: 'hello' },
      { type: 'codex' },
      { type: 'dsh', instruction: 'hello' },
    ]) {
      const result = await tool.run(ctx, input)
      expect(result.success).toBe(false)
      expect(result.output).toMatch(/type|instruction|dsh/i)
    }
    expect(trace()).toEqual([])
  })

  test('starts a local app-server and retains early notifications for the requested turn', async () => {
    const { tool, ctx, workspace, trace } = setup()
    const progress: BackgroundToolProgressInput[] = []
    const result = await tool.run(
      {
        ...ctx,
        currentToolUseId: 'tool-progress',
        backgroundToolTasks: {
          thresholdMs: 60_000,
          run: (task) => task.execute(),
          reportProgress: (event) => progress.push(event),
        },
      },
      { type: 'codex', instruction: 'early', model: 'fixture-model' },
    )
    expect(result.success).toBe(true)
    for (const value of [
      'thread-fixture',
      'the final worker response',
      'bun test',
      'exit 0',
      'fixture stdout',
      '1234',
      '456',
      '179',
    ]) {
      expect(result.output).toContain(value)
    }
    expect(result.output).not.toContain('from other turn')
    expect(result.output).toContain(
      `${join(workspace, 'updated.ts')} → ${join(workspace, 'renamed.ts')}`,
    )
    expect(result.output).toContain(`[delete] ${join(workspace, 'deleted.ts')}`)
    expect(result.artifacts).toEqual([join(workspace, 'renamed.ts')])
    expect(
      progress.some(
        (event) =>
          event.toolUseId === 'tool-progress' && event.outputTail.includes('fixture stdout'),
      ),
    ).toBe(true)
    const calls = trace()
    expect(calls[0]).toMatchObject({
      args: expect.arrayContaining(['app-server']),
      sessionId: ctx.sessionId,
      channelId: 'channel-test',
    })
    expect(calls.map((call) => call.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ])
    expect(calls.find((call) => call.method === 'thread/start')).toMatchObject({
      cwd: ctx.projectRoot,
      model: 'fixture-model',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  test('resumes the supplied thread and merges writable roots without broadening the other permissions', async () => {
    const { tool, ctx, workspace, trace } = setup()
    const customCwd = join(workspace, 'custom-cwd')
    const extra = join(workspace, 'extra')
    mkdirSync(customCwd)
    mkdirSync(extra)
    const result = await tool.run(ctx, {
      type: 'codex',
      instruction: 'continue',
      resumeThreadId: 'old-thread',
      workingDirectory: customCwd,
      additionalDirectories: [extra],
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('old-thread')
    expect(trace().find((call) => call.method === 'thread/resume')).toMatchObject({
      threadId: 'old-thread',
      cwd: customCwd,
    })
    expect(trace().find((call) => call.method === 'turn/start')).toMatchObject({
      threadId: 'old-thread',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: expect.arrayContaining([join(workspace, 'configured-root'), extra]),
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    })
  })

  test('declines server-initiated approval without hanging the turn', async () => {
    const { tool, ctx, trace } = setup()
    const result = await tool.run(ctx, { type: 'codex', instruction: 'approval' })
    expect(result.success).toBe(true)
    expect(trace()).toContainEqual({ decision: 'decline' })
  })

  test('preserves a failed turn error and treats EOF before completion as failure without replay', async () => {
    for (const instruction of ['fail', 'reject', 'eof']) {
      const { tool, ctx, trace } = setup()
      const result = await tool.run(ctx, { type: 'codex', instruction })
      expect(result.success).toBe(false)
      if (instruction === 'fail') expect(result.output).toContain('fixture model rejected the turn')
      if (instruction === 'reject') expect(result.output).toContain('invalid turn parameters')
      if (instruction === 'eof') {
        expect(result.output).toContain('threadId: thread-fixture')
        expect(result.output).toContain('turnId: turn-fixture')
        expect(result.outputSummary).toContain('outcome unknown')
      } else {
        expect(result.outputSummary).not.toContain('outcome unknown')
      }
      expect(trace().filter((entry) => entry.method === 'turn/start')).toHaveLength(1)
    }
  })

  test('interrupts only the selected in-flight worker using its thread and turn IDs', async () => {
    const a = setup()
    const b = setup()
    const registry = new SessionRunningToolRegistry()
    const handle = registry.register({ toolUseId: 'selected', toolName: 'worker', abortable: true })
    const selected = a.tool.run(
      { ...a.ctx, currentToolUseId: 'selected', runningToolRegistry: registry },
      {
        type: 'codex',
        instruction: 'wait',
        resumeThreadId: 'selected-thread',
      },
    )
    const deadline = Date.now() + 3_000
    while (!a.trace().some((entry) => entry.method === 'turn/start') && Date.now() < deadline)
      await Bun.sleep(10)
    const other = a.tool.run(b.ctx, {
      type: 'codex',
      instruction: 'finish',
      resumeThreadId: 'other-thread',
    })
    expect(handle.requestAbort('stop only the selected worker')).toBe('accepted')
    const [aborted, finished] = await Promise.all([selected, other])
    expect(aborted.success).toBe(false)
    expect(finished.success).toBe(true)
    expect(handle.getTerminalMetadata()?.cause).toBe('abort')
    expect(a.trace()).toContainEqual({
      method: 'turn/interrupt',
      threadId: 'selected-thread',
      turnId: 'turn-fixture',
    })
    expect(b.trace().some((entry) => entry.method === 'turn/interrupt')).toBe(false)
  })
})
