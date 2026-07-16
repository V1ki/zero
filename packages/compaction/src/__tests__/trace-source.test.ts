import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTraceEntry, readTraceSnapshot } from '../trace-source'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('trace source', () => {
  test('streams a frozen prefix and keeps only the latest span lifecycle snapshot', async () => {
    const sessionId = 'sess_trace_test'
    const root = makeTempDir()
    const tracePath = join(root, sessionId, 'trace.jsonl')
    const sentinel = 'SECRET_SHOULD_NOT_SURVIVE_projection'
    const entries = [
      entry({ sessionId, spanId: 'span_1', status: 'running', input: { query: sentinel } }),
      entry({
        sessionId,
        spanId: 'span_1',
        status: 'running',
        input: { query: sentinel },
        outputSummary: sentinel,
      }),
      entry({
        sessionId,
        spanId: 'span_1',
        status: 'success',
        input: { query: sentinel },
        outputSummary: sentinel,
      }),
      entry({ sessionId, spanId: 'span_2', status: 'error', error: '429 at capacity' }),
    ]
    writeJsonl(tracePath, entries)

    const snapshot = await readTraceSnapshot({
      tracePath,
      sourceSessionId: sessionId,
      allowedTraceRoot: root,
    })

    expect(snapshot.stats.sourceLines).toBe(4)
    expect(snapshot.stats.uniqueSpans).toBe(2)
    expect(snapshot.stats.supersededLifecycleEntries).toBe(2)
    expect(snapshot.stats.invalidJsonLines).toBe(0)
    expect(snapshot.stats.invalidShapeLines).toBe(0)
    expect(snapshot.stats.foreignSessionLines).toBe(0)
    expect(snapshot.observations[0]?.status).toBe('success')
    expect(snapshot.observations[1]?.errorClass).toBe('resource_exhausted')
    expect(JSON.stringify(snapshot)).not.toContain(sentinel)
  })

  test('separates malformed, foreign-session, and invalid-shape lines', async () => {
    const sessionId = 'sess_trace_test'
    const root = makeTempDir()
    const tracePath = join(root, sessionId, 'trace.jsonl')
    const valid = entry({ sessionId, spanId: 'span_ok', status: 'success' })
    const foreign = entry({ sessionId: 'sess_other', spanId: 'span_foreign', status: 'success' })
    const lines = [JSON.stringify(valid), '{not-json', JSON.stringify(foreign), JSON.stringify({})]
    mkdirSync(join(root, sessionId), { recursive: true })
    writeFileSync(tracePath, `${lines.join('\n')}\n`, 'utf-8')

    const snapshot = await readTraceSnapshot({ tracePath, sourceSessionId: sessionId })

    expect(snapshot.stats.invalidJsonLines).toBe(1)
    expect(snapshot.stats.foreignSessionLines).toBe(1)
    expect(snapshot.stats.invalidShapeLines).toBe(1)
    expect(snapshot.observations).toHaveLength(1)
  })

  test('freezes at the last complete JSONL record and ignores a partial append tail', async () => {
    const sessionId = 'sess_trace_test'
    const root = makeTempDir()
    const tracePath = join(root, sessionId, 'trace.jsonl')
    const complete = JSON.stringify(entry({ sessionId, spanId: 'span_ok', status: 'success' }))
    mkdirSync(join(root, sessionId), { recursive: true })
    writeFileSync(tracePath, `${complete}\n{"spanId":"partial`, 'utf-8')

    const snapshot = await readTraceSnapshot({
      tracePath,
      sourceSessionId: sessionId,
      allowedTraceRoot: root,
    })

    expect(snapshot.stats.sourceBytes).toBe(Buffer.byteLength(`${complete}\n`, 'utf8'))
    expect(snapshot.stats.sourceLines).toBe(1)
    expect(snapshot.observations).toHaveLength(1)
  })

  test('projects tool actions, closure signals, and side-effect boundaries', () => {
    const sessionId = 'sess_trace_test'
    const scheduleList = projectTraceEntry(
      entry({
        sessionId,
        spanId: 'span_list',
        status: 'success',
        name: 'tool:schedule',
        input: { action: 'list' },
      }),
      { sourceLine: 1, payloadChars: 10, expectedSessionId: sessionId },
    )
    const scheduleCreate = projectTraceEntry(
      entry({
        sessionId,
        spanId: 'span_create',
        status: 'success',
        name: 'tool:schedule',
        input: { action: 'create', name: 'watcher' },
      }),
      { sourceLine: 2, payloadChars: 10, expectedSessionId: sessionId },
    )
    const closure = projectTraceEntry(
      {
        ...entry({
          sessionId,
          spanId: 'span_closure',
          status: 'success',
          name: 'task_closure_decision',
        }),
        kind: 'closure_decision',
        data: { closure: { action: 'continue', reason: 'private reason' } },
      },
      { sourceLine: 3, payloadChars: 10, expectedSessionId: sessionId },
    )

    expect(scheduleList?.operation).toBe('tool:schedule:list')
    expect(scheduleList?.sideEffect).toBe(false)
    expect(scheduleCreate?.operation).toBe('tool:schedule:create')
    expect(scheduleCreate?.sideEffect).toBe(true)
    expect(closure?.operation).toBe('task_closure_decision:continue')
    expect(closure?.lane).toBe('control')
    expect(JSON.stringify(closure)).not.toContain('private reason')
  })

  test('classifies built-in and unknown tool effects against an independent oracle', () => {
    const sessionId = 'sess_trace_test'
    const cases: Array<{
      name: string
      kind?: string
      input?: Record<string, unknown>
      expectedOperation?: string
      expectedSideEffect: boolean
    }> = [
      {
        name: 'tool:fetch',
        input: { method: 'GET' },
        expectedOperation: 'tool:fetch:get',
        expectedSideEffect: false,
      },
      {
        name: 'tool:fetch',
        expectedOperation: 'tool:fetch:get',
        expectedSideEffect: false,
      },
      { name: 'tool:fetch', input: { method: 'HEAD' }, expectedSideEffect: false },
      { name: 'tool:fetch', input: { method: 'POST' }, expectedSideEffect: true },
      { name: 'tool:fetch', input: { method: 'PUT' }, expectedSideEffect: true },
      { name: 'tool:fetch', input: { method: 'PATCH' }, expectedSideEffect: true },
      {
        name: 'tool:fetch',
        input: { method: 'DELETE' },
        expectedOperation: 'tool:fetch:delete',
        expectedSideEffect: true,
      },
      { name: 'tool:codex', expectedOperation: 'tool:codex', expectedSideEffect: true },
      { name: 'tool:bash', expectedSideEffect: true },
      { name: 'tool:write', expectedSideEffect: true },
      { name: 'tool:edit', expectedSideEffect: true },
      { name: 'tool:x_search', expectedSideEffect: false },
      { name: 'tool:memory_read', expectedSideEffect: false },
      {
        name: 'tool:schedule',
        input: { action: 'list' },
        expectedOperation: 'tool:schedule:list',
        expectedSideEffect: false,
      },
      {
        name: 'tool:schedule',
        input: { action: 'create' },
        expectedOperation: 'tool:schedule:create',
        expectedSideEffect: true,
      },
      { name: 'tool:PRIVATE_UNKNOWN_TOOL', expectedSideEffect: true },
      {
        name: 'TOOL:fetch',
        kind: 'tool_call',
        input: { method: 'DELETE' },
        expectedOperation: 'tool:fetch:delete',
        expectedSideEffect: true,
      },
      { name: 'mcp:fetch', kind: 'tool_call', expectedSideEffect: true },
      {
        name: 'tool:schedule',
        input: { action: 'PRIVATE_UNKNOWN_ACTION' },
        expectedSideEffect: true,
      },
    ]

    for (const [index, item] of cases.entries()) {
      const observation = projectTraceEntry(
        entry({
          sessionId,
          spanId: `span_${index}`,
          status: 'success',
          name: item.name,
          kind: item.kind,
          input: item.input,
        }),
        { sourceLine: index + 1, payloadChars: 10, expectedSessionId: sessionId },
      )
      expect(observation?.sideEffect).toBe(item.expectedSideEffect)
      if (item.expectedOperation) expect(observation?.operation).toBe(item.expectedOperation)
    }
  })

  test('hashes unknown span, tool, action, kind, and span identifiers', () => {
    const sessionId = 'sess_trace_test'
    const sentinel = 'PRIVATE_TRACE_LABEL_SENTINEL'
    const inputs = [
      entry({
        sessionId,
        spanId: sentinel,
        status: 'success',
        name: sentinel,
        kind: sentinel,
      }),
      entry({
        sessionId,
        spanId: 'span_unknown_tool',
        status: 'success',
        name: `tool:${sentinel}`,
      }),
      entry({
        sessionId,
        spanId: 'span_unknown_action',
        status: 'success',
        name: 'tool:schedule',
        input: { action: sentinel },
      }),
      {
        ...entry({
          sessionId,
          spanId: 'span_unknown_closure',
          status: 'success',
          name: 'task_closure_decision',
        }),
        kind: 'closure_decision',
        data: { closure: { action: sentinel } },
      },
    ]
    const observations = inputs.map((input, index) =>
      projectTraceEntry(input, {
        sourceLine: index + 1,
        payloadChars: 10,
        expectedSessionId: sessionId,
      }),
    )

    expect(JSON.stringify(observations)).not.toContain(sentinel)
    expect(observations[0]?.operation).toMatch(/^operation:unknown_[a-f0-9]{16}$/)
    expect(observations[1]?.operation).toMatch(/^tool:custom_[a-f0-9]{16}$/)
    expect(observations[2]?.operation).toMatch(/^tool:schedule:action_[a-f0-9]{16}$/)
    expect(observations[3]?.operation).toMatch(/^task_closure_decision:action_[a-f0-9]{16}$/)
  })
})

function entry(options: {
  sessionId: string
  spanId: string
  status: 'running' | 'success' | 'error'
  name?: string
  kind?: string
  input?: Record<string, unknown>
  outputSummary?: string
  error?: string
}) {
  return {
    spanId: options.spanId,
    sessionId: options.sessionId,
    kind: options.kind ?? (options.name?.startsWith('tool:') ? 'tool_call' : 'turn'),
    name: options.name ?? 'turn:test',
    startTime: '2026-07-01T00:00:00.000Z',
    ...(options.status !== 'running' ? { endTime: '2026-07-01T00:00:01.000Z' } : {}),
    status: options.status,
    data: {
      ...(options.input ? { input: options.input } : {}),
      ...(options.outputSummary
        ? {
            outputSummary: options.outputSummary,
            toolResult: {
              success: options.status === 'success',
              outputSummary: options.outputSummary,
            },
          }
        : {}),
    },
    metadata: {
      ...(options.error ? { error: options.error } : {}),
    },
  }
}

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-compaction-trace-'))
  tempDirs.push(root)
  return root
}

function writeJsonl(path: string, entries: unknown[]): void {
  const directory = path.slice(0, path.lastIndexOf('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8')
}
