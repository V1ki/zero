import { describe, expect, test } from 'bun:test'
import { generateId, now } from '@zero-os/shared'
import type { ContentBlock, Message } from '@zero-os/shared'
import { prepareRequestMessages } from '../compaction'
import {
  estimateConversationTokens,
  extractRetainedHandles,
  mergeInterleavedQueuedMessages,
  sanitizeConversationHistoryForSignedThinkingToolUse,
} from '../context'

function makeMessage(role: 'user' | 'assistant', content: ContentBlock[]): Message {
  return {
    id: generateId(),
    sessionId: 'test-session',
    role,
    messageType: 'message',
    content,
    createdAt: now(),
  }
}

function makeUserText(text: string): Message {
  return makeMessage('user', [{ type: 'text', text }])
}

function makeToolResult(toolUseId: string, output: string, isError = false): Message {
  return makeMessage('user', [{ type: 'tool_result', toolUseId, content: output, isError }])
}

function makeAssistantText(text: string): Message {
  return makeMessage('assistant', [{ type: 'text', text }])
}

function makeQueuedUserText(text: string): Message {
  return {
    ...makeMessage('user', [{ type: 'text', text }]),
    messageType: 'queued',
  }
}

function makeNotificationUserText(text: string): Message {
  return {
    ...makeMessage('user', [{ type: 'text', text }]),
    messageType: 'notification',
  }
}

function makeBackgroundToolCompletedControl(text: string): Message {
  return {
    ...makeMessage('user', [{ type: 'text', text }]),
    messageType: 'control',
    controlKind: 'background_tool_completed',
  }
}

function makeAssistantToolUse(name: string, toolUseId: string): Message {
  return makeMessage('assistant', [
    { type: 'text', text: 'Using tool...' },
    { type: 'tool_use', id: toolUseId, name, input: {} },
  ])
}

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('sanitizeConversationHistoryForSignedThinkingToolUse', () => {
  test('sanitizeConversationHistoryForSignedThinkingToolUse preserves valid thinking tool turns', () => {
    const messages = [
      makeUserText('run tool'),
      makeMessage('assistant', [
        { type: 'thinking', thinking: 'Need a tool.', signature: 'sig_1' },
        { type: 'tool_use', id: 'call_with_thinking', name: 'noop', input: {} },
      ]),
      makeToolResult('call_with_thinking', 'tool output'),
    ]

    expect(sanitizeConversationHistoryForSignedThinkingToolUse(messages)).toBe(messages)
  })

  test('sanitizeConversationHistoryForSignedThinkingToolUse preserves signature-only thinking turns', () => {
    const messages = [
      makeUserText('run tool'),
      makeMessage('assistant', [
        { type: 'thinking', thinking: '', signature: 'sig_1' },
        { type: 'tool_use', id: 'call_with_empty_thinking', name: 'noop', input: {} },
      ]),
      makeToolResult('call_with_empty_thinking', 'tool output'),
    ]

    expect(sanitizeConversationHistoryForSignedThinkingToolUse(messages)).toBe(messages)
  })

  test('drops signature-less thinking tool turns when thinking replay requires signatures', () => {
    const messages = [
      makeUserText('run tool'),
      makeMessage('assistant', [
        { type: 'thinking', thinking: 'Need a tool.' },
        { type: 'text', text: 'I will call the tool.' },
        { type: 'tool_use', id: 'call_without_signature', name: 'noop', input: {} },
      ]),
      makeToolResult('call_without_signature', 'tool output'),
    ]

    const result = sanitizeConversationHistoryForSignedThinkingToolUse(messages)

    expect(result).toHaveLength(2)
    expect(result[1].content).toEqual([{ type: 'text', text: 'I will call the tool.' }])
  })
})

describe('extractRetainedHandles', () => {
  test('extracts exact paths and URLs from tool output', () => {
    const artifactPath = '/Users/v1ki/Desktop/test4_zero/.zero/workspace/shared/video_v4.mp4'
    const handles = extractRetainedHandles(
      `render ok, artifact written to ${artifactPath}, manifest https://example.com/run/0/manifest.json tail noise`,
    )

    expect(handles).toContain(artifactPath)
    expect(handles).toContain('https://example.com/run/0/manifest.json')
  })
})

describe('prepareRequestMessages without a checkpoint', () => {
  test('returns empty array for empty input', () => {
    const result = prepareRequestMessages([], undefined, { requireThinkingForToolUse: false })
    expect(result).toEqual([])
  })

  test('drops invalid tool_use turns when thinking is required', () => {
    const messages = [
      makeUserText('run tool'),
      makeMessage('assistant', [
        { type: 'text', text: 'I will call the tool.' },
        { type: 'tool_use', id: 'call_missing_thinking', name: 'noop', input: {} },
      ]),
      makeToolResult('call_missing_thinking', 'tool output'),
      makeUserText('continue'),
    ]

    const result = prepareRequestMessages(messages, undefined, { requireThinkingForToolUse: true })

    expect(result).toHaveLength(3)
    expect(result[1].content).toEqual([{ type: 'text', text: 'I will call the tool.' }])
    expect(
      result.some((message) => message.content.some((block) => block.type === 'tool_result')),
    ).toBe(false)
    expect(result.at(-1)?.content).toEqual([{ type: 'text', text: 'continue' }])
  })

  test('keeps non-thinking tool_use turns when thinking is not required', () => {
    const messages = [
      makeUserText('run tool'),
      makeMessage('assistant', [
        { type: 'text', text: 'I will call the tool.' },
        { type: 'tool_use', id: 'call_no_thinking', name: 'noop', input: {} },
      ]),
      makeToolResult('call_no_thinking', 'tool output'),
    ]

    const result = prepareRequestMessages(messages, undefined, { requireThinkingForToolUse: false })

    expect(result).toHaveLength(3)
    expect(result[1].content.some((block) => block.type === 'tool_use')).toBe(true)
    expect(result[2].content.some((block) => block.type === 'tool_result')).toBe(true)
  })

  test('excludes notification messages from prompt history', () => {
    const notification = makeNotificationUserText(
      '<memory_inject layer="layer1">hint</memory_inject>',
    )
    const result = prepareRequestMessages(
      [makeUserText('first question'), notification, makeAssistantText('first reply')],
      undefined,
      { requireThinkingForToolUse: false },
    )

    expect(result).toHaveLength(2)
    expect(result.some((message) => message.messageType === 'notification')).toBe(false)
  })

  test('queued messages between tool_use and tool_result are merged before API call', () => {
    // Reproduces the exact bug: sess_20260318_1452_fei_adaa
    const messages = [
      makeUserText('fix issues'),
      makeAssistantToolUse('bash', 'toolu_01MGFBSJfmWFTmKqy8Zd1oyJ'),
      makeQueuedUserText('表格不要替换成列表'),
      makeToolResult('toolu_01MGFBSJfmWFTmKqy8Zd1oyJ', 'All 4 tasks completed'),
      makeAssistantText('done'),
    ]

    const result = prepareRequestMessages(messages, undefined, { requireThinkingForToolUse: false })

    // The queued message should NOT appear as standalone
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === 'assistant' && result[i].content.some((b) => b.type === 'tool_use')) {
        // Next message must contain tool_result
        const next = result[i + 1]
        expect(next).toBeDefined()
        expect(next.role).toBe('user')
        expect(next.content.some((b) => b.type === 'tool_result')).toBe(true)
      }
    }
  })

  test('background completion controls between tool_use and tool_result are merged before API call', () => {
    const messages = [
      makeUserText('run long command'),
      makeAssistantToolUse('bash', 'toolu_long'),
      makeBackgroundToolCompletedControl(
        '<system_event type="background_tool.completed"><background_task status="success" /></system_event>',
      ),
      makeToolResult('toolu_long', 'Background task started'),
      makeUserText('现在处理得怎么样了'),
    ]

    const result = prepareRequestMessages(messages, undefined, { requireThinkingForToolUse: false })
    const toolUseIndex = result.findIndex(
      (message) =>
        message.role === 'assistant' && message.content.some((b) => b.type === 'tool_use'),
    )
    const next = result[toolUseIndex + 1]

    expect(next).toBeDefined()
    expect(next.role).toBe('user')
    expect(next.content.some((b) => b.type === 'tool_result')).toBe(true)
    expect(result.some((message) => message.controlKind === 'background_tool_completed')).toBe(
      false,
    )
  })
})

/**
 * 提供方要求:每条带 tool_use 的 assistant 消息后面紧跟带全部对应 tool_result 的 user 消息,
 * 每个 tool_result 都指向上一条消息里的 tool_use;要求签名 thinking 时不能有无签名的 tool_use。
 */
function expectProviderValid(messages: Message[], requireThinkingForToolUse: boolean): void {
  messages.forEach((message, index) => {
    const uses = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
    const results = message.content.flatMap((block) =>
      block.type === 'tool_result' ? [block.toolUseId] : [],
    )
    if (uses.length > 0) {
      const next = messages[index + 1]
      expect(next?.role).toBe('user')
      const nextResults = new Set(
        next?.content.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : [])),
      )
      for (const id of uses) expect(nextResults.has(id)).toBe(true)
      if (requireThinkingForToolUse) {
        expect(
          message.content.some((block) => block.type === 'thinking' && Boolean(block.signature)),
        ).toBe(true)
      }
    }
    if (results.length > 0) {
      const previousUses = new Set(
        messages[index - 1]?.content.flatMap((block) =>
          block.type === 'tool_use' ? [block.id] : [],
        ),
      )
      for (const id of results) expect(previousUses.has(id)).toBe(true)
    }
  })
}

function makeSignedToolUse(...toolUseIds: string[]): Message {
  return makeMessage('assistant', [
    { type: 'thinking', thinking: 'Need tools.', signature: 'sig' },
    ...toolUseIds.map((id) => ({ type: 'tool_use' as const, id, name: 'bash', input: {} })),
  ])
}

function makeToolResults(...toolUseIds: string[]): Message {
  return makeMessage(
    'user',
    toolUseIds.map((toolUseId) => ({ type: 'tool_result', toolUseId, content: 'ok' })),
  )
}

// 恢复不再重排 canonical(docs/session-log-replay.md 步骤 4):原来恢复时修复的形状,请求组装都要给出合法的请求
describe('prepareRequestMessages on tool calls interleaved with queued and control messages', () => {
  const shapes: Array<[string, () => Message[]]> = [
    [
      'one queued message',
      () => [
        makeUserText('start'),
        makeSignedToolUse('t1'),
        makeQueuedUserText('queued while running'),
        makeToolResults('t1'),
        makeAssistantText('done'),
      ],
    ],
    [
      'one background completion control',
      () => [
        makeUserText('start'),
        makeSignedToolUse('t1'),
        makeBackgroundToolCompletedControl('<system_event type="background_tool.completed" />'),
        makeToolResults('t1'),
      ],
    ],
    [
      'several interleaved messages, a recalled one among them',
      () => [
        makeUserText('start'),
        makeSignedToolUse('t1'),
        makeQueuedUserText('first queued'),
        makeNotificationUserText('用户已撤回这条消息。'),
        makeBackgroundToolCompletedControl('<system_event type="background_tool.completed" />'),
        makeQueuedUserText('second queued'),
        makeToolResults('t1'),
        makeAssistantText('done'),
      ],
    ],
    [
      'parallel tool calls',
      () => [
        makeUserText('start'),
        makeSignedToolUse('t1', 't2', 't3'),
        makeQueuedUserText('queued while running'),
        makeBackgroundToolCompletedControl('<system_event type="background_tool.completed" />'),
        makeToolResults('t1', 't2', 't3'),
        makeSignedToolUse('t4'),
        makeQueuedUserText('queued again'),
        makeToolResults('t4'),
        makeAssistantText('done'),
      ],
    ],
    [
      'unsigned tool calls next to signed ones',
      () => [
        makeUserText('start'),
        makeAssistantToolUse('bash', 'unsigned_1'),
        makeQueuedUserText('queued during the unsigned call'),
        makeToolResult('unsigned_1', 'ok'),
        makeSignedToolUse('t1', 't2'),
        makeQueuedUserText('queued during the signed calls'),
        makeToolResults('t1', 't2'),
        makeAssistantText('done'),
      ],
    ],
  ]

  for (const [name, build] of shapes) {
    for (const requireThinkingForToolUse of [false, true]) {
      test(`${name} (requireThinkingForToolUse: ${requireThinkingForToolUse})`, () => {
        const messages = build()
        const before = structuredClone(messages)

        const result = prepareRequestMessages(messages, undefined, { requireThinkingForToolUse })

        expectProviderValid(result, requireThinkingForToolUse)
        // 排队与控制消息的原文都还在请求里,canonical 原样不动
        const sent = JSON.stringify(result)
        for (const message of messages) {
          if (message.messageType !== 'queued' && message.messageType !== 'control') continue
          for (const block of message.content) {
            if (block.type === 'text') expect(sent).toContain(JSON.stringify(block.text))
          }
        }
        expect(messages).toEqual(before)
      })
    }
  }
})

describe('mergeInterleavedQueuedMessages', () => {
  test('returns same messages when no queued messages present', () => {
    const messages = [
      makeUserText('hello'),
      makeAssistantToolUse('bash', 'tool-1'),
      makeToolResult('tool-1', 'ok'),
      makeAssistantText('done'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)
    expect(result).toBe(messages) // same reference, no copy needed
  })

  test('merges queued message between tool_use and tool_result', () => {
    const messages = [
      makeUserText('do something'),
      makeAssistantToolUse('bash', 'toolu_abc'),
      makeQueuedUserText('additional constraint from user'),
      makeToolResult('toolu_abc', 'task completed'),
      makeAssistantText('done'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)

    // Queued message should be removed as standalone
    expect(result.length).toBe(4)
    // Message order: user, assistant(tool_use), user(tool_result + queued text), assistant
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
    expect(result[2].role).toBe('user')
    expect(result[3].role).toBe('assistant')

    // tool_result message should contain both tool_result AND queued text blocks
    const toolResultMsg = result[2]
    const types = toolResultMsg.content.map((b) => b.type)
    expect(types).toContain('tool_result')
    expect(types).toContain('text')

    // Queued text content should be present
    const textBlock = toolResultMsg.content.find(
      (b) => b.type === 'text' && (b as { text: string }).text.includes('additional constraint'),
    )
    expect(textBlock).toBeDefined()
  })

  test('merges background completion control between tool_use and tool_result', () => {
    const messages = [
      makeUserText('start watchdog'),
      makeAssistantToolUse('bash', 'toolu_background'),
      makeBackgroundToolCompletedControl(
        '<system_event type="background_tool.completed"><background_task status="success" /></system_event>',
      ),
      makeToolResult('toolu_background', 'Background task started'),
      makeAssistantText('done'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)

    expect(result.length).toBe(4)
    const toolResultMsg = result[2]
    expect(toolResultMsg.role).toBe('user')
    expect(toolResultMsg.content.some((b) => b.type === 'tool_result')).toBe(true)
    expect(
      toolResultMsg.content.some(
        (b) =>
          b.type === 'text' && (b as { text: string }).text.includes('background_tool.completed'),
      ),
    ).toBe(true)
  })

  test('merges multiple queued messages between tool_use and tool_result', () => {
    const messages = [
      makeUserText('start'),
      makeAssistantToolUse('bash', 'toolu_1'),
      makeQueuedUserText('first queued'),
      makeQueuedUserText('second queued'),
      makeToolResult('toolu_1', 'result'),
      makeAssistantText('end'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)

    expect(result.length).toBe(4)
    // Both queued messages should be merged into the tool_result
    const toolResultMsg = result[2]
    const textBlocks = toolResultMsg.content.filter((b) => b.type === 'text')
    expect(textBlocks.length).toBe(2)
  })

  test('does not merge queued messages that are not between tool_use/tool_result', () => {
    const messages = [
      makeUserText('turn 1'),
      makeAssistantToolUse('bash', 'tool-1'),
      makeToolResult('tool-1', 'ok'),
      makeAssistantText('reply 1'),
      makeQueuedUserText('late follow-up'), // NOT between tool_use and tool_result
      makeAssistantText('queued ack'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)

    // No merge should happen — queued message stays as-is
    expect(result).toBe(messages)
  })

  test('does not modify original messages array', () => {
    const messages = [
      makeUserText('start'),
      makeAssistantToolUse('bash', 'toolu_1'),
      makeQueuedUserText('queued'),
      makeToolResult('toolu_1', 'result'),
    ]
    const originalLength = messages.length
    const originalContent = messages[3].content.length

    mergeInterleavedQueuedMessages(messages)

    expect(messages.length).toBe(originalLength)
    expect(messages[3].content.length).toBe(originalContent)
  })

  test('handles fewer than 3 messages', () => {
    const messages = [makeUserText('hi'), makeAssistantText('hello')]
    const result = mergeInterleavedQueuedMessages(messages)
    expect(result).toBe(messages)
  })

  test('handles multiple tool_use/queued/tool_result groups in same conversation', () => {
    const messages = [
      makeUserText('start'),
      // First tool cycle with queued
      makeAssistantToolUse('bash', 'tool-1'),
      makeQueuedUserText('queued during tool-1'),
      makeToolResult('tool-1', 'result-1'),
      // Second tool cycle with queued
      makeAssistantToolUse('bash', 'tool-2'),
      makeQueuedUserText('queued during tool-2'),
      makeToolResult('tool-2', 'result-2'),
      makeAssistantText('all done'),
    ]
    const result = mergeInterleavedQueuedMessages(messages)

    // Both queued messages should be merged
    expect(result.length).toBe(6) // 8 - 2 queued = 6
    // Both tool_result messages should have merged text blocks
    const tr1 = result[2]
    expect(tr1.content.some((b) => b.type === 'text')).toBe(true)
    expect(tr1.content.some((b) => b.type === 'tool_result')).toBe(true)
    const tr2 = result[4]
    expect(tr2.content.some((b) => b.type === 'text')).toBe(true)
    expect(tr2.content.some((b) => b.type === 'tool_result')).toBe(true)
  })
})

describe('estimateConversationTokens', () => {
  test('returns 0 for empty messages', () => {
    expect(estimateConversationTokens([])).toBe(0)
  })

  test('returns positive number for non-empty messages', () => {
    const messages = [
      makeUserText('Hello, how are you?'),
      makeAssistantText('I am fine, thank you!'),
    ]
    const tokens = estimateConversationTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  test('includes per-message overhead', () => {
    const single = [makeUserText('Hi')]
    const double = [makeUserText('Hi'), makeAssistantText('Hi')]

    const singleTokens = estimateConversationTokens(single)
    const doubleTokens = estimateConversationTokens(double)

    // The second message adds content tokens + 4 overhead
    expect(doubleTokens).toBeGreaterThan(singleTokens)
    // Overhead difference should be at least 4 (per-message overhead)
    expect(doubleTokens - singleTokens).toBeGreaterThanOrEqual(4)
  })

  test('counts tool_result content tokens', () => {
    const shortResult = [makeToolResult('t1', 'ok')]
    const longResult = [makeToolResult('t1', 'x'.repeat(1000))]

    const shortTokens = estimateConversationTokens(shortResult)
    const longTokens = estimateConversationTokens(longResult)

    expect(longTokens).toBeGreaterThan(shortTokens)
  })

  test('counts structured images attached to tool_result blocks', () => {
    const withoutImage = [makeToolResult('t1', 'ok')]
    const withImage = [makeToolResult('t1', 'ok')]
    const block = expectDefined(withImage[0].content.find((b) => b.type === 'tool_result'))
    block.contentItems = [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }]

    expect(estimateConversationTokens(withImage)).toBeGreaterThan(
      estimateConversationTokens(withoutImage),
    )
  })
})
