import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompressionSpanCard } from '../context-panel/ContextPanel'
import type { TraceSpan } from '../timeline/timeline'

describe('CompressionSpanCard', () => {
  test('renders compression model, cost, token badges, and collapsible sections', () => {
    const span: TraceSpan = {
      id: 'span_compression',
      sessionId: 'sess_1',
      kind: 'llm_request',
      name: 'compression',
      startTime: '2026-03-08T00:00:00.000Z',
      endTime: '2026-03-08T00:00:00.500Z',
      durationMs: 500,
      status: 'success',
      data: {
        compression: {
          model: 'anthropic/claude-sonnet-4-6',
          provider: 'anthropic',
          prompt: 'summarize this context',
          response: 'summary text',
          cost: 0.05,
          durationMs: 500,
          tokens: {
            input: 100,
            output: 80,
            cacheWrite: 20,
            cacheRead: 10,
            reasoning: 5,
          },
        },
      },
      children: [],
    }

    const html = renderToStaticMarkup(<CompressionSpanCard span={span} />)

    expect(html).toContain('data-trace-card="compression"')
    expect(html).toContain('anthropic/claude-sonnet-4-6')
    expect(html).toContain('anthropic')
    expect(html).toContain('$0.050')
    expect(html).toContain('in 100')
    expect(html).toContain('out 80')
    expect(html).toContain('cw 20')
    expect(html).toContain('cr 10')
    expect(html).toContain('rs 5')
    expect(html).toContain('Prompt')
    expect(html).toContain('Response')
  })
})
