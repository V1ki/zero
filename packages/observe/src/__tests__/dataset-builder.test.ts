import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { getSessionLogRelativeDir } from '@zero-os/shared'
import { DatasetBuilder, MetricsDB, ObservabilityStore, SessionDB, type TraceEntry } from '../index'

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess_default',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    source: 'web',
    status: 'completed',
    currentModel: 'gpt-5.3-codex-medium',
    modelHistory: [
      {
        model: 'gpt-5.3-codex-medium',
        from: '2026-04-01T00:00:00.000Z',
        to: null,
      },
    ],
    tags: [],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_default',
    sessionId: 'sess_default',
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: 'hello' }],
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  }
}

function writeSessionTraceEntries(baseDir: string, sessionId: string, entries: TraceEntry[]): void {
  const sessionDir = join(baseDir, getSessionLogRelativeDir(sessionId))
  mkdirSync(sessionDir, { recursive: true })
  appendFileSync(
    join(sessionDir, 'trace.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

function createFixture() {
  const logsDir = mkdtempSync(join(tmpdir(), 'observe-dataset-'))
  const sessionDB = SessionDB.createInMemory()
  const metricsDB = MetricsDB.createInMemory()
  const observability = new ObservabilityStore(logsDir)
  const builder = new DatasetBuilder(sessionDB, metricsDB, observability)

  return {
    logsDir,
    sessionDB,
    metricsDB,
    observability,
    builder,
  }
}

describe('DatasetBuilder', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('extractEpisode normalizes session facts, evaluation history, and recorded context', () => {
    const fixture = createFixture()
    cleanupDirs.push(fixture.logsDir)

    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_dataset_001',
        updatedAt: '2026-04-02T09:00:00.000Z',
        tags: ['ops', 'incident/demo'],
        summary: 'demo summary',
      }),
      '{"mode":"agent"}',
      'session prompt',
    )
    fixture.sessionDB.saveMessages('sess_dataset_001', [
      makeMessage({
        id: 'msg_real_user',
        sessionId: 'sess_dataset_001',
        content: [{ type: 'text', text: 'inspect the logs' }],
      }),
      makeMessage({
        id: 'msg_assistant',
        sessionId: 'sess_dataset_001',
        role: 'assistant',
        content: [{ type: 'text', text: 'working on it' }],
      }),
      makeMessage({
        id: 'msg_tool_result_carrier',
        sessionId: 'sess_dataset_001',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'tool output' }],
      }),
      makeMessage({
        id: 'msg_queued_wrapper',
        sessionId: 'sess_dataset_001',
        content: [{ type: 'text', text: '<queued_message>queued text</queued_message>' }],
      }),
    ])

    fixture.metricsDB.recordUsage({
      id: 'usage_1',
      sessionId: 'sess_dataset_001',
      category: 'completion',
      purpose: 'agent_loop',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 20,
      outputTokens: 10,
      cost: 0.02,
      durationMs: 120,
      createdAt: '2026-04-02T09:00:01.000Z',
    })
    fixture.metricsDB.recordUsage({
      id: 'usage_2',
      sessionId: null,
      parentSessionId: 'sess_dataset_001',
      category: 'completion',
      purpose: 'task_closure',
      model: 'gpt-5.3-codex-medium',
      provider: 'openai-codex',
      inputTokens: 5,
      outputTokens: 3,
      cost: 0.01,
      durationMs: 40,
      createdAt: '2026-04-02T09:00:02.000Z',
    })
    fixture.metricsDB.recordEvaluation({
      sessionId: 'sess_dataset_001',
      model: 'judge-model',
      overallScore: 70,
      verdict: 'mixed',
      confidence: 'medium',
      dimensions: [],
      findings: [],
      generatedAt: '2026-04-02T09:00:10.000Z',
      createdAt: '2026-04-02T09:00:10.000Z',
    })
    fixture.metricsDB.recordEvaluation({
      sessionId: 'sess_dataset_001',
      model: 'judge-model',
      overallScore: 88,
      verdict: 'strong',
      confidence: 'high',
      dimensions: [],
      findings: [],
      generatedAt: '2026-04-02T09:05:00.000Z',
      createdAt: '2026-04-02T09:05:00.000Z',
    })

    writeSessionTraceEntries(fixture.logsDir, 'sess_dataset_001', [
      {
        spanId: 'span_req_001',
        sessionId: 'sess_dataset_001',
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-04-02T09:00:00.000Z',
        endTime: '2026-04-02T09:00:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_001',
            turnIndex: 1,
            sessionId: 'sess_dataset_001',
            model: 'gpt-5.3-codex-medium',
            provider: 'openai-codex',
            userPrompt: 'inspect the logs',
            response: 'done',
            stopReason: 'end_turn',
            toolUseCount: 1,
            toolCalls: [{ id: 'call_1', name: 'read', input: { path: 'logs/app.log' } }],
            toolResults: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                content: 'ok',
              },
            ],
            queuedInjection: {
              count: 1,
              formattedText: '<queued_message>queued text</queued_message>',
              messages: [],
            },
            tokens: { input: 20, output: 10 },
            cost: 0.02,
            durationMs: 1000,
          },
        },
      },
      {
        spanId: 'span_snapshot_001',
        sessionId: 'sess_dataset_001',
        kind: 'snapshot',
        name: 'snapshot:context_updated',
        startTime: '2026-04-02T09:00:01.500Z',
        endTime: '2026-04-02T09:00:01.600Z',
        durationMs: 100,
        status: 'success',
        data: {
          snapshot: {
            id: 'snap_001',
            trigger: 'context_updated',
            tools: ['read', 'bash'],
            identityMemory: 'You are ZeRo',
            systemPrompt: 'snapshot system prompt',
          },
        },
      },
      {
        spanId: 'span_closure_001',
        sessionId: 'sess_dataset_001',
        kind: 'closure_decision',
        name: 'task_closure_decision',
        startTime: '2026-04-02T09:00:02.000Z',
        endTime: '2026-04-02T09:00:02.100Z',
        durationMs: 100,
        status: 'success',
        data: {
          closure: {
            sessionId: 'sess_dataset_001',
            event: 'task_closure_decision',
            action: 'finish',
            reason: 'done',
            classifierRequest: {
              system: 'system',
              prompt: 'prompt',
              maxTokens: 100,
            },
          },
        },
      },
    ])

    const episode = expectDefined(fixture.builder.extractEpisode('sess_dataset_001'))

    expect(episode.schemaVersion).toBe(1)
    expect(episode.conversation.messageCount).toBe(4)
    expect(episode.conversation.userTurnCount).toBe(1)
    expect(episode.conversation.assistantTurnCount).toBe(1)
    expect(episode.recordedContext).toEqual({
      systemPrompt: 'session prompt',
      agentConfigJson: '{"mode":"agent"}',
      tools: ['read', 'bash'],
      toolsSource: 'snapshot',
      identityMemory: 'You are ZeRo',
      snapshotId: 'snap_001',
    })
    expect(episode.trace.counts).toMatchObject({
      requestCount: 1,
      closureCount: 1,
      snapshotCount: 1,
      toolCallCount: 1,
      toolErrorCount: 0,
    })
    expect(episode.usage.totalCost).toBeCloseTo(0.03, 5)
    expect(episode.usage.requestCount).toBe(2)
    expect(episode.usage.byPurpose.map((row) => row.purpose)).toEqual([
      'agent_loop',
      'task_closure',
    ])
    expect(episode.evaluations).toHaveLength(2)
    expect(episode.evaluations[0].overallScore).toBe(88)
    expect(episode.evaluations[1].overallScore).toBe(70)
    expect(episode.traits).toEqual(['uses-tools', 'has-closure-finish', 'has-queued-injection'])

    fixture.sessionDB.close()
    fixture.metricsDB.close()
  })

  test('extractEpisode returns null for unknown session IDs', () => {
    const fixture = createFixture()
    cleanupDirs.push(fixture.logsDir)

    expect(fixture.builder.extractEpisode('sess_missing')).toBeNull()

    fixture.sessionDB.close()
    fixture.metricsDB.close()
  })

  test('extractEpisode marks missing snapshot context explicitly', () => {
    const fixture = createFixture()
    cleanupDirs.push(fixture.logsDir)

    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_dataset_no_snapshot',
        updatedAt: '2026-04-03T09:00:00.000Z',
      }),
      undefined,
      'session prompt only',
    )
    fixture.sessionDB.saveMessages('sess_dataset_no_snapshot', [
      makeMessage({
        id: 'msg_user',
        sessionId: 'sess_dataset_no_snapshot',
        content: [{ type: 'text', text: 'hello' }],
      }),
    ])

    const episode = expectDefined(fixture.builder.extractEpisode('sess_dataset_no_snapshot'))

    expect(episode.recordedContext).toEqual({
      systemPrompt: 'session prompt only',
      agentConfigJson: undefined,
      tools: [],
      toolsSource: 'none',
      identityMemory: undefined,
      snapshotId: undefined,
    })
    expect(episode.evaluations).toEqual([])

    fixture.sessionDB.close()
    fixture.metricsDB.close()
  })

  test('extractEpisodes applies source, tag, hasEvaluation false, trait, and pagination filters', () => {
    const fixture = createFixture()
    cleanupDirs.push(fixture.logsDir)

    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_batch_1',
        source: 'web',
        status: 'completed',
        tags: ['alpha'],
        updatedAt: '2026-04-06T12:00:00.000Z',
      }),
    )
    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_batch_2',
        source: 'web',
        status: 'completed',
        tags: ['alpha', 'beta'],
        updatedAt: '2026-04-05T12:00:00.000Z',
      }),
    )
    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_batch_3',
        source: 'feishu',
        status: 'completed',
        tags: ['alpha'],
        updatedAt: '2026-04-04T12:00:00.000Z',
      }),
    )

    fixture.sessionDB.saveMessages('sess_batch_1', [])
    fixture.sessionDB.saveMessages('sess_batch_2', [
      makeMessage({
        id: 'batch_2_user',
        sessionId: 'sess_batch_2',
        content: [{ type: 'text', text: 'inspect README' }],
      }),
    ])
    fixture.sessionDB.saveMessages('sess_batch_3', [
      makeMessage({
        id: 'batch_3_user',
        sessionId: 'sess_batch_3',
        content: [{ type: 'text', text: 'inspect logs' }],
      }),
    ])

    fixture.metricsDB.recordEvaluation({
      sessionId: 'sess_batch_2',
      model: 'judge-model',
      overallScore: 90,
      verdict: 'strong',
      confidence: 'high',
      dimensions: [],
      findings: [],
      generatedAt: '2026-04-05T12:00:10.000Z',
      createdAt: '2026-04-05T12:00:10.000Z',
    })

    writeSessionTraceEntries(fixture.logsDir, 'sess_batch_2', [
      {
        spanId: 'span_batch_2_request',
        sessionId: 'sess_batch_2',
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-04-05T12:00:00.000Z',
        endTime: '2026-04-05T12:00:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_batch_2',
            turnIndex: 1,
            sessionId: 'sess_batch_2',
            model: 'gpt-5.3-codex-medium',
            provider: 'openai-codex',
            userPrompt: 'inspect README',
            response: 'done',
            stopReason: 'end_turn',
            toolUseCount: 1,
            toolCalls: [{ id: 'call_batch_2', name: 'read', input: { path: 'README.md' } }],
            toolResults: [],
            tokens: { input: 1, output: 1 },
            cost: 0.01,
          },
        },
      },
    ])

    const noEvaluation = fixture.builder.extractEpisodes({
      sources: ['web'],
      tags: ['alpha'],
      hasEvaluation: false,
    })
    expect(noEvaluation.map((episode) => episode.sessionId)).toEqual(['sess_batch_1'])
    expect(noEvaluation[0]?.conversation.messageCount).toBe(0)
    expect(noEvaluation[0]?.conversation.userTurnCount).toBe(0)
    expect(noEvaluation[0]?.traits).toEqual([])

    const traitFiltered = fixture.builder.extractEpisodes({
      statuses: ['completed'],
      traits: ['uses-tools'],
    })
    expect(traitFiltered.map((episode) => episode.sessionId)).toEqual(['sess_batch_2'])

    const paged = fixture.builder.extractEpisodes({
      statuses: ['completed'],
      offset: 1,
      limit: 1,
    })
    expect(paged.map((episode) => episode.sessionId)).toEqual(['sess_batch_2'])

    fixture.sessionDB.close()
    fixture.metricsDB.close()
  })

  test('listMatchingSessionIds and getUpdatedSessionIds apply date, trait, and evaluation filters', () => {
    const fixture = createFixture()
    cleanupDirs.push(fixture.logsDir)

    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_keep',
        updatedAt: '2026-04-04T12:00:00.000Z',
        status: 'completed',
      }),
    )
    fixture.sessionDB.saveSession(
      makeSessionData({
        id: 'sess_drop',
        updatedAt: '2026-04-01T08:00:00.000Z',
        status: 'completed',
      }),
    )

    fixture.sessionDB.saveMessages('sess_keep', [
      makeMessage({
        id: 'keep_user_1',
        sessionId: 'sess_keep',
        content: [{ type: 'text', text: 'first real turn' }],
      }),
      makeMessage({
        id: 'keep_user_2',
        sessionId: 'sess_keep',
        content: [{ type: 'text', text: 'second real turn' }],
        createdAt: '2026-04-04T12:00:01.000Z',
      }),
    ])
    fixture.sessionDB.saveMessages('sess_drop', [
      makeMessage({
        id: 'drop_user_1',
        sessionId: 'sess_drop',
        content: [{ type: 'text', text: 'single turn' }],
      }),
    ])

    fixture.metricsDB.recordEvaluation({
      sessionId: 'sess_keep',
      model: 'judge-model',
      overallScore: 90,
      verdict: 'strong',
      confidence: 'high',
      dimensions: [],
      findings: [],
      generatedAt: '2026-04-04T12:00:10.000Z',
      createdAt: '2026-04-04T12:00:10.000Z',
    })

    writeSessionTraceEntries(fixture.logsDir, 'sess_keep', [
      {
        spanId: 'span_keep_request',
        sessionId: 'sess_keep',
        kind: 'llm_request',
        name: 'llm_request',
        startTime: '2026-04-04T12:00:00.000Z',
        endTime: '2026-04-04T12:00:01.000Z',
        durationMs: 1000,
        status: 'success',
        data: {
          request: {
            id: 'req_keep',
            turnIndex: 1,
            sessionId: 'sess_keep',
            model: 'gpt-5.3-codex-medium',
            provider: 'openai-codex',
            userPrompt: 'run read',
            response: 'done',
            stopReason: 'end_turn',
            toolUseCount: 1,
            toolCalls: [{ id: 'call_keep', name: 'read', input: { path: 'README.md' } }],
            toolResults: [],
            tokens: { input: 1, output: 1 },
            cost: 0.01,
          },
        },
      },
    ])

    const ids = fixture.builder.listMatchingSessionIds({
      statuses: ['completed'],
      since: '2026-04-02T00:00:00.000Z',
      traits: ['uses-tools', 'multi-turn'],
      hasEvaluation: true,
    })

    expect(ids).toEqual(['sess_keep'])
    expect(fixture.builder.getUpdatedSessionIds('2026-04-02T00:00:00.000Z')).toEqual([
      'sess_keep',
    ])

    fixture.sessionDB.close()
    fixture.metricsDB.close()
  })
})
