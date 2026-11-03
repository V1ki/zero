import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundToolProgressInput, ToolContext } from '@zero-os/shared'
import { SessionRunningToolRegistry } from '../../session/running-tool-registry'
import { WorkerTool } from '../worker'

const fixtures: Array<{ tool: WorkerTool; workspace: string }> = []

function setup() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'zero-worker-test-')))
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
  async function waitForRequest(method: string) {
    const deadline = Date.now() + 2000
    while (!trace().some((entry) => entry.method === method) && Date.now() < deadline)
      await Bun.sleep(5)
    expect(trace().some((entry) => entry.method === method)).toBe(true)
  }
  const tool = new WorkerTool({ codexPath: binary })
  fixtures.push({ tool, workspace })
  return { workspace, ctx, trace, tool, waitForRequest }
}

function startWaiting(tool: WorkerTool, ctx: ToolContext, resumeThreadId?: string) {
  const registry = new SessionRunningToolRegistry()
  const target = registry.register({ toolUseId: 'original', toolName: 'worker', abortable: true })
  const scoped = { ...ctx, currentToolUseId: target.toolUseId, runningToolRegistry: registry }
  const started = Promise.withResolvers<{ threadId: string; turnId: string }>()
  const running = tool.run(
    {
      ...scoped,
      logger: {
        ...ctx.logger,
        info: (event, data) => {
          if (
            event === 'worker_turn_started' &&
            typeof data?.threadId === 'string' &&
            typeof data.turnId === 'string'
          ) {
            started.resolve({ threadId: data.threadId, turnId: data.turnId })
          }
        },
      },
    },
    { type: 'codex', action: 'run', instruction: 'wait', resumeThreadId },
  )
  const ready = Promise.race([
    started.promise,
    running.then((result) => {
      throw new Error(`Worker exited before starting: ${result.outputSummary}`)
    }),
  ])
  return { running, ready, target, scoped }
}

afterEach(async () => {
  for (const { tool, workspace } of fixtures.splice(0)) {
    try {
      await tool.close()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
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
      inheritedZeroKeys: [],
      cwd: process.cwd(),
    })
    expect(calls.map((call) => call.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'thread/unsubscribe',
    ])
    expect(calls.find((call) => call.method === 'thread/start')).toMatchObject({
      cwd: ctx.projectRoot,
      model: 'fixture-model',
      extraEnvKeys: 0,
      env: {
        ZERO_WORKSPACE: ctx.workDir,
        ZERO_PROJECT_ROOT: ctx.projectRoot,
        ZERO_SESSION_ID: ctx.sessionId,
        ZERO_CHANNEL_NAME: 'control',
        ZERO_CHANNEL_ID: 'channel-test',
      },
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
      env: { ZERO_SESSION_ID: ctx.sessionId, ZERO_WORKSPACE: ctx.workDir },
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

  test('steers the targeted active turn in place and reports the original run result', async () => {
    const { tool, ctx, trace } = setup()
    const { running, ready, target, scoped } = startWaiting(tool, ctx, 'steered-thread')
    const control = { ...scoped, currentToolUseId: 'follow-up' }
    const steer = { type: 'codex', action: 'steer', targetToolUseId: target.toolUseId }
    try {
      const { turnId } = await ready
      const foreign = await tool.run(
        {
          ...control,
          sessionId: 'other-session',
          runningToolRegistry: new SessionRunningToolRegistry(),
        },
        { ...steer, instruction: 'foreign message' },
      )
      expect(foreign.success).toBe(false)
      for (const invalidInput of [
        { ...steer, targetToolUseId: 'missing' },
        { ...steer, model: 'invalid-override' },
        { ...steer, resumeThreadId: 'other-thread' },
      ]) {
        const rejected = await tool.run(control, {
          ...invalidInput,
          instruction: 'bad target or parameters',
        })
        expect(rejected.success).toBe(false)
      }
      expect(trace().filter((entry) => entry.method === 'turn/steer')).toHaveLength(0)

      for (const instruction of ['reject steer', 'wrong ack']) {
        const rejected = await tool.run(control, { ...steer, instruction })
        expect(rejected.success).toBe(false)
      }
      const first = await tool.run(control, { ...steer, instruction: 'focus on tests' })
      expect(first.success).toBe(true)
      const final = await tool.run(control, { ...steer, instruction: 'finish with adjusted scope' })
      expect(final.success).toBe(true)
      const result = await running
      expect(result.success).toBe(true)
      expect(result.output).toContain('finish with adjusted scope')
      expect(result.output).toContain(`turnId: ${turnId}`)
      const late = await tool.run(control, { ...steer, instruction: 'message after completion' })
      expect(late.success).toBe(false)
      const events = trace()
      expect(events.filter((entry) => entry.method === 'initialize')).toHaveLength(1)
      expect(events.filter((entry) => entry.method === 'turn/start')).toHaveLength(1)
      expect(events.filter((entry) => entry.method === 'turn/steer')).toEqual(
        ['reject steer', 'wrong ack', 'focus on tests', 'finish with adjusted scope'].map((text) =>
          expect.objectContaining({
            threadId: 'steered-thread',
            expectedTurnId: turnId,
            input: [expect.objectContaining({ type: 'text', text })],
          }),
        ),
      )
    } finally {
      target.requestAbort('fixture cleanup')
      await running
    }
  })

  test('delivers an adjustment submitted before Codex acknowledges the original turn', async () => {
    const { tool, ctx, workspace, trace, waitForRequest } = setup()
    const registry = new SessionRunningToolRegistry()
    const target = registry.register({ toolUseId: 'starting', toolName: 'worker', abortable: true })
    const scoped = { ...ctx, runningToolRegistry: registry }
    const running = tool.run(
      { ...scoped, currentToolUseId: target.toolUseId },
      { type: 'codex', instruction: 'wait for start gate' },
    )
    try {
      await waitForRequest('turn/start')
      const steering = tool.run(scoped, {
        type: 'codex',
        action: 'steer',
        instruction: 'finish with adjusted scope',
        targetToolUseId: target.toolUseId,
      })
      // Let the control call reach the live handler while the original start is still blocked.
      await Bun.sleep(0)
      writeFileSync(join(workspace, 'allow-turn-start'), '')
      expect((await steering).success).toBe(true)
      expect((await running).success).toBe(true)
      expect(trace().filter((entry) => entry.method === 'turn/steer')).toHaveLength(1)
    } finally {
      target.requestAbort('fixture cleanup')
      await running
    }
  })

  test('routes concurrent steer and interrupt to their own sessions on one server', async () => {
    const { tool, ctx, workspace, trace } = setup()
    const otherWorkspace = join(workspace, 'other')
    const otherRoot = join(otherWorkspace, 'project')
    mkdirSync(otherRoot, { recursive: true })
    const otherCtx: ToolContext = {
      ...ctx,
      sessionId: 'other-session',
      workDir: otherWorkspace,
      projectRoot: otherRoot,
      channelBinding: undefined,
    }
    // Both sessions use the same toolUseId, so only the session registry distinguishes them.
    const adjusted = startWaiting(tool, ctx)
    const interrupted = startWaiting(tool, otherCtx)
    const [a, b] = await Promise.all([adjusted.ready, interrupted.ready])
    expect(a.threadId).not.toBe(b.threadId)

    const steering = tool.run(adjusted.scoped, {
      type: 'codex',
      action: 'steer',
      targetToolUseId: adjusted.target.toolUseId,
      instruction: 'finish with adjusted scope',
    })
    expect(interrupted.target.requestAbort('stop second worker')).toBe('accepted')
    const [ack, finished, stopped] = await Promise.all([
      steering,
      adjusted.running,
      interrupted.running,
    ])
    expect(ack.success).toBe(true)
    expect(finished.success).toBe(true)
    expect(finished.output).toContain('finish with adjusted scope')
    expect(finished.output).not.toContain('stop second worker')
    expect(stopped.success).toBe(false)
    expect(stopped.output).toContain('stop second worker')
    expect(stopped.output).not.toContain('finish with adjusted scope')
    expect(interrupted.target.getTerminalMetadata()?.cause).toBe('abort')
    const events = trace()
    expect(events.filter((e) => e.method === 'turn/steer')).toEqual([
      expect.objectContaining({ threadId: a.threadId, expectedTurnId: a.turnId }),
    ])
    expect(events.filter((e) => e.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', ...b },
    ])
    const otherStart = events.find((e) => e.method === 'thread/start' && e.threadId === b.threadId)
    expect(otherStart).toMatchObject({
      cwd: otherRoot,
      env: {
        ZERO_SESSION_ID: otherCtx.sessionId,
        ZERO_PROJECT_ROOT: otherRoot,
        ZERO_WORKSPACE: otherWorkspace,
        ZERO_CHANNEL_NAME: '',
        ZERO_CHANNEL_ID: '',
      },
    })
    expect(
      events.find((e) => e.method === 'thread/start' && e.threadId === a.threadId),
    ).toMatchObject({
      cwd: ctx.projectRoot,
      env: { ZERO_SESSION_ID: ctx.sessionId, ZERO_CHANNEL_ID: 'channel-test' },
    })
    const later = await tool.run(ctx, { type: 'codex', instruction: 'finish' })
    expect(later.success).toBe(true)
    expect(trace().filter((entry) => entry.pid)).toHaveLength(1)
    expect(trace().filter((entry) => entry.method === 'initialize')).toHaveLength(1)
  })

  test('rejects concurrent resume of one thread, then allows resume after completion', async () => {
    const { tool, ctx, trace } = setup()
    const threadId = 'shared-thread'
    const first = startWaiting(tool, ctx, threadId)
    const duplicate = tool.run(ctx, {
      type: 'codex',
      instruction: 'duplicate',
      resumeThreadId: threadId,
    })
    await first.ready
    const rejected = await duplicate
    expect(rejected.success).toBe(false)
    expect(rejected.output).toMatch(/active|in use/i)
    expect(trace().filter((e) => e.method === 'thread/resume')).toHaveLength(1)
    first.target.requestAbort()
    await first.running
    const later = await tool.run(ctx, {
      type: 'codex',
      instruction: 'continue',
      resumeThreadId: threadId,
    })
    expect(later.success).toBe(true)
    expect(
      trace()
        .filter((e) => e.method === 'turn/start')
        .map((e) => e.mode),
    ).toEqual(['wait', 'continue'])
    expect(trace().filter((e) => e.pid)).toHaveLength(1)
  })

  test.each(['close retained threads', 'eof'])(
    'guards a thread after failed unsubscribe until %s',
    async (endOfSubscription) => {
      const { tool, ctx, trace } = setup()
      const resumeThreadId = 'retained-thread'
      const other = { ...ctx, sessionId: 'later-session' }
      const run = await tool.run(ctx, {
        type: 'codex',
        resumeThreadId,
        instruction: 'keep thread loaded',
      })
      expect(run.success).toBe(false)
      expect(run.output).toContain('Codex thread cleanup failed: fixture still holds subscription')

      const followup = { type: 'codex', resumeThreadId, instruction: 'report thread session' }
      const beforeResume = trace()
      const blocked = await tool.run(other, followup)
      expect(blocked.success).toBe(false)
      expect(blocked.output).toMatch(/active|in use/i)
      expect(trace()).toEqual(beforeResume)

      const sibling = await tool.run(other, { type: 'codex', instruction: 'report thread session' })
      expect(sibling.success).toBe(true)
      expect(sibling.output).toContain(other.sessionId)
      const release = await tool.run(other, { type: 'codex', instruction: endOfSubscription })
      expect(release.success).toBe(endOfSubscription !== 'eof')

      const resumed = await tool.run(other, followup)
      expect(resumed.success).toBe(true)
      expect(resumed.output).toContain(other.sessionId)
      expect(resumed.output).not.toContain(ctx.sessionId)
      expect(trace().filter((e) => e.method === 'thread/resume')).toHaveLength(2)
      expect(trace().filter((e) => e.method === 'initialize')).toHaveLength(
        endOfSubscription === 'eof' ? 2 : 1,
      )
    },
  )

  test('isolates a malformed thread notification while a sibling remains steerable', async () => {
    const { tool, ctx, trace } = setup()
    const sibling = startWaiting(tool, ctx)
    await sibling.ready
    const invalid = await tool.run(ctx, {
      type: 'codex',
      instruction: 'malformed notification',
      resumeThreadId: 'broken-thread',
    })
    expect(invalid.success).toBe(false)
    expect(invalid.output).toContain('threadId: broken-thread')
    expect(invalid.output).toMatch(/invalid.*text/i)
    const ack = await tool.run(sibling.scoped, {
      type: 'codex',
      action: 'steer',
      targetToolUseId: sibling.target.toolUseId,
      instruction: 'finish with adjusted scope',
    })
    expect(ack.success).toBe(true)
    const finished = await sibling.running
    expect(finished.success).toBe(true)
    expect(finished.output).toContain('finish with adjusted scope')
    expect(trace().filter((entry) => entry.method === 'initialize')).toHaveLength(1)
  })

  test('loss of one shared server fails its active turns and only a new run starts a fresh server', async () => {
    const { tool, ctx, trace, waitForRequest } = setup()
    const first = startWaiting(tool, ctx)
    const { threadId, turnId } = await first.ready
    const pendingSteer = tool.run(first.scoped, {
      type: 'codex',
      action: 'steer',
      targetToolUseId: first.target.toolUseId,
      instruction: 'hold ack',
    })
    await waitForRequest('turn/steer')
    const lost = tool.run(ctx, { type: 'codex', instruction: 'eof' })
    const [waiting, crashed, steer] = await Promise.all([first.running, lost, pendingSteer])
    expect(steer.success).toBe(false)
    expect(steer.output).toMatch(/delivery is unknown/i)
    for (const result of [waiting, crashed]) {
      expect(result.success).toBe(false)
      expect(result.outputSummary).toContain('outcome unknown')
    }
    expect(waiting.output).toContain(`threadId: ${threadId}`)
    expect(waiting.output).toContain(`turnId: ${turnId}`)
    expect(waiting.output).not.toContain('incomplete reply')
    expect(trace().filter((e) => e.pid)).toHaveLength(1)

    const next = await tool.run(ctx, { type: 'codex', instruction: 'fresh' })
    expect(next.success).toBe(true)
    const events = trace()
    expect(events.filter((e) => e.method === 'turn/steer')).toHaveLength(1)
    expect(events.filter((e) => e.pid)).toHaveLength(2)
    expect(events.filter((e) => e.method === 'initialize')).toHaveLength(2)
    expect(events.filter((e) => e.method === 'turn/start').map((e) => e.mode)).toEqual([
      'wait',
      'eof',
      'fresh',
    ])
  })
})
