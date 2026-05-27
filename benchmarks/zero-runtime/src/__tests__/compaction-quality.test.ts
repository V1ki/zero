import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import { scoreCompactedContext, selectCheckpointCandidates } from '../compaction-quality'

const now = '2026-05-26T00:00:00.000Z'

function user(id: string, text: string): Message {
  return {
    id,
    sessionId: 'sess_quality_test',
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now,
  }
}

function assistant(id: string, text: string): Message {
  return {
    id,
    sessionId: 'sess_quality_test',
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now,
  }
}

function toolUse(id: string, toolUseId: string, input: Record<string, unknown>): Message {
  return {
    id,
    sessionId: 'sess_quality_test',
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'tool_use', id: toolUseId, name: 'read', input }],
    createdAt: now,
  }
}

describe('compaction quality eval helpers', () => {
  test('selects meaningful checkpoints and skips system notices when enough turns exist', () => {
    const messages = [
      user('u1', '分析 /Users/v1ki/project/article.md'),
      assistant('a1', '已分析'),
      user('u2', '继续修复 article.md'),
      assistant('a2', '继续处理'),
      user('u3', '<system_notice>结束时创建记忆</system_notice>'),
      assistant('a3', '已创建'),
      user('u4', '检查 article.md 的资源引用'),
      assistant('a4', '资源完整'),
    ]

    const checkpoints = selectCheckpointCandidates(messages, 3, 2)

    expect(checkpoints.map((checkpoint) => checkpoint.messageIndex)).toEqual([2, 6])
  })

  test('scores compacted context by terms reused by the next real turn', () => {
    const prefixMessages = [
      user('u1', '请检查 /Users/v1ki/project/article.md，并保留 mp.weixin.qq.com 发布链接'),
      assistant('a1', '路径和发布链接已经记录'),
    ]
    const compactedMessages = [
      user('c1', '压缩摘要：已记录 article.md，但发布链接需要回看原始证据'),
    ]
    const futureWindow = [
      user('u2', '继续用刚才的 mp.weixin.qq.com 链接同步 article.md'),
      toolUse('t1', 'call_read', { path: '/Users/v1ki/project/article.md' }),
      assistant('a2', '已同步 article.md'),
    ]

    const scored = scoreCompactedContext({
      prefixMessages,
      compactedMessages,
      futureWindow,
    })

    expect(scored.terms.some((term) => term.term.includes('mp.weixin.qq.com'))).toBe(true)
    expect(scored.baseline.score).toBe(100)
    expect(scored.compact.score).toBeLessThan(100)
    expect(scored.compact.missingTerms.some((term) => term.term.includes('mp.weixin.qq.com'))).toBe(
      true,
    )
  })
})
