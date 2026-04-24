import { describe, expect, test } from 'bun:test'
import { buildContextTokenSummary, estimateToolResultTokens } from '../context-tokens'

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
})
