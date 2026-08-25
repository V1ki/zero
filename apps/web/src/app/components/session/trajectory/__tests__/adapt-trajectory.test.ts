import { describe, expect, it } from 'bun:test'
import type { Message, SessionDetail, SessionRequestEntry } from '../../detail/useSessionDetailData'
import type { TraceSpan } from '../../timeline/timeline'
import { buildTrajectorySnapshot } from '../adapt-trajectory'
import { deriveTrajectoryLayout } from '../layout'
import { cellBadgeKind } from '../trajectory-record'

const T0 = '2026-08-24T07:00:00.000Z'
const T1 = '2026-08-24T07:00:02.000Z'
const T2 = '2026-08-24T07:00:05.000Z'
const T3 = '2026-08-24T07:00:06.000Z'
const T4 = '2026-08-24T07:00:20.000Z'
const T5 = '2026-08-24T07:00:22.000Z'
const T6 = '2026-08-24T07:00:23.200Z'
const T7 = '2026-08-24T07:00:30.000Z'

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    messageType: 'message',
    content: [],
    createdAt: T0,
    ...partial,
  }
}

function request(
  partial: Partial<SessionRequestEntry> & Pick<SessionRequestEntry, 'id' | 'ts'>,
): SessionRequestEntry {
  return {
    turnIndex: 1,
    model: 'qwen',
    provider: 'openai',
    userPrompt: 'p',
    response: 'r',
    stopReason: 'end_turn',
    toolUseCount: 0,
    toolCalls: [],
    toolResults: [],
    tokens: { input: 10, output: 5 },
    cost: 0,
    ...partial,
  }
}

function span(partial: Partial<TraceSpan> & Pick<TraceSpan, 'id' | 'name'>): TraceSpan {
  return {
    sessionId: 's1',
    startTime: T0,
    status: 'success',
    children: [],
    ...partial,
  }
}

function baseSession(messages: Message[]): SessionDetail {
  return {
    id: 's1',
    source: 'test',
    isCurrent: false,
    placement: 'current',
    currentModel: 'qwen',
    createdAt: T0,
    updatedAt: T7,
    messages,
    tags: [],
    modelHistory: [],
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    effectiveInputTokens: 0,
    cacheHitRate: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    grossAvoidedInputCost: 0,
    netSavings: 0,
    totalCost: 0,
    auxiliaryCost: 0,
    purposeBreakdown: [],
    requestCount: 0,
  }
}

const session = baseSession([
  message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'read it' }] }),
  message({
    id: 'a1',
    role: 'assistant',
    createdAt: T3,
    content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'tool_use', id: 'call_read', name: 'read', input: { path: '/a' } },
    ],
  }),
  message({
    id: 'tr1',
    role: 'user',
    createdAt: T2,
    content: [
      { type: 'tool_result', toolUseId: 'call_read', content: 'file body', isError: false },
    ],
  }),
  message({
    id: 'a2',
    role: 'assistant',
    createdAt: T3,
    content: [{ type: 'text', text: 'done' }],
  }),
  message({ id: 'u2', role: 'user', createdAt: T4, content: [{ type: 'text', text: 'again' }] }),
  message({ id: 'a3', role: 'assistant', createdAt: T5, content: [{ type: 'text', text: 'ok' }] }),
])

const requests: SessionRequestEntry[] = [
  request({
    id: 'req1',
    ts: T3,
    durationMs: 4000,
    turnIndex: 1,
    toolCalls: [{ id: 'call_read', name: 'read', input: { path: '/a' } }],
    toolResults: [{ type: 'tool_result', toolUseId: 'call_read', content: 'file body' }],
    tokens: { input: 100, output: 20, reasoning: 4 },
  }),
  request({ id: 'req2', ts: T6, durationMs: 1200, turnIndex: 2 }),
]

const traces: TraceSpan[] = [
  span({
    id: 'span1',
    name: 'tool:read',
    kind: 'tool_call',
    startTime: T1,
    endTime: T2,
    durationMs: 3000,
    status: 'success',
    data: { tool: 'read', requestId: 'req1' },
  }),
]

describe('buildTrajectorySnapshot', () => {
  it('projects messages into ordered nodes with turns and steps', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces)

    expect(snapshot.eventNodes.map((node) => node.kind)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'assistant',
      'user',
      'assistant',
    ])

    const seqs = snapshot.eventNodes.map((node) => node.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number)
    }

    const assistantNodes = snapshot.eventNodes.filter((node) => node.kind === 'assistant')
    expect(assistantNodes.map((node) => [node.turn, node.step])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ])

    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    expect(toolNode).toBeDefined()
    if (toolNode?.kind === 'tool-result') {
      expect(toolNode.callId).toBe('call_read')
      expect(toolNode.call?.name).toBe('read')
      expect(toolNode.isError).toBe(false)
      expect(snapshot.eventLocations.get(toolNode.seq)).toEqual({
        kind: 'step',
        turn: { turn: 1 },
        step: { step: 0 },
      })
      // Timing backfilled from the tool_call trace span.
      expect(toolNode.callTime).toBe(Date.parse(T1))
      expect(toolNode.time).toBe(Date.parse(T2))
    }

    for (const node of snapshot.eventNodes) {
      expect(snapshot.eventLocations.get(node.seq)).toBeDefined()
    }
  })

  it('pairs requests with assistant messages and enriches them', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces)

    expect(snapshot.requests).toHaveLength(2)
    expect(snapshot.requests.every((view) => view.purpose === 'assistant')).toBe(true)

    const first = snapshot.requests[0]
    expect(first?.turn).toBe(1)
    expect(first?.step).toBe(0)
    expect(first?.startedAt).toBe(Date.parse(T3) - 4000)
    expect(first?.completedAt).toBe(Date.parse(T3))
    expect(first?.usage).toMatchObject({ inputTokens: 100, reasoningTokens: 4 })

    // req2 has no tool calls: it pairs with the latest assistant at or before
    // its log timestamp (a3), not with the earlier unpaired one (a2).
    const second = snapshot.requests[1]
    expect(second?.turn).toBe(2)
    expect(second?.step).toBe(0)

    const firstAssistant = snapshot.eventNodes.find(
      (node) => node.kind === 'assistant' && node.step === 0 && node.turn === 1,
    )
    if (firstAssistant?.kind === 'assistant') {
      expect(firstAssistant.provenance).toEqual({ provider: 'openai', model: 'qwen' })
      expect(firstAssistant.timing?.completedTime).toBe(Date.parse(T3))
    }
  })

  it('degrades to message flow when requests and traces are empty', () => {
    const snapshot = buildTrajectorySnapshot(session, [], [])

    expect(snapshot.requests).toEqual([])
    expect(snapshot.runningCalls).toEqual([])
    expect(snapshot.eventNodes.length).toBe(6)
    // Tool call heads stay attached from message blocks alone.
    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    if (toolNode?.kind === 'tool-result') {
      expect(toolNode.call?.name).toBe('read')
      expect(toolNode.callTime).toBe(Date.parse(T2))
    }
  })

  it('surfaces running tool spans as in-flight calls', () => {
    const runningTraces: TraceSpan[] = [
      span({
        id: 'span2',
        name: 'tool:read',
        kind: 'tool_call',
        startTime: T1,
        status: 'running',
        data: { tool: 'read', requestId: 'req1' },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, runningTraces)

    expect(snapshot.runningCalls).toHaveLength(1)
    expect(snapshot.runningCalls[0]).toMatchObject({
      callId: 'call_read',
      name: 'read',
      turn: 1,
      step: 0,
      time: Date.parse(T1),
    })
  })

  it('places compaction markers chronologically with between-turn requests', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      compactionBlocks: [
        {
          id: 'cb1',
          summary: 'summarized',
          coveredMessageCount: 3,
          createdAt: T7,
        },
      ],
    })

    const compaction = snapshot.eventNodes.find((node) => node.kind === 'compaction')
    expect(compaction).toBeDefined()
    if (compaction?.kind === 'compaction') {
      expect(compaction.summary).toBe('summarized')
      expect(compaction.shadowedItemCount).toBe(3)
      expect(snapshot.eventLocations.get(compaction.seq)).toEqual({
        kind: 'turn',
        turn: { turn: 2 },
      })
    }

    const compactionRequest = snapshot.requests.find((view) => view.purpose === 'compaction')
    expect(compactionRequest).toBeDefined()
    expect(compactionRequest?.turn).toBeNull()
    expect(compactionRequest?.status).toBe('complete')
    if (compactionRequest?.purpose === 'compaction') {
      // The summary rides on the request so the COMPACTED section can render it.
      expect(compactionRequest.summary).toEqual([{ type: 'text', text: 'summarized' }])
    }

    const seqs = snapshot.eventNodes.map((node) => node.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('reports tool errors from message blocks', () => {
    const failing = baseSession([
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [{ type: 'tool_use', id: 'call_x', name: 'bash', input: { cmd: 'ls' } }],
      }),
      message({
        id: 'tr1',
        role: 'user',
        createdAt: T2,
        content: [{ type: 'tool_result', toolUseId: 'call_x', content: 'boom', isError: true }],
      }),
    ])
    const snapshot = buildTrajectorySnapshot(failing, [], [])
    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    if (toolNode?.kind === 'tool-result') {
      expect(toolNode.isError).toBe(true)
    }
  })

  it('captures evidence pointers from tool_result blocks', () => {
    const evidenced = baseSession([
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [
          {
            type: 'tool_use',
            id: 'call_e',
            name: 'read',
            input: { path: '/a' },
            evidence: {
              kind: 'tool_use_input',
              path: '.artifacts/s1/call_e.in.json',
              chars: 40,
              sha256: 'abcdef0123456789abcdef0123456789',
            },
          },
        ],
      }),
      message({
        id: 'tr1',
        role: 'user',
        createdAt: T2,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_e',
            content: 'file body',
            evidence: {
              kind: 'tool_result_output',
              path: '.artifacts/s1/call_e.out.txt',
              chars: 9001,
              sha256: '1234567890abcdef1234567890abcdef',
            },
          },
        ],
      }),
    ])
    const snapshot = buildTrajectorySnapshot(evidenced, [], [])
    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    if (toolNode?.kind === 'tool-result') {
      // The result-side pointer wins over the input-side one.
      expect(toolNode.evidence).toEqual({
        kind: 'tool_result_output',
        path: '.artifacts/s1/call_e.out.txt',
        chars: 9001,
        sha256: '1234567890abcdef1234567890abcdef',
      })
    }
  })

  it('falls back to the tool_use evidence pointer when the result has none', () => {
    const inputOnly = baseSession([
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [
          {
            type: 'tool_use',
            id: 'call_f',
            name: 'bash',
            input: { cmd: 'ls' },
            evidence: { kind: 'tool_use_input', path: '.artifacts/s1/call_f.in.json', chars: 12 },
          },
        ],
      }),
      message({
        id: 'tr1',
        role: 'user',
        createdAt: T2,
        content: [{ type: 'tool_result', toolUseId: 'call_f', content: 'ok' }],
      }),
    ])
    const snapshot = buildTrajectorySnapshot(inputOnly, [], [])
    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    if (toolNode?.kind === 'tool-result') {
      expect(toolNode.evidence).toEqual({
        kind: 'tool_use_input',
        path: '.artifacts/s1/call_f.in.json',
        chars: 12,
      })
    }
  })

  it('ignores malformed evidence payloads', () => {
    const malformed = baseSession([
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [{ type: 'tool_use', id: 'call_g', name: 'read', input: { path: '/a' } }],
      }),
      message({
        id: 'tr1',
        role: 'user',
        createdAt: T2,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_g',
            content: 'ok',
            evidence: { kind: 'tool_result_output', chars: 'many' },
          },
        ],
      }),
    ])
    const snapshot = buildTrajectorySnapshot(malformed, [], [])
    const toolNode = snapshot.eventNodes.find((node) => node.kind === 'tool-result')
    if (toolNode?.kind === 'tool-result') {
      expect(toolNode.evidence).toBeNull()
    }
  })

  it('attaches the system prompt to the first assistant request', () => {
    const withPrompt: SessionDetail = { ...session, systemPrompt: 'You are ZeRo OS.' }
    const snapshot = buildTrajectorySnapshot(withPrompt, requests, traces)

    const first = snapshot.requests.find((view) => view.purpose === 'assistant')
    expect(first?.purpose).toBe('assistant')
    if (first?.purpose === 'assistant') {
      expect(first.prompt).toEqual({
        config: { provider: 'openai', model: 'qwen' },
        system: 'You are ZeRo OS.',
        tools: [],
      })
      expect(first.promptChange).toMatchObject({ kind: 'initial', seq: -1 })
    }
  })

  it('builds SYSTEM records from context snapshots with tool catalogs', () => {
    const snapshotTraces: TraceSpan[] = [
      span({
        id: 'snap1',
        name: 'snapshot:session_start',
        kind: 'snapshot',
        startTime: T0,
        endTime: T0,
        status: 'success',
        data: {
          snapshot: {
            trigger: 'session_start',
            systemPrompt: 'You are ZeRo OS.',
            tools: ['read', 'write'],
          },
        },
      }),
      span({
        id: 'snap2',
        name: 'snapshot:context_updated',
        kind: 'snapshot',
        startTime: T2,
        endTime: T2,
        status: 'success',
        data: {
          snapshot: {
            trigger: 'context_updated',
            systemPrompt: 'You are ZeRo OS.',
            tools: ['read', 'write'],
          },
        },
      }),
      span({
        id: 'snap3',
        name: 'snapshot:tools_changed',
        kind: 'snapshot',
        startTime: T5,
        endTime: T5,
        status: 'success',
        data: {
          snapshot: {
            trigger: 'tools_changed',
            systemPrompt: 'You are ZeRo OS.',
            tools: ['read', 'write', 'grep'],
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, snapshotTraces)

    const assistantViews = snapshot.requests.filter(
      (view): view is Extract<(typeof snapshot.requests)[number], { purpose: 'assistant' }> =>
        view.purpose === 'assistant',
    )
    // Initial snapshot lands on request 1; the unchanged context_updated
    // snapshot is skipped; tools_changed lands on request 2 with a diff.
    expect(assistantViews[0]?.promptChange).toMatchObject({ kind: 'initial' })
    expect(assistantViews[0]?.prompt?.tools).toEqual([{ name: 'read' }, { name: 'write' }])
    expect(assistantViews[0]?.prompt?.system).toBe('You are ZeRo OS.')

    const change = assistantViews[1]?.promptChange
    expect(change).toMatchObject({ kind: 'tools' })
    expect(assistantViews[1]?.prompt?.tools).toEqual([
      { name: 'read' },
      { name: 'write' },
      { name: 'grep' },
    ])
    if (change?.kind !== undefined && 'previous' in change && change.previous) {
      expect(change.previous.tools).toEqual([{ name: 'read' }, { name: 'write' }])
    }
  })

  it('fills tool catalog definitions from the registry and marks provenance', () => {
    const snapshotTraces: TraceSpan[] = [
      span({
        id: 'snap1',
        name: 'snapshot:session_start',
        kind: 'snapshot',
        startTime: T0,
        endTime: T0,
        status: 'success',
        data: {
          snapshot: {
            trigger: 'session_start',
            systemPrompt: 'You are ZeRo OS.',
            tools: ['read', 'unknown_tool'],
          },
        },
      }),
    ]
    const registry = [
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, snapshotTraces, {
      toolSchemas: registry,
    })

    const assistantView = snapshot.requests.find(
      (view): view is Extract<(typeof snapshot.requests)[number], { purpose: 'assistant' }> =>
        view.purpose === 'assistant',
    )
    expect(assistantView?.prompt?.tools).toEqual([
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        source: 'registry',
      },
      { name: 'unknown_tool' },
    ])
  })

  it('projects gate messages as context and steering records', () => {
    const gated: Message[] = [
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      {
        ...message({
          id: 'c1',
          role: 'user',
          createdAt: T1,
          messageType: 'control',
          content: [
            {
              type: 'text',
              text: '<system_event type="background_tool.completed"> done</system_event>',
            },
          ],
        }),
        controlKind: 'background_tool_completed',
      } as Message,
      {
        ...message({
          id: 'n1',
          role: 'user',
          createdAt: T2,
          messageType: 'notification',
          content: [{ type: 'text', text: '<memory_inject layer="layer2"> hint</memory_inject>' }],
        }),
      },
      {
        ...message({
          id: 'q1',
          role: 'user',
          createdAt: T3,
          messageType: 'queued',
          content: [{ type: 'text', text: 'while you were busy' }],
        }),
      },
    ]
    const snapshot = buildTrajectorySnapshot(baseSession(gated), [], [])

    const contextNodes = snapshot.eventNodes.filter((node) => node.kind === 'context')
    expect(contextNodes).toHaveLength(2)
    const [control, notice] = contextNodes as Extract<
      (typeof snapshot.eventNodes)[number],
      { kind: 'context' }
    >[]
    expect(control.source).toEqual({ kind: 'background tool' })
    expect(control.form).toBe('control')
    expect(notice.source).toEqual({ kind: 'memory' })

    const steering = snapshot.eventNodes.find((node) => node.kind === 'steering')
    expect(steering).toBeDefined()
    if (steering?.kind === 'steering') {
      expect(steering.messageId).toBe('q1')
      expect(steering.source).toEqual({ kind: 'user' })
    }

    for (const node of snapshot.eventNodes) {
      expect(snapshot.eventLocations.get(node.seq)).toBeDefined()
    }
  })

  it('labels task-closure control notices with their gate kind', () => {
    const gated: Message[] = [
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      {
        ...message({
          id: 'c1',
          role: 'user',
          createdAt: T1,
          messageType: 'control',
          content: [{ type: 'text', text: '<system_notice> wrap up the task</system_notice>' }],
        }),
        controlKind: 'task_closure',
      } as Message,
    ]
    const snapshot = buildTrajectorySnapshot(baseSession(gated), [], [])

    const contextNode = snapshot.eventNodes.find((node) => node.kind === 'context')
    expect(contextNode).toMatchObject({ source: { kind: 'task closure' }, form: 'control' })
    // The injected continuation notice entered the agent context, so its badge
    // stays CONTEXT rather than GATEWAY.
    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    const controlCell = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .find((candidate) => candidate.kind === 'context' && candidate.outputDetail === undefined)
    if (controlCell !== undefined) {
      expect(cellBadgeKind(controlCell)).toBe('context')
    }
  })

  it('inserts task-closure gates chronologically with unique seqs', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      taskClosureEvents: [
        {
          ts: T4,
          event: 'task_closure_decision',
          action: 'continue',
          reason: 'still working',
        },
        {
          ts: T7,
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'all done',
        },
        { ts: T7, event: 'task_closure_failed', reason: 'classifier error' },
      ],
    })

    const closures = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'task-closure',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(closures).toHaveLength(3)
    expect(closures.map((node) => node.source)).toEqual([
      { kind: 'task closure', action: 'continue' },
      { kind: 'task closure', action: 'finish' },
      { kind: 'task closure', action: 'failed' },
    ])
    const text = closures[2]?.content[0]
    if (text?.type === 'text') {
      expect(text.text).toBe('task closure failed: classifier error')
    }

    const seqs = snapshot.eventNodes.map((node) => node.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('inserts sub-agent spawns as context records with lifecycle status', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      subAgentEvents: [
        {
          ts: T3,
          agentId: 'agent-1',
          label: 'news-collector',
          model: 'glm-4.7',
          status: 'completed',
          instruction: 'Collect trending AI news.',
        },
        { ts: T6, agentId: 'agent-2', label: 'runner', status: 'errored', instruction: '' },
      ],
    })

    const spawns = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'sub-agent',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(spawns).toHaveLength(2)
    expect(spawns[0]?.source).toMatchObject({
      kind: 'sub-agent',
      agentId: 'agent-1',
      label: 'news-collector',
      status: 'completed',
    })
    const firstText = spawns[0]?.content[0]
    if (firstText?.type === 'text') {
      expect(firstText.text).toContain('sub-agent news-collector (glm-4.7): completed')
      expect(firstText.text).toContain('Collect trending AI news.')
    }
    const secondText = spawns[1]?.content[0]
    if (secondText?.type === 'text') {
      expect(secondText.text).toBe('sub-agent runner: errored')
    }

    const seqs = snapshot.eventNodes.map((node) => node.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
    for (const node of spawns) {
      expect(snapshot.eventLocations.get(node.seq)).toBeDefined()
    }
  })

  it('projects the sub-agent child tool-call trail as payload/result detail', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      subAgentEvents: [
        {
          ts: T3,
          agentId: 'agent-1',
          label: 'researcher',
          model: 'glm-4.7',
          status: 'completed',
          instruction: 'Research the harness effect.',
          durationMs: 133_000,
          output: 'Harness design dominates token economics.',
          childToolCalls: [
            {
              name: 'bash',
              input: { command: 'rg -n harness packages' },
              result: '12 matches',
              durationMs: 2_400,
            },
            {
              name: 'read',
              input: { path: '/a.md' },
              summary: 'paper notes',
              isError: true,
              durationMs: 300,
            },
          ],
        },
      ],
    })

    const spawn = snapshot.eventNodes.find(
      (node) => node.kind === 'context' && node.form === 'sub-agent',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }> | undefined
    expect(spawn).toBeDefined()
    const spawnText = spawn?.content[0]
    if (spawnText?.type === 'text') {
      expect(spawnText.text).toContain('sub-agent researcher (glm-4.7): completed')
      expect(spawnText.text).toContain('· 2 tools · 133,000 ms')
    }

    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    const cell = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .find((candidate) => candidate.kind === 'context' && candidate.inputDetail !== undefined)
    expect(cell).toMatchObject({
      kind: 'context',
      inputDetail: 'Research the harness effect.',
      timeSeconds: 133,
    })
    expect(cell?.outputDetail).toContain('Child tool calls (2)')
    expect(cell?.outputDetail).toContain('- bash: rg -n harness packages · ok · 2,400 ms')
    expect(cell?.outputDetail).toContain('12 matches')
    expect(cell?.outputDetail).toContain('- read: /a.md · error · 300 ms')
    expect(cell?.outputDetail).toContain('paper notes')
    expect(cell?.outputDetail).toContain('Output:\nHarness design dominates token economics.')
    if (cell !== undefined) {
      expect(cellBadgeKind(cell)).toBe('gateway')
    }
  })

  it('inserts span-derived memory nudges and skips control-sourced duplicates', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      memoryNudgeEvents: [
        {
          ts: T2,
          prompt: '当前阶段已完成。请快速评估是否需要保留跨会话记忆。',
          source: 'trace',
          iteration: 3,
          memoryWritten: true,
          status: 'success',
        },
        {
          ts: T5,
          prompt: 'control-paired nudge',
          source: 'control',
          status: 'success',
        },
      ],
    })

    const nudges = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-nudge',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.source).toEqual({ kind: 'memory nudge', memoryWritten: true })
    const text = nudges[0]?.content[0]
    if (text?.type === 'text') {
      expect(text.text).toContain('memory nudge #3 · memory written')
      expect(text.text).toContain('当前阶段已完成')
    }
    const seqs = snapshot.eventNodes.map((node) => node.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('captures the task-closure question/answer pair for tool-style detail', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      taskClosureEvents: [
        {
          ts: T4,
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'all done',
          assistantMessageId: 'a2',
          classifierRequest: { prompt: 'Is the task complete?', maxTokens: 64 },
          classifierResponse: {
            model: 'gpt-5.6-sol',
            content: [{ type: 'text', text: '{"action":"finish","reason":"all done"}' }],
            reasoningContent: '**Weighing completion**',
            usage: { input: 2368, output: 303, cacheRead: 0, reasoning: 221 },
          },
        },
        {
          ts: T7,
          event: 'task_closure_failed',
          reason: 'classifier error',
          classifierRequest: { prompt: 'Is the task complete?' },
          failureStage: 'request_classifier',
          error: 'rate limited',
        },
      ],
    })

    const closures = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'task-closure',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(closures[0]?.content).toEqual([{ type: 'text', text: 'task closure finish: all done' }])
    expect(closures[0]?.gateQa).toEqual({
      question: 'Is the task complete?',
      answer:
        '{"action":"finish","reason":"all done"}\n\nClassifier reasoning:\n**Weighing completion**',
      usage: { input: 2368, output: 303, cacheRead: 0, reasoning: 221 },
    })
    expect(closures[0]?.source).toEqual({
      kind: 'task closure',
      action: 'finish',
      maxTokens: 64,
      model: 'gpt-5.6-sol',
    })

    expect(closures[1]?.content).toEqual([
      { type: 'text', text: 'task closure failed: classifier error' },
    ])
    expect(closures[1]?.gateQa).toEqual({
      question: 'Is the task complete?',
      answer: 'Failure detail:\nstage: request_classifier\nerror: rate limited',
    })
  })

  it('joins task-closure spans for gate timing', () => {
    const closureSpan = span({
      id: 'span-closure',
      name: 'task_closure_decision',
      startTime: T3,
      endTime: T4,
      durationMs: 14000,
      status: 'success',
      data: { closure: { assistantMessageId: 'a2' } },
    })
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, closureSpan], {
      taskClosureEvents: [
        {
          ts: T4,
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'all done',
          assistantMessageId: 'a2',
          classifierRequest: { prompt: 'Is the task complete?' },
          classifierResponse: {
            content: [{ type: 'text', text: '{"action":"finish","reason":"all done"}' }],
            usage: { input: 120, output: 30, reasoning: 6 },
          },
        },
      ],
    })

    const closures = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'task-closure',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(closures[0]?.gateQa).toEqual({
      question: 'Is the task complete?',
      answer: '{"action":"finish","reason":"all done"}',
      startedAt: Date.parse(T3),
      durationMs: Date.parse(T4) - Date.parse(T3),
      usage: { input: 120, output: 30, reasoning: 6 },
    })
  })

  it('projects gate question/answer as tool-style Payload/Result cell detail', () => {
    const closureSpan = span({
      id: 'span-closure',
      name: 'task_closure_decision',
      startTime: T3,
      endTime: T4,
      durationMs: 14000,
      status: 'success',
      data: { closure: { assistantMessageId: 'a2' } },
    })
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, closureSpan], {
      taskClosureEvents: [
        {
          ts: T4,
          event: 'task_closure_decision',
          action: 'finish',
          reason: 'all done',
          assistantMessageId: 'a2',
          classifierRequest: { prompt: 'Is the task complete?', maxTokens: 64 },
          classifierResponse: {
            content: [{ type: 'text', text: '{"action":"finish","reason":"all done"}' }],
            usage: { input: 120, output: 30, reasoning: 6 },
          },
        },
      ],
    })
    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    const cell = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .find((candidate) => candidate.kind === 'context' && candidate.inputDetail !== undefined)
    expect(cell).toMatchObject({
      kind: 'context',
      inputDetail: 'Is the task complete?',
      outputDetail: '{"action":"finish","reason":"all done"}',
      outputBlocks: [{ type: 'text', content: '{"action":"finish","reason":"all done"}' }],
      previewMarkdown: 'task closure finish: all done',
      timeSeconds: (Date.parse(T4) - Date.parse(T3)) / 1000,
      startedAt: Date.parse(T3),
      input: 120,
      output: 30,
      think: 6,
    })
    if (cell !== undefined) {
      expect(cellBadgeKind(cell)).toBe('gateway')
    }
  })

  it('captures the memory nudge question/answer pair with span timing and token usage', () => {
    const prompt = `${'A'.repeat(300)}? ${'B'.repeat(300)}.`
    const mid = '2026-08-24T07:00:13.000Z'
    const nudgeTraces: TraceSpan[] = [
      span({
        id: 'span-nudge',
        name: 'memory_nudge',
        startTime: T3,
        endTime: T4,
        durationMs: 14000,
        status: 'success',
      }),
      span({
        id: 'span-nudge-req1',
        name: 'llm_request',
        startTime: T3,
        endTime: mid,
        status: 'success',
        data: {
          request: {
            model: 'pool/gpt-5.6-sol',
            tokens: { input: 3234, output: 79, cacheRead: 76288, reasoning: 41 },
            response: '',
          },
        },
      }),
      span({
        id: 'span-nudge-req2',
        name: 'llm_request',
        startTime: mid,
        endTime: T4,
        status: 'success',
        data: {
          request: {
            model: 'pool/gpt-5.6-sol',
            tokens: { input: 1359, output: 525, reasoning: 0 },
            response: '已记录 Weekly digest',
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...nudgeTraces], {
      memoryNudgeEvents: [
        {
          ts: T4,
          prompt,
          source: 'trace',
          iteration: 8,
          memoryWritten: true,
          durationMs: 14000,
          status: 'success',
          relatedToolCalls: [
            {
              name: 'memory_search',
              input: { query: 'project conventions' },
              durationMs: 812,
              summary: 'Found 2 notes',
            },
            {
              name: 'memory',
              input: { action: 'create', type: 'note', title: 'Weekly digest' },
              durationMs: 1200,
              isError: true,
            },
          ],
        },
      ],
    })

    const nudges = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-nudge',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(nudges).toHaveLength(1)
    const headline = nudges[0]?.content[0]
    expect(headline?.type).toBe('text')
    if (headline?.type === 'text') {
      expect(headline.text).toContain('memory nudge #8 · memory written · 14,000 ms')
      expect(headline.text).toContain('Recorded note: Weekly digest')
    }
    expect(nudges[0]?.content).toHaveLength(1)
    expect(nudges[0]?.gateQa?.question).toBe(prompt)
    expect(nudges[0]?.gateQa?.answer).toContain('Memory steps (2):')
    expect(nudges[0]?.gateQa?.answer).toContain(
      '- memory_search: project conventions · ok · 812 ms\n  Found 2 notes',
    )
    expect(nudges[0]?.gateQa?.answer).toContain('- memory: Weekly digest · error · 1,200 ms')
    expect(nudges[0]?.gateQa?.answer).toContain('Response:\n已记录 Weekly digest')
    expect(nudges[0]?.gateQa?.startedAt).toBe(Date.parse(T3))
    expect(nudges[0]?.gateQa?.durationMs).toBe(Date.parse(T4) - Date.parse(T3))
    expect(nudges[0]?.gateQa?.usage).toEqual({
      input: 4593,
      output: 604,
      cacheRead: 76288,
      reasoning: 41,
    })
    expect(nudges[0]?.source).toEqual({
      kind: 'memory nudge',
      memoryWritten: true,
      model: 'pool/gpt-5.6-sol',
    })
  })

  it('projects the memory nudge gate as tool-style Payload/Result cell detail', () => {
    const nudgeTraces: TraceSpan[] = [
      span({
        id: 'span-nudge',
        name: 'memory_nudge',
        startTime: T3,
        endTime: T4,
        durationMs: 14000,
        status: 'success',
      }),
      span({
        id: 'span-nudge-req',
        name: 'llm_request',
        startTime: T3,
        endTime: T4,
        status: 'success',
        data: {
          request: {
            model: 'pool/gpt-5.6-sol',
            tokens: { input: 3234, output: 79, reasoning: 41 },
            response: '无需记忆',
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...nudgeTraces], {
      memoryNudgeEvents: [
        {
          ts: T4,
          prompt: 'worth remembering anything?',
          source: 'trace',
          memoryWritten: false,
          durationMs: 14000,
          status: 'success',
        },
      ],
    })

    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    const cell = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .find((candidate) => candidate.kind === 'context' && candidate.inputDetail !== undefined)
    expect(cell).toMatchObject({
      kind: 'context',
      inputDetail: 'worth remembering anything?',
      outputDetail: 'Response:\n无需记忆',
      outputBlocks: [{ type: 'text', content: 'Response:\n无需记忆' }],
      timeSeconds: 14,
      startedAt: Date.parse(T3),
      input: 3234,
      output: 79,
      think: 41,
    })
    if (cell !== undefined) {
      expect(cellBadgeKind(cell)).toBe('gateway')
    }
  })

  it('closes the nudged turn instead of opening the next one', () => {
    // The nudge ran after turn 1's last assistant (T3) and before turn 2's
    // user message (T4), so it must land at the end of turn 1 — not at the
    // top of turn 2 ahead of that turn's user message and assistant.
    const betweenTurns = '2026-08-24T07:00:10.000Z'
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      memoryNudgeEvents: [
        {
          ts: betweenTurns,
          prompt: 'worth remembering anything?',
          source: 'trace',
          memoryWritten: false,
          status: 'success',
        },
      ],
    })

    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2])
    const turnCells = (turnNumber: number) =>
      turns.find((turn) => turn.turn === turnNumber)?.groups.flatMap((group) => group.cells) ?? []
    const turnOneCells = turnCells(1)
    const nudgeCell = turnOneCells.find(
      (cell) => cell.kind === 'context' && cell.inputDetail === 'worth remembering anything?',
    )
    expect(nudgeCell).toBeDefined()
    expect(turnOneCells.at(-1)).toBe(nudgeCell)
    const turnTwoFirst = turnCells(2).find((cell) => cell.kind === 'user')
    expect(turnTwoFirst?.inputDetail).toBe('again')
    expect(turnCells(2).at(0)?.kind).toBe('user')
  })

  it('falls back to the written-state answer when a nudge recorded no output', () => {
    const snapshot = buildTrajectorySnapshot(session, requests, traces, {
      memoryNudgeEvents: [
        { ts: T2, prompt: 'worth remembering anything?', source: 'trace', status: 'success' },
      ],
    })

    const nudges = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-nudge',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(nudges[0]?.gateQa).toEqual({
      question: 'worth remembering anything?',
      answer: 'No recorded output.',
    })
  })

  it('prefers the nudge reply captured on the span over the request fallback', () => {
    const nudgeTraces: TraceSpan[] = [
      span({
        id: 'span-nudge',
        name: 'memory_nudge',
        startTime: T3,
        endTime: T4,
        durationMs: 6000,
        status: 'success',
        data: { memoryNudge: { response: '  本轮无需记录新记忆。 ' } },
      }),
      span({
        id: 'span-nudge-req',
        name: 'llm_request',
        startTime: T3,
        endTime: T4,
        status: 'success',
        data: {
          request: {
            model: 'pool/gpt-5.6-sol',
            tokens: { input: 14373, output: 21, reasoning: 15 },
            response: 'stale request fallback',
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...nudgeTraces], {
      memoryNudgeEvents: [
        {
          ts: T4,
          prompt: 'worth remembering anything?',
          source: 'trace',
          memoryWritten: false,
          durationMs: 6000,
          status: 'success',
        },
      ],
    })

    const nudges = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-nudge',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.gateQa?.answer).toBe('Response:\n本轮无需记录新记忆。')
    expect(nudges[0]?.gateQa?.usage).toEqual({ input: 14373, output: 21, reasoning: 15 })
  })

  it('projects layer-1 memory retrievals with badge, payload, and usage', () => {
    const retrievalTraces: TraceSpan[] = [
      span({
        id: 'span-retrieval-hit',
        name: 'memory_retrieval_decision',
        startTime: T1,
        endTime: T2,
        durationMs: 3000,
        status: 'success',
        metadata: { layer: 'layer1' },
        data: {
          memoryRetrievalDecision: {
            model: 'pool/gpt-5.6-sol',
            prompt: '看看这个帖子',
            response: '',
            need: true,
            queries: ['X 帖子抓取失败怎么办', 'tweet 镜像 API'],
            tokens: { input: 322, output: 46 },
            durationMs: 3000,
            selectedMemories: [
              { id: 'mem_1', type: 'runbook', title: '从X推文提取视频音频', score: 0.7316 },
            ],
          },
        },
      }),
      span({
        id: 'span-retrieval-miss',
        name: 'memory_retrieval_decision',
        startTime: T4,
        endTime: T5,
        durationMs: 2000,
        status: 'success',
        metadata: { layer: 'layer1' },
        data: {
          memoryRetrievalDecision: {
            prompt: '继续',
            need: false,
            queries: [],
            tokens: { input: 210, output: 12 },
            durationMs: 2000,
            selectedMemories: [],
          },
        },
      }),
      span({
        id: 'span-retrieval-layer2',
        name: 'memory_retrieval_decision',
        startTime: T6,
        endTime: T7,
        metadata: { layer: 'layer2', source: 'memory_hint' },
        data: { memoryRetrievalDecision: { prompt: 'tool failed' } },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...retrievalTraces])
    const retrievals = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-retrieval',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(retrievals).toHaveLength(2)

    // Snapshot the answer first: bun's toMatchObject with asymmetric matchers
    // overwrites received properties with the matcher objects.
    const hitAnswer = retrievals[0]?.gateQa?.answer
    expect(retrievals[0]?.gateQa).toMatchObject({
      question: '看看这个帖子',
      startedAt: Date.parse(T1),
      durationMs: 3000,
      usage: { input: 322, output: 46 },
    })
    expect(hitAnswer).toContain('Queries (2):')
    expect(hitAnswer).toContain('X 帖子抓取失败怎么办')
    expect(hitAnswer).toContain(
      'Selected memories (1):\n- 从X推文提取视频音频 · runbook · score 0.73',
    )
    expect(retrievals[0]?.source).toEqual({
      kind: 'memory retrieval',
      injected: true,
      count: 1,
      model: 'pool/gpt-5.6-sol',
    })
    expect(retrievals[1]?.gateQa?.answer).toBe('No memories needed.')
    expect(retrievals[1]?.source).toEqual({
      kind: 'memory retrieval',
      injected: false,
      count: 0,
    })

    const turns = deriveTrajectoryLayout({
      nodes: snapshot.eventNodes,
      eventLocations: snapshot.eventLocations,
      partial: snapshot.partial,
      runningCalls: snapshot.runningCalls,
    })
    const cells = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .filter((cell) => cell.kind === 'context' && cell.inputDetail === '看看这个帖子')
    expect(cells).toHaveLength(1)
    if (cells[0] !== undefined) {
      expect(cellBadgeKind(cells[0])).toBe('context')
    }
    const missCells = turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .filter((cell) => cell.kind === 'context' && cell.inputDetail === '继续')
    if (missCells[0] !== undefined) {
      expect(cellBadgeKind(missCells[0])).toBe('gateway')
    }
  })

  it('renders executed memory searches with candidates and fallback selection', () => {
    const retrievalTraces: TraceSpan[] = [
      span({
        id: 'span-retrieval-searches',
        name: 'memory_retrieval_decision',
        startTime: T1,
        endTime: T2,
        durationMs: 3000,
        status: 'success',
        metadata: { layer: 'layer1' },
        data: {
          memoryRetrievalDecision: {
            prompt: '看看这个帖子',
            need: true,
            queries: ['X 帖子抓取失败怎么办', 'GitHub 401 恢复'],
            searches: [
              {
                query: 'X 帖子抓取失败怎么办',
                mode: 'scored',
                options: { topN: 8, confidenceThreshold: 0.5, minScore: 0.7 },
                resultCount: 1,
                results: [
                  {
                    id: 'mem_1',
                    type: 'runbook',
                    title: '从X推文提取视频音频',
                    contentPreview:
                      '## 场景\n  用户给一条 x.com 推文链接，要提取视频文案、分析内容或下载视频。',
                    score: 0.7316,
                    scoreBreakdown: { keyword: 0, recency: 0.9718, vector: 0.6716 },
                  },
                ],
              },
              {
                query: 'GitHub 401 恢复',
                mode: 'scored',
                options: { topN: 8, confidenceThreshold: 0.5, minScore: 0.7 },
                resultCount: 0,
                results: [],
              },
            ],
            usedFallbackSelection: true,
            selectedMemories: [
              { id: 'mem_1', type: 'runbook', title: '从X推文提取视频音频', score: 0.7316 },
            ],
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...retrievalTraces])
    const retrievals = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-retrieval',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    const answer = retrievals[0]?.gateQa?.answer ?? ''
    expect(answer).toContain('Memory searches (2):')
    expect(answer).toContain('- X 帖子抓取失败怎么办 · scored · 1 result · topN 8 · minScore 0.70')
    expect(answer).toContain(
      '  - 从X推文提取视频音频 · runbook · score 0.73 · vector 0.67 · recency 0.97 · keyword 0.00',
    )
    expect(answer).toContain(
      '    ## 场景 用户给一条 x.com 推文链接，要提取视频文案、分析内容或下载视频。',
    )
    expect(answer).toContain('- GitHub 401 恢复 · scored · 0 results · topN 8 · minScore 0.70')
    expect(answer).toContain('Selected memories (1) · fallback selection:')
    expect(answer).not.toContain('Queries (2):')
  })

  it('pairs the retrieval side-loop instruction with the trigger message in the payload', () => {
    const retrievalTraces: TraceSpan[] = [
      span({
        id: 'span-retrieval-sys',
        name: 'memory_retrieval_decision',
        startTime: T1,
        endTime: T2,
        durationMs: 2500,
        status: 'success',
        metadata: { layer: 'layer1' },
        data: {
          memoryRetrievalDecision: {
            system: '判定是否需要检索记忆，需要则生成查询。',
            prompt: '继续',
            need: false,
            queries: [],
            tokens: { input: 210, output: 12 },
            selectedMemories: [],
          },
        },
      }),
    ]
    const snapshot = buildTrajectorySnapshot(session, requests, [...traces, ...retrievalTraces])
    const retrievals = snapshot.eventNodes.filter(
      (node) => node.kind === 'context' && node.form === 'memory-retrieval',
    ) as Extract<(typeof snapshot.eventNodes)[number], { kind: 'context' }>[]
    expect(retrievals).toHaveLength(1)
    expect(retrievals[0]?.gateQa?.question).toBe('判定是否需要检索记忆，需要则生成查询。\n\n继续')
  })

  it('uses request turnIndex and parentId for assistant locations', () => {
    const flow = [
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [{ type: 'text', text: 'one' }],
      }),
      message({
        id: 'a2',
        role: 'assistant',
        createdAt: T2,
        content: [{ type: 'text', text: 'two' }],
      }),
    ]
    const requestFlow = [
      request({ id: 'r1', ts: T1, turnIndex: 7 }),
      request({ id: 'r2', ts: T2, turnIndex: 7, parentId: 'r1' }),
    ]
    const snapshot = buildTrajectorySnapshot(baseSession(flow), requestFlow, [])
    const assistants = snapshot.eventNodes.filter((node) => node.kind === 'assistant')

    expect(assistants.map((node) => ({ turn: node.turn, step: node.step }))).toEqual([
      { turn: 7, step: 0 },
      { turn: 7, step: 1 },
    ])
    expect(snapshot.requests.map((view) => ({ turn: view.turn, step: view.step }))).toEqual([
      { turn: 7, step: 0 },
      { turn: 7, step: 1 },
    ])
  })

  it('reads nested tool spans by toolUseId and fills per-call schemas', () => {
    const flow = [
      message({ id: 'u1', role: 'user', createdAt: T0, content: [{ type: 'text', text: 'go' }] }),
      message({
        id: 'a1',
        role: 'assistant',
        createdAt: T1,
        content: [
          { type: 'tool_use', id: 'call_a', name: 'read', input: { path: '/a' } },
          { type: 'tool_use', id: 'call_b', name: 'bash', input: { command: 'pwd' } },
        ],
      }),
      message({
        id: 'tr1',
        role: 'user',
        createdAt: T4,
        content: [
          { type: 'tool_result', toolUseId: 'call_a', content: 'a' },
          { type: 'tool_result', toolUseId: 'call_b', content: 'b' },
        ],
      }),
    ]
    const requestFlow = [
      request({
        id: 'r1',
        ts: T4,
        turnIndex: 3,
        toolCalls: [
          { id: 'call_a', name: 'read', input: { path: '/a' } },
          { id: 'call_b', name: 'bash', input: { command: 'pwd' } },
        ],
      }),
    ]
    const nested = span({
      id: 'root',
      name: 'llm',
      kind: 'llm_request',
      children: [
        span({
          id: 'span-b',
          name: 'tool:bash',
          kind: 'tool_call',
          startTime: T2,
          endTime: T3,
          data: { requestId: 'r1' },
          metadata: { toolUseId: 'call_b' },
        }),
        span({
          id: 'span-a',
          name: 'tool:read',
          kind: 'tool_call',
          startTime: T1,
          endTime: T2,
          data: { requestId: 'r1' },
          metadata: { toolUseId: 'call_a' },
        }),
      ],
    })
    const snapshot = buildTrajectorySnapshot(baseSession(flow), requestFlow, [nested], {
      toolSchemas: [
        { name: 'read', parameters: { type: 'object' } },
        { name: 'bash', parameters: { type: 'object' } },
      ],
    })
    const results = snapshot.eventNodes.filter((node) => node.kind === 'tool-result')
    const byCall = new Map(results.map((node) => [node.callId, node]))

    expect(byCall.get('call_a')?.callTime).toBe(Date.parse(T1))
    expect(byCall.get('call_b')?.callTime).toBe(Date.parse(T2))
    expect(snapshot.callSchemas.get('call_a')?.name).toBe('read')
    expect(snapshot.callSchemas.get('call_b')?.name).toBe('bash')
  })

  it('matches nested compaction spans through the persisted block id', () => {
    const block = { id: 'block-1', summary: 'summary', coveredMessageCount: 2, createdAt: T4 }
    const compactSpan = span({
      id: 'root',
      name: 'turn',
      kind: 'turn',
      children: [
        span({
          id: 'compact',
          name: 'timeline_compaction_block',
          kind: 'context_compaction',
          startTime: T2,
          endTime: T3,
          data: { compaction: { blockId: 'block-1' } },
          metadata: { blockId: 'block-1' },
        }),
      ],
    })
    const snapshot = buildTrajectorySnapshot(session, requests, [compactSpan], {
      compactionBlocks: [block],
    })
    const compactRequest = snapshot.requests.find((view) => view.purpose === 'compaction')

    expect(compactRequest?.startedAt).toBe(Date.parse(T2))
    expect(compactRequest?.completedAt).toBe(Date.parse(T3))
  })
})
