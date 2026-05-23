import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tracer } from '../trace'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('Tracer', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('start and end a root span', () => {
    const tracer = new Tracer()
    const span = tracer.startSpan('sess_001', 'handle_message')
    expect(span.status).toBe('running')
    expect(span.sessionId).toBe('sess_001')

    tracer.endSpan(span.id, 'success', { tokensUsed: 500 })
    const ended = expectDefined(tracer.getSpan(span.id))
    expect(ended.status).toBe('success')
    expect(ended.durationMs).toBeGreaterThanOrEqual(0)
    expect(ended.metadata?.tokensUsed).toBe(500)
  })

  test('child spans link to parent', () => {
    const tracer = new Tracer()
    const root = tracer.startSpan('sess_001', 'agent_loop')
    const child = tracer.startSpan('sess_001', 'tool_call:bash', root.id)

    expect(child.parentId).toBe(root.id)
    expect(root.children).toHaveLength(1)
    expect(root.children[0].id).toBe(child.id)
  })

  test('getSessionTraces returns root spans for a session', () => {
    const tracer = new Tracer()
    tracer.startSpan('sess_001', 'trace_1')
    tracer.startSpan('sess_001', 'trace_2')
    tracer.startSpan('sess_002', 'trace_3')

    const traces = tracer.getSessionTraces('sess_001')
    expect(traces).toHaveLength(2)
  })

  test('exportSession returns full trace tree', () => {
    const tracer = new Tracer()
    const root = tracer.startSpan('sess_001', 'main')
    tracer.startSpan('sess_001', 'child_1', root.id)
    tracer.startSpan('sess_001', 'child_2', root.id)

    const exported = tracer.exportSession('sess_001')
    expect(exported).toHaveLength(1)
    expect(exported[0].children).toHaveLength(2)
  })

  test('persists span lifecycle snapshots to session trace.jsonl and run.log', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1423_web_a1b2'
    const tracer = new Tracer(logsDir)

    const root = tracer.startSpan(sessionId, 'turn:web', undefined, {
      kind: 'turn',
      agentName: 'web',
      data: { turnIndex: 1 },
    })
    tracer.updateSpan(root.id, {
      data: { requestCount: 1 },
      metadata: { source: 'test' },
    })
    tracer.endSpan(root.id, 'success')

    const tracePath = join(logsDir, 'sessions', '2026-03-16', sessionId, 'trace.jsonl')
    const runLogPath = join(logsDir, 'sessions', '2026-03-16', sessionId, 'run.log')
    expect(existsSync(tracePath)).toBe(true)
    expect(existsSync(runLogPath)).toBe(true)

    const entries = readFileSync(tracePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(entries).toHaveLength(3)
    expect(entries[0].status).toBe('running')
    expect(entries[1].status).toBe('running')
    expect(entries[2].status).toBe('success')
    expect(entries[2].spanId).toBe(root.id)
    expect(entries[2].kind).toBe('turn')
    expect(entries[2].agentName).toBe('web')
    expect(entries[2].data).toEqual({ turnIndex: 1, requestCount: 1 })
    expect(entries[2].metadata).toEqual({ source: 'test' })

    const runEntries = readFileSync(runLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(runEntries).toHaveLength(3)
    expect(runEntries[0].event).toBe('trace.turn.running')
    expect(runEntries[2].event).toBe('trace.turn.success')
    expect(runEntries[2].spanId).toBe(root.id)
  })

  test('logSession appends session debug entries to run.log', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1423_web_a1b2'
    const tracer = new Tracer(logsDir)

    tracer.logSession(sessionId, 'debug', 'llm_request.raw_request', {
      request: { model: 'fake-model', prompt: 'hello' },
    })

    const runLogPath = join(logsDir, 'sessions', '2026-03-16', sessionId, 'run.log')
    const entries = readFileSync(runLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'debug',
      event: 'llm_request.raw_request',
      sessionId,
    })
    expect(entries[0].data).toEqual({ request: { model: 'fake-model', prompt: 'hello' } })
  })

  test('externalizes image payloads from trace snapshots and raw request logs', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1520_web_a1b2'
    const tracer = new Tracer(logsDir)
    const imageData = Buffer.from('image-bytes').toString('base64')

    const span = tracer.startSpan(sessionId, 'tool:read_image', undefined, {
      kind: 'tool_call',
      data: {
        result: {
          contentItems: [{ type: 'image', mediaType: 'image/png', data: imageData }],
        },
      },
    })
    tracer.logSession(sessionId, 'debug', 'llm_request.raw_request', {
      request: {
        image_url: `data:image/png;base64,${imageData}`,
      },
    })

    const tracePath = join(logsDir, 'sessions', '2026-03-16', sessionId, 'trace.jsonl')
    const runLogPath = join(logsDir, 'sessions', '2026-03-16', sessionId, 'run.log')
    const traceRaw = readFileSync(tracePath, 'utf-8')
    const runLogRaw = readFileSync(runLogPath, 'utf-8')

    expect(traceRaw).not.toContain(imageData)
    expect(runLogRaw).not.toContain(imageData)
    expect(runLogRaw).not.toContain('data:image/png;base64')
    expect(JSON.stringify(tracer.getSpan(span.id))).not.toContain(imageData)
    const exportedRaw = JSON.stringify(tracer.exportSession(sessionId))
    expect(exportedRaw).not.toContain(imageData)
    expect(exportedRaw).toContain('"imageRef"')

    const traceEntry = JSON.parse(traceRaw.trim().split('\n')[0]) as Record<string, unknown>
    const imageItem = (
      ((traceEntry.data as Record<string, unknown>).result as Record<string, unknown>)
        .contentItems as Array<Record<string, unknown>>
    )[0]
    const imageRef = imageItem.imageRef as { path: string; relativePath: string; bytes: number }

    expect(imageItem.data).toBeUndefined()
    expect(imageRef.relativePath).toMatch(/^images\/[a-f0-9]+\.png$/)
    expect(imageRef.bytes).toBe(Buffer.from('image-bytes').length)
    expect(existsSync(imageRef.path)).toBe(true)
    expect(readFileSync(imageRef.path, 'utf-8')).toBe('image-bytes')
  })

  test('readSessionEntries collapses lifecycle snapshots to latest state', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1450_web_a1b2'
    const tracer = new Tracer(logsDir)

    const span = tracer.startSpan(sessionId, 'turn:web', undefined, {
      kind: 'turn',
      data: { step: 'started' },
    })
    tracer.updateSpan(span.id, {
      data: { step: 'updated' },
    })

    const entries = tracer.readSessionEntries(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].spanId).toBe(span.id)
    expect(entries[0].status).toBe('running')
    expect(entries[0].data).toEqual({ step: 'updated' })
  })

  test('exportSession restores persisted running spans after restart', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1500_web_a1b2'
    const writer = new Tracer(logsDir)

    const root = writer.startSpan(sessionId, 'turn:web', undefined, {
      kind: 'turn',
    })
    writer.startSpan(sessionId, 'tool:read', root.id, {
      kind: 'tool_call',
      data: { path: '/tmp/demo.txt' },
    })

    const reader = new Tracer(logsDir)
    const exported = reader.exportSession(sessionId)

    expect(exported).toHaveLength(1)
    expect(exported[0].status).toBe('running')
    expect(exported[0].children).toHaveLength(1)
    expect(exported[0].children[0].status).toBe('running')
    expect(exported[0].children[0].data).toEqual({ path: '/tmp/demo.txt' })
  })

  test('exportSession rebuilds persisted tree and overlays running spans', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'zero-trace-'))
    tempDirs.push(logsDir)
    const sessionId = 'sess_20260316_1423_web_a1b2'
    const tracer = new Tracer(logsDir)

    const root = tracer.startSpan(sessionId, 'turn:web', undefined, { kind: 'turn' })
    const child = tracer.startSpan(sessionId, 'llm_request', root.id, { kind: 'llm_request' })
    tracer.endSpan(child.id, 'success')
    tracer.endSpan(root.id, 'success')

    const runningRoot = tracer.startSpan(sessionId, 'turn:running', undefined, { kind: 'turn' })
    tracer.startSpan(sessionId, 'tool:read', runningRoot.id, { kind: 'tool_call' })

    const exported = tracer.exportSession(sessionId)
    expect(exported).toHaveLength(2)
    expect(exported[0].children).toHaveLength(1)
    expect(exported[0].children[0].name).toBe('llm_request')
    expect(exported[1].name).toBe('turn:running')
    expect(exported[1].children).toHaveLength(1)
    expect(exported[1].children[0].status).toBe('running')
  })

  test('updateSpan deep-merges nested data objects', () => {
    const tracer = new Tracer()
    const span = tracer.startSpan('sess_001', 'task_closure_decision', undefined, {
      kind: 'closure_decision',
      data: {
        closure: {
          event: 'task_closure_decision',
          action: 'continue',
        },
      },
    })

    tracer.updateSpan(span.id, {
      data: {
        closure: {
          assistantMessageId: 'msg_001',
        },
      },
    })

    expect(tracer.getSpan(span.id)?.data).toEqual({
      closure: {
        event: 'task_closure_decision',
        action: 'continue',
        assistantMessageId: 'msg_001',
      },
    })
  })

  test('clear removes all spans', () => {
    const tracer = new Tracer()
    tracer.startSpan('sess_001', 'to_clear')
    tracer.clear()
    expect(tracer.getSessionTraces('sess_001')).toHaveLength(0)
  })
})
