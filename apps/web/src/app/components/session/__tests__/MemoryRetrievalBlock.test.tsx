import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRetrievalBlock } from '../memory/MemoryRetrievalBlock'

describe('MemoryRetrievalBlock', () => {
  test('renders inline memory retrieval detail with injection preview when expanded', () => {
    const html = renderToStaticMarkup(
      <MemoryRetrievalBlock
        id="decision_memory_1"
        outcome="injected"
        createdAt="2026-03-08T00:00:02.000Z"
        durationMs={850}
        selected
        detail={{
          layer: 'layer2',
          turnIndex: 2,
          queries: ['deployment rollback runbook'],
          searches: [
            {
              query: 'deployment rollback runbook',
              resultCount: 2,
              topResultTitle: 'Deploy rollback runbook',
            },
          ],
          selectedMemories: [
            {
              id: 'mem_1',
              type: 'runbook',
              title: 'Deploy rollback runbook',
              score: 0.92,
            },
          ],
          tokens: { input: 14, output: 9 },
          cost: 0.0042,
        }}
        rationale="Need the rollback memory for grounding."
        llmRequests={[
          {
            id: 'req_2',
            turnIndex: 2,
            ts: '2026-03-08T00:00:02.100Z',
            memoryInjections: [
              {
                layer: 'layer2',
                source: 'memory_hint',
                formattedText:
                  '<memory_inject layer="layer2"><memory_hint>retry with browser</memory_hint></memory_inject>',
              },
            ],
          },
        ]}
        onSelect={() => {}}
      />,
    )

    expect(html).toContain('memory_retrieval')
    expect(html).toContain('memory_hint')
    expect(html).toContain('Injected Context')
    expect(html).toContain('deployment rollback runbook')
    expect(html).toContain('Deploy rollback runbook')
    expect(html).toContain('data-memory-entry-id="mem_1"')
    expect(html).toContain('Expand (91 chars)')
    expect(html).toContain('14+9 tokens')
    expect(html).not.toContain('Runtime Warning')
  })
})
