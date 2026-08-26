import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TimelineView } from '../timeline/TimelineView'
import type { TimelineItem } from '../timeline/timeline'

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

  test('renders folded decisions as a collapsible thinking section on the assistant block', () => {
    const items: TimelineItem[] = [
      {
        type: 'agent-text',
        messageId: 'msg_assistant_thinking',
        text: 'done',
        createdAt: '2026-04-19T10:32:01.000Z',
        thinking: [
          {
            type: 'decision',
            id: 'dec_tools',
            decisionType: 'tool_selection',
            outcome: 'read',
            detail: { selectedTools: ['read'] },
            sourceKind: 'llm_request',
            createdAt: '2026-04-19T10:32:00.900Z',
          },
        ],
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId={null}
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

    expect(html).toContain('data-testid="assistant-thinking"')
    expect(html).toContain('Thinking')
    expect(html).toContain('tool_selection')
    expect(html).toContain('data-decision-id="dec_tools"')
    expect(html).toContain('done')
  })

  test('renders token usage chips on user, assistant, and tool items', () => {
    const items: TimelineItem[] = [
      {
        type: 'user-message',
        text: 'hello',
        queued: false,
        createdAt: '2026-04-19T10:32:00.000Z',
        tokenUsage: { total: 4, source: 'estimate' },
      },
      {
        type: 'agent-text',
        messageId: 'msg_assistant_tokens',
        text: 'hi',
        model: 'test-model',
        createdAt: '2026-04-19T10:32:01.000Z',
        tokenUsage: {
          total: 30,
          input: 20,
          output: 10,
          effectiveInput: 20,
          cost: 0.01,
          source: 'request',
        },
      },
      {
        type: 'tool-call',
        id: 'tool-token-1',
        name: 'read',
        input: { path: '/tmp/demo.txt' },
        createdAt: '2026-04-19T10:32:02.000Z',
        tokenUsage: { total: 12, input: 10, output: 2, source: 'request' },
        resultTokenUsage: { total: 8, source: 'estimate' },
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId={null}
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

    expect(html).toContain('Tokens')
    expect(html).toContain('4 est.')
    expect(html).toContain('30 total')
    expect(html).toContain('Request')
    expect(html).toContain('Result')
  })

  test('renders compaction blocks as slim appended markers with expandable detail', () => {
    const items: TimelineItem[] = [
      {
        type: 'compaction-block',
        id: 'timeline_compaction_1',
        summary: '<timeline_compaction_block>old summary</timeline_compaction_block>',
        workingStateSummary: '<working_state_compaction>continue here</working_state_compaction>',
        coveredMessageCount: 3,
        coveredRange: {
          startMessageId: 'old_user',
          endMessageId: 'old_result',
          startCreatedAt: '2026-04-19T10:31:00.000Z',
          endCreatedAt: '2026-04-19T10:31:02.000Z',
        },
        strategy: 'deterministic_contiguous_older_turns_v1',
        strategyVersion: 'timeline_compaction_block_v1',
        boundaryReason: 'older tool turn',
        generation: 1,
        evidence: [],
        evidenceCount: 0,
        evidenceChars: 0,
        evidenceBytes: 0,
        skippedUnfinishedToolUseIds: [],
        coveredMessages: [
          {
            id: 'old_user',
            role: 'user',
            messageType: 'message',
            content: [{ type: 'text', text: 'old prompt' }],
            createdAt: '2026-04-19T10:31:00.000Z',
          },
          {
            id: 'old_tool',
            role: 'assistant',
            messageType: 'message',
            content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: '/tmp/a' } }],
            createdAt: '2026-04-19T10:31:01.000Z',
          },
          {
            id: 'old_result',
            role: 'user',
            messageType: 'message',
            content: [{ type: 'tool_result', toolUseId: 'tool_1', content: 'raw output' }],
            createdAt: '2026-04-19T10:31:02.000Z',
          },
        ],
        createdAt: '2026-04-19T10:31:00.000Z',
        updatedAt: '2026-04-19T10:31:03.000Z',
      },
    ]

    const html = renderToStaticMarkup(
      <TimelineView
        items={items}
        selectedToolId={null}
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

    expect(html).toContain('context_compaction')
    expect(html).toContain('messages 3')
    expect(html).toContain('timeline_compaction_block_v1')
    expect(html).toContain('old summary')
    expect(html).toContain('continue here')
    // Covered messages render in the main lane, not nested inside the block.
    expect(html).not.toContain('Covered Messages')
    expect(html).not.toContain('tool_result id=tool_1')
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
