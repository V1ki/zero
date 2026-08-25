import { describe, expect, test } from 'bun:test'
import {
  type Message,
  type SessionDecisionEvent,
  type SessionTaskClosureEvent,
  type TimelineCompactionBlock,
  type TraceSpan,
  buildTimeline,
  collectSubAgentTimelineItems,
  extractFilesTouched,
  filterDisplayableDecisions,
} from '../timeline/timeline'

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
      expect(toolCall.status).toBe('success')
    }
  })

  test('attaches estimated and request token usage to visible timeline items', () => {
    const messages: Message[] = [
      {
        id: 'msg_user_tokens',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'inspect this file' }],
        createdAt: '2026-04-24T01:00:00.000Z',
      },
      {
        id: 'msg_tool_assistant_tokens',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_use', id: 'call_tokens_1', name: 'read', input: { path: 'a.ts' } }],
        createdAt: '2026-04-24T01:00:01.000Z',
      },
      {
        id: 'msg_tool_result_tokens',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_tokens_1', content: 'file contents' }],
        createdAt: '2026-04-24T01:00:02.000Z',
      },
      {
        id: 'msg_assistant_tokens',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'I inspected it.' }],
        createdAt: '2026-04-24T01:00:03.000Z',
      },
    ]

    const items = buildTimeline(
      messages,
      [],
      [],
      [],
      [
        {
          id: 'req_tool_tokens',
          turnIndex: 1,
          model: 'test-model',
          provider: 'test-provider',
          userPrompt: 'inspect this file',
          response: '',
          stopReason: 'tool_use',
          toolUseCount: 1,
          toolCalls: [{ id: 'call_tokens_1', name: 'read', input: { path: 'a.ts' } }],
          tokens: { input: 100, output: 12 },
          cost: 0.01,
          ts: '2026-04-24T01:00:01.500Z',
        },
        {
          id: 'req_text_tokens',
          turnIndex: 1,
          parentId: 'req_tool_tokens',
          model: 'test-model',
          provider: 'test-provider',
          userPrompt: 'inspect this file',
          response: 'I inspected it.',
          stopReason: 'end_turn',
          toolUseCount: 0,
          tokens: { input: 140, output: 9, cacheRead: 30 },
          cost: 0.02,
          ts: '2026-04-24T01:00:03.500Z',
        },
      ],
    )

    const user = items.find((item) => item.type === 'user-message')
    const toolCall = items.find((item) => item.type === 'tool-call')
    const assistant = items.find((item) => item.type === 'agent-text')

    expect(user?.tokenUsage?.source).toBe('estimate')
    if (toolCall?.type === 'tool-call') {
      expect(toolCall.tokenUsage?.total).toBe(112)
      expect(toolCall.resultTokenUsage?.total).toBeGreaterThan(0)
    }
    if (assistant?.type === 'agent-text') {
      expect(assistant.tokenUsage?.total).toBe(149)
      expect(assistant.tokenUsage?.cacheRead).toBe(30)
    }
  })

  test('marks live tool calls as running from trace status', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant_running',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'tool_use', id: 'call_running_1', name: 'bash', input: { command: 'sleep 30' } },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_tool_running',
        sessionId: 'sess_1',
        name: 'tool:bash',
        startTime: '2026-03-08T00:00:01.000Z',
        durationMs: 120,
        status: 'running',
        metadata: {
          toolUseId: 'call_running_1',
          toolName: 'bash',
        },
        children: [],
      },
    ]

    const items = buildTimeline(messages, traces)
    const toolCall = items.find((item) => item.type === 'tool-call')

    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'tool-call') {
      expect(toolCall.status).toBe('running')
      expect(toolCall.result).toBeUndefined()
    }
  })

  test('preserves structured image content items on read_image tool calls', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_image',
            name: 'read_image',
            input: { path: '/tmp/screenshot.png' },
          },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_image',
            content: 'Read image /tmp/screenshot.png (image/png, 3 bytes)',
            outputSummary: 'Read image /tmp/screenshot.png (image/png, 3 bytes)',
            contentItems: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const items = buildTimeline(messages)
    const imageItem = items.find((item) => item.type === 'tool-call' && item.id === 'call_image')

    expect(imageItem).toMatchObject({
      type: 'tool-call',
      name: 'read_image',
      contentItems: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
    })
  })

  test('preserves read_image imageRef content items without inline data', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_image',
            name: 'read_image',
            input: { path: '/tmp/screenshot.png' },
          },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_image',
            content: 'Read image /tmp/screenshot.png (image/png, 3 bytes)',
            contentItems: [
              {
                type: 'image',
                mediaType: 'image/png',
                imageRef: {
                  path: '/tmp/session/images/hash.png',
                  relativePath: 'images/hash.png',
                  sha256: 'hash',
                  bytes: 3,
                },
              },
            ],
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const items = buildTimeline(messages)
    const imageItem = items.find((item) => item.type === 'tool-call' && item.id === 'call_image')

    expect(imageItem).toMatchObject({
      type: 'tool-call',
      name: 'read_image',
      contentItems: [
        {
          type: 'image',
          mediaType: 'image/png',
          imageRef: { relativePath: 'images/hash.png', bytes: 3 },
        },
      ],
    })
  })

  test('prefers richer llm request tool results over generic success markers', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pwd' } }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: '✓ success' }],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const items = buildTimeline(
      messages,
      [],
      [],
      [],
      [
        {
          toolResults: [
            {
              toolUseId: 'call_1',
              content: '/Users/demo/project\n',
              outputSummary: 'Executed: pwd',
            },
          ],
        },
      ],
    )

    const toolCall = items.find((item) => item.type === 'tool-call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'tool-call') {
      expect(toolCall.result).toBe('/Users/demo/project')
      expect(toolCall.summary).toBe('Executed: pwd')
    }
  })

  test('keeps trace summaries for write tools when only generic success was persisted', () => {
    const messages: Message[] = [
      {
        id: 'msg_tool_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [
          { type: 'tool_use', id: 'call_write', name: 'write', input: { path: '/tmp/demo.ts' } },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'tool_result', toolUseId: 'call_write', content: '✓ success' }],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_tool',
        sessionId: 'sess_1',
        name: 'tool:write',
        startTime: '2026-03-08T00:00:01.000Z',
        endTime: '2026-03-08T00:00:01.050Z',
        durationMs: 50,
        status: 'success',
        metadata: {
          toolUseId: 'call_write',
          toolName: 'write',
          outputSummary: 'Wrote /tmp/demo.ts',
        },
        children: [],
      },
    ]

    const items = buildTimeline(messages, traces)
    const toolCall = items.find((item) => item.type === 'tool-call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'tool-call') {
      expect(toolCall.result).toBe('✓ success')
      expect(toolCall.summary).toBe('Wrote /tmp/demo.ts')
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

  test('renders control messages as system events', () => {
    const messages: Message[] = [
      {
        id: 'msg_control',
        role: 'user',
        messageType: 'control',
        controlKind: 'task_closure',
        content: [{ type: 'text', text: '<system_notice>继续完成当前任务</system_notice>' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ]

    const items = buildTimeline(messages)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('system-event')
    if (items[0].type === 'system-event') {
      expect(items[0].variant).toBe('info')
      expect(items[0].text).toContain('继续完成当前任务')
      expect(items[0].label).toBe('Task Closure Prompt')
    }
  })

  test('projects memory_nudge control messages into expandable timeline cards', () => {
    const messages: Message[] = [
      {
        id: 'msg_memory_nudge',
        role: 'user',
        messageType: 'control',
        controlKind: 'memory_nudge',
        content: [
          {
            type: 'text',
            text: '<system_notice>\n当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？\n- 用户偏好或习惯\n</system_notice>',
          },
        ],
        createdAt: '2026-03-08T00:00:02.000Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'agent.run:test',
        startTime: '2026-03-08T00:00:00.000Z',
        endTime: '2026-03-08T00:00:03.000Z',
        durationMs: 3000,
        status: 'success',
        children: [
          {
            id: 'span_memory_nudge',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'memory_nudge',
            startTime: '2026-03-08T00:00:02.010Z',
            endTime: '2026-03-08T00:00:02.310Z',
            durationMs: 300,
            status: 'success',
            metadata: {
              purpose: 'memory_nudge',
              iteration: 3,
              memoryWritten: true,
            },
            data: {
              memoryNudge: {
                prompt:
                  '<system_notice>当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？</system_notice>',
                iteration: 3,
              },
            },
            children: [],
          },
          {
            id: 'span_memory_tool',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'tool:memory',
            startTime: '2026-03-08T00:00:02.120Z',
            endTime: '2026-03-08T00:00:02.130Z',
            durationMs: 10,
            status: 'success',
            metadata: {
              toolUseId: 'tool_memory_1',
              toolName: 'memory',
              input: {
                action: 'create',
                type: 'note',
                title: 'Deployment rollback details',
              },
              result: 'Created memory: Deployment rollback details',
              outputSummary: 'Created memory: Deployment rollback details',
            },
            children: [],
          },
        ],
      },
    ]

    const items = buildTimeline(messages, traces)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('memory-nudge')
    if (items[0].type === 'memory-nudge') {
      expect(items[0].prompt).toContain('当前阶段已完成。请快速评估')
      expect(items[0].iteration).toBe(3)
      expect(items[0].memoryWritten).toBe(true)
      expect(items[0].relatedToolCalls).toHaveLength(1)
      expect(items[0].relatedToolCalls[0]?.name).toBe('memory')
      expect(items[0].relatedToolCalls[0]?.summary).toBe(
        'Created memory: Deployment rollback details',
      )
    }
  })

  test('renders trace-based memory_nudge when no control message was persisted', () => {
    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'agent.run:test',
        startTime: '2026-03-08T00:00:00.000Z',
        status: 'success',
        children: [
          {
            id: 'span_memory_nudge',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'memory_nudge',
            startTime: '2026-03-08T00:00:02.000Z',
            endTime: '2026-03-08T00:00:02.300Z',
            durationMs: 300,
            status: 'success',
            metadata: {
              purpose: 'memory_nudge',
              iteration: 3,
              memoryWritten: true,
            },
            data: {
              memoryNudge: {
                prompt:
                  '<system_notice>当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？</system_notice>',
                iteration: 3,
              },
            },
            children: [],
          },
          {
            id: 'span_memory_search',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'tool:memory_search',
            startTime: '2026-03-08T00:00:02.050Z',
            endTime: '2026-03-08T00:00:02.090Z',
            durationMs: 40,
            status: 'success',
            metadata: {
              toolUseId: 'tool_search_1',
              toolName: 'memory_search',
              input: { query: 'deployment rollback' },
              result: 'Found 2 relevant memories',
              outputSummary: 'Found 2 relevant memories',
            },
            children: [],
          },
          {
            id: 'span_memory_write',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'tool:memory',
            startTime: '2026-03-08T00:00:02.120Z',
            endTime: '2026-03-08T00:00:02.160Z',
            durationMs: 40,
            status: 'success',
            metadata: {
              toolUseId: 'tool_memory_1',
              toolName: 'memory',
              input: {
                action: 'create',
                type: 'runbook',
                title: 'Rollback checklist',
              },
              result: 'Created memory: Rollback checklist',
              outputSummary: 'Created memory: Rollback checklist',
            },
            children: [],
          },
        ],
      },
    ]

    const items = buildTimeline([], traces)
    const memoryNudge = items.find((item) => item.type === 'memory-nudge')

    expect(memoryNudge).toBeDefined()
    if (memoryNudge?.type === 'memory-nudge') {
      expect(memoryNudge.prompt).toContain('当前阶段已完成。请快速评估')
      expect(memoryNudge.iteration).toBe(3)
      expect(memoryNudge.memoryWritten).toBe(true)
      expect(memoryNudge.relatedToolCalls.map((toolCall) => toolCall.name)).toEqual([
        'memory_search',
        'memory',
      ])
      expect(memoryNudge.createdAt).toBe('2026-03-08T00:00:02.300Z')
    }
  })

  test('extracts touched files from both top-level and sub-agent tool inputs', () => {
    const items = buildTimeline(
      [
        {
          id: 'msg_tool_use',
          role: 'assistant',
          messageType: 'message',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/demo.txt' } },
            {
              type: 'tool_use',
              id: 'spawn_1',
              name: 'spawn_agent',
              input: {
                agentId: 'agent_1',
                label: 'Worker 1',
                instruction: 'Inspect files',
              },
            },
          ],
          createdAt: '2026-03-08T00:00:01.000Z',
        },
        {
          id: 'msg_tool_result',
          role: 'user',
          messageType: 'message',
          content: [
            { type: 'tool_result', toolUseId: 'spawn_1', content: '{"agentId":"agent_1"}' },
          ],
          createdAt: '2026-03-08T00:00:01.100Z',
        },
      ],
      [
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
              id: 'span_spawn',
              parentId: 'span_root',
              sessionId: 'sess_1',
              name: 'tool:spawn_agent',
              startTime: '2026-03-08T00:00:01.000Z',
              endTime: '2026-03-08T00:00:01.500Z',
              durationMs: 500,
              status: 'success',
              metadata: {
                toolUseId: 'spawn_1',
                toolName: 'spawn_agent',
                spawnedAgentId: 'agent_1',
                spawnedAgentLabel: 'Worker 1',
              },
              children: [
                {
                  id: 'span_child_read',
                  parentId: 'span_spawn',
                  sessionId: 'sess_1',
                  name: 'tool:read',
                  startTime: '2026-03-08T00:00:01.100Z',
                  endTime: '2026-03-08T00:00:01.200Z',
                  durationMs: 100,
                  status: 'success',
                  data: {
                    kind: 'sub_agent',
                    agentId: 'agent_1',
                  },
                  metadata: {
                    agentId: 'agent_1',
                  },
                  children: [
                    {
                      id: 'span_nested_read',
                      parentId: 'span_child_read',
                      sessionId: 'sess_1',
                      name: 'tool:read',
                      startTime: '2026-03-08T00:00:01.120Z',
                      endTime: '2026-03-08T00:00:01.180Z',
                      durationMs: 60,
                      status: 'success',
                      metadata: {
                        toolUseId: 'child_read_1',
                        toolName: 'read',
                        input: { path: '/tmp/child.txt' },
                      },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    )

    expect(extractFilesTouched(items)).toEqual(['/tmp/demo.txt', '/tmp/child.txt'])
  })

  test('keeps memory inject notifications at their original timestamp', () => {
    const messages: Message[] = [
      {
        id: 'msg_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'please inspect this' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_memory_inject',
        role: 'user',
        messageType: 'notification',
        content: [{ type: 'text', text: '<memory_inject layer="layer2">memory</memory_inject>' }],
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
    const userIndex = items.findIndex(
      (item) => item.type === 'user-message' && item.text === 'please inspect this',
    )
    const notificationIndex = items.findIndex(
      (item) =>
        item.type === 'system-event' && item.text.includes('<memory_inject layer="layer2">'),
    )
    const replyIndex = items.findIndex(
      (item) => item.type === 'agent-text' && item.text === 'working on it',
    )

    expect(userIndex).toBeGreaterThanOrEqual(0)
    expect(notificationIndex).toBeGreaterThanOrEqual(0)
    expect(replyIndex).toBeGreaterThanOrEqual(0)
    expect(notificationIndex).toBeGreaterThan(userIndex)
    expect(notificationIndex).toBeLessThan(replyIndex)
    expect(items[notificationIndex]).toMatchObject({
      type: 'system-event',
      createdAt: '2026-03-08T00:00:00.001Z',
    })
  })

  test('keeps memory inject notifications after hidden tool results', () => {
    const messages: Message[] = [
      {
        id: 'msg_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'analyze x.com link' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_tool_use',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_browser',
            name: 'browser',
            input: { url: 'https://x.com/demo' },
          },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'msg_tool_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_browser',
            content: 'browser navigation failed',
            isError: true,
          },
        ],
        createdAt: '2026-03-08T00:00:02.000Z',
      },
      {
        id: 'msg_memory_hint',
        role: 'user',
        messageType: 'notification',
        content: [{ type: 'text', text: '<memory_inject layer="layer2">hint</memory_inject>' }],
        createdAt: '2026-03-08T00:00:03.000Z',
      },
      {
        id: 'msg_assistant_reply',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'retrying with memory hint' }],
        createdAt: '2026-03-08T00:00:04.000Z',
      },
    ]

    const items = buildTimeline(messages)
    const toolIndex = items.findIndex(
      (item) => item.type === 'tool-call' && item.id === 'call_browser',
    )
    const notificationIndex = items.findIndex(
      (item) =>
        item.type === 'system-event' && item.text.includes('<memory_inject layer="layer2">'),
    )
    const replyIndex = items.findIndex(
      (item) => item.type === 'agent-text' && item.text === 'retrying with memory hint',
    )

    expect(toolIndex).toBeGreaterThanOrEqual(0)
    expect(notificationIndex).toBeGreaterThanOrEqual(0)
    expect(replyIndex).toBeGreaterThanOrEqual(0)
    expect(notificationIndex).toBeGreaterThan(toolIndex)
    expect(notificationIndex).toBeLessThan(replyIndex)
    expect(items[toolIndex]).toMatchObject({
      type: 'tool-call',
      id: 'call_browser',
      isError: true,
    })
    expect(items[notificationIndex]).toMatchObject({
      type: 'system-event',
      createdAt: '2026-03-08T00:00:03.000Z',
    })
  })

  test('adds projected decision items and keeps task_closure decisions out of the decision lane', () => {
    const decisions: SessionDecisionEvent[] = [
      {
        id: 'decision_compress',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:01.000Z',
        decisionType: 'context_compression',
        outcome: 'compress',
        detail: {
          messagesBefore: 14,
          messagesAfter: 8,
          model: 'anthropic/claude-sonnet-4-6',
          cost: 0.05,
        },
        sourceKind: 'snapshot',
      },
      {
        id: 'decision_tools',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:02.000Z',
        decisionType: 'tool_selection',
        outcome: 'read, bash',
        detail: {
          selectedTools: ['read', 'bash'],
        },
        rationale: 'Need to inspect first, then validate in shell.',
        sourceKind: 'llm_request',
      },
      {
        id: 'decision_task_closure',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:03.000Z',
        decisionType: 'task_closure',
        outcome: 'finish',
        rationale: 'Already represented by task closure events.',
        sourceKind: 'closure_decision',
      },
    ]

    const items = buildTimeline([], [], [], decisions)
    const decisionItems = items.filter((item) => item.type === 'decision')

    expect(decisionItems).toHaveLength(2)
    expect(decisionItems.map((item) => item.type === 'decision' && item.id)).toEqual([
      'decision_compress',
      'decision_tools',
    ])
    expect(decisionItems[1]).toMatchObject({
      type: 'decision',
      decisionType: 'tool_selection',
      outcome: 'read, bash',
      rationale: 'Need to inspect first, then validate in shell.',
    })
    expect(decisionItems[0]).toMatchObject({
      type: 'decision',
      decisionType: 'context_compression',
      detail: {
        model: 'anthropic/claude-sonnet-4-6',
        cost: 0.05,
      },
    })
  })

  test('reuses the shared display filter for non-task-closure decisions', () => {
    const decisions: SessionDecisionEvent[] = [
      {
        id: 'decision_memory',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:01.000Z',
        decisionType: 'memory_retrieval',
        outcome: 'retrieve',
        sourceKind: 'llm_request',
      },
      {
        id: 'decision_task_closure',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:02.000Z',
        decisionType: 'task_closure',
        outcome: 'finish',
        sourceKind: 'closure_decision',
      },
    ]

    expect(filterDisplayableDecisions(decisions).map((decision) => decision.id)).toEqual([
      'decision_memory',
    ])
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

test('orders memory retrieval decisions after the triggering user message when timestamps are chronological', () => {
  const items = buildTimeline(
    [
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
    ],
    [],
    [],
    [
      {
        id: 'decision_memory',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:00.500Z',
        decisionType: 'memory_retrieval',
        outcome: 'injected',
        sourceKind: 'llm_request',
        detail: {
          layer: 'layer1',
          turnIndex: 1,
        },
      },
    ],
  )

  expect(items.map((item) => item.type)).toEqual(['user-message', 'decision', 'agent-text'])
})

test('merges matched memory inject notifications into memory retrieval decisions', () => {
  const items = buildTimeline(
    [
      {
        id: 'msg_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'please inspect this' }],
        createdAt: '2026-03-08T00:00:00.001Z',
      },
      {
        id: 'msg_memory_inject',
        role: 'user',
        messageType: 'notification',
        content: [
          {
            type: 'text',
            text: '<memory_inject layer="layer2"><memory_hint>tool execution error, retry with browser</memory_hint></memory_inject>',
          },
        ],
        createdAt: '2026-03-08T00:00:00.800Z',
      },
      {
        id: 'msg_assistant',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'text', text: 'working on it' }],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
    ],
    [],
    [],
    [
      {
        id: 'decision_memory',
        sessionId: 'sess_1',
        ts: '2026-03-08T00:00:00.700Z',
        decisionType: 'memory_retrieval',
        outcome: 'injected',
        sourceKind: 'llm_request',
        detail: {
          layer: 'layer2',
          turnIndex: 2,
          selectedMemoryIds: ['mem_1'],
        },
      },
    ],
    [
      {
        id: 'req_memory',
        turnIndex: 2,
        ts: '2026-03-08T00:00:00.810Z',
        memoryInjections: [
          {
            layer: 'layer2',
            source: 'memory_hint',
            formattedText:
              '<memory_inject layer="layer2"><memory_hint>tool execution error, retry with browser</memory_hint></memory_inject>',
          },
        ],
      },
    ],
  )

  expect(items.map((item) => item.type)).toEqual(['user-message', 'decision', 'agent-text'])
  expect(
    items.find(
      (item) =>
        item.type === 'system-event' && item.text.includes('<memory_inject layer="layer2">'),
    ),
  ).toBeUndefined()
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

test('projects timeline compaction blocks while hiding covered messages from the main lane', () => {
  const messages: Message[] = [
    {
      id: 'old_user',
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'old task' }],
      createdAt: '2026-03-08T00:00:00.000Z',
    },
    {
      id: 'old_assistant_tool',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'tool_use', id: 'tool_old', name: 'read', input: { path: '/tmp/a' } }],
      createdAt: '2026-03-08T00:00:01.000Z',
    },
    {
      id: 'old_result',
      role: 'user',
      messageType: 'message',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool_old',
          content: 'raw output',
          outputSummary: 'read /tmp/a',
        },
      ],
      createdAt: '2026-03-08T00:00:02.000Z',
    },
    {
      id: 'old_assistant_text',
      role: 'assistant',
      messageType: 'message',
      content: [{ type: 'text', text: 'old answer' }],
      createdAt: '2026-03-08T00:00:03.000Z',
    },
    {
      id: 'current_user',
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: 'current task' }],
      createdAt: '2026-03-08T00:01:00.000Z',
    },
  ]
  const blocks: TimelineCompactionBlock[] = [
    {
      id: 'timeline_compaction_1',
      sessionId: 'sess_timeline',
      status: 'active',
      strategy: 'deterministic_contiguous_older_turns_v1',
      strategyVersion: 'timeline_compaction_block_v1',
      boundaryReason: 'test boundary',
      summary: '<timeline_compaction_block>summary</timeline_compaction_block>',
      workingStateSummary: '<working_state_compaction>state</working_state_compaction>',
      coveredMessageIds: ['old_user', 'old_assistant_tool', 'old_result', 'old_assistant_text'],
      coveredRange: {
        startMessageId: 'old_user',
        endMessageId: 'old_assistant_text',
        startCreatedAt: '2026-03-08T00:00:00.000Z',
        endCreatedAt: '2026-03-08T00:00:03.000Z',
      },
      coveredMessageCount: 4,
      toolUseIds: ['tool_old'],
      evidence: [],
      evidenceCount: 0,
      evidenceChars: 0,
      evidenceBytes: 0,
      rawCharsMovedToEvidence: 0,
      skippedUnfinishedToolUseIds: [],
      episodeFullRetainTurns: 0,
      createdAt: '2026-03-08T00:00:00.000Z',
      updatedAt: '2026-03-08T00:00:04.000Z',
      generation: 1,
    },
  ]

  const items = buildTimeline(messages, [], [], [], [], blocks)

  expect(items.map((item) => item.type)).toEqual(['compaction-block', 'user-message'])
  const block = items[0]
  expect(block.type).toBe('compaction-block')
  if (block.type === 'compaction-block') {
    expect(block.coveredMessageCount).toBe(4)
    expect(block.coveredMessages.map((message) => message.id)).toEqual([
      'old_user',
      'old_assistant_tool',
      'old_result',
      'old_assistant_text',
    ])
    expect(block.summary).toContain('summary')
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
              model: 'deepseek/deepseek-v4-pro',
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
      expect(subAgent.model).toBe('deepseek/deepseek-v4-pro')
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

  test('collects sub-agent items even when compaction covers the spawn messages', () => {
    const messages: Message[] = [
      {
        id: 'old_user',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'old task' }],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'old_spawn',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_spawn',
            name: 'spawn_agent',
            input: { label: 'probe', instruction: 'Probe the cluster' },
          },
        ],
        createdAt: '2026-03-08T00:00:01.000Z',
      },
      {
        id: 'old_spawn_result',
        role: 'user',
        messageType: 'message',
        content: [
          { type: 'tool_result', toolUseId: 'call_spawn', content: '{"agentId":"agent_9"}' },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
      {
        id: 'old_wait',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_wait',
            name: 'wait_agent',
            input: { agentId: 'agent_9' },
          },
        ],
        createdAt: '2026-03-08T00:00:02.000Z',
      },
      {
        id: 'old_wait_result',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_wait',
            content: '{"status":"completed","output":"probe done","durationMs":800}',
          },
        ],
        createdAt: '2026-03-08T00:00:02.100Z',
      },
    ]
    const blocks: TimelineCompactionBlock[] = [
      {
        id: 'timeline_compaction_1',
        sessionId: 'sess_timeline',
        status: 'active',
        strategy: 'deterministic_contiguous_older_turns_v1',
        strategyVersion: 'timeline_compaction_block_v1',
        boundaryReason: 'test boundary',
        summary: '<timeline_compaction_block>summary</timeline_compaction_block>',
        workingStateSummary: '<working_state_compaction>state</working_state_compaction>',
        coveredMessageIds: messages.map((message) => message.id),
        coveredRange: {
          startMessageId: 'old_user',
          endMessageId: 'old_wait_result',
          startCreatedAt: '2026-03-08T00:00:00.000Z',
          endCreatedAt: '2026-03-08T00:00:02.100Z',
        },
        coveredMessageCount: messages.length,
        toolUseIds: ['call_spawn', 'call_wait'],
        evidence: [],
        evidenceCount: 0,
        evidenceChars: 0,
        evidenceBytes: 0,
        rawCharsMovedToEvidence: 0,
        skippedUnfinishedToolUseIds: [],
        episodeFullRetainTurns: 0,
        createdAt: '2026-03-08T00:00:00.000Z',
        updatedAt: '2026-03-08T00:00:03.000Z',
        generation: 1,
      },
    ]

    const timelineItems = buildTimeline(messages, [], [], [], [], blocks)
    expect(timelineItems.find((item) => item.type === 'sub-agent')).toBeUndefined()

    const collected = collectSubAgentTimelineItems(messages)
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatchObject({
      agentId: 'agent_9',
      label: 'probe',
      status: 'completed',
      instruction: 'Probe the cluster',
      output: 'probe done',
      durationMs: 800,
    })
  })

  test('prefers the sub-agent span output over a background wait notice', () => {
    const messages: Message[] = [
      {
        id: 'msg_spawn',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_spawn',
            name: 'spawn_agent',
            input: { label: 'probe', instruction: 'Probe the cluster' },
          },
        ],
        createdAt: '2026-03-08T00:00:00.000Z',
      },
      {
        id: 'msg_spawn_result',
        role: 'user',
        messageType: 'message',
        content: [
          { type: 'tool_result', toolUseId: 'call_spawn', content: '{"agentId":"agent_9"}' },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
      {
        id: 'msg_wait',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_wait',
            name: 'wait_agent',
            input: { agentId: 'agent_9' },
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
            content:
              '<system_event type="background_tool.started"><background_task tool_name="wait_agent" status="running">',
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]
    const traces: TraceSpan[] = [
      {
        id: 'span_spawn',
        sessionId: 'sess_timeline',
        name: 'tool:spawn_agent',
        startTime: '2026-03-08T00:00:00.000Z',
        status: 'success',
        metadata: { toolUseId: 'call_spawn' },
        children: [
          {
            id: 'span_agent',
            sessionId: 'sess_timeline',
            name: 'sub_agent:probe',
            startTime: '2026-03-08T00:00:00.100Z',
            status: 'success',
            durationMs: 1200,
            data: { output: 'span final report', durationMs: 1200 },
            children: [],
          },
        ],
      },
    ]

    const collected = collectSubAgentTimelineItems(messages, traces)
    expect(collected).toHaveLength(1)
    expect(collected[0]?.output).toBe('span final report')
    expect(collected[0]?.durationMs).toBe(1200)
  })

  test('sub-agent resolves waiting status from wait_agent ids results', () => {
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
              label: 'interactive-agent',
              instruction: 'Wait for more work',
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
            content: '{"agentId":"agent_waiting"}',
          },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
      {
        id: 'msg_wait',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_wait',
            name: 'wait_agent',
            input: { ids: ['agent_waiting'], resolveOn: 'ready' },
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
            content:
              '{"statuses":{"agent_waiting":{"state":"waiting","output":"reply:Wait for more work","elapsedMs":250}},"timedOut":false}',
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const items = buildTimeline(messages)
    const subAgent = items.find((item) => item.type === 'sub-agent')

    expect(subAgent).toBeDefined()
    if (subAgent?.type === 'sub-agent') {
      expect(subAgent.status).toBe('waiting')
      expect(subAgent.output).toBe('reply:Wait for more work')
      expect(subAgent.durationMs).toBe(250)
    }
  })

  test('waiting status takes precedence over running trace spans', () => {
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
              label: 'interactive-agent',
              instruction: 'Wait for more work',
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
            content: '{"agentId":"agent_waiting"}',
          },
        ],
        createdAt: '2026-03-08T00:00:00.100Z',
      },
      {
        id: 'msg_wait',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'call_wait',
            name: 'wait_agent',
            input: { ids: ['agent_waiting'], resolveOn: 'ready' },
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
            content: '{"statuses":{"agent_waiting":{"state":"waiting"}},"timedOut":false}',
          },
        ],
        createdAt: '2026-03-08T00:00:01.100Z',
      },
    ]

    const traces: TraceSpan[] = [
      {
        id: 'span_root',
        sessionId: 'sess_1',
        name: 'tool:spawn_agent',
        startTime: '2026-03-08T00:00:00.000Z',
        status: 'success',
        metadata: { toolUseId: 'call_spawn' },
        children: [
          {
            id: 'span_sub',
            parentId: 'span_root',
            sessionId: 'sess_1',
            name: 'sub_agent:interactive-agent',
            startTime: '2026-03-08T00:00:00.000Z',
            status: 'running',
            metadata: { agentId: 'agent_waiting', model: 'anthropic/claude-opus-4-6' },
            children: [],
          },
        ],
      },
    ]

    const items = buildTimeline(messages, traces)
    const subAgent = items.find((item) => item.type === 'sub-agent')

    expect(subAgent).toBeDefined()
    if (subAgent?.type === 'sub-agent') {
      expect(subAgent.status).toBe('waiting')
      expect(subAgent.model).toBe('anthropic/claude-opus-4-6')
    }
  })

  test('sub-agent extracts child tool calls from nested traces', () => {
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
                id: 'span_request',
                parentId: 'span_sub',
                sessionId: 'sess_1',
                name: 'llm_request',
                startTime: '2026-03-08T00:00:00.200Z',
                endTime: '2026-03-08T00:00:00.350Z',
                durationMs: 150,
                status: 'success',
                children: [
                  {
                    id: 'span_child_tool',
                    parentId: 'span_request',
                    sessionId: 'sess_1',
                    name: 'tool:read',
                    startTime: '2026-03-08T00:00:00.210Z',
                    endTime: '2026-03-08T00:00:00.350Z',
                    durationMs: 140,
                    status: 'success',
                    metadata: {
                      toolUseId: 'child_call_1',
                      input: { path: 'apps/web/src/api/routes.ts' },
                    },
                    children: [],
                  },
                ],
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
      expect(subAgent.childToolCalls[0].durationMs).toBe(140)
      expect(subAgent.childToolCalls[0].input.path).toBe('apps/web/src/api/routes.ts')
      expect(subAgent.traceSpan?.id).toBe('span_sub')
      expect(subAgent.traceSpan?.children[0]?.id).toBe('span_request')
    }
  })
})
