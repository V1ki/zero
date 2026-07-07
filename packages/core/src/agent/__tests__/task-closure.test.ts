import { describe, expect, test } from 'bun:test'
import { now } from '@zero-os/shared'
import type { ContentBlock, Message } from '@zero-os/shared'
import {
  buildTaskClosurePrompt,
  buildTaskClosureDecisionPrompt,
  buildTaskClosurePromptContext,
  extractAssistantTail,
  extractAssistantText,
  extractToolDetail,
  formatToolGroup,
  hasAssistantText,
  parseTaskClosureDecision,
} from '../task-closure'

describe('parseTaskClosureDecision', () => {
  test('parses valid JSON surrounded by extra text', () => {
    expect(parseTaskClosureDecision('result: {"action":"continue","reason":"后续仍必要"}')).toEqual(
      {
        action: 'continue',
        reason: '后续仍必要',
      },
    )
  })

  test('rejects decisions without a reason', () => {
    expect(parseTaskClosureDecision('{"action":"continue"}')).toBeNull()
  })
})

describe('buildTaskClosurePrompt', () => {
  test('injects the classifier reason inside classifier_reason tags', () => {
    const prompt = buildTaskClosurePrompt('后续核验仍属于当前任务')

    expect(prompt).toContain(
      '<classifier_reason>后续核验仍属于当前任务</classifier_reason>',
    )
  })

  test('preserves the core continuation guidance from the static notice', () => {
    const prompt = buildTaskClosurePrompt('需要继续')

    expect(prompt).toContain('不要把它们交还给用户选择')
  })

  test('wraps the notice in system_notice tags', () => {
    const prompt = buildTaskClosurePrompt('需要继续')

    expect(prompt.startsWith('<system_notice>')).toBe(true)
    expect(prompt.endsWith('</system_notice>')).toBe(true)
  })
})

describe('assistant text helpers', () => {
  test('extractAssistantText joins all text blocks', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: '第一段' },
      { type: 'tool_result', toolUseId: 'tool_1', content: 'ignored' },
      { type: 'text', text: '第二段' },
    ]

    expect(extractAssistantText(content)).toBe('第一段第二段')
  })

  test('extractAssistantTail uses the last text block', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: '前文' },
      { type: 'text', text: 'abcdef' },
    ]

    expect(extractAssistantTail(content, 3)).toBe('def')
  })

  test('hasAssistantText ignores whitespace-only text blocks', () => {
    expect(hasAssistantText([{ type: 'text', text: '   ' }])).toBe(false)
    expect(hasAssistantText([{ type: 'text', text: '有内容' }])).toBe(true)
  })
})

function makeMessage(role: 'user' | 'assistant', content: ContentBlock[]): Message {
  return {
    id: `${role}-${messageCounter++}`,
    sessionId: 'test-session',
    role,
    messageType: 'message',
    content,
    createdAt: now(),
  }
}

let messageCounter = 0

test('buildTaskClosureDecisionPrompt renders tool summary without task context', () => {
  const prompt = buildTaskClosureDecisionPrompt(
    '看看这个链接, 然后把可能相关的信息也分析下',
    '这里是一版初步结论',
    {
      toolSummary: 'fetch reddit.com ✓ 共 1 次',
    },
  )

  expect(prompt).toContain('研究/分析类任务额外规则')
  expect(prompt).toContain('多源交叉验证')
  expect(prompt).toContain('后台任务额外规则')
  expect(prompt).toContain('等待已知后台完成事件')
  expect(prompt).toContain(
    '<tool_calls_this_turn>\nfetch reddit.com ✓ 共 1 次\n</tool_calls_this_turn>',
  )
  expect(prompt).not.toContain('<task_context>')
  expect(prompt).not.toContain('external_lookup_count')
  expect(prompt).not.toContain('coverage_hint')
})

test('buildTaskClosureDecisionPrompt includes tool call summary', () => {
  const prompt = buildTaskClosureDecisionPrompt(
    '2分钟后提醒我',
    '已设置好，2分钟后会提醒你',
    {
      toolSummary: 'schedule 1次: create ✓',
    },
  )

  expect(prompt).toContain('<tool_calls_this_turn>')
  expect(prompt).toContain('schedule 1次: create ✓')
})

test('buildTaskClosureDecisionPrompt renders none when no tool summary', () => {
  const prompt = buildTaskClosureDecisionPrompt('你好', '你好！')

  expect(prompt).toContain('<tool_calls_this_turn>\nnone\n</tool_calls_this_turn>')
})

test('buildTaskClosureDecisionPrompt includes applied queued intent when provided', () => {
  const prompt = buildTaskClosureDecisionPrompt(
    '先分析主贴',
    '这里是当前结论，已完成',
    undefined,
    '[10:30] 顺便核验一下官方 changelog',
  )

  expect(prompt).toContain('<applied_queued_messages>')
  expect(prompt).toContain('顺便核验一下官方 changelog')
  expect(prompt).not.toContain('<queued_message>')
  expect(prompt).not.toContain('<assistant_tail>')
})

describe('extractToolDetail', () => {
  test('formats fetch, bash, file tools and generic tools', () => {
    expect(
      extractToolDetail(
        'fetch',
        { url: 'https://www.reddit.com/r/typescript/comments/example' },
        { isError: false },
      ),
    ).toBe('reddit.com ✓')

    expect(
      extractToolDetail(
        'bash',
        { command: 'bun test', description: '运行测试' },
        { isError: false, outputSummary: 'Executed: bun test' },
      ),
    ).toBe('运行测试 ✓')

    expect(
      extractToolDetail(
        'bash',
        { command: 'bun run build', description: '构建项目' },
        { isError: false, outputSummary: 'Background task started: bash (task_123)' },
      ),
    ).toBe('Background task started: bash (task_123) ✓')

    expect(
      extractToolDetail(
        'codex',
        { action: 'run' },
        { isError: false, outputSummary: 'Background task started: codex (task_456)' },
      ),
    ).toBe('Background task started: codex (task_456) ✓')

    expect(
      extractToolDetail(
        'bash',
        { command: 'git status' },
        { isError: false, outputSummary: 'Executed: git status' },
      ),
    ).toBe('git status ✓')

    expect(
      extractToolDetail(
        'bash',
        { command: 'bun test' },
        { isError: true, outputSummary: 'Command failed (exit 1): bun test' },
      ),
    ).toBe('bun test ✗')

    expect(extractToolDetail('bash', { command: 'pwd' })).toBe('command …')

    expect(extractToolDetail('read', { path: '/tmp/agent.ts' }, { isError: false })).toBe(
      'agent.ts ✓',
    )

    expect(extractToolDetail('schedule', { action: 'create' }, { isError: false })).toBe('create ✓')
  })
})

describe('formatToolGroup', () => {
  test('formats fetch summaries with a compact count', () => {
    expect(
      formatToolGroup('fetch', ['reddit.com ✓', 'example.com ✓', 'news.ycombinator.com ✗']),
    ).toBe('fetch reddit.com ✓, example.com ✓ 共 3 次')
  })

  test('formats a single file tool detail without file count boilerplate', () => {
    expect(formatToolGroup('read', ['agent.ts ✓'])).toBe('read agent.ts ✓')
  })

  test('formats file tools with file counts and truncation', () => {
    expect(
      formatToolGroup('read', [
        'agent.ts ✓',
        'config.ts ✓',
        'task.ts ✓',
        'tool.ts ✓',
        'queue.ts ✓',
      ]),
    ).toBe('read 5 个文件: agent.ts ✓, config.ts ✓, task.ts ✓, tool.ts ✓ 等')
  })
})

describe('buildTaskClosurePromptContext', () => {
  test('aggregates tool calls into a readable summary', () => {
    const messages: Message[] = [
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'fetch-1',
          name: 'fetch',
          input: { url: 'https://www.reddit.com/r/zero/comments/abc' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'fetch-1',
          content: 'ok',
          outputSummary: 'HTTP 200',
        },
      ]),
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'bash-1',
          name: 'bash',
          input: { command: 'bun test', description: '运行测试' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'bash-1',
          content: 'ok',
          outputSummary: 'Executed: bun test',
        },
      ]),
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'read-1',
          name: 'read',
          input: { path: '/repo/packages/core/src/agent.ts' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'read-1',
          content: 'ok',
          outputSummary: 'Read 20 lines',
        },
      ]),
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'read-2',
          name: 'read',
          input: { path: '/repo/packages/core/src/task-closure.ts' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'read-2',
          content: 'ok',
          outputSummary: 'Read 40 lines',
        },
      ]),
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'schedule-1',
          name: 'schedule',
          input: { action: 'create' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'schedule-1',
          content: 'created',
          outputSummary: 'Created schedule',
        },
      ]),
    ]

    expect(buildTaskClosurePromptContext(messages)).toEqual({
      toolSummary:
        'fetch reddit.com ✓; bash 执行 运行测试 ✓; read 2 个文件: agent.ts ✓, task-closure.ts ✓; schedule 1次: create ✓',
    })
  })

  test('preserves background tool started summaries in tool context', () => {
    const messages: Message[] = [
      makeMessage('assistant', [
        {
          type: 'tool_use',
          id: 'codex-1',
          name: 'codex',
          input: { action: 'run' },
        },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'codex-1',
          content: '<system_event type="background_tool.started" />',
          outputSummary: 'Background task started: codex (task_456)',
        },
      ]),
    ]

    expect(buildTaskClosurePromptContext(messages)).toEqual({
      toolSummary: 'codex 1次: Background task started: codex (task_456) ✓',
    })
  })

  test('returns none when no tool calls exist', () => {
    expect(
      buildTaskClosurePromptContext([makeMessage('assistant', [{ type: 'text', text: 'hello' }])]),
    ).toEqual({
      toolSummary: 'none',
    })
  })
})
