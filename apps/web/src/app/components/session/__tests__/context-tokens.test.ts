import { describe, expect, test } from 'bun:test'
import type { ContextCheckpoint } from '@zero-os/shared'
import {
  type MessageLike,
  buildContextTokenSummary,
  estimateToolResultTokens,
  projectPromptMessages,
} from '../context-panel/context-tokens'

const AT = '2026-04-24T01:00:00.000Z'

function textMessage(id: string, role: string, text: string): MessageLike {
  return { id, role, messageType: 'message', createdAt: AT, content: [{ type: 'text', text }] }
}

const LONG_OLD_TEXT = 'old history '.repeat(2000)
const LONG_TOOL_OUTPUT = 'x'.repeat(10_000)

const checkpointMessages: MessageLike[] = [
  textMessage('m1', 'user', LONG_OLD_TEXT),
  textMessage('m2', 'assistant', LONG_OLD_TEXT),
  {
    id: 'm3',
    role: 'assistant',
    messageType: 'message',
    createdAt: AT,
    content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } }],
  },
  {
    id: 'm4',
    role: 'user',
    messageType: 'message',
    createdAt: AT,
    content: [{ type: 'tool_result', toolUseId: 'call_1', content: LONG_TOOL_OUTPUT }],
  },
  textMessage('m5', 'user', 'latest question'),
]

const checkpoint: ContextCheckpoint = {
  id: 'cp_1',
  sessionId: 's1',
  generation: 1,
  summarizedThroughMessageId: 'm2',
  prunedThroughMessageId: 'm4',
  summary: '## 当前工作\nshort summary',
  coveredMessageCount: 2,
  tokensBefore: 6000,
  tokensAfter: 500,
  createdAt: AT,
}

function summarize(messages: MessageLike[], withCheckpoint?: ContextCheckpoint | null) {
  return buildContextTokenSummary({
    messages,
    checkpoint: withCheckpoint,
    llmRequests: [],
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    effectiveInputTokens: 0,
    totalCost: 0,
    requestCount: 0,
  })
}

describe('context token summary', () => {
  test('summarizes current context sections and latest request usage', () => {
    const summary = buildContextTokenSummary({
      systemPrompt: 'You are helpful.',
      messages: [
        {
          id: 'msg_user',
          role: 'user',
          messageType: 'message',
          createdAt: '2026-04-24T01:00:00.000Z',
          content: [{ type: 'text', text: 'Please inspect the repository.' }],
        },
        {
          id: 'msg_assistant_tool',
          role: 'assistant',
          messageType: 'message',
          createdAt: '2026-04-24T01:00:01.000Z',
          content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } }],
        },
        {
          id: 'msg_tool_result',
          role: 'user',
          messageType: 'message',
          createdAt: '2026-04-24T01:00:02.000Z',
          content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file contents' }],
        },
      ],
      llmRequests: [
        {
          id: 'req_1',
          turnIndex: 1,
          model: 'test-model',
          provider: 'test-provider',
          userPrompt: 'Please inspect the repository.',
          response: '',
          stopReason: 'tool_use',
          toolUseCount: 1,
          toolCalls: [{ id: 'call_1', name: 'read', input: { path: 'a.ts' } }],
          memoryInjections: [
            {
              layer: 'layer1',
              source: 'retrieved_memories',
              formattedText: '<memory_inject>remember this repo</memory_inject>',
            },
          ],
          queuedInjection: {
            count: 1,
            formattedText: '<queued_message>follow up</queued_message>',
            messages: [
              {
                timestamp: '2026-04-24T01:00:00.500Z',
                content: 'follow up',
                imageCount: 0,
                mediaTypes: [],
              },
            ],
          },
          tokens: { input: 120, output: 30, cacheRead: 40, reasoning: 5 },
          cost: 0.01,
          durationMs: 800,
          ts: '2026-04-24T01:00:03.000Z',
        },
      ],
      totalTokens: 150,
      inputTokens: 120,
      outputTokens: 30,
      cacheWriteTokens: 0,
      cacheReadTokens: 40,
      reasoningTokens: 5,
      effectiveInputTokens: 160,
      totalCost: 0.01,
      requestCount: 1,
    })

    expect(summary.latestRequest?.total).toBe(150)
    expect(summary.latestRequest?.effectiveInput).toBe(160)
    expect(summary.sections.map((section) => section.key)).toContain('tool-results')
    expect(summary.sections.map((section) => section.key)).toContain('memory')
    expect(summary.sections.map((section) => section.key)).toContain('queued')
    expect(summary.hotspots[0]?.tokens).toBeGreaterThan(0)
  })

  test('estimates tool result content items', () => {
    expect(
      estimateToolResultTokens('text result', [
        { type: 'text', text: 'structured text' },
        { type: 'image', mediaType: 'image/png', data: 'abc' },
      ]),
    ).toBeGreaterThan(300)
  })

  test('replaces the summarized prefix with the checkpoint summary and clips pruned results', () => {
    const projected = projectPromptMessages(checkpointMessages, checkpoint)
    expect(projected.map((message) => message.id)).toEqual(['cp_1', 'm3', 'm4', 'm5'])
    const summaryText = projected[0]?.content[0]?.text
    expect(typeof summaryText === 'string' && summaryText.includes('short summary')).toBe(true)
    const prunedResult = projected[2]?.content[0]?.content
    expect(typeof prunedResult === 'string' && prunedResult.length < LONG_TOOL_OUTPUT.length).toBe(
      true,
    )

    const withoutCheckpoint = summarize(checkpointMessages, null)
    const withCheckpoint = summarize(checkpointMessages, checkpoint)
    expect(withCheckpoint.estimatedContextTokens).toBeLessThan(
      withoutCheckpoint.estimatedContextTokens / 4,
    )
    const checkpointSection = withCheckpoint.sections.find(
      (section) => section.key === 'checkpoint',
    )
    expect(checkpointSection?.tokens).toBeGreaterThan(0)
    expect(withoutCheckpoint.sections.some((section) => section.key === 'checkpoint')).toBe(false)
    expect(withCheckpoint.hotspots.some((hotspot) => hotspot.id === 'm1')).toBe(false)
    expect(withCheckpoint.hotspots.find((hotspot) => hotspot.id === 'cp_1')?.label).toBe(
      'Checkpoint',
    )
  })

  test('ignores a checkpoint whose watermarks are not in the history', () => {
    const stale = { ...checkpoint, summarizedThroughMessageId: 'gone' }
    expect(projectPromptMessages(checkpointMessages, stale)).toEqual(checkpointMessages)
    expect(summarize(checkpointMessages, stale).estimatedContextTokens).toBe(
      summarize(checkpointMessages, null).estimatedContextTokens,
    )
  })
})
