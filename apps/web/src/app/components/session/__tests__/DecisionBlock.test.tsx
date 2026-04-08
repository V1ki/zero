import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionBlock } from '../DecisionBlock'

describe('DecisionBlock', () => {
  test('renders context_compression preview with model and cost', () => {
    const html = renderToStaticMarkup(
      <DecisionBlock
        id="decision_compression"
        decisionType="context_compression"
        outcome="compress"
        detail={{
          messagesBefore: 100,
          messagesAfter: 80,
          model: 'anthropic/claude-sonnet-4-6',
          cost: 0.05,
        }}
      />,
    )

    expect(html).toContain('messages 100 -&gt; 80 | anthropic/claude-sonnet-4-6 | $0.0500')
  })
})
