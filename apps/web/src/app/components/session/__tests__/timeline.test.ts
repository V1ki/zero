import { describe, expect, test } from 'bun:test'
import {
  type Message,
  type SessionTaskClosureEvent,
  type TraceSpan,
  buildTimeline,
} from '../timeline'

describe('buildTimeline', () => {
  test('adds task closure decision span as a dedicated task-closure item from trace data', () => {
    const messages: Message[] = [
      {
        id: 'msg_1',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_2',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'done' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_1',
        sessionId: 'sess_1',
        name: 'agent.run:test',
        startTime: '2026-03-08T00:00:00.000Z',
        endTime: '2026-03-08T00:00:02.000Z',
        durationMs: 2000,
        status: 'success',
        children: [
          {
            id: 'span_2',
            parentId: 'span_1',
            sessionId: 'sess_1',
            name: 'task_closure_decision',
            startTime: '2026-03-08T00:00:01.100Z',
            endTime: '2026-03-08T00:00:01.200Z',
            durationMs: 100,
            status: 'success',
            data: {
              closure: {
                event: 'task_closure_decision',
                action: 'continue',
                reason: 'remaining work is required',
              },
            },
            metadata: {
              called: true,
              action: 'block',
              reason: 'stale metadata should not win',
            },
            children: [],
          },
        ],
      },
    ]

    const items = buildTimeline(messages, traces)
    const taskClosure = items.find((item) => item.type === 'task-closure')

    expect(taskClosure).toBeDefined()
    if (taskClosure?.type === 'task-closure') {
      expect(taskClosure.id).toBe('tc-trace-span_2')
      expect(taskClosure.event).toBe('task_closure_decision')
      expect(taskClosure.action).toBe('continue')
      expect(taskClosure.reason).toBe('remaining work is required')
    }
  })

  test('adds failed span as a dedicated task-closure item from trace data', () => {
    const items = buildTimeline(
      [],
      [
        {
          id: 'span_trim',
          sessionId: 'sess_1',
          name: 'task_closure_failed',
          startTime: '2026-03-08T00:00:01.000Z',
          endTime: '2026-03-08T00:00:01.100Z',
          durationMs: 100,
          status: 'error',
          data: {
            closure: {
              event: 'task_closure_failed',
              reason: 'invalid_classifier_output',
              failureStage: 'parse_classifier_response',
            },
          },
          metadata: {
            reason: 'stale metadata should not win',
            failureStage: 'request_classifier',
          },
          children: [],
        },
      ],
    )

    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('task-closure')
    if (items[0].type === 'task-closure') {
      expect(items[0].event).toBe('task_closure_failed')
      expect(items[0].failureStage).toBe('parse_classifier_response')
      expect(items[0].reason).toBe('invalid_classifier_output')
    }
  })

  test('attaches tool duration from trace metadata to matching tool call', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/demo' } }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'demo contents' }],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'agent.run:test',
        startTime: '2026-03-08T00:00:00.000Z',
        endTime: '2026-03-08T00:00:02.000Z',
        durationMs: 2000,
        status: 'success',
        children: [
          {
            id: 'span_tool',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'tool:read',
            startTime: '2026-03-08T00:00:01.000Z',
            endTime: '2026-03-08T00:00:01.125Z',
            durationMs: 125,
            status: 'success',
            metadata: {
              toolUseId: 'call_1',
              toolName: 'read',
            },
            children: [],
          },
        ],
      },
    ]

    const items = buildTimeline(messages, traces)
    const toolCall = items.find((item) => item.type === 'tool-call')

    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'tool-call') {
      expect(toolCall.durationMs).toBe(125)
    }
  })

  test('renders notification messages as system events', () => {
    const messages: Message[] = [
      {
        id: 'msg_notification',
        role: 'user',
        messageType: 'notification',
        content: [{ type: 'text', text: '<memory_hint>twitter requires browser</memory_hint>' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ]

    const items = buildTimeline(messages)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('system-event')
    if (items[0].type === 'system-event') {
      expect(items[0].text).toContain('twitter requires browser')
    }
  })

  test('anchors memory inject notifications after the triggering user message', () => {
    const messages: Message[] = [
      {
        id: 'msg_memory_inject',
        role: 'user',
        messageType: 'notification',
        content: [{ type: 'text', text: '<memory_inject layer="layer1">memory</memory_inject>' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'please inspect this' }],
        createdAt: '2026-03-08T00:00:00.001Z',
      },
      {
        id: 'msg_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'working on it' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ]

    const items = buildTimeline(messages)
    expect(items.map((item) => item.type)).toEqual(['user-message', 'system-event', 'agent-text'])
    if (items[1]?.type === 'system-event') {
      expect(items[1].text).toContain('<memory_inject layer="layer1">')
      expect(items[1].createdAt).toBe('2026-03-08T00:00:00.001Z')
    }
  })

  test('anchors later memory inject notifications to the most recent user message', () => {
    const messages: Message[] = [
      {
        id: 'msg_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'analyze x.com link' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'fetch failed, retrying' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_memory_hint',
        role: 'user',
        messageType: 'notification',
        content: [{ type: 'text', text: '<memory_inject layer="layer2">hint</memory_inject>' }],
        createdAt: '2026-03-08T00:00:02.000Z',
      },
    ]

    const items = buildTimeline(messages)
    expect(items.map((item) => item.type)).toEqual(['user-message', 'system-event', 'agent-text'])
    if (items[1]?.type === 'system-event') {
      expect(items[1].text).toContain('<memory_inject layer="layer2">')
      expect(items[1].createdAt).toBe('2026-03-08T00:00:00.000Z')
    }
  })
})

test('adds session task closure event when traces are unavailable', () => {
  const persisted: SessionTaskClosureEvent[] = [
    {
      ts: '2026-03-08T00:00:03.000Z',
      event: 'task_closure_decision',
      action: 'continue',
      reason: 'remaining work is required',
      classifierRequest: {
        prompt: '<instruction>prompt</instruction>',
        maxTokens: 200,
      },
    },
  ]

  const items = buildTimeline([], [], persisted)
  expect(items).toHaveLength(1)
  expect(items[0].type).toBe('task-closure')
  if (items[0].type === 'task-closure') {
    expect(items[0].id).toBe('tc-sess-0')
    expect(items[0].action).toBe('continue')
    expect(items[0].reason).toBe('remaining work is required')
  }
})

test('orders task closure event after its assistant message when assistant timestamp is available', () => {
  const messages: Message[] = [
    {
      id: 'msg_1',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'text', text: 'analysis result' }],
      createdAt: '2026-03-08T00:00:02.000Z',
    },
  ]

  const traces: TraceSpan[] = [
    {
      id: 'span_1',
      sessionId: 'sess_1',
      name: 'task_closure_decision',
      startTime: '2026-03-08T00:00:01.100Z',
      endTime: '2026-03-08T00:00:01.200Z',
      durationMs: 100,
      status: 'success',
      metadata: {
        called: true,
        action: 'continue',
        reason: 'remaining work is required',
        assistantMessageId: 'msg_1',
        assistantMessageCreatedAt: '2026-03-08T00:00:02.000Z',
      },
      children: [],
    },
  ]

  const items = buildTimeline(messages, traces)
  expect(items).toHaveLength(2)
  expect(items[0].type).toBe('agent-text')
  expect(items[1].type).toBe('task-closure')
})

test('deduplicates session task closure events when matching trace spans exist', () => {
  const traces: TraceSpan[] = [
    {
      id: 'span_1',
      sessionId: 'sess_1',
      name: 'task_closure_failed',
      startTime: '2026-03-08T00:00:01.000Z',
      endTime: '2026-03-08T00:00:01.100Z',
      durationMs: 100,
      status: 'success',
      data: {
        closure: {
          event: 'task_closure_failed',
          reason: 'invalid_classifier_output',
          failureStage: 'parse_classifier_response',
          assistantMessageId: 'msg_1',
        },
      },
      metadata: {
        reason: 'stale metadata should not win',
        failureStage: 'request_classifier',
      },
      children: [],
    },
  ]

  const persisted: SessionTaskClosureEvent[] = [
    {
      ts: '2026-03-08T00:00:01.200Z',
      event: 'task_closure_failed',
      reason: 'invalid_classifier_output',
      failureStage: 'parse_classifier_response',
      classifierRequest: {
        prompt: '<instruction>prompt</instruction>',
        maxTokens: 200,
      },
      assistantMessageId: 'msg_1',
    },
  ]

  const items = buildTimeline([], traces, persisted)
  expect(items).toHaveLength(1)
  expect(items[0].type).toBe('task-closure')
  if (items[0].type === 'task-closure') {
    expect(items[0].reason).toBe('invalid_classifier_output')
  }
})

test('does not infer tool duration without toolUseId metadata', () => {
  const messages: Message[] = [
    {
      id: 'msg_tool_assistant',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/demo' } }],
      createdAt: '2026-03-08T00:00:01.000Z',
    },
  ]

  const traces: TraceSpan[] = [
    {
      id: 'span_tool',
      sessionId: 'sess_1',
      name: 'tool:read',
      startTime: '2026-03-08T00:00:01.000Z',
      endTime: '2026-03-08T00:00:01.125Z',
      durationMs: 125,
      status: 'success',
      metadata: {
        toolName: 'read',
      },
      children: [],
    },
  ]

  const items = buildTimeline(messages, traces)
  const toolCall = items.find((item) => item.type === 'tool-call')

  expect(toolCall).toBeDefined()
  if (toolCall?.type === 'tool-call') {
    expect(toolCall.durationMs).toBeUndefined()
  }
})

test('does not render queued user messages as standalone timeline items', () => {
  const items = buildTimeline([
    {
      id: 'msg_live',
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'first' }],
      createdAt: '2026-03-08T00:00:00.000Z',
    },
    {
      id: 'msg_queued',
      role: 'user',
      messageType: 'queued',
      content: [
        { type: 'text', text: 'late follow-up' },
        { type: 'image', mediaType: 'image/png', data: 'abc123' },
      ],
      createdAt: '2026-03-08T00:00:01.000Z',
    },
  ])

  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    type: 'user-message',
    text: 'first',
    queued: false,
  })
})

test('does not render tool-result carrier messages as duplicate user messages', () => {
  const items = buildTimeline([
    {
      id: 'msg_assistant_tool',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'call_1', name: 'generate', input: {} }],
      createdAt: '2026-03-08T00:00:00.000Z',
    },
    {
      id: 'msg_tool_result_carrier',
      role: 'user',
      messageType: 'message',
      content: [
        { type: 'tool_result', toolUseId: 'call_1', content: 'ok' },
        { type: 'text', text: '<queued_message>late follow-up</queued_message>' },
      ],
      createdAt: '2026-03-08T00:00:01.000Z',
    },
    {
      id: 'msg_queued_visible',
      role: 'user',
      messageType: 'queued',
      content: [{ type: 'text', text: 'late follow-up' }],
      createdAt: '2026-03-08T00:00:02.000Z',
    },
  ])

  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    type: 'tool-call',
    id: 'call_1',
  })
})

describe('sub-agent timeline items', () => {
  test('converts spawn_agent tool call into a sub-agent timeline item', () => {
    const messages: Message[] = [
      {
        id: 'msg_1',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_spawn',
            name: 'spawn_agent',
            input: {
              label: 'count-ts-files',
              role: 'explorer',
              instruction: 'Count all TypeScript files',
            },
          },
        ],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_spawn_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_spawn',
            content: '{"agentId":"agent_1"}',
          },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
      {
        id: 'msg_2',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_wait',
            name: 'wait_agent',
            input: { agentId: 'agent_1' },
          },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_wait_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_wait',
            content: '{"status":"completed","output":"Found 42 files","durationMs":1500}',
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const items = buildTimeline(messages)
    const subAgent = items.find((item) => item.type === 'sub-agent')

    expect(subAgent).toBeDefined()
    if (subAgent?.type === 'sub-agent') {
      expect(subAgent.agentId).toBe('agent_1')
      expect(subAgent.label).toBe('count-ts-files')
      expect(subAgent.role).toBe('explorer')
      expect(subAgent.instruction).toBe('Count all TypeScript files')
      expect(subAgent.status).toBe('completed')
      expect(subAgent.output).toBe('Found 42 files')
      expect(subAgent.durationMs).toBe(1500)
    }

    const waitToolCall = items.find(
      (item) => item.type === 'tool-call' && item.name === 'wait_agent',
    )
    expect(waitToolCall).toBeUndefined()
  })

  test('sub-agent shows running status when no wait_agent result exists', () => {
    const messages: Message[] = [
      {
        id: 'msg_1',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_spawn',
            name: 'spawn_agent',
            input: {
              label: 'running-agent',
              instruction: 'Do something',
            },
          },
        ],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_spawn_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_spawn',
            content: '{"agentId":"agent_2"}',
          },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
    ]

    const items = buildTimeline(messages)
    const subAgent = items.find((item) => item.type === 'sub-agent')

    expect(subAgent).toBeDefined()
    if (subAgent?.type === 'sub-agent') {
      expect(subAgent.status).toBe('running')
      expect(subAgent.output).toBeUndefined()
    }
  })

  test('sub-agent extracts child tool calls from traces', () => {
    const messages: Message[] = [
      {
        id: 'msg_1',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_spawn',
            name: 'spawn_agent',
            input: {
              label: 'reader-agent',
              instruction: 'Read files',
            },
          },
        ],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_spawn_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_spawn',
            content: '{"agentId":"agent_3"}',
          },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'agent.run:main',
        startTime: '2026-03-08T00:00:00.000Z',
        status: 'success',
        children: [
          {
            id: 'span_sub',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'sub_agent',
            startTime: '2026-03-08T00:00:00.000Z',
            status: 'success',
            metadata: { agentId: 'agent_3' },
            children: [
              {
                id: 'span_child_tool',
                parentId: 'span_sub',
                sessionId: 'sess_1',
                name: 'tool:read',
                startTime: '2026-03-08T00:00:00.200Z',
                endTime: '2026-03-08T00:00:00.350Z',
                durationMs: 150,
                status: 'success',
                metadata: { toolUseId: 'child_call_1' },
                children: [],
              },
            ],
          },
        ],
      },
    ]

    const items = buildTimeline(messages, traces)
    const subAgent = items.find((item) => item.type === 'sub-agent')

    expect(subAgent).toBeDefined()
    if (subAgent?.type === 'sub-agent') {
      expect(subAgent.childToolCalls).toHaveLength(1)
      expect(subAgent.childToolCalls[0].name).toBe('read')
      expect(subAgent.childToolCalls[0].durationMs).toBe(150)
    }
  })
})
