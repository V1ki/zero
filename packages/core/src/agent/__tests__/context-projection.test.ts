import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionEventStore } from '@zero-os/observe'
import type { ContentBlock, Message, TimelineCompactionBlock } from '@zero-os/shared'
import { prepareConversationHistory, prepareConversationHistoryWithCompaction } from '../context'

// Prompt preparation is a pure projection of canonical history: the session
// persists the same Message objects it passes in, so any in-place change leaks
// into evidence files and the session event log.

const sessionId = 'sess_projection_fixture'
const TURNS = 8

function rawOutput(turn: number): string {
  return `RAW-${turn}-${'x'.repeat(2000)}-END-${turn}`
}

function buildTurn(turn: number): Message[] {
  const createdAt = (offset: number) => new Date(1_700_000_000_000 + turn * 10_000 + offset * 1000)
  const message = (id: string, role: Message['role'], content: ContentBlock[], offset: number) => ({
    id: `m${turn}-${id}`,
    sessionId,
    role,
    messageType: 'message' as const,
    content,
    createdAt: createdAt(offset).toISOString(),
  })
  return [
    message('user', 'user', [{ type: 'text', text: `do step ${turn}` }], 0),
    message(
      'tool-use',
      'assistant',
      [{ type: 'tool_use', id: `tu${turn}`, name: 'bash', input: { command: `echo ${turn}` } }],
      1,
    ),
    message(
      'tool-result',
      'user',
      [{ type: 'tool_result', toolUseId: `tu${turn}`, content: rawOutput(turn) }],
      2,
    ),
    message('reply', 'assistant', [{ type: 'text', text: `done ${turn}` }], 3),
  ]
}

async function simulateTurns(
  workDir: string,
  afterTurn: (canonical: Message[], blocks: TimelineCompactionBlock[]) => void,
): Promise<{ canonical: Message[]; blocks: TimelineCompactionBlock[] }> {
  const canonical: Message[] = []
  let blocks: TimelineCompactionBlock[] = []
  for (let turn = 1; turn <= TURNS; turn++) {
    canonical.push(...buildTurn(turn))
    await prepareConversationHistoryWithCompaction([...canonical], {
      enableEpisodeCompaction: true,
      evidenceWorkDir: workDir,
      sessionId,
      timelineCompactionBlocks: blocks,
      onTimelineCompactionBlocksChanged: (next) => {
        blocks = next
      },
      contextCompactor: async () => undefined,
    })
    afterTurn(canonical, blocks)
  }
  return { canonical, blocks }
}

describe('prompt history preparation is a pure projection', () => {
  test('never mutates canonical messages across successive turns', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-projection-pure-'))
    try {
      const canonical: Message[] = []
      for (let turn = 1; turn <= 12; turn++) canonical.push(...buildTurn(turn))
      const snapshot = structuredClone(canonical)

      for (let length = 4; length <= canonical.length; length += 4) {
        const history = canonical.slice(0, length)
        const first = prepareConversationHistory(history)
        expect(prepareConversationHistory(history)).toEqual(first)
        await prepareConversationHistoryWithCompaction(history, {
          enableEpisodeCompaction: true,
          evidenceWorkDir: workDir,
          sessionId,
          contextCompactor: async () => undefined,
        })
      }

      expect(canonical).toEqual(snapshot)
      for (const block of canonical.flatMap((message) => message.content)) {
        expect('truncationLevel' in block).toBe(false)
      }
      // The oldest tool result is reduced in the projection only.
      const projected = prepareConversationHistory(canonical)
      const oldest = projected[2].content[0]
      expect(oldest.type === 'tool_result' && oldest.truncationLevel).toBe('status')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('timeline compaction evidence holds the raw tool output', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-projection-evidence-'))
    try {
      const { blocks } = await simulateTurns(workDir, () => {})

      const outputEvidence = blocks
        .flatMap((block) => block.evidence)
        .filter((evidence) => evidence.kind === 'tool_result_output')
      expect(outputEvidence.length).toBeGreaterThan(0)
      for (const evidence of outputEvidence) {
        const turn = Number(evidence.toolUseId.replace('tu', ''))
        const raw = rawOutput(turn)
        expect(evidence.chars).toBe(raw.length)
        expect(readFileSync(evidence.path, 'utf-8')).toBe(raw)
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('session event log stays append-only across normal turns', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-projection-eventlog-'))
    try {
      const store = new SessionEventStore({ basePath: workDir })
      store.ensureSession({ v: 1, sessionId, schemaVersion: 1, source: 'web' })

      const { canonical, blocks } = await simulateTurns(workDir, (messages, current) => {
        store.syncCanonical(sessionId, { messages, blocks: current })
      })
      expect(blocks.length).toBeGreaterThan(0)

      const events = readFileSync(join(workDir, 'sessions', sessionId, 'session.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; data: { message?: Message } })
      expect(events.filter((event) => event.type === 'messages/truncate')).toEqual([])
      const messageEventIds = events
        .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
        .map((event) => event.data.message?.id)
      expect(messageEventIds).toEqual(canonical.map((message) => message.id))
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
