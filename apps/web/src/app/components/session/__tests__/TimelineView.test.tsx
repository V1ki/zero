import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TimelineView } from '../TimelineView'
import type { TimelineItem } from '../timeline'

describe('TimelineView', () => {
  test('renders the provided timeline items without recomputing a thinner tool result', () => {
    const items: TimelineItem[] = [
      {
        type: 'tool-call',
        id: 'tool-1',
        name: 'bash',
        input: { command: 'system_profiler SPHardwareDataType' },
        result: 'Model Name: MacBook Pro\nChip: Apple M4 Max\nMemory: 128 GB',
        summary: 'Executed: system_profiler SPHardwareDataType',
        isError: false,
        durationMs: 14523,
        createdAt: '2026-04-19T10:33:00.000Z',
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId="tool-1"
        selectedDecisionId={null}
        selectedTaskClosureId={null}
        selectedMemoryNudgeId={null}
        selectedSubAgentId={null}
        highlightedAssistantMessageId={null}
        highlightedSubAgentId={null}
        onSelectTool={() => {}}
        onSelectDecision={() => {}}
        onSelectTaskClosure={() => {}}
        onSelectMemoryNudge={() => {}}
        onSelectSubAgent={() => {}}
      />,
    )

    expect(html).toContain('data-tool-renderer="bash"')
    expect(html).toContain('Model Name: MacBook Pro')
    expect(html).toContain('Chip: Apple M4 Max')
    expect(html).not.toContain('did not persist stdout/stderr')
  })

  test('renders expandable memory nudge cards with nested memory tool details', () => {
    const items: TimelineItem[] = [
      {
        type: 'memory-nudge',
        id: 'memory-nudge-1',
        prompt: '当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？',
        createdAt: '2026-04-19T10:35:00.000Z',
        source: 'trace',
        iteration: 3,
        memoryWritten: true,
        durationMs: 320,
        status: 'success',
        relatedToolCalls: [
          {
            id: 'memory-tool-1',
            name: 'memory',
            input: {
              action: 'create',
              type: 'note',
              title: 'Deployment rollback details',
              content: 'Remember the final rollback checklist.',
            },
            summary: 'Created memory: Deployment rollback details',
            result: 'Created memory: Deployment rollback details',
            durationMs: 12,
          },
        ],
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId="memory-tool-1"
        selectedDecisionId={null}
        selectedTaskClosureId={null}
        selectedMemoryNudgeId="memory-nudge-1"
        selectedSubAgentId={null}
        highlightedAssistantMessageId={null}
        highlightedSubAgentId={null}
        onSelectTool={() => {}}
        onSelectDecision={() => {}}
        onSelectTaskClosure={() => {}}
        onSelectMemoryNudge={() => {}}
        onSelectSubAgent={() => {}}
      />,
    )

    expect(html).toContain('memory_nudge')
    expect(html).toContain('wrote memory')
    expect(html).toContain('Deployment rollback details')
    expect(html).toContain('data-tool-renderer="memory"')
  })

  test('shows an abort action for a selected running bash call when a session id is available', () => {
    const items: TimelineItem[] = [
      {
        type: 'tool-call',
        id: 'tool-abort-1',
        name: 'bash',
        input: { command: 'sleep 30' },
        status: 'running',
        createdAt: '2026-04-19T10:36:00.000Z',
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        sessionId="sess_abort"
        items={items}
        selectedToolId="tool-abort-1"
        selectedDecisionId={null}
        selectedTaskClosureId={null}
        selectedMemoryNudgeId={null}
        selectedSubAgentId={null}
        highlightedAssistantMessageId={null}
        highlightedSubAgentId={null}
        onSelectTool={() => {}}
        onSelectDecision={() => {}}
        onSelectTaskClosure={() => {}}
        onSelectMemoryNudge={() => {}}
        onSelectSubAgent={() => {}}
      />,
    )

    expect(html).toContain('Abort')
    expect(html).toContain('running')
  })
})
