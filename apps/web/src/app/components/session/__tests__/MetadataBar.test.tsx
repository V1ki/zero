import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MetadataBar } from '../detail/MetadataBar'

describe('MetadataBar', () => {
  test('renders reasoning and auxiliary cost breakdown details', () => {
    const html = renderToStaticMarkup(
      <MetadataBar
        sessionId="sess_meta_001"
        summary="Deploy fix follow-up"
        source="web"
        channelName="web"
        channelId="default"
        createdAt="2026-04-01T08:00:00.000Z"
        updatedAt="2026-04-01T08:30:00.000Z"
        modelHistory={[{ model: 'chatgpt/gpt-5.4', from: '2026-04-01T08:00:00.000Z', to: null }]}
        requestCount={4}
        totalTokens={1200}
        inputTokens={800}
        outputTokens={400}
        cacheWriteTokens={100}
        cacheReadTokens={200}
        reasoningTokens={42}
        effectiveInputTokens={1100}
        cacheHitRate={0.18}
        totalCost={0.42}
        auxiliaryCost={0.12}
        purposeBreakdown={[
          {
            purpose: 'agent_loop',
            totalCost: 0.3,
            totalTokens: 1000,
            reasoningTokens: 40,
            requestCount: 2,
          },
          {
            purpose: 'task_closure',
            totalCost: 0.12,
            totalTokens: 200,
            reasoningTokens: 2,
            requestCount: 2,
          },
        ]}
      />,
    )

    expect(html).toContain('reasoning 42')
    expect(html).toContain('aux 0.120')
    expect(html).toContain('task_closure: 0.120')
    expect(html).toContain('id default')
    expect(html).toContain('session sess_meta_001')
  })
})
