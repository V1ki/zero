import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionLogRelativeDir } from '@zero-os/shared'
import { ObservabilityStore } from '../observability-store'
import type { TraceEntry } from '../trace'

const testDir = join(import.meta.dir, '__fixtures__/logs')

describe('ObservabilityStore', () => {
  afterEach(() => {
    rmSync(join(import.meta.dir, '__fixtures__'), { recursive: true, force: true })
  })

  test('log writes to events.jsonl', () => {
    const store = new ObservabilityStore(testDir)
    store.log('info', 'test_event', { key: 'value' })

    const entries = store.readEntries<Record<string, unknown>>('events.jsonl')
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe('test_event')
    expect(entries[0].level).toBe('info')
    expect(entries[0].key).toBe('value')
    expect(entries[0].ts).toBeDefined()
  })

  test('logEvent writes structured event entry', () => {
    const store = new ObservabilityStore(testDir)
    store.logEvent({
      level: 'info',
      sessionId: 'sess_20260316_0900_web_a1b2',
      event: 'tool_call',
      tool: 'bash',
      input: 'ls -la',
      outputSummary: 'listed 12 files',
      durationMs: 45,
    })

    const entries = store.readEntries<Record<string, unknown>>('events.jsonl')
    expect(entries).toHaveLength(1)
    expect(entries[0].tool).toBe('bash')
    expect(entries[0].durationMs).toBe(45)
  })

  test('readSessionRequests returns trace-projected requests', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0100_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_req_001',
        sessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T01:00:00.000Z',
        endTime: '2026-03-16T01:00:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_trace_001',
            turnIndex: 2,
            sessionId,
            agentName: 'trace-agent',
            model: 'trace-model',
            provider: 'trace-provider',
            userPrompt: 'trace prompt',
            response: 'trace response',
            stopReason: 'end_turn',
            toolUseCount: 1,
            toolCalls: [{ id: 'call_1', name: 'read', input: { path: '/tmp/demo.txt' } }],
            toolResults: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                content: 'demo file contents',
                outputSummary: 'demo file contents',
              },
            ],
            queuedInjection: {
              count: 1,
              formattedText: '<queued_message>queued follow-up</queued_message>',
              messages: [
                {
                  timestamp: '2026-03-16T01:00:00.500Z',
                  content: 'queued follow-up',
                  imageCount: 1,
                  mediaTypes: ['image/png'],
                },
              ],
            },
            memoryInjections: [
              {
                layer: 'layer1',
                source: 'retrieved_memories',
                formattedText:
                  '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
              },
            ],
            tokens: { input: 3, output: 4, reasoning: 1 },
            cost: 0.02,
            durationMs: 1000,
          },
        },
      },
    ])

    const entries = store.readSessionRequests(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('req_trace_001')
    expect(entries[0].agentName).toBe('trace-agent')
    expect(entries[0].toolCalls).toEqual([
      { id: 'call_1', name: 'read', input: { path: '/tmp/demo.txt' } },
    ])
    expect(entries[0].toolResults).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'call_1',
        content: 'demo file contents',
        outputSummary: 'demo file contents',
      },
    ])
    expect(entries[0].queuedInjection).toEqual({
      count: 1,
      formattedText: '<queued_message>queued follow-up</queued_message>',
      messages: [
        {
          timestamp: '2026-03-16T01:00:00.500Z',
          content: 'queued follow-up',
          imageCount: 1,
          mediaTypes: ['image/png'],
        },
      ],
    })
    expect(entries[0].memoryInjections).toEqual([
      {
        layer: 'layer1',
        source: 'retrieved_memories',
        formattedText:
          '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
      },
    ])
    expect(entries[0].tokens.reasoning).toBe(1)
  })

  test('readSessionRequests ignores malformed queuedInjection and memoryInjections payloads', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0105_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_req_queued_invalid',
        sessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T01:05:00.000Z',
        endTime: '2026-03-16T01:05:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_trace_invalid_queue',
            turnIndex: 1,
            sessionId,
            model: 'trace-model',
            provider: 'trace-provider',
            userPrompt: 'trace prompt',
            response: 'trace response',
            stopReason: 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults: [],
            queuedInjection: {
              count: 'bad',
              formattedText: 123,
              messages: {},
            },
            memoryInjections: [
              {
                layer: 'layer3',
                source: 'oops',
                formattedText: 123,
              },
            ],
            tokens: { input: 3, output: 4 },
            cost: 0.02,
          },
        },
      },
    ])

    const entries = store.readSessionRequests(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].queuedInjection).toBeUndefined()
    expect(entries[0].memoryInjections).toBeUndefined()
  })

  test('readSessionRequests ignores non-projectable trace entries', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0110_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_req_incomplete',
        sessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T01:10:00.000Z',
        endTime: '2026-03-16T01:10:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          requestId: 'incomplete-shape',
        },
      },
    ])

    expect(store.readSessionRequests(sessionId)).toEqual([])
  })

  test('readAllRequests includes trace-only session requests', () => {
    const store = new ObservabilityStore(testDir)
    const firstSessionId = 'sess_20260316_0140_web_abcd'
    const secondSessionId = 'sess_20260316_0141_fei_ef12'

    writeSessionTraceEntries(testDir, firstSessionId, [
      {
        spanId: 'span_req_all_001',
        sessionId: firstSessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T01:40:00.000Z',
        endTime: '2026-03-16T01:40:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_trace_all_001',
            turnIndex: 1,
            sessionId: firstSessionId,
            model: 'trace-model',
            provider: 'trace-provider',
            userPrompt: 'trace only prompt',
            response: 'trace only response',
            stopReason: 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults: [],
            tokens: { input: 2, output: 3 },
            cost: 0.03,
          },
        },
      },
    ])
    writeSessionTraceEntries(testDir, secondSessionId, [
      {
        spanId: 'span_req_all_002',
        sessionId: secondSessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T01:41:00.000Z',
        endTime: '2026-03-16T01:41:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_trace_all_002',
            turnIndex: 1,
            sessionId: secondSessionId,
            model: 'trace-model-2',
            provider: 'trace-provider',
            userPrompt: 'trace only prompt 2',
            response: 'trace only response 2',
            stopReason: 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults: [],
            tokens: { input: 4, output: 5 },
            cost: 0.04,
          },
        },
      },
    ])

    const ids = new Set(store.readAllRequests().map((entry) => entry.id))
    expect(ids).toEqual(new Set(['req_trace_all_001', 'req_trace_all_002']))
  })

  test('syncSessionActiveState maintains _active symlinks for active sessions only', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260312_2130_fei_a1b2'

    store.syncSessionActiveState(sessionId, 'active')
    const linkPath = join(testDir, 'sessions', '_active', sessionId)

    expect(existsSync(linkPath)).toBe(true)
    expect(readlinkSync(linkPath)).toBe('../2026-03-12/sess_20260312_2130_fei_a1b2')

    store.syncSessionActiveState(sessionId, 'completed')
    expect(existsSync(linkPath)).toBe(false)
  })

  test('readSessionClosures returns trace-projected closure events', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0120_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_closure_001',
        sessionId,
        kind: 'closure_decision',
        name: 'task_closure_decision',
        startTime: '2026-03-16T01:20:00.000Z',
        endTime: '2026-03-16T01:20:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          closure: {
            event: 'task_closure_decision',
            action: 'finish',
            reason: 'trace_complete',
            classifierRequest: {
              system: 'trace system',
              prompt: 'trace prompt',
              maxTokens: 200,
            },
            assistantMessageId: 'msg_trace_001',
          },
        },
      },
    ])

    const entries = store.readSessionClosures(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe('task_closure_decision')
    expect(entries[0].assistantMessageId).toBe('msg_trace_001')
  })

  test('readSessionSnapshots returns trace-projected snapshots', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0130_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_snapshot_001',
        sessionId,
        kind: 'snapshot',
        name: 'snapshot:context_updated',
        startTime: '2026-03-16T01:30:00.000Z',
        endTime: '2026-03-16T01:30:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          snapshot: {
            id: 'snap_trace_001',
            trigger: 'context_updated',
            model: 'trace-model',
            systemPrompt: 'trace system prompt',
            tools: ['read', 'bash'],
          },
        },
      },
    ])

    const entries = store.readSessionSnapshots(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('snap_trace_001')
    expect(entries[0].systemPrompt).toBe('trace system prompt')
  })

  test('readAllSnapshots includes trace-only session snapshots', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0150_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_snapshot_all_001',
        sessionId,
        kind: 'snapshot',
        name: 'snapshot:session_start',
        startTime: '2026-03-16T01:50:00.000Z',
        endTime: '2026-03-16T01:50:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          snapshot: {
            id: 'snap_trace_all_001',
            trigger: 'session_start',
            model: 'trace-model',
            systemPrompt: 'trace snapshot prompt',
          },
        },
      },
    ])

    const ids = new Set(store.readAllSnapshots().map((entry) => entry.id))
    expect(ids).toEqual(new Set(['snap_trace_all_001']))
  })

  test('readAllTraceEntries scans every persisted session trace file', () => {
    const store = new ObservabilityStore(testDir)
    const firstSessionId = 'sess_20260316_0200_web_trace'
    const secondSessionId = 'sess_20260316_0201_fei_trace'

    writeSessionTraceEntries(testDir, firstSessionId, [
      {
        spanId: 'span_trace_all_001',
        sessionId: firstSessionId,
        kind: 'turn',
        name: 'turn:web',
        startTime: '2026-03-16T02:00:00.000Z',
        endTime: '2026-03-16T02:00:01.000Z',
        durationMs: 1000,
        status: 'success',
      },
    ])
    writeSessionTraceEntries(testDir, secondSessionId, [
      {
        spanId: 'span_trace_all_002',
        parentSpanId: 'span_trace_all_001',
        sessionId: secondSessionId,
        kind: 'tool_call',
        name: 'tool:bash',
        startTime: '2026-03-16T02:01:00.000Z',
        endTime: '2026-03-16T02:01:01.000Z',
        durationMs: 1000,
        status: 'success',
      },
    ])

    expect(store.readAllTraceEntries().map((entry) => entry.spanId)).toEqual([
      'span_trace_all_001',
      'span_trace_all_002',
    ])
  })

  test('readSessionTraceEntries keeps the latest lifecycle snapshot for each span', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0210_web_trace'

    writeSessionTraceEntries(testDir, sessionId, [
      {
        spanId: 'span_trace_lifecycle_001',
        sessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T02:10:00.000Z',
        status: 'running',
        data: {
          request: {
            id: 'req_trace_lifecycle_001',
            turnIndex: 1,
            sessionId,
            model: 'trace-model',
            provider: 'trace-provider',
            userPrompt: 'started',
            response: 'partial',
            stopReason: 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults: [],
            tokens: { input: 1, output: 1 },
            cost: 0.01,
          },
        },
      },
      {
        spanId: 'span_trace_lifecycle_001',
        sessionId,
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-03-16T02:10:00.000Z',
        endTime: '2026-03-16T02:10:02.000Z',
        durationMs: 2000,
        status: 'success',
        data: {
          request: {
            id: 'req_trace_lifecycle_001',
            turnIndex: 1,
            sessionId,
            model: 'trace-model',
            provider: 'trace-provider',
            userPrompt: 'finished',
            response: 'done',
            stopReason: 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults: [],
            tokens: { input: 2, output: 3 },
            cost: 0.02,
          },
        },
      },
    ])

    const entries = store.readSessionTraceEntries(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('success')
    expect(entries[0].durationMs).toBe(2000)
    expect(store.readSessionRequests(sessionId)[0].response).toBe('done')
  })

  test('appendSessionJudge writes history into the session log directory', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'sess_20260316_0220_web_judge'
    const entry = {
      version: 1,
      savedAt: '2026-03-16T02:20:05.000Z',
      sessionId,
      run: {
        sessionId,
        model: 'openai/gpt-test',
        generatedAt: '2026-03-16T02:20:05.000Z',
        result: {
          overallScore: 88,
          verdict: 'strong',
          confidence: 'high',
          summary: 'good run',
          dimensions: [],
          findings: [],
          signals: {
            totalCost: 0.1,
            requestCount: 1,
            toolCallCount: 0,
            duplicateToolCallCount: 0,
            memorySearchCount: 0,
            memoryGetCount: 0,
            memoryWriteCount: 0,
            closureCount: 1,
          },
        },
      },
      artifacts: {
        primary: {
          request: {
            systemPrompt: 'judge-system',
            userPrompt: 'judge-user',
            model: 'gpt-test',
            maxTokens: 1600,
            stream: false,
          },
          response: {
            completion: {
              id: 'judge_resp_1',
              content: [{ type: 'text', text: '{"overallScore":88}' }],
              stopReason: 'end_turn',
              usage: { input: 10, output: 20 },
              model: 'gpt-test',
            },
            rawText: '{"overallScore":88}',
          },
        },
        repair: {
          request: {
            systemPrompt: 'repair-system',
            userPrompt: 'repair-user',
            model: 'gpt-test',
            maxTokens: 1800,
            stream: false,
          },
          response: {
            completion: {
              id: 'judge_resp_2',
              content: [{ type: 'text', text: '{"overallScore":88}' }],
              stopReason: 'end_turn',
              usage: { input: 5, output: 8 },
              model: 'gpt-test',
            },
            rawText: '{"overallScore":88}',
          },
        },
      },
    }

    store.appendSessionJudge(sessionId, entry)

    const filePath = join(testDir, getSessionLogRelativeDir(sessionId), 'llm-judge.jsonl')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toContain('judge-system')

    const history = store.readSessionJudges<typeof entry>(sessionId)
    expect(history).toHaveLength(1)
    expect(history[0].artifacts.primary.request.userPrompt).toBe('judge-user')
    expect(history[0].artifacts.repair?.response.rawText).toBe('{"overallScore":88}')
  })

  test('readSessionJudges skips malformed lines and returns latest first', () => {
    const store = new ObservabilityStore(testDir)
    const sessionId = 'oc_session_judge_history'
    const sessionDir = join(testDir, getSessionLogRelativeDir(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    appendFileSync(
      join(sessionDir, 'llm-judge.jsonl'),
      [
        JSON.stringify({ savedAt: '2026-03-16T02:00:00.000Z', run: { result: { overallScore: 60 } } }),
        '{not-json',
        JSON.stringify({ savedAt: '2026-03-16T03:00:00.000Z', run: { result: { overallScore: 90 } } }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const history = store.readSessionJudges<{ savedAt: string; run: { result: { overallScore: number } } }>(sessionId)
    expect(history).toHaveLength(2)
    expect(history[0].savedAt).toBe('2026-03-16T03:00:00.000Z')
    expect(history[0].run.result.overallScore).toBe(90)
    expect(history[1].savedAt).toBe('2026-03-16T02:00:00.000Z')
  })

  test('readEntries returns empty array for missing file', () => {
    const store = new ObservabilityStore(testDir)
    expect(store.readEntries('nonexistent.jsonl')).toEqual([])
  })
})

function writeSessionTraceEntries(baseDir: string, sessionId: string, entries: TraceEntry[]): void {
  const sessionDir = join(baseDir, getSessionLogRelativeDir(sessionId))
  mkdirSync(sessionDir, { recursive: true })
  appendFileSync(
    join(sessionDir, 'trace.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}
