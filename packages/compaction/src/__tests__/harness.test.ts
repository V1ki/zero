import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCompactionHarness } from '../harness'
import { stableJson } from '../hash'
import type { CompactionSessionBinding } from '../types'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('independent compaction harness', () => {
  test('replays deterministically, retains every mutation, and never changes source trace', async () => {
    const fixture = createHarnessFixture()
    const sourceHashBefore = fileHash(fixture.tracePath)
    const first = await runCompactionHarness(request(fixture, 'run_1'))
    const second = await runCompactionHarness(request(fixture, 'run_2'))
    const sourceHashAfter = fileHash(fixture.tracePath)

    expect(first.validation?.status).toBe('passed')
    expect(second.validation?.status).toBe('passed')
    expect(first.phase).toBe('ready_to_commit')
    expect(first.publishStatus).toBe('not_requested')
    expect(first.candidate?.checkpointDigest).toBe(second.candidate?.checkpointDigest)
    expect(first.candidate?.candidateKind).toBe('trace_diagnostic_checkpoint')
    expect(first.candidate?.semanticReplacementEvaluated).toBe(false)
    expect(first.source?.sourceDigest).toBe(second.source?.sourceDigest)
    expect(sourceHashAfter).toBe(sourceHashBefore)
    expect(first.candidate?.coverage.sideEffectObservations).toBe(11)
    expect(first.candidate?.coverage.retainedSideEffects).toBe(11)
    expect(first.candidate?.incidents[0]?.errorClass).toBe('empty_response')
    expect(first.validation?.candidateBytes).toBe(
      Buffer.byteLength(stableJson(first.candidate), 'utf8'),
    )
    expect(first.validation?.ledgerBytes).toBe(Buffer.byteLength(stableJson(first.ledger), 'utf8'))
    expect(first.validation?.publishedPayloadBytes).toBe(
      (first.validation?.candidateBytes ?? 0) + (first.validation?.ledgerBytes ?? 0),
    )
    expect(JSON.stringify(first)).not.toContain(fixture.sentinel)
  })

  test('does not publish when the immutable ledger exceeds its hard budget', async () => {
    const fixture = createHarnessFixture()
    let publishCalls = 0
    const result = await runCompactionHarness(
      {
        ...request(fixture, 'run_budget'),
        mode: 'publish',
        limits: { maxLedgerChars: 1 },
      },
      {
        publisher: {
          publish: async () => {
            publishCalls++
            return 'published'
          },
        },
      },
    )

    expect(result.phase).toBe('failed')
    expect(result.validation?.errors).toContain('ledger_exceeds_char_budget')
    expect(result.validation?.ledgerChars).toBeGreaterThan(1)
    expect(result.validation?.maxLedgerChars).toBe(1)
    expect(publishCalls).toBe(0)
  })

  test('does not publish when ledger bytes or combined payload bytes exceed hard budgets', async () => {
    const fixture = createHarnessFixture()
    let publishCalls = 0
    const publisher = {
      publish: async () => {
        publishCalls++
        return 'published' as const
      },
    }
    const ledgerBytes = await runCompactionHarness(
      {
        ...request(fixture, 'run_ledger_bytes'),
        mode: 'publish',
        limits: { maxLedgerBytes: 1 },
      },
      { publisher },
    )
    const publishedBytes = await runCompactionHarness(
      {
        ...request(fixture, 'run_published_bytes'),
        mode: 'publish',
        limits: { maxPublishedPayloadBytes: 1 },
      },
      { publisher },
    )

    expect(ledgerBytes.validation?.errors).toContain('ledger_exceeds_byte_budget')
    expect(publishedBytes.validation?.errors).toContain('published_payload_exceeds_byte_budget')
    expect(publishCalls).toBe(0)
  })

  test('surfaces stale CAS result without treating candidate as committed', async () => {
    const fixture = createHarnessFixture()
    const result = await runCompactionHarness(
      { ...request(fixture, 'run_stale'), mode: 'publish' },
      { publisher: { publish: async () => 'stale' } },
    )

    expect(result.validation?.errors).toEqual([])
    expect(result.validation?.status).toBe('passed')
    expect(result.phase).toBe('stale')
    expect(result.publishStatus).toBe('stale')
  })

  test('requires a canonical session binding before publish', async () => {
    const fixture = createHarnessFixture()
    const { sessionBinding: _sessionBinding, ...withoutBinding } = request(
      fixture,
      'run_missing_binding',
    )
    let publishCalls = 0
    const result = await runCompactionHarness(
      { ...withoutBinding, mode: 'publish' },
      {
        publisher: {
          publish: async () => {
            publishCalls++
            return 'published'
          },
        },
      },
    )

    expect(result.phase).toBe('failed')
    expect(result.error).toBe('session_binding_required_for_publish')
    expect(publishCalls).toBe(0)
  })

  test('validates canonical session binding structure at runtime before publish', async () => {
    const fixture = createHarnessFixture()
    let publishCalls = 0
    const result = await runCompactionHarness(
      {
        ...request(fixture, 'run_invalid_binding'),
        mode: 'publish',
        sessionBinding: {
          ...sessionBinding(),
          rollbackGeneration: -1,
          coveredMessageRange: { messageCount: 2 },
        },
      },
      {
        publisher: {
          publish: async () => {
            publishCalls++
            return 'published'
          },
        },
      },
    )

    expect(result.validation?.errors).toContain('invalid_rollback_generation')
    expect(result.validation?.errors).toContain('incomplete_covered_message_range')
    expect(publishCalls).toBe(0)
  })

  test('binds publisher CAS and checkpoint digest to canonical session state', async () => {
    const fixture = createHarnessFixture()
    const expected = sessionBinding()
    let publishedBinding: CompactionSessionBinding | undefined
    const published = await runCompactionHarness(
      { ...request(fixture, 'run_publish'), mode: 'publish', sessionBinding: expected },
      {
        publisher: {
          publish: async (input) => {
            publishedBinding = input.expectedSessionBinding
            return 'published'
          },
        },
      },
    )
    const changed = await runCompactionHarness({
      ...request(fixture, 'run_changed'),
      sessionBinding: {
        ...expected,
        messagesDigest: 'changed_messages_digest',
        coveredMessageDigest: 'changed_covered_digest',
      },
    })

    expect(published.phase).toBe('committed')
    expect(publishedBinding).toEqual(expected)
    expect(changed.candidate?.checkpointDigest).not.toBe(published.candidate?.checkpointDigest)
  })

  test('produces the same checkpoint across different leaf and fan-in partitions', async () => {
    const fixture = createHarnessFixture()
    const narrow = await runCompactionHarness({
      ...request(fixture, 'run_partition_narrow'),
      limits: { maxLeafObservations: 10, maxMergeFanIn: 2 },
    })
    const wide = await runCompactionHarness({
      ...request(fixture, 'run_partition_wide'),
      limits: { maxLeafObservations: 40, maxMergeFanIn: 4 },
    })

    expect(narrow.validation?.status).toBe('passed')
    expect(wide.validation?.status).toBe('passed')
    expect(narrow.candidate?.checkpointDigest).toBe(wide.candidate?.checkpointDigest)
    expect(narrow.ledger?.digest).toBe(wide.ledger?.digest)
  })

  test('selects latest potential side effects per entity before filling recent items', async () => {
    const fixture = createEntityMutationFixture()
    const result = await runCompactionHarness({
      ...request(fixture, 'run_entity_mutations'),
      limits: { maxSideEffects: 2, maxLatestStates: 2 },
    })

    expect(result.validation?.status).toBe('passed')
    expect(result.ledger?.sideEffects).toHaveLength(4)
    expect(result.candidate?.sideEffects).toHaveLength(2)
    expect(new Set(result.candidate?.sideEffects.map((item) => item.subjectDigest)).size).toBe(2)
    expect(result.candidate?.latestState).toHaveLength(2)
    expect(result.candidate?.latestState.every((item) => item.status === 'error')).toBe(true)
  })
})

function createHarnessFixture(): {
  root: string
  tracePath: string
  sessionId: string
  sentinel: string
} {
  const root = mkdtempSync(join(tmpdir(), 'zero-compaction-harness-'))
  tempDirs.push(root)
  const sessionId = 'sess_harness'
  const tracePath = join(root, sessionId, 'trace.jsonl')
  const sentinel = 'SECRET_FIXTURE_PAYLOAD'
  mkdirSync(join(root, sessionId), { recursive: true })
  const entries: unknown[] = []
  let sequence = 0

  for (let index = 0; index < 97; index++) {
    entries.push(toolEntry(sessionId, sequence++, 'schedule', { action: 'list' }, true, sentinel))
  }
  for (let index = 0; index < 6; index++) {
    entries.push(
      toolEntry(
        sessionId,
        sequence++,
        'schedule',
        { action: 'create', name: `watch_${index}` },
        true,
        sentinel,
      ),
    )
  }
  for (let index = 0; index < 5; index++) {
    entries.push(
      toolEntry(
        sessionId,
        sequence++,
        'schedule',
        { action: 'cancel', name: `watch_${index}` },
        true,
        sentinel,
      ),
    )
  }
  entries.push(turnEntry(sessionId, sequence++, 'success'))
  entries.push(turnEntry(sessionId, sequence++, 'error', 'LLM returned empty response'))
  entries.push(turnEntry(sessionId, sequence++, 'error', 'LLM returned empty response'))
  entries.push(turnEntry(sessionId, sequence++, 'success'))
  writeFileSync(tracePath, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8')
  return { root, tracePath, sessionId, sentinel }
}

function request(fixture: ReturnType<typeof createHarnessFixture>, runId: string) {
  return {
    runId,
    sourceSessionId: fixture.sessionId,
    tracePath: fixture.tracePath,
    allowedTraceRoot: fixture.root,
    mode: 'dry_run' as const,
    strategyVersion: 'test_strategy_v1',
    schemaVersion: 'test_schema_v1',
    sessionBinding: sessionBinding(),
  }
}

function createEntityMutationFixture(): ReturnType<typeof createHarnessFixture> {
  const root = mkdtempSync(join(tmpdir(), 'zero-compaction-entities-'))
  tempDirs.push(root)
  const sessionId = 'sess_entity_mutations'
  const tracePath = join(root, sessionId, 'trace.jsonl')
  const sentinel = 'P'.repeat(2_000)
  mkdirSync(join(root, sessionId), { recursive: true })
  const entries = Array.from({ length: 100 }, (_, index) =>
    toolEntry(
      sessionId,
      index,
      'fetch',
      { method: 'GET', url: `https://example.invalid/read/${index}` },
      true,
      sentinel,
    ),
  )
  entries.push(
    toolEntry(
      sessionId,
      100,
      'fetch',
      { method: 'DELETE', url: 'https://example.invalid/entity-a' },
      false,
      sentinel,
    ),
    toolEntry(
      sessionId,
      101,
      'fetch',
      { method: 'DELETE', url: 'https://example.invalid/entity-b' },
      false,
      sentinel,
    ),
    toolEntry(
      sessionId,
      102,
      'fetch',
      { method: 'DELETE', url: 'https://example.invalid/entity-c' },
      false,
      sentinel,
    ),
    toolEntry(
      sessionId,
      103,
      'fetch',
      { method: 'DELETE', url: 'https://example.invalid/entity-b' },
      false,
      sentinel,
    ),
  )
  writeFileSync(tracePath, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8')
  return { root, tracePath, sessionId, sentinel }
}

function sessionBinding(): CompactionSessionBinding {
  return {
    messagesRevision: 'messages:revision:1',
    messagesDigest: 'messages_digest_1',
    compactionBlocksRevision: 'blocks:revision:1',
    compactionBlocksDigest: 'blocks_digest_1',
    activeBlockHeadsDigest: 'active_heads_digest_1',
    previousCheckpointHead: 'checkpoint_1',
    rollbackGeneration: 1,
    coveredMessageDigest: 'covered_messages_digest_1',
    coveredMessageRange: {
      fromMessageId: 'message_1',
      toMessageId: 'message_2',
      messageCount: 2,
    },
  }
}

function toolEntry(
  sessionId: string,
  index: number,
  tool: string,
  input: Record<string, unknown>,
  success: boolean,
  sentinel: string,
) {
  const at = new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
  return {
    spanId: `span_tool_${index}`,
    sessionId,
    kind: 'tool_call',
    name: `tool:${tool}`,
    startTime: at,
    endTime: at,
    status: success ? 'success' : 'error',
    data: {
      input: { ...input, privatePayload: sentinel },
      outputSummary: sentinel,
      toolResult: { success, outputSummary: sentinel },
    },
  }
}

function turnEntry(sessionId: string, index: number, status: 'success' | 'error', error?: string) {
  const at = new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
  return {
    spanId: `span_turn_${index}`,
    sessionId,
    kind: 'turn',
    name: 'turn:test',
    startTime: at,
    endTime: at,
    status,
    data: { turnIndex: index },
    metadata: error ? { error } : {},
  }
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
