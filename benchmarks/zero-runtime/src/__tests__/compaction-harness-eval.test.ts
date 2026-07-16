import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderCompactionHarnessEvalMarkdown,
  runCompactionHarnessEval,
} from '../compaction-harness-eval'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('trace-sidecar compaction evaluator', () => {
  test('marks semantic replacement out of scope and removes absolute paths from artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zero-compaction-eval-'))
    tempDirs.push(root)
    const sessionId = 'sess_eval_path_privacy'
    const logsRoot = join(root, 'logs')
    const tracePath = join(logsRoot, 'sessions', '2026-07-10', sessionId, 'trace.jsonl')
    const dbPath = join(logsRoot, 'sessions.db')
    const outDir = join(root, 'output')
    mkdirSync(join(tracePath, '..'), { recursive: true })
    const payload = 'private-payload-that-must-not-be-projected'.repeat(100)
    const entries = Array.from({ length: 20 }, (_, index) => ({
      spanId: `span_${index}`,
      sessionId,
      kind: 'tool_call',
      name: 'tool:fetch',
      startTime: new Date(Date.UTC(2026, 6, 10, 0, index)).toISOString(),
      endTime: new Date(Date.UTC(2026, 6, 10, 0, index, 1)).toISOString(),
      status: 'success',
      data: {
        input: { method: 'GET', url: `https://example.invalid/${index}` },
        outputSummary: payload,
      },
    }))
    writeFileSync(tracePath, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`)
    const blocksJson = createSessionDb(dbPath, sessionId)

    const report = await runCompactionHarnessEval({
      sessionId,
      tracePath,
      logsRoot,
      dbPath,
      outDir,
      repeat: 1,
    })
    const markdown = renderCompactionHarnessEvalMarkdown(report)

    expect(report.semanticReplacementEvaluated).toBe(false)
    expect(report.sessionBindingPresent).toBe(true)
    expect(report.runs[0]?.candidate?.sessionBinding?.compactionBlocksDigest).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(Buffer.byteLength(blocksJson, 'utf8')).toBeGreaterThan(1024 * 1024)
    expect(report.runs[0]?.candidate?.sessionBinding?.compactionBlocksDigest).toBe(
      createHash('sha256').update(blocksJson).digest('hex'),
    )
    expect(report.deterministic).toBeNull()
    expect(report.sourceDigestStable).toBeNull()
    expect(report.tracePath).toBe(`sessions/2026-07-10/${sessionId}/trace.jsonl`)
    expect(report.runs[0]?.source?.sourcePath).toBe(report.tracePath)
    expect(JSON.stringify(report)).not.toContain(root)
    expect(markdown).toContain('does not evaluate replacement of canonical session history')
    expect(markdown).toContain('Deterministic checkpoint: **not_evaluated**')
    expect(markdown).toContain('Sidecar replay duration:')
  })

  test('redacts missing-trace filesystem paths from errors and event details', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zero-compaction-missing-trace-'))
    tempDirs.push(root)
    const logsRoot = join(root, 'logs')
    const tracePath = join(logsRoot, 'sessions', 'missing-trace.jsonl')
    mkdirSync(logsRoot, { recursive: true })

    const report = await runCompactionHarnessEval({
      sessionId: 'sess_missing_trace',
      tracePath,
      logsRoot,
      outDir: join(root, 'output'),
      repeat: 1,
    })

    expect(report.runs[0]?.error).toBe('trace_source_error:enoent')
    expect(JSON.stringify(report)).not.toContain(root)
    expect(report.deterministic).toBeNull()
    expect(report.sourceDigestStable).toBeNull()
  })
})

function createSessionDb(path: string, sessionId: string): string {
  const db = new Database(path, { create: true })
  try {
    db.exec(`
      create table session_messages (
        session_id text primary key,
        messages_json text not null,
        message_count integer not null,
        updated_at text not null
      );
      create table session_compaction_blocks (
        session_id text primary key,
        blocks_json text not null,
        block_count integer not null,
        updated_at text not null
      );
    `)
    const messages = JSON.stringify([
      { id: 'message_1', role: 'user', content: 'hello' },
      { id: 'message_2', role: 'assistant', content: 'world' },
    ])
    const blocksJson = JSON.stringify([
      {
        id: 'block_1',
        status: 'active',
        generation: 1,
        summary: '多字节'.repeat(150_000),
      },
    ])
    db.query(
      `insert into session_messages
       (session_id, messages_json, message_count, updated_at) values (?, ?, ?, ?)`,
    ).run(sessionId, messages, 2, '2026-07-10T00:00:00.000Z')
    db.query(
      `insert into session_compaction_blocks
       (session_id, blocks_json, block_count, updated_at) values (?, ?, ?, ?)`,
    ).run(sessionId, blocksJson, 1, '2026-07-10T00:00:00.000Z')
    return blocksJson
  } finally {
    db.close()
  }
}
