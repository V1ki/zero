import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import {
  TOOL_IO_DIGEST_VARIANTS,
  buildToolIoDigestSamples,
  extractHandleTerms,
  extractToolIoPairs,
  scoreDigestText,
} from '../tool-io-digest-benchmark'

describe('tool io digest benchmark helpers', () => {
  test('extracts paired tool_use and tool_result blocks with human context kept out of digest', () => {
    const messages = makeMessages()
    const pairs = extractToolIoPairs(messages, 'sess_test')

    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toMatchObject({
      toolUseId: 'tool_read_1',
      toolName: 'read',
      previousUserText: '检查 /Users/v1ki/project/src/app.ts 的实现',
    })
    expect(pairs[0].toolInputRaw).toContain('/Users/v1ki/project/src/app.ts')
    expect(pairs[0].toolResultRaw).toContain('export function runApp')
    expect(pairs[1].toolName).toBe('bash')
  })

  test('builds samples around the largest tool result and keeps a consecutive group', () => {
    const messages = makeMessages()
    const row = {
      sessionId: 'sess_test',
      messageCount: messages.length,
      messageJsonChars: JSON.stringify(messages).length,
      messagesJson: JSON.stringify(messages),
    }
    const samples = buildToolIoDigestSamples([row], { sampleLimit: 1, groupSize: 2 })

    expect(samples).toHaveLength(1)
    expect(samples[0].singlePair.toolName).toBe('bash')
    expect(samples[0].groupPairs.map((pair) => pair.toolName)).toEqual(['read', 'bash'])
    expect(samples[0].handleTerms).toContain('/Users/v1ki/project/src/app.ts')
  })

  test('scores natural environment digest coverage', () => {
    const pairs = extractToolIoPairs(makeMessages(), 'sess_test')
    const variant = TOOL_IO_DIGEST_VARIANTS.find((item) => item.id === 'GROUP_NL')
    if (!variant) throw new Error('missing variant')

    const response = `环境摘要：这段工具 IO 先读取并测试了 /Users/v1ki/project/src/app.ts。
逐工具摘要：
- T1 / tool_read_1 / read：输入 path=/Users/v1ki/project/src/app.ts，结果显示包含 runApp。
- T2 / tool_bash_1 / bash：执行 bun test /Users/v1ki/project/src/app.test.ts --timeout 10000，结果测试通过。
可复用原文标识：/Users/v1ki/project/src/app.ts、/Users/v1ki/project/src/app.test.ts、--timeout、tool_bash_1。`
    const score = scoreDigestText({
      responseText: response,
      pairs,
      variant,
      handleTerms: extractHandleTerms(pairs.map((pair) => pair.toolInputRaw).join('\n')),
      rawChars: 1000,
    })

    expect(score.parseOk).toBe(true)
    expect(score.handleCoverageScore).toBe(100)
    expect(score.toolCoverageScore).toBe(100)
  })
})

function makeMessages(): Message[] {
  return [
    {
      id: 'm1',
      sessionId: 'sess_test',
      role: 'user',
      messageType: 'message',
      createdAt: '2026-05-26T00:00:00.000Z',
      content: [{ type: 'text', text: '检查 /Users/v1ki/project/src/app.ts 的实现' }],
    },
    {
      id: 'm2',
      sessionId: 'sess_test',
      role: 'assistant',
      messageType: 'message',
      createdAt: '2026-05-26T00:00:01.000Z',
      content: [
        { type: 'text', text: '我先看这个文件。' },
        {
          type: 'tool_use',
          id: 'tool_read_1',
          name: 'read',
          input: { path: '/Users/v1ki/project/src/app.ts', range: '1-80' },
        },
      ],
    },
    {
      id: 'm3',
      sessionId: 'sess_test',
      role: 'user',
      messageType: 'message',
      createdAt: '2026-05-26T00:00:02.000Z',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool_read_1',
          outputSummary: 'read app.ts',
          content: 'export function runApp() { return "/Users/v1ki/project/src/app.ts" }',
        },
      ],
    },
    {
      id: 'm4',
      sessionId: 'sess_test',
      role: 'assistant',
      messageType: 'message',
      createdAt: '2026-05-26T00:00:03.000Z',
      content: [
        {
          type: 'tool_use',
          id: 'tool_bash_1',
          name: 'bash',
          input: { cmd: 'bun test /Users/v1ki/project/src/app.test.ts --timeout 10000' },
        },
      ],
    },
    {
      id: 'm5',
      sessionId: 'sess_test',
      role: 'user',
      messageType: 'message',
      createdAt: '2026-05-26T00:00:04.000Z',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool_bash_1',
          outputSummary: 'tests passed',
          content:
            'bun test /Users/v1ki/project/src/app.test.ts --timeout 10000\n1 pass\n/Users/v1ki/project/src/app.ts',
        },
      ],
    },
  ]
}
