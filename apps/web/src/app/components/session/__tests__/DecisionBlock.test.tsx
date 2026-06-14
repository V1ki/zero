import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TimelineItem } from '../timeline/timeline'
import { TimelineView } from '../timeline/TimelineView'

describe('DecisionBlock', () => {
  test('renders context_compression preview with model and cost', () => {
    const items: TimelineItem[] = [
      {
        type: 'decision',
        id: 'decision_compression',
        decisionType: 'context_compression',
        outcome: 'compress',
        sourceKind: 'trace',
        createdAt: '2026-04-19T10:32:00.000Z',
        detail: {
          messagesBefore: 100,
          messagesAfter: 80,
          model: 'anthropic/claude-sonnet-4-6',
          cost: 0.05,
        },
      },
    ]
    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId={null}
        selectedDecisionId={null}
        selectedTaskClosureId={null}
        onSelectTool={() => {}}
        onSelectDecision={() => {}}
        onSelectTaskClosure={() => {}}
      />,
    )

    expect(html).toContain('messages 100 -&gt; 80 | anthropic/claude-sonnet-4-6 | $0.0500')
  })
})
