import { describe, expect, test } from 'bun:test'
import { buildSessionDetailInsights } from '../session-detail-insights'
import type { TimelineItem, TraceSpan } from '../timeline'

describe('buildSessionDetailInsights', () => {
  test('summarizes timeline composition, tool distribution, and trace health', () => {
    const items: TimelineItem[] = [
      {
        type: 'user-message',
        text: 'Investigate the regression',
        queued: false,
        createdAt: '2026-04-19T09:00:00.000Z',
      },
      {
        type: 'agent-text',
        messageId: 'msg_assistant_1',
        text: 'I am checking the trace projections now.',
        model: 'openai/gpt-5.4',
        createdAt: '2026-04-19T09:00:10.000Z',
      },
      {
        type: 'tool-call',
        id: 'tool_1',
        name: 'read',
        input: { path: 'apps/web/src/api/routes.ts' },
        durationMs: 180,
        createdAt: '2026-04-19T09:00:20.000Z',
      },
      {
        type: 'tool-call',
        id: 'tool_2',
        name: 'bash',
        input: { command: 'bun run check' },
        durationMs: 920,
        createdAt: '2026-04-19T09:00:30.000Z',
      },
      {
        type: 'decision',
        id: 'decision_1',
        decisionType: 'tool_selection',
        outcome: 'read, bash',
        sourceKind: 'llm_request',
        createdAt: '2026-04-19T09:00:40.000Z',
      },
      {
        type: 'task-closure',
        id: 'task_closure_1',
        event: 'task_closure_decision',
        action: 'continue',
        reason: 'visual QA still pending',
        createdAt: '2026-04-19T09:00:50.000Z',
      },
      {
        type: 'system-event',
        variant: 'info',
        text: 'memory nudge injected',
        createdAt: '2026-04-19T09:00:55.000Z',
      },
      {
        type: 'sub-agent',
        agentId: 'agent_1',
        label: 'Worker 1',
        instruction: 'Inspect the metrics regression',
        status: 'completed',
        output: 'done',
        spawnToolCallId: 'tool_spawn_1',
        childToolCalls: [],
        createdAt: '2026-04-19T09:01:00.000Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'turn',
        startTime: '2026-04-19T09:00:00.000Z',
        status: 'success',
        children: [
          {
            id: 'span_child_running',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'llm_request',
            startTime: '2026-04-19T09:00:10.000Z',
            status: 'running',
            children: [],
          },
          {
            id: 'span_child_error',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'tool_call',
            startTime: '2026-04-19T09:00:20.000Z',
            status: 'error',
            children: [],
          },
        ],
      },
    ]

    const summary = buildSessionDetailInsights(items, traces, [
      { durationMs: 800 },
      { durationMs: 1200 },
    ])

    expect(summary.timelineCount).toBe(8)
    expect(summary.userCount).toBe(1)
    expect(summary.assistantCount).toBe(1)
    expect(summary.toolCallCount).toBe(2)
    expect(summary.decisionCount).toBe(1)
    expect(summary.taskClosureCount).toBe(1)
    expect(summary.systemEventCount).toBe(1)
    expect(summary.subAgentCount).toBe(1)
    expect(summary.dominantTool).toEqual({ name: 'read', count: 1 })
    expect(summary.slowestTool).toEqual({ name: 'bash', durationMs: 920 })
    expect(summary.lastDecision).toEqual({
      decisionType: 'tool_selection',
      outcome: 'read, bash',
      createdAt: '2026-04-19T09:00:40.000Z',
    })
    expect(summary.lastTaskClosure).toEqual({
      event: 'task_closure_decision',
      action: 'continue',
      createdAt: '2026-04-19T09:00:50.000Z',
    })
    expect(summary.runningTraceCount).toBe(1)
    expect(summary.errorTraceCount).toBe(1)
    expect(summary.successfulTraceCount).toBe(1)
    expect(summary.averageRequestDurationMs).toBe(1000)
  })
})
