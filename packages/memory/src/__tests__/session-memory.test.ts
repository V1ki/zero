import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import { Session } from '../../../core/src/session/session'
import { shouldEvaluateSessionMemory } from '../session-memory'

function makeMessage(
  role: Message['role'],
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `${role}_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_test_session_memory',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('shouldEvaluateSessionMemory', () => {
  test('returns false for empty message list', () => {
    expect(shouldEvaluateSessionMemory([], Session.isTopLevelUserTurn)).toBe(false)
  })

  test('returns false for a single trivial user turn', () => {
    const messages = [makeMessage('user', 'hello'), makeMessage('assistant', 'hi')]
    expect(shouldEvaluateSessionMemory(messages, Session.isTopLevelUserTurn)).toBe(false)
  })

  test('returns false for short multi-turn session without tools', () => {
    const messages = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
      makeMessage('user', 'thanks'),
      makeMessage('assistant', 'you are welcome'),
    ]
    expect(shouldEvaluateSessionMemory(messages, Session.isTopLevelUserTurn)).toBe(false)
  })

  test('returns true for multi-turn session with tool usage and substantial content', () => {
    const messages: Message[] = [
      makeMessage(
        'user',
        '请帮我排查部署失败的问题，我已经尝试重启服务，但是日志里还是提示 migration failed。我需要你确认根因、修复路径、验证方式，以及这次改动之后下次部署还要特别注意哪些前置条件。',
      ),
      {
        id: 'assistant_tool',
        sessionId: 'sess_test_session_memory',
        role: 'assistant',
        messageType: 'message',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'bash', input: { cmd: 'bun run check' } }],
        createdAt: new Date().toISOString(),
      },
      makeMessage(
        'assistant',
        '我检查了仓库配置、运行脚本和数据库迁移状态，确认问题出在旧的 schema 没有执行，已经整理出修复步骤和验证方式，同时把出错阶段、影响范围、需要复核的环境变量和回滚注意事项也记录出来了。',
      ),
      makeMessage(
        'user',
        '那就按这个方案修掉，并把关键原因和验证点也总结一下，后面我还会再看一次。我希望这次对话后续还能被当作完整排障参考，而不只是一次临时聊天记录。',
      ),
      makeMessage(
        'assistant',
        '已经完成修复，迁移脚本和验证命令都通过了，同时记录了根因、修改点和回归检查项，后续重跑部署时可以直接复用。这次对话里已经形成了比较完整的处理结论和操作经验，明显超过了普通短问答的范围。',
      ),
    ]

    expect(shouldEvaluateSessionMemory(messages, Session.isTopLevelUserTurn)).toBe(true)
  })
})
