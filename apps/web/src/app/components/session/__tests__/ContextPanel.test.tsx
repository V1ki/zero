import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ContextPanel,
  MemoryRetrievalDetailPanel,
  PersistedDecisionCard,
  TraceSummaryCard,
} from '../ContextPanel'

describe('TraceSummaryCard', () => {
  test('renders classifier request details from trace data before metadata fallback', () => {
    const html = renderToStaticMarkup(
      <TraceSummaryCard
        span={{
          id: 'span_1',
          sessionId: 'sess_1',
          name: 'task_closure_decision',
          startTime: '2026-03-08T00:00:00.000Z',
          endTime: '2026-03-08T00:00:01.000Z',
          durationMs: 1000,
          status: 'success',
          data: {
            closure: {
              event: 'task_closure_decision',
              action: 'continue',
              reason: 'still researching',
              assistantMessageId: 'msg_assistant_1',
              classifierRequest: {
                prompt: '<instruction>research this deeply</instruction>',
                maxTokens: 200,
              },
            },
          },
          metadata: {
            action: 'block',
            reason: 'stale metadata should not win',
            classifierRequest: {
              prompt: '<instruction>stale</instruction>',
              maxTokens: 100,
            },
          },
          children: [],
        }}
      />,
    )

    expect(html).toContain('classifier_request')
    expect(html).toContain('&lt;instruction&gt;research this deeply&lt;/instruction&gt;')
    expect(html).toContain('still researching')
    expect(html).not.toContain('&lt;instruction&gt;stale&lt;/instruction&gt;')
  })

  test('keeps context panel height constrained', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId={null}
      />,
    )

    expect(html).toContain('h-full min-h-0 overflow-y-auto')
  })

  test('keeps selected tool detail scrollable', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        modelHistory={[]}
        toolCalls={[
          {
            id: 'tool_1',
            name: 'bash',
            input: { command: 'echo test' },
            result: 'done',
            durationMs: 1250,
          },
        ]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId="tool_1"
      />,
    )

    expect(html).toContain('h-full min-h-0 overflow-y-auto')
    expect(html).toContain('max-h-[320px] overflow-y-auto')
    expect(html).toContain('DURATION')
    expect(html).toContain('1.3s')
  })

  test('renders selected task closure detail with classifier metadata', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId={null}
        selectedTaskClosure={{
          type: 'task-closure',
          id: 'tc-sess-0',
          event: 'task_closure_decision',
          action: 'continue',
          reason: 'still working through remaining checks',
          classifierRequest: {
            prompt: '<instruction>decide if the task is done</instruction>',
            maxTokens: 200,
          },
          classifierResponseRaw: '{"action":"continue"}',
          assistantMessageId: 'msg_assistant_1',
          createdAt: '2026-03-08T00:00:02.000Z',
        }}
        onJumpToAssistantMessage={() => {}}
      />,
    )

    expect(html).toContain('Task Closure Detail')
    expect(html).toContain('EVENT')
    expect(html).toContain('task_closure_decision')
    expect(html).toContain('ACTION')
    expect(html).toContain('continue')
    expect(html).toContain('REASON')
    expect(html).toContain('still working through remaining checks')
    expect(html).toContain('ASSISTANT MESSAGE')
    expect(html).toContain('Jump to message')
    expect(html).toContain('CLASSIFIER PROMPT')
    expect(html).toContain('CLASSIFIER RESPONSE')
    expect(html).toContain('{&quot;action&quot;:&quot;continue&quot;}')
    expect(html).not.toContain('CLASSIFIER SYSTEM PROMPT')
  })

  test('renders selected decision detail with rationale, context, and detail payloads', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId={null}
        selectedDecision={{
          type: 'decision',
          id: 'decision_1',
          decisionType: 'tool_selection',
          outcome: 'read, bash',
          sourceKind: 'llm_request',
          rationale: 'Inspect the file first, then run the validation command.',
          context: {
            currentTokens: 12000,
          },
          detail: {
            selectedTools: ['read', 'bash'],
            toolCount: 2,
          },
          durationMs: 850,
          createdAt: '2026-03-08T00:00:02.000Z',
        }}
      />,
    )

    expect(html).toContain('Decision Detail')
    expect(html).toContain('DECISION TYPE')
    expect(html).toContain('tool_selection')
    expect(html).toContain('OUTCOME')
    expect(html).toContain('read, bash')
    expect(html).toContain('SOURCE KIND')
    expect(html).toContain('llm_request')
    expect(html).toContain('DURATION')
    expect(html).toContain('850ms')
    expect(html).toContain('RATIONALE')
    expect(html).toContain('Inspect the file first, then run the validation command.')
    expect(html).toContain('CONTEXT')
    expect(html).toContain('&quot;currentTokens&quot;: 12000')
    expect(html).toContain('DETAIL')
    expect(html).toContain('&quot;selectedTools&quot;')
  })

  test('renders memory retrieval detail with searches, selections, fallback, and reasoning', () => {
    const html = renderToStaticMarkup(
      <MemoryRetrievalDetailPanel
        decision={{
          type: 'decision',
          id: 'decision_memory_1',
          decisionType: 'memory_retrieval',
          outcome: 'injected',
          sourceKind: 'llm_request',
          rationale:
            'Need the rollback memory for grounding.\n{"result":[{"id":"mem_1","reason":"matches rollback request"}]}',
          detail: {
            layer: 'layer2',
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
            usedFallbackSelection: true,
            tokens: {
              input: 14,
              output: 9,
            },
            cost: 0.0042,
          },
          durationMs: 850,
          createdAt: '2026-03-08T00:00:02.000Z',
        }}
      />,
    )

    expect(html).toContain('Memory Retrieval Detail')
    expect(html).toContain('OUTCOME')
    expect(html).toContain('injected')
    expect(html).toContain('LAYER')
    expect(html).toContain('layer2')
    expect(html).toContain('QUERIES')
    expect(html).toContain('deployment rollback runbook')
    expect(html).toContain('SEARCHES')
    expect(html).toContain('2 results · top: Deploy rollback runbook')
    expect(html).toContain('SELECTED MEMORIES')
    expect(html).toContain('type="button"')
    expect(html).toContain('mem_1')
    expect(html).toContain('Deploy rollback runbook')
    expect(html).toContain('score 0.92')
    expect(html).toContain('FALLBACK')
    expect(html).toContain('fallback selection')
    expect(html).toContain('COST')
    expect(html).toContain('850ms · 14+9 tokens · $0.0042')
    expect(html).toContain('AGENT REASONING')
    expect(html).toContain('Need the rollback memory for grounding.')
    expect(html).toContain('Expand')
  })

  test('renders memory retrieval decision cards with outcome states and layer tag', () => {
    const html = renderToStaticMarkup(
      <PersistedDecisionCard
        card={{
          id: 'decision_memory_1',
          createdAt: '2026-03-08T00:00:02.000Z',
          decisionType: 'memory_retrieval',
          outcome: 'empty',
          sourceKind: 'llm_request',
          context: undefined,
          rationale: '{"result":[]}',
          detail: {
            layer: 'layer2',
            queries: ['browser login'],
            searches: [
              {
                query: 'browser login',
                resultCount: 1,
                topResultTitle: 'Twitter requires browser',
              },
              {
                query: 'x.com auth',
                resultCount: 2,
                topResultTitle: 'Browser workflow',
              },
            ],
            selectedMemoryIds: [],
          },
          durationMs: 1200,
        }}
      />,
    )

    expect(html).toContain('memory_retrieval')
    expect(html).toContain('empty')
    expect(html).toContain('memory_hint')
    expect(html).toContain('activity:</span> 2 searches · 0 selected')
    expect(html).toContain('duration:</span> 1.2s')
    expect(html).toContain('Decision Details')
    expect(html).toContain('&quot;browser login&quot;')
  })

  test('keeps tool detail priority over selected task closure detail', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        modelHistory={[]}
        toolCalls={[
          {
            id: 'tool_1',
            name: 'bash',
            input: { command: 'echo test' },
            result: 'done',
          },
        ]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId="tool_1"
        selectedTaskClosure={{
          type: 'task-closure',
          id: 'tc-sess-0',
          event: 'task_closure_failed',
          reason: 'classifier error',
          error: 'invalid json',
          createdAt: '2026-03-08T00:00:02.000Z',
        }}
      />,
    )

    expect(html).toContain('Tool Detail')
    expect(html).not.toContain('Task Closure Detail')
  })

  test('renders cache summary and savings fields', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        cacheWriteTokens={120}
        cacheReadTokens={480}
        effectiveInputTokens={960}
        cacheHitRate={0.5}
        cacheReadCost={0.02}
        cacheWriteCost={0.01}
        grossAvoidedInputCost={0.08}
        netSavings={0.07}
        selectedToolId={null}
      />,
    )

    expect(html).toContain('Cache')
    expect(html).toContain('Effective Input')
    expect(html).toContain('Net Savings')
    expect(html).toContain('+$0.070')
  })

  test('renders trace eval summary in the default summary tab', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        llmRequests={[
          {
            id: 'req_1',
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'check status',
            response: 'all good',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 10, output: 20 },
            cost: 0.001,
            ts: '2026-03-08T00:00:01.000Z',
          },
        ]}
        taskClosureEvents={[
          {
            ts: '2026-03-08T00:00:02.000Z',
            event: 'task_closure_decision',
            action: 'finish',
            reason: 'task is done',
            classifierRequest: {
              prompt: 'judge prompt',
              maxTokens: 200,
            },
          },
        ]}
        selectedToolId={null}
      />,
    )

    expect(html).toContain('TRACE EVAL')
    expect(html).toContain('Resolved')
    expect(html).toContain('/100')
    expect(html).toContain('Run Judge')
  })

  test('renders queued injection details for llm requests', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        llmRequests={[
          {
            id: 'req_1',
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'check status',
            response: 'all good',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 10, output: 20 },
            cost: 0.001,
            ts: '2026-03-08T00:00:01.000Z',
            queuedInjection: {
              count: 2,
              formattedText: '<queued_messages count="2">queued</queued_messages>',
              messages: [
                {
                  timestamp: '2026-03-08T10:30:00.000Z',
                  content: 'queued one',
                  imageCount: 0,
                  mediaTypes: [],
                },
                {
                  timestamp: '2026-03-08T10:31:00.000Z',
                  content: 'queued two',
                  imageCount: 2,
                  mediaTypes: ['image/png'],
                },
              ],
            },
          },
        ]}
        selectedToolId={null}
      />,
    )

    expect(html).toContain('queued_injection')
    expect(html).toContain('Queued injection: 2 message(s)')
    expect(html).toContain(
      '&lt;queued_messages count=&quot;2&quot;&gt;queued&lt;/queued_messages&gt;',
    )
    expect(html).toContain('10:31 | 2 images')
  })

  test('renders memory injection details for llm requests', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        llmRequests={[
          {
            id: 'req_1',
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'check status',
            response: 'all good',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 10, output: 20 },
            cost: 0.001,
            ts: '2026-03-08T00:00:01.000Z',
            memoryInjections: [
              {
                layer: 'layer1',
                source: 'retrieved_memories',
                formattedText:
                  '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
              },
              {
                layer: 'layer2',
                source: 'memory_hint',
                formattedText:
                  '<memory_inject layer="layer2"><memory_hint>retry with browser</memory_hint></memory_inject>',
              },
            ],
          },
        ]}
        selectedToolId={null}
      />,
    )

    expect(html).toContain('memory_injections')
    expect(html).toContain('layer1')
    expect(html).toContain('retrieved_memories')
    expect(html).toContain('layer2')
    expect(html).toContain('memory_hint')
    expect(html).toContain(
      '&lt;memory_inject layer=&quot;layer2&quot;&gt;&lt;memory_hint&gt;retry with browser&lt;/memory_hint&gt;&lt;/memory_inject&gt;',
    )
  })

  test('does not render queued injection block when absent', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        llmRequests={[
          {
            id: 'req_1',
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'check status',
            response: 'all good',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 10, output: 20 },
            cost: 0.001,
            ts: '2026-03-08T00:00:01.000Z',
          },
        ]}
        selectedToolId={null}
      />,
    )

    expect(html).not.toContain('queued_injection')
    expect(html).not.toContain('Queued injection:')
  })

  test('renders the matching injection preview for a selected memory retrieval decision', () => {
    const html = renderToStaticMarkup(
      <ContextPanel
        sessionId="sess_1"
        modelHistory={[]}
        toolCalls={[]}
        filesTouched={[]}
        totalTokens={0}
        selectedToolId={null}
        selectedDecision={{
          type: 'decision',
          id: 'decision_memory_2',
          decisionType: 'memory_retrieval',
          outcome: 'injected',
          sourceKind: 'llm_request',
          createdAt: '2026-03-08T00:00:02.000Z',
          detail: {
            layer: 'layer1',
            turnIndex: 2,
            selectedMemories: [
              {
                id: 'mem_2',
                type: 'note',
                title: 'Deploy note',
              },
            ],
          },
        }}
        llmRequests={[
          {
            id: 'req_1',
            turnIndex: 1,
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'first',
            response: 'ok',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 1, output: 1 },
            cost: 0.001,
            ts: '2026-03-08T00:00:01.000Z',
            memoryInjections: [
              {
                layer: 'layer1',
                source: 'retrieved_memories',
                formattedText: '<memory_inject layer="layer1">wrong turn</memory_inject>',
              },
            ],
          },
          {
            id: 'req_2',
            turnIndex: 2,
            model: 'gpt-test',
            provider: 'openai',
            userPrompt: 'second',
            response: 'ok',
            stopReason: 'end_turn',
            toolUseCount: 0,
            tokens: { input: 1, output: 1 },
            cost: 0.001,
            ts: '2026-03-08T00:00:02.100Z',
            memoryInjections: [
              {
                layer: 'layer1',
                source: 'retrieved_memories',
                formattedText: '<memory_inject layer="layer1">matched turn</memory_inject>',
              },
            ],
          },
        ]}
      />,
    )

    expect(html).toContain('INJECTION PREVIEW')
    expect(html).toContain('retrieved_memories')
    expect(html).toContain('Expand (58 chars)')
    expect(html).not.toContain('wrong turn')
  })
})
