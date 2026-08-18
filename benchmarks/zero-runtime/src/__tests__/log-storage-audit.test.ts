import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LOG_STORAGE_AUDIT_OPTIONS,
  type LogStorageAuditOptions,
  type RunLogStorageReport,
  type StorageBucketRow,
  type TraceLogStorageReport,
  analyzeLogStorage,
  nearestRankPercentileThreshold,
} from '../log-storage-audit'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createLogsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-log-storage-audit-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'sessions'), { recursive: true })
  return root
}

function createSession(logsRoot: string, session: string): string {
  const path = join(logsRoot, 'sessions', '2026-07-25', session)
  mkdirSync(path, { recursive: true })
  return path
}

function auditOptions(
  logsDir: string,
  overrides: Partial<LogStorageAuditOptions> = {},
): LogStorageAuditOptions {
  return {
    ...DEFAULT_LOG_STORAGE_AUDIT_OPTIONS,
    logsDir,
    ...overrides,
  }
}

function row(rows: StorageBucketRow[], key: string): StorageBucketRow {
  const found = rows.find((candidate) => candidate.key === key)
  expect(found, `missing bucket ${key}`).toBeDefined()
  return found as StorageBucketRow
}

function sumBytes(rows: StorageBucketRow[]): number {
  return rows.reduce((sum, bucket) => sum + bucket.bytes, 0)
}

function expectRunAccounting(report: RunLogStorageReport): void {
  expect(report.scannedBytes).toBe(report.snapshotBytes)
  expect(sumBytes(report.byCategory)).toBe(report.scannedBytes)
  expect(sumBytes(report.byEvent)).toBe(report.scannedBytes)
}

function expectTraceAccounting(report: TraceLogStorageReport): void {
  expect(report.scannedBytes).toBe(report.snapshotBytes)
  expect(sumBytes(report.byKind)).toBe(report.scannedBytes)
  expect(sumBytes(report.byKindStatus)).toBe(report.scannedBytes)
}

function jsonLine(value: Record<string, unknown>, ending: '\n' | '\r\n' | '' = '\n'): string {
  return `${JSON.stringify(value)}${ending}`
}

function paddedJsonLine(value: Record<string, unknown>, bytes: number): string {
  const json = JSON.stringify(value)
  const padding = bytes - Buffer.byteLength(json) - 1
  if (padding < 0) throw new Error(`Fixture does not fit in ${bytes} bytes`)
  return `${json}${' '.repeat(padding)}\n`
}

describe('log storage audit', () => {
  test('counts UTF-8 and LF, CRLF, and partial-tail bytes across all five run categories', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_run_categories')
    const lines = [
      jsonLine({
        ts: '2026-07-25T00:00:00.000Z',
        event: 'llm_request.raw_request',
        data: { prompt: '你好，世界' },
      }),
      jsonLine(
        {
          event: 'trace.context_compaction.success',
          data: { note: '镜像' },
        },
        '\r\n',
      ),
      jsonLine({
        data: { result: '工具结果' },
        event: 'tool_call.raw_result',
      }),
      jsonLine({
        event: 'context_compaction.history_snapshot',
        data: { reason: '诊断' },
      }),
      jsonLine({ event: 'runtime.notice', data: { text: '无尾换行' } }, ''),
    ]
    writeFileSync(join(session, 'run.log'), lines.join(''))

    const report = await analyzeLogStorage(
      auditOptions(logsRoot, { source: 'run', session: 'sess_run_categories' }),
    )
    const run = report.run
    expect(run).toBeDefined()
    if (!run) throw new Error('run report missing')

    expect(run.lines).toBe(5)
    expect(run.completeLines).toBe(4)
    expect(run.partialTailLines).toBe(1)
    expect(run.partialTailBytes).toBe(Buffer.byteLength(lines[4]))
    expect(run.snapshotBytes).toBe(Buffer.byteLength(lines.join('')))
    expect(run.byCategory.map((bucket) => bucket.key).sort()).toEqual([
      'compaction diagnostics',
      'llm_request.raw_request',
      'other',
      'tool_call.raw_result',
      'trace.* mirror',
    ])

    const expectedCategoryBytes = new Map([
      ['llm_request.raw_request', Buffer.byteLength(lines[0])],
      ['trace.* mirror', Buffer.byteLength(lines[1])],
      ['tool_call.raw_result', Buffer.byteLength(lines[2])],
      ['compaction diagnostics', Buffer.byteLength(lines[3])],
      ['other', Buffer.byteLength(lines[4])],
    ])
    for (const [key, bytes] of expectedCategoryBytes) {
      expect(row(run.byCategory, key).bytes).toBe(bytes)
      expect(row(run.byCategory, key).lines).toBe(1)
    }
    expect(row(run.byEvent, 'llm_request.raw_request').bytes).toBe(Buffer.byteLength(lines[0]))
    expect(row(run.traceMirrorByKind, 'context_compaction').bytes).toBe(Buffer.byteLength(lines[1]))
    expectRunAccounting(run)
  })

  test('counts every trace lifecycle record by kind and kind/status without collapsing spans', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_trace_lifecycle')
    const lines = [
      jsonLine({
        spanId: 'span_same',
        kind: 'llm_call',
        status: 'running',
        data: { phase: 'start', text: '开始' },
      }),
      jsonLine(
        {
          spanId: 'span_same',
          kind: 'llm_call',
          status: 'running',
          data: { phase: 'update', text: '中间快照' },
        },
        '\r\n',
      ),
      jsonLine(
        {
          spanId: 'span_same',
          kind: 'llm_call',
          status: 'success',
          data: { phase: 'end', text: '完成' },
        },
        '',
      ),
    ]
    writeFileSync(join(session, 'trace.jsonl'), lines.join(''))

    const report = await analyzeLogStorage(
      auditOptions(logsRoot, { source: 'trace', session: 'sess_trace_lifecycle' }),
    )
    const trace = report.trace
    expect(trace).toBeDefined()
    if (!trace) throw new Error('trace report missing')

    expect(trace.lines).toBe(3)
    expect(trace.completeLines).toBe(2)
    expect(trace.partialTailLines).toBe(1)
    expect(row(trace.byKind, 'llm_call')).toMatchObject({
      lines: 3,
      bytes: Buffer.byteLength(lines.join('')),
    })
    expect(row(trace.byKindStatus, 'llm_call/running')).toMatchObject({
      lines: 2,
      bytes: Buffer.byteLength(lines[0] + lines[1]),
    })
    expect(row(trace.byKindStatus, 'llm_call/success')).toMatchObject({
      lines: 1,
      bytes: Buffer.byteLength(lines[2]),
    })
    expectTraceAccounting(trace)
  })

  test('classifies a multi-chunk line with reordered fields and ignores nested pseudo-fields', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_large_line')
    const largePayload = 'x'.repeat(1024 * 1024)
    const runLine = jsonLine({
      data: {
        event: 'tool_call.raw_result',
        payload: largePayload,
      },
      level: 'debug',
      event: 'llm_request.raw_request',
    })
    const traceLine = jsonLine({
      data: {
        kind: 'tool_call',
        status: 'error',
        payload: largePayload,
      },
      status: 'success',
      spanId: 'span_reordered',
      kind: 'context_compaction',
    })
    writeFileSync(join(session, 'run.log'), runLine)
    writeFileSync(join(session, 'trace.jsonl'), traceLine)

    const report = await analyzeLogStorage(auditOptions(logsRoot, { session: 'sess_large_line' }))
    const run = report.run
    const trace = report.trace
    expect(run).toBeDefined()
    expect(trace).toBeDefined()
    if (!run || !trace) throw new Error('expected both source reports')

    expect(row(run.byEvent, 'llm_request.raw_request')).toMatchObject({
      lines: 1,
      bytes: Buffer.byteLength(runLine),
    })
    expect(run.byEvent.some((bucket) => bucket.key === 'tool_call.raw_result')).toBe(false)
    expect(run.maxClassifierBufferedBytes).toBeLessThanOrEqual(256)

    expect(row(trace.byKindStatus, 'context_compaction/success')).toMatchObject({
      lines: 1,
      bytes: Buffer.byteLength(traceLine),
    })
    expect(trace.byKind.some((bucket) => bucket.key === 'tool_call')).toBe(false)
    expect(trace.maxClassifierBufferedBytes).toBeLessThanOrEqual(256)
    expectRunAccounting(run)
    expectTraceAccounting(trace)
  })

  test('uses nearest-rank P90 thresholds independently per source and includes ties', async () => {
    const logsRoot = createLogsRoot()
    const runSizes = [100, 200, 500, 500]
    const traceSizes = [120, 220, 220]

    runSizes.forEach((bytes, index) => {
      const session = createSession(logsRoot, `sess_run_${index}`)
      writeFileSync(
        join(session, 'run.log'),
        paddedJsonLine({ event: `run.event.${index}` }, bytes),
      )
    })
    traceSizes.forEach((bytes, index) => {
      const session = createSession(logsRoot, `sess_trace_${index}`)
      writeFileSync(
        join(session, 'trace.jsonl'),
        paddedJsonLine({ kind: `kind_${index}`, status: 'success' }, bytes),
      )
    })

    expect(nearestRankPercentileThreshold([10, 20, 30, 40], 75)).toBe(30)
    expect(nearestRankPercentileThreshold(runSizes, 90)).toBe(500)
    expect(nearestRankPercentileThreshold(traceSizes, 90)).toBe(220)

    const report = await analyzeLogStorage(auditOptions(logsRoot, { percentile: 90 }))
    const run = report.run
    const trace = report.trace
    expect(run).toBeDefined()
    expect(trace).toBeDefined()
    if (!run || !trace) throw new Error('expected both source reports')

    expect(run.selection).toMatchObject({
      candidateFiles: 4,
      nonEmptyFiles: 4,
      cutoffBytes: 500,
      selectedFiles: 2,
      discoveredSelectedBytes: 1000,
    })
    expect(trace.selection).toMatchObject({
      candidateFiles: 3,
      nonEmptyFiles: 3,
      cutoffBytes: 220,
      selectedFiles: 2,
      discoveredSelectedBytes: 440,
    })
    expect(run.snapshotBytes).toBe(1000)
    expect(trace.snapshotBytes).toBe(440)
    expect(report.totalSnapshotBytes).toBe(1440)
    expectRunAccounting(run)
    expectTraceAccounting(trace)
  })

  test('does not scan a _current session symlink twice', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_canonical')
    const runLine = jsonLine({ event: 'runtime.ready' })
    const traceLine = jsonLine({ kind: 'agent_run', status: 'success' })
    writeFileSync(join(session, 'run.log'), runLine)
    writeFileSync(join(session, 'trace.jsonl'), traceLine)
    symlinkSync(session, join(logsRoot, 'sessions', '_current'), 'dir')

    const report = await analyzeLogStorage(auditOptions(logsRoot))
    const run = report.run
    const trace = report.trace
    expect(run).toBeDefined()
    expect(trace).toBeDefined()
    if (!run || !trace) throw new Error('expected both source reports')

    expect(run.selection.candidateFiles).toBe(1)
    expect(trace.selection.candidateFiles).toBe(1)
    expect(run.snapshotBytes).toBe(Buffer.byteLength(runLine))
    expect(trace.snapshotBytes).toBe(Buffer.byteLength(traceLine))
    expectRunAccounting(run)
    expectTraceAccounting(trace)
  })

  test('reports legacy trace-only sessions without requiring a paired run.log', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_trace_only')
    const traceLine = jsonLine({ kind: 'turn', status: 'success' })
    writeFileSync(join(session, 'trace.jsonl'), traceLine)

    const report = await analyzeLogStorage(auditOptions(logsRoot, { session: 'sess_trace_only' }))
    expect(report.run).toBeDefined()
    expect(report.trace).toBeDefined()
    expect(report.run?.selection.candidateFiles).toBe(0)
    expect(report.run?.snapshotBytes).toBe(0)
    expect(report.trace?.selection.candidateFiles).toBe(1)
    expect(report.trace?.snapshotBytes).toBe(Buffer.byteLength(traceLine))
    if (report.run) expectRunAccounting(report.run)
    if (report.trace) expectTraceAccounting(report.trace)
  })

  test('keeps blank and missing-field lines visible and preserves all physical bytes', async () => {
    const logsRoot = createLogsRoot()
    const session = createSession(logsRoot, 'sess_unclassified')
    const emptySession = createSession(logsRoot, 'sess_empty')
    const runLines = ['\n', jsonLine({ data: { event: 'nested-only' } }), '{malformed-json}\r\n']
    const traceLines = [
      '\r\n',
      jsonLine({ kind: 'llm_call' }),
      jsonLine({ status: 'success' }),
      jsonLine({ data: { kind: 'nested-kind', status: 'nested-status' } }, ''),
    ]
    writeFileSync(join(session, 'run.log'), runLines.join(''))
    writeFileSync(join(session, 'trace.jsonl'), traceLines.join(''))
    writeFileSync(join(emptySession, 'run.log'), '')
    writeFileSync(join(emptySession, 'trace.jsonl'), '')

    const report = await analyzeLogStorage(auditOptions(logsRoot))
    const run = report.run
    const trace = report.trace
    expect(run).toBeDefined()
    expect(trace).toBeDefined()
    if (!run || !trace) throw new Error('expected both source reports')

    expect(run.selection).toMatchObject({
      candidateFiles: 2,
      nonEmptyFiles: 1,
      emptyFiles: 1,
    })
    expect(run.blankLines).toBe(1)
    expect(run.blankBytes).toBe(Buffer.byteLength(runLines[0]))
    expect(run.unclassifiedLines).toBe(2)
    expect(run.unclassifiedBytes).toBe(Buffer.byteLength(runLines[1] + runLines[2]))
    expect(row(run.byEvent, '<blank>').bytes).toBe(Buffer.byteLength(runLines[0]))
    expect(row(run.byEvent, '<missing-event>')).toMatchObject({
      lines: 2,
      bytes: Buffer.byteLength(runLines[1] + runLines[2]),
    })

    expect(trace.selection).toMatchObject({
      candidateFiles: 2,
      nonEmptyFiles: 1,
      emptyFiles: 1,
    })
    expect(trace.blankLines).toBe(1)
    expect(trace.unclassifiedLines).toBe(3)
    expect(trace.unclassifiedBytes).toBe(
      Buffer.byteLength(traceLines[1] + traceLines[2] + traceLines[3]),
    )
    expect(row(trace.byKind, '<blank>').bytes).toBe(Buffer.byteLength(traceLines[0]))
    expect(row(trace.byKind, '<missing-kind>').lines).toBe(2)
    expect(row(trace.byKindStatus, 'llm_call/<missing-status>').lines).toBe(1)
    expect(row(trace.byKindStatus, '<missing-kind>/success').lines).toBe(1)
    expect(row(trace.byKindStatus, '<missing-kind>/<missing-status>').lines).toBe(1)

    expectRunAccounting(run)
    expectTraceAccounting(trace)
    expect(report.totalScannedBytes).toBe(
      Buffer.byteLength(runLines.join('') + traceLines.join('')),
    )
  })
})
