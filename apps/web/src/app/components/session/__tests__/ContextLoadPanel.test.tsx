import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextLoadPanel } from '../ContextLoadPanel'
import type { ContextTokenSummary } from '../context-tokens'

describe('ContextLoadPanel', () => {
  test('renders latest request and context distribution', () => {
    const summary: ContextTokenSummary = {
      estimatedContextTokens: 230,
      latestRequest: {
        id: 'req_1',
        model: 'test-model',
        provider: 'test-provider',
        ts: '2026-04-24T01:00:00.000Z',
        total: 150,
        input: 120,
        output: 30,
        effectiveInput: 160,
        cacheRead: 40,
        cost: 0.01,
        source: 'request',
      },
      cumulative: {
        totalTokens: 150,
        inputTokens: 120,
        outputTokens: 30,
        cacheWriteTokens: 0,
        cacheReadTokens: 40,
        reasoningTokens: 0,
        effectiveInputTokens: 160,
        totalCost: 0.01,
        requestCount: 1,
      },
      sections: [
        { key: 'system', label: 'System', tokens: 30, detail: 'prompt', tone: 'system' },
        { key: 'tool-results', label: 'Tool Results', tokens: 120, tone: 'tool' },
        { key: 'user', label: 'User', tokens: 80, tone: 'user' },
      ],
      hotspots: [{ id: 'msg_1', label: 'Tool Result', tokens: 120, detail: 'large output' }],
    }

    const html = renderToStaticMarkup(<ContextLoadPanel summary={summary} />)

    expect(html).toContain('Context Load')
    expect(html).toContain('Distribution')
    expect(html).toContain('Tool Results')
    expect(html).toContain('Latest Request')
    expect(html).toContain('test-model')
  })
})
