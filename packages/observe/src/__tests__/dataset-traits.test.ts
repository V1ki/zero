import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import {
  countUserTurns,
  deriveTraits,
  isPureToolResultCarrier,
  isQueuedWrapperOnlyMessage,
  isRealUserTurn,
} from '../dataset'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_test',
    sessionId: 'sess_test',
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: 'hello' }],
    createdAt: '2026-04-08T10:00:00.000Z',
    ...overrides,
  }
}

describe('dataset traits', () => {
  test('real user turn detection excludes tool_result carriers and queued wrapper injections', () => {
    const realUser = makeMessage({
      id: 'msg_real',
      content: [{ type: 'text', text: 'please inspect this file' }],
    })
    const toolResultCarrier = makeMessage({
      id: 'msg_tool_result',
      content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'done' }],
    })
    const queuedWrapper = makeMessage({
      id: 'msg_queued',
      content: [{ type: 'text', text: '<queued_message>follow-up</queued_message>' }],
    })

    expect(isRealUserTurn(realUser)).toBe(true)
    expect(isPureToolResultCarrier(toolResultCarrier)).toBe(true)
    expect(isQueuedWrapperOnlyMessage(queuedWrapper)).toBe(true)
    expect(isRealUserTurn(toolResultCarrier)).toBe(false)
    expect(isRealUserTurn(queuedWrapper)).toBe(false)
    expect(countUserTurns([realUser, toolResultCarrier, queuedWrapper])).toBe(1)
  })

  test('deriveTraits returns ordered objective tags from trace facts', () => {
    const messages: Message[] = [
      makeMessage({
        id: 'msg_user_1',
        content: [{ type: 'text', text: 'first user turn' }],
      }),
      makeMessage({
        id: 'msg_user_2',
        content: [{ type: 'text', text: 'second user turn' }],
        createdAt: '2026-04-08T10:01:00.000Z',
      }),
      makeMessage({
        id: 'msg_with_image',
        role: 'assistant',
        content: [{ type: 'image', mediaType: 'image/png', data: 'abc' }],
      }),
    ]

    const traits = deriveTraits({
      messages,
      userTurnCount: 2,
      requests: [
        {
          id: 'req_1',
          turnIndex: 1,
          sessionId: 'sess_test',
          agentName: 'sub-agent',
          spawnedByRequestId: 'req_parent',
          model: 'gpt-test',
          provider: 'openai',
          userPrompt: 'do it',
          response: 'done',
          stopReason: 'end_turn',
          toolUseCount: 2,
          toolCalls: [
            { id: 'tool_1', name: 'read', input: { path: 'README.md' } },
            { id: 'tool_2', name: 'memory', input: { action: 'write' } },
          ],
          toolResults: [
            {
              type: 'tool_result',
              toolUseId: 'tool_1',
              content: 'missing',
              isError: true,
            },
          ],
          queuedInjection: {
            count: 1,
            formattedText: '<queued_message>later</queued_message>',
            messages: [],
          },
          tokens: { input: 1, output: 1 },
          cost: 0.01,
          ts: '2026-04-08T10:00:01.000Z',
        },
      ],
      closures: [
        {
          ts: '2026-04-08T10:00:02.000Z',
          sessionId: 'sess_test',
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'done',
          classifierRequest: {
            system: 'system',
            prompt: 'prompt',
            maxTokens: 100,
          },
        },
        {
          ts: '2026-04-08T10:00:03.000Z',
          sessionId: 'sess_test',
          event: 'task_closure_decision',
          action: 'block',
          reason: 'blocked',
          classifierRequest: {
            system: 'system',
            prompt: 'prompt',
            maxTokens: 100,
          },
        },
      ],
      decisions: [
        {
          id: 'dec_1',
          sessionId: 'sess_test',
          ts: '2026-04-08T10:00:01.500Z',
          sourceKind: 'llm_request',
          decisionType: 'memory_retrieval',
          outcome: 'injected',
        },
      ],
      snapshots: [
        {
          id: 'snap_1',
          sessionId: 'sess_test',
          trigger: 'context_compression',
          ts: '2026-04-08T10:00:01.250Z',
        },
      ],
    })

    expect(traits).toEqual([
      'uses-tools',
      'uses-memory-retrieval',
      'uses-memory-write',
      'has-closure-finish',
      'has-closure-block',
      'has-compression',
      'has-sub-agent',
      'multi-turn',
      'has-tool-errors',
      'has-queued-injection',
      'has-images',
    ])
  })

  test('deriveTraits treats spawnedByRequestId as the sub-agent signal, not agentName alone', () => {
    const withoutSpawn = deriveTraits({
      messages: [],
      userTurnCount: 0,
      requests: [
        {
          id: 'req_root',
          turnIndex: 1,
          sessionId: 'sess_test',
          agentName: 'main',
          model: 'gpt-test',
          provider: 'openai',
          userPrompt: 'do it',
          response: 'done',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: { input: 1, output: 1 },
          cost: 0.01,
          ts: '2026-04-08T10:00:01.000Z',
        },
      ],
      closures: [],
      decisions: [],
      snapshots: [],
    })

    const withSpawn = deriveTraits({
      messages: [],
      userTurnCount: 0,
      requests: [
        {
          id: 'req_child',
          turnIndex: 1,
          sessionId: 'sess_test',
          agentName: 'child',
          spawnedByRequestId: 'req_root',
          model: 'gpt-test',
          provider: 'openai',
          userPrompt: 'do it',
          response: 'done',
          stopReason: 'end_turn',
          toolUseCount: 0,
          toolCalls: [],
          toolResults: [],
          tokens: { input: 1, output: 1 },
          cost: 0.01,
          ts: '2026-04-08T10:00:02.000Z',
        },
      ],
      closures: [],
      decisions: [],
      snapshots: [],
    })

    expect(withoutSpawn).not.toContain('has-sub-agent')
    expect(withSpawn).toContain('has-sub-agent')
  })

  test('deriveTraits returns empty for empty inputs', () => {
    expect(
      deriveTraits({
        messages: [],
        userTurnCount: 0,
        requests: [],
        closures: [],
        decisions: [],
        snapshots: [],
      }),
    ).toEqual([])
  })
})
