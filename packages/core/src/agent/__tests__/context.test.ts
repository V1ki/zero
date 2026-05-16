import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateId, now } from '@zero-os/shared'
import type { ContentBlock, Message, TimelineCompactionBlock } from '@zero-os/shared'
import {
  type ContextCompactionModelInput,
  type EpisodeCompactionTraceEvent,
  estimateConversationTokens,
  mergeInterleavedQueuedMessages,
  prepareConversationHistory,
  prepareConversationHistoryWithCompaction,
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

function makeAssistantToolUse(name: string, toolUseId: string): Message {
  return makeMessage('assistant', [
    { type: 'text', text: 'Using tool...' },
    { type: 'tool_use', id: toolUseId, name, input: {} },
  ])
}

function makeAssistantToolUseWithInput(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
): Message {
  return makeMessage('assistant', [
    { type: 'text', text: `Using ${name}...` },
    { type: 'tool_use', id: toolUseId, name, input },
  ])
}

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

function semanticCompactor(label = 'semantic compact') {
  return async (input: ContextCompactionModelInput) => ({
    summary: `${label}: ${input.episode.goal}`,
    confirmedFacts: [
      `covered ${input.segment.length} messages`,
      ...input.episode.confirmedFacts.slice(0, 2),
    ],
    userConstraints: ['preserve raw evidence through manifest paths'],
    decisions: ['create immutable semantic compact block'],
    currentState: [`current_goal=${input.currentGoal}`],
    openQuestions: input.episode.blockers,
    nextActions: ['continue from retained recent messages'],
    doNotInfer: ['do not treat raw tool IO capture as business confirmation'],
    keyEvidence: input.episode.evidence
      .slice(0, 2)
      .map((item) => `${item.toolName}:${item.toolUseId} path=${item.path}`),
  })
}

/**
 * Build a conversation with N turns.
 * Each turn consists of:
 *   1. User text message (turn boundary)
 *   2. Assistant tool_use message
 *   3. User tool_result message
 *   4. Assistant text reply
 */
function buildConversation(turnCount: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < turnCount; i++) {
    const toolId = `tool-${i}`
    messages.push(makeUserText(`User question for turn ${i}`))
    messages.push(makeAssistantToolUse('bash', toolId))
    messages.push(
      makeToolResult(toolId, `Full output of tool execution for turn ${i}. `.repeat(20), false),
    )
    messages.push(makeAssistantText(`Response for turn ${i}`))
  }
  return messages
}

function buildLongToolConversation(sessionId = 'sess_20260512_1006_fei_8161_fixture'): Message[] {
  const toolSpecs: Array<{
    name: string
    input: Record<string, unknown>
    output: string
    summary: string
  }> = [
    {
      name: 'read',
      input: { path: '/repo/packages/core/src/agent/agent-loop.ts', offset: 1, limit: 120 },
      output: `AGENT_LOOP_RAW_${'read evidence '.repeat(900)}`,
      summary: 'Read AgentLoop tool loop and request construction.',
    },
    {
      name: 'write',
      input: { path: '/repo/tmp/design.md', content: 'design content '.repeat(500) },
      output: 'Wrote /repo/tmp/design.md',
      summary: 'Wrote design note.',
    },
    {
      name: 'edit',
      input: {
        path: '/repo/packages/core/src/agent/context.ts',
        old_string: 'old behavior '.repeat(200),
        new_string: 'new behavior '.repeat(200),
      },
      output: 'Edited /repo/packages/core/src/agent/context.ts',
      summary: 'Edited context preparation.',
    },
    {
      name: 'bash',
      input: {
        command: 'rg "tool_result" packages/core/src',
        description: 'scan tool_result flow',
      },
      output: `BASH_RAW_${'tool_result line\n'.repeat(800)}`,
      summary: 'Scanned tool_result flow.',
    },
    {
      name: 'memory_search',
      input: { query: 'episode compaction boundaries', topN: 5 },
      output: 'Found memory entries about working-state compaction.',
      summary: 'Found relevant memories.',
    },
    {
      name: 'memory_read',
      input: { path: '/Users/v1ki/.codex/memories/MEMORY.md' },
      output: `MEMORY_RAW_${'working state compaction '.repeat(500)}`,
      summary: 'Read memory guidance.',
    },
  ]
  const messages: Message[] = []

  for (let index = 0; index < toolSpecs.length; index++) {
    const spec = toolSpecs[index]
    const toolId = `fixture_tool_${index}_${spec.name}`
    messages.push({
      ...makeUserText(`Investigate subproblem ${index}: ${spec.name}`),
      sessionId,
    })
    messages.push({
      ...makeAssistantToolUseWithInput(spec.name, toolId, spec.input),
      sessionId,
    })
    messages.push({
      ...makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: spec.output,
          outputSummary: spec.summary,
        },
      ]),
      sessionId,
    })
    messages.push({
      ...makeAssistantText(`Confirmed ${spec.summary}`),
      sessionId,
    })
  }

  messages.push({ ...makeUserText('Current task: finish the implementation safely'), sessionId })
  messages.push({
    ...makeAssistantToolUseWithInput('bash', 'fixture_recent_bash', {
      command: 'bun test packages/core/src/agent/__tests__/context.test.ts',
    }),
    sessionId,
  })
  messages.push({
    ...makeToolResult('fixture_recent_bash', `RECENT_RAW_${'keep full '.repeat(500)}`),
    sessionId,
  })
  messages.push({ ...makeAssistantText('Still working on current task.'), sessionId })

  return messages
}

describe('prepareConversationHistory', () => {
  test('returns empty array for empty input', () => {
    const result = prepareConversationHistory([])
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

    const result = prepareConversationHistory(messages, { requireThinkingForToolUse: true })

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

    const result = prepareConversationHistory(messages)

    expect(result).toHaveLength(3)
    expect(result[1].content.some((block) => block.type === 'tool_use')).toBe(true)
    expect(result[2].content.some((block) => block.type === 'tool_result')).toBe(true)
  })

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

  test('does not treat notification messages as top-level turns', () => {
    const messages: Message[] = [
      makeUserText('first question'),
      makeAssistantToolUse('fetch', 'tool-1'),
      makeToolResult('tool-1', 'tool output'),
      makeNotificationUserText('<memory_hint>domain specific hint</memory_hint>'),
      makeAssistantText('first reply'),
      makeUserText('second question'),
      makeAssistantText('second reply'),
    ]

    const result = prepareConversationHistory(messages)
    const toolResult = expectDefined(
      result[2].content.find((block) => block.type === 'tool_result'),
    )
    expect(toolResult.truncationLevel).toBe('full')
  })

  test('excludes notification messages from prompt history', () => {
    const notification = makeNotificationUserText(
      '<memory_inject layer="layer1">hint</memory_inject>',
    )
    const result = prepareConversationHistory([
      makeUserText('first question'),
      notification,
      makeAssistantText('first reply'),
    ])

    expect(result).toHaveLength(2)
    expect(result.some((message) => message.messageType === 'notification')).toBe(false)
  })

  test('mutates tool_result blocks in place to persist truncation levels', () => {
    const messages = buildConversation(6)
    const oldestToolResult = expectDefined(
      messages[2].content.find((b) => b.type === 'tool_result'),
    )
    const newestToolResult = expectDefined(
      messages[messages.length - 2].content.find((b) => b.type === 'tool_result'),
    )

    const result = prepareConversationHistory(messages)

    expect(result).not.toBe(messages)
    expect(oldestToolResult.truncationLevel).toBe('summary')
    expect(oldestToolResult.content.length).toBeLessThanOrEqual(210)
    expect(newestToolResult.truncationLevel).toBe('full')
  })

  test('preserves full tool output for turns 0-3 (most recent)', () => {
    const messages = buildConversation(4)
    const result = prepareConversationHistory(messages)

    // All 4 turns are within age 0-3, so all tool_results should be preserved
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            expect(block.content).toBe(
              expectDefined(messages[i].content.find((b) => b.type === 'tool_result')).content,
            )
          }
        }
      }
    }
  })

  test('truncates tool output to ~200 chars for turns 4-8', () => {
    // 12 turns: turns 0-3 = full, 4-8 = truncated, 9-11 = status only
    // Turn numbering is from the end, so the oldest turns get the highest age.
    const messages = buildConversation(12)
    const result = prepareConversationHistory(messages)

    // Turn 5 (age 6 from end) should be truncated.
    // In a 12-turn conversation, turn indices from end:
    //   chronological turn 0 => age 11 (status only)
    //   chronological turn 3 => age 8 (truncated)
    //   chronological turn 7 => age 4 (truncated)
    //   chronological turn 8 => age 3 (full)

    // Check a mid-range turn (chronological turn 5 => age 6)
    // Each turn = 4 messages. Turn 5 tool_result is at index 5*4+2 = 22
    const midToolResult = result[22]
    expect(midToolResult.role).toBe('user')
    const midBlock = expectDefined(midToolResult.content.find((b) => b.type === 'tool_result'))
    // The original content is long (~800 chars), truncated should be ~200 + "..."
    expect(midBlock.content.length).toBeLessThanOrEqual(210)
    expect(midBlock.content).toEndWith('...')
    expect(midBlock.truncationLevel).toBe('summary')
  })

  test('replaces tool output with status for turns 9+', () => {
    const messages = buildConversation(12)
    const result = prepareConversationHistory(messages)

    // Chronological turn 0 has age 11 (status only)
    // Turn 0 tool_result is at index 0*4+2 = 2
    const oldToolResult = result[2]
    expect(oldToolResult.role).toBe('user')
    const oldBlock = expectDefined(oldToolResult.content.find((b) => b.type === 'tool_result'))
    expect(oldBlock.content).toBe('\u2713 success')
    expect(oldBlock.truncationLevel).toBe('status')
  })

  test('drops structured tool result content items when old turns are reduced', () => {
    const messages = buildConversation(12)
    const oldestToolResult = expectDefined(
      messages[2].content.find((block) => block.type === 'tool_result'),
    )
    oldestToolResult.contentItems = [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }]

    const result = prepareConversationHistory(messages)
    const reducedBlock = expectDefined(result[2].content.find((b) => b.type === 'tool_result'))

    expect(reducedBlock.truncationLevel).toBe('status')
    expect(reducedBlock.contentItems).toBeUndefined()
  })

  test('handles error tool results with failed prefix', () => {
    const messages: Message[] = []
    // Build 12 turns, but make the first turn (oldest) have an error
    for (let i = 0; i < 12; i++) {
      const toolId = `tool-${i}`
      const isError = i === 0 // First turn has error
      messages.push(makeUserText(`Question ${i}`))
      messages.push(makeAssistantToolUse('bash', toolId))
      messages.push(makeToolResult(toolId, `Error: command not found in turn ${i}`, isError))
      messages.push(makeAssistantText(`Reply ${i}`))
    }

    const result = prepareConversationHistory(messages)

    // Turn 0 (chronological) has age 11 => status only, with error
    const errorResult = result[2]
    const errorBlock = expectDefined(errorResult.content.find((b) => b.type === 'tool_result'))
    expect(errorBlock.content).toContain('\u2717 failed:')
    expect(errorBlock.content).toContain('Error: command not found')
    expect(errorBlock.truncationLevel).toBe('status')
  })

  test('handles success tool results with success marker', () => {
    const messages = buildConversation(12)
    const result = prepareConversationHistory(messages)

    // Chronological turn 1 has age 10 => status only, success
    // Turn 1 tool_result at index 1*4+2 = 6
    const successResult = result[6]
    const successBlock = expectDefined(successResult.content.find((b) => b.type === 'tool_result'))
    expect(successBlock.content).toBe('\u2713 success')
    expect(successBlock.truncationLevel).toBe('status')
  })

  test('leaves assistant messages untouched', () => {
    const messages = buildConversation(12)
    const result = prepareConversationHistory(messages)

    // Check all assistant messages are identical references
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'assistant') {
        expect(result[i]).toBe(messages[i])
      }
    }
  })

  test('uses outputSummary when available for mid-range truncation', () => {
    const messages: Message[] = []
    // Build 6 turns; turn 0 (chronological, age 5) should be truncated
    for (let i = 0; i < 6; i++) {
      const toolId = `tool-${i}`
      messages.push(makeUserText(`Question ${i}`))
      messages.push(makeAssistantToolUse('bash', toolId))
      if (i === 0) {
        // Give the oldest turn an outputSummary
        messages.push(
          makeMessage('user', [
            {
              type: 'tool_result',
              toolUseId: toolId,
              content: 'A'.repeat(1000),
              outputSummary: 'Custom summary of output',
            },
          ]),
        )
      } else {
        messages.push(makeToolResult(toolId, `Output for turn ${i}`))
      }
      messages.push(makeAssistantText(`Reply ${i}`))
    }

    const result = prepareConversationHistory(messages)

    // Turn 0 (chronological) has age 5 => mid-range truncation
    const block = expectDefined(result[2].content.find((b) => b.type === 'tool_result'))
    expect(block.content).toContain('Custom summary of output')
    expect(block.truncationLevel).toBe('summary')
  })

  test('repeated calls are idempotent for already summarized blocks', () => {
    const messages = buildConversation(6)

    prepareConversationHistory(messages)
    const block = expectDefined(messages[2].content.find((b) => b.type === 'tool_result'))
    const firstContent = block.content

    const result = prepareConversationHistory(messages)
    const repeatedBlock = expectDefined(result[2].content.find((b) => b.type === 'tool_result'))

    expect(repeatedBlock.content).toBe(firstContent)
    expect(repeatedBlock.truncationLevel).toBe('summary')
  })

  test('previously summarized blocks can later degrade to status', () => {
    const messages = buildConversation(6)
    prepareConversationHistory(messages)

    const firstBlock = expectDefined(messages[2].content.find((b) => b.type === 'tool_result'))
    expect(firstBlock.truncationLevel).toBe('summary')

    const extended = [...messages, ...buildConversation(4)]
    const result = prepareConversationHistory(extended)
    const degradedBlock = expectDefined(result[2].content.find((b) => b.type === 'tool_result'))

    expect(degradedBlock.content).toBe('\u2713 success')
    expect(degradedBlock.truncationLevel).toBe('status')
  })

  test('preserves user text messages that are not tool results', () => {
    const messages = buildConversation(12)
    const result = prepareConversationHistory(messages)

    // Every user text message (every 4th starting from 0) should be preserved
    for (let i = 0; i < 12; i++) {
      const textMsg = result[i * 4]
      expect(textMsg.role).toBe('user')
      const textBlock = expectDefined(textMsg.content.find((b) => b.type === 'text'))
      expect(textBlock.text).toContain(`turn ${i}`)
    }
  })

  test('does not treat queued user messages as turn boundaries', () => {
    const messages: Message[] = [
      makeUserText('turn 1'),
      makeAssistantToolUse('bash', 'tool-1'),
      makeToolResult('tool-1', 'A'.repeat(400)),
      makeAssistantText('reply 1'),
      makeQueuedUserText('late follow-up'),
      makeAssistantText('queued ack'),
      makeUserText('turn 2'),
      makeAssistantToolUse('bash', 'tool-2'),
      makeToolResult('tool-2', 'B'.repeat(400)),
      makeAssistantText('reply 2'),
    ]

    const result = prepareConversationHistory(messages)
    const olderToolResult = expectDefined(
      result[2].content.find((block) => block.type === 'tool_result'),
    )

    expect(olderToolResult.content).toBe('A'.repeat(400))
    expect(result[4]).toBe(messages[4])
  })

  test('compacts old tool-heavy turns into model-authored semantic block with evidence paths', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-context-'))
    const messages = buildLongToolConversation()
    const compactionEvents: EpisodeCompactionTraceEvent[] = []
    let timelineCompactionBlocks: TimelineCompactionBlock[] = []
    const originalJsonChars = JSON.stringify(messages).length
    const oldestResult = expectDefined(
      messages[2].content.find((block) => block.type === 'tool_result'),
    )
    const oldestRawContent = oldestResult.content

    try {
      const result = await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_20260512_1006_fei_8161_fixture',
        contextCompactor: semanticCompactor(),
        onTimelineCompactionBlocksChanged: (blocks) => {
          timelineCompactionBlocks = blocks
        },
        onEpisodeCompaction: (event) => compactionEvents.push(event),
      })
      const compactedJsonChars = JSON.stringify(result).length
      const text = result
        .flatMap((message) =>
          message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
        )
        .join('\n')

      expect(oldestResult.content).toBe(oldestRawContent)
      expect(result.length).toBeLessThan(messages.length)
      expect(compactedJsonChars).toBeLessThan(originalJsonChars * 0.75)
      expect(text).toContain('<context_compaction_summary source="model">')
      expect(text).toContain('<working_state_compaction>')
      expect(text).toContain('strategy: deterministic_contiguous_older_turns_v1')
      expect(text).toContain('summary:')
      expect(text).toContain('semantic compact:')
      expect(text).toContain('confirmed_facts:')
      expect(text).toContain('open_questions_or_blockers:')
      expect(text).toContain('confirms only the tool IO was captured')
      expect(text).toContain('evidence_manifest:')
      expect(text).toContain('.artifacts/sess_20260512_1006_fei_8161_fixture/tool-evidence')
      expect(JSON.stringify(result)).not.toContain('AGENT_LOOP_RAW_')
      expect(JSON.stringify(result)).toContain('RECENT_RAW_')
      expect(text).not.toContain('assistant concluded:')
      expect(text).not.toContain('confirmed write result')

      const evidencePaths = Array.from(text.matchAll(/path=([^\s]+)/g), (match) => match[1])
      expect(evidencePaths.length).toBeGreaterThan(0)
      const firstEvidence = evidencePaths[0]
      expect(existsSync(firstEvidence)).toBe(true)
      expect(readFileSync(firstEvidence, 'utf-8').length).toBeGreaterThan(0)

      const outputEvidencePaths = Array.from(
        text.matchAll(/tool_result_output path=([^\s]+)/g),
        (match) => match[1],
      )
      expect(outputEvidencePaths.length).toBeGreaterThan(0)
      expect(readFileSync(outputEvidencePaths[0], 'utf-8')).toContain('AGENT_LOOP_RAW_')
      const compactionEvent = expectDefined(compactionEvents[0])
      expect(compactionEvents).toHaveLength(1)
      expect(compactionEvent.event).toBe('timeline_compaction_block')
      expect(compactionEvent.lifecycle).toBe('created')
      expect(compactionEvent.blockId).toBe(timelineCompactionBlocks[0]?.id)
      expect(compactionEvent.messagesBefore).toBe(messages.length)
      expect(compactionEvent.messagesAfter).toBe(result.length)
      expect(compactionEvent.episodesCreated).toBeGreaterThan(0)
      expect(compactionEvent.compactedMessageCount).toBeGreaterThan(0)
      expect(compactionEvent.promptCharsAfter).toBeLessThan(compactionEvent.promptCharsBefore)
      expect(compactionEvent.tokensAfter).toBeLessThan(compactionEvent.tokensBefore)
      expect(compactionEvent.evidenceCount).toBeGreaterThan(0)
      expect(compactionEvent.rawCharsMovedToEvidence).toBeGreaterThan(0)
      expect(compactionEvent.workingStateId).toContain(':working_state')
      expect(compactionEvent.evidence.some((item) => item.writeStatus === 'created')).toBe(true)
      expect(timelineCompactionBlocks).toHaveLength(1)
      expect(timelineCompactionBlocks[0].coveredMessageCount).toBeGreaterThan(0)
      expect(timelineCompactionBlocks[0].summary).toContain('<timeline_compaction_block')
      expect(timelineCompactionBlocks[0].summary).toContain('<working_state_compaction>')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('reuses existing immutable timeline compaction blocks without rewriting them', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-reuse-'))
    const messages = buildLongToolConversation('sess_reuse_fixture')
    let timelineCompactionBlocks: TimelineCompactionBlock[] = []

    try {
      const firstEvents: EpisodeCompactionTraceEvent[] = []
      const first = await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_reuse_fixture',
        contextCompactor: semanticCompactor('first semantic compact'),
        onTimelineCompactionBlocksChanged: (blocks) => {
          timelineCompactionBlocks = blocks
        },
        onEpisodeCompaction: (event) => firstEvents.push(event),
      })
      const changedBlocks = timelineCompactionBlocks
      const secondEvents: EpisodeCompactionTraceEvent[] = []
      let changedAgain = false
      const second = await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_reuse_fixture',
        timelineCompactionBlocks: changedBlocks,
        contextCompactor: semanticCompactor('second semantic compact'),
        onTimelineCompactionBlocksChanged: () => {
          changedAgain = true
        },
        onEpisodeCompaction: (event) => secondEvents.push(event),
      })

      expect(firstEvents[0]?.lifecycle).toBe('created')
      expect(secondEvents).toHaveLength(0)
      expect(changedAgain).toBe(false)
      expect(second).toEqual(first)
      expect(JSON.stringify(second)).not.toContain('AGENT_LOOP_RAW_')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('creates a new immutable block instead of expanding an existing block', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-update-'))
    const messages = buildLongToolConversation('sess_update_fixture')
    let timelineCompactionBlocks: TimelineCompactionBlock[] = []

    try {
      await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_update_fixture',
        contextCompactor: semanticCompactor('original semantic compact'),
        onTimelineCompactionBlocksChanged: (blocks) => {
          timelineCompactionBlocks = blocks
        },
      })
      const originalBlock = expectDefined(timelineCompactionBlocks[0])
      const extended = [
        ...messages,
        ...buildConversation(4).map((message) => ({
          ...message,
          sessionId: 'sess_update_fixture',
        })),
        {
          ...makeUserText('Latest current task after second compactable group'),
          sessionId: 'sess_update_fixture',
        },
        {
          ...makeAssistantText('Latest answer stays high fidelity'),
          sessionId: 'sess_update_fixture',
        },
      ]
      const events: EpisodeCompactionTraceEvent[] = []
      await prepareConversationHistoryWithCompaction(extended, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_update_fixture',
        timelineCompactionBlocks,
        contextCompactor: semanticCompactor('second semantic compact'),
        onTimelineCompactionBlocksChanged: (blocks) => {
          timelineCompactionBlocks = blocks
        },
        onEpisodeCompaction: (event) => events.push(event),
      })

      const activeBlocks = timelineCompactionBlocks.filter((block) => block.status === 'active')
      const originalAfter = expectDefined(
        activeBlocks.find((block) => block.id === originalBlock.id),
      )
      const newBlock = expectDefined(activeBlocks.find((block) => block.id !== originalBlock.id))
      expect(events[0]?.lifecycle).toBe('created')
      expect(activeBlocks).toHaveLength(2)
      expect(originalAfter.generation).toBe(originalBlock.generation)
      expect(originalAfter.coveredMessageIds).toEqual(originalBlock.coveredMessageIds)
      expect(newBlock.generation).toBe(1)
      expect(newBlock.coveredMessageIds).not.toEqual(originalBlock.coveredMessageIds)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('keeps artifact evidence root out of tracked source by gitignore policy', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8')

    expect(gitignore.split(/\r?\n/)).toContain('.artifacts/')
  })

  test('marks task-closure continuation episodes as blocked instead of finished work', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-blocked-'))
    const messages = [
      makeUserText('old blocked task'),
      makeAssistantToolUseWithInput('bash', 'blocked_tool', { command: 'check-login' }),
      makeToolResult('blocked_tool', 'missing login cookie'),
      {
        ...makeMessage('user', [
          {
            type: 'text',
            text: '<system_notice><classifier_reason>缺少登录态</classifier_reason></system_notice>',
          },
        ]),
        messageType: 'control' as const,
        controlKind: 'task_closure' as const,
      },
      ...buildConversation(4),
      makeUserText('current task'),
      makeAssistantText('working'),
    ]

    try {
      const result = await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_blocked_fixture',
        contextCompactor: semanticCompactor('blocked semantic compact'),
      })
      const text = result
        .flatMap((message) =>
          message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
        )
        .join('\n')

      expect(text).toContain('<context_compaction_summary source="model">')
      expect(text).toContain('status="blocked"')
      expect(text).toContain('task_closure continuation occurred inside this episode')
      expect(text).toContain('缺少登录态')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('marks persisted task_closure=block assistant messages as blocked episodes', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-task-block-'))
    const blockedAssistant = makeAssistantText('要继续线上核验，我需要你的账号登录态或截图授权。')
    blockedAssistant.taskClosure = { action: 'block', reason: '缺少登录态' }
    const messages = [
      makeUserText('old task with blocker'),
      makeAssistantToolUseWithInput('bash', 'task_block_tool', { command: 'check-login' }),
      makeToolResult('task_block_tool', 'login cookie missing'),
      blockedAssistant,
      ...buildConversation(4),
      makeUserText('current task'),
      makeAssistantText('working'),
    ]

    try {
      const result = await prepareConversationHistoryWithCompaction(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_task_block_fixture',
        contextCompactor: semanticCompactor('task block semantic compact'),
      })
      const text = result
        .flatMap((message) =>
          message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
        )
        .join('\n')

      expect(text).toContain('<context_compaction_summary source="model">')
      expect(text).toContain('status="blocked"')
      expect(text).toContain('task_closure=block for this episode')
      expect(text).toContain('缺少登录态')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('keeps unfinished unpaired tool turns out of episode compaction', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-unfinished-'))
    const messages = [
      makeUserText('old unfinished task'),
      makeAssistantToolUseWithInput('bash', 'unfinished_tool', { command: 'sleep 10' }),
      ...buildConversation(6),
    ]

    try {
      const result = prepareConversationHistory(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_unfinished_fixture',
      })

      expect(
        result.some((message) =>
          message.content.some(
            (block) => block.type === 'tool_use' && block.id === 'unfinished_tool',
          ),
        ),
      ).toBe(true)
      expect(
        result.some((message) =>
          message.content.some(
            (block) => block.type === 'tool_result' && block.toolUseId === 'unfinished_tool',
          ),
        ),
      ).toBe(false)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('episode compaction preserves legal tool_use and tool_result pairing in retained history', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-episode-pairs-'))
    const messages = buildLongToolConversation('sess_pair_fixture')

    try {
      const result = prepareConversationHistory(messages, {
        enableEpisodeCompaction: true,
        evidenceWorkDir: workDir,
        sessionId: 'sess_pair_fixture',
      })
      const toolUseIds = new Set<string>()
      const toolResultIds = new Set<string>()

      for (const message of result) {
        for (const block of message.content) {
          if (block.type === 'tool_use') toolUseIds.add(block.id)
          if (block.type === 'tool_result') toolResultIds.add(block.toolUseId)
        }
      }

      expect(toolUseIds.size).toBeGreaterThan(0)
      for (const toolUseId of toolUseIds) {
        expect(toolResultIds.has(toolUseId)).toBe(true)
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
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

describe('prepareConversationHistory — queued message merging', () => {
  test('queued messages between tool_use and tool_result are merged before API call', () => {
    // Reproduces the exact bug: sess_20260318_1452_fei_adaa
    const messages = [
      makeUserText('fix issues'),
      makeAssistantToolUse('bash', 'toolu_01MGFBSJfmWFTmKqy8Zd1oyJ'),
      makeQueuedUserText('表格不要替换成列表'),
      makeToolResult('toolu_01MGFBSJfmWFTmKqy8Zd1oyJ', 'All 4 tasks completed'),
      makeAssistantText('done'),
    ]

    const result = prepareConversationHistory(messages)

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
