import { afterAll, describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import { ToolRegistry } from '../../tool/registry'
import { SessionManager } from '../manager'
import type { Session } from '../session'
import { SessionTurnRuntime } from '../session-turn-runtime'
import { createTestModelRouter, createTestProjectRoot } from './test-helpers'

const testProject = createTestProjectRoot('zero-stalled-session-recovery-')

afterAll(() => {
  testProject.cleanup()
})

interface EmittedEvent {
  topic: string
  data: Record<string, unknown>
}

function createManager(events: EmittedEvent[] = []): SessionManager {
  return new SessionManager(createTestModelRouter(), new ToolRegistry(), {
    projectRoot: testProject.projectRoot,
    bus: {
      emit: (topic, data) => events.push({ topic, data }),
    },
  })
}

function installTurnRuntime(session: Session, runtime: SessionTurnRuntime): void {
  ;(session as unknown as { turnRuntime: SessionTurnRuntime }).turnRuntime = runtime
}

function makeMessage(
  sessionId: string,
  role: Message['role'],
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `msg_${role}_${Math.random().toString(36).slice(2)}`,
    sessionId,
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function createMeaningfulMessages(sessionId: string): Message[] {
  return [
    makeMessage(
      sessionId,
      'user',
      '请帮我排查部署失败的问题，我需要确认根因、修复路径、验证方式，以及这次改动之后下次部署还需要注意哪些前置条件。',
    ),
    makeMessage(sessionId, 'assistant', '', {
      content: [{ type: 'tool_use', id: 'tool_1', name: 'bash', input: { cmd: 'bun run check' } }],
    }),
    makeMessage(
      sessionId,
      'assistant',
      '我检查了仓库配置、运行脚本和数据库迁移状态，确认问题出在旧的 schema 没有执行，并整理了修复步骤、验证方式、影响范围和回滚注意事项。',
    ),
    makeMessage(
      sessionId,
      'user',
      '请按这个方案修复，并把关键原因和验证点总结下来，确保以后可以把这次对话当作完整排障参考，而不是一次临时聊天记录。',
    ),
  ]
}

describe('stalled session recovery', () => {
  test('atomically quarantines the exact stalled binding without waiting for memory evaluation', async () => {
    const events: EmittedEvent[] = []
    const manager = createManager(events)
    const alice = manager.getOrCreateForChannel('feishu', 'shared-room', 'feishu:ops', 'ou_alice')
    const bob = manager.getOrCreateForChannel('feishu', 'shared-room', 'feishu:ops', 'ou_bob')

    let clock = 10_000
    const turnRuntime = new SessionTurnRuntime({ now: () => clock })
    installTurnRuntime(alice.session, turnRuntime)
    await turnRuntime.acquireTurn('stalled-turn')
    clock += 90_000

    expect(alice.session.getTurnHealth().idleForMs).toBe(90_000)
    expect(alice.session.isTurnStalled(60_000)).toBe(true)

    let memoryWaitCalls = 0
    ;(
      alice.session as unknown as {
        isAgentInitialized(): boolean
        getMessages(): Message[]
        waitForTurnComplete(): Promise<void>
      }
    ).isAgentInitialized = () => true
    ;(
      alice.session as unknown as {
        getMessages(): Message[]
      }
    ).getMessages = () => createMeaningfulMessages(alice.session.data.id)
    ;(
      alice.session as unknown as {
        waitForTurnComplete(): Promise<void>
      }
    ).waitForTurnComplete = () => {
      memoryWaitCalls++
      return new Promise(() => {})
    }

    const wrongParticipant = manager.recoverStalledCurrentSessionForChannel(
      'feishu',
      'shared-room',
      {
        channelName: 'feishu:ops',
        participantId: 'ou_bob',
        expectedSessionId: alice.session.data.id,
        stallTimeoutMs: 60_000,
      },
    )
    expect(wrongParticipant).toBeNull()

    const recovered = manager.recoverStalledCurrentSessionForChannel('feishu', 'shared-room', {
      channelName: 'feishu:ops',
      participantId: 'ou_alice',
      expectedSessionId: alice.session.data.id,
      stallTimeoutMs: 60_000,
    })

    expect(recovered).not.toBeNull()
    expect(recovered?.previousSessionId).toBe(alice.session.data.id)
    expect(recovered?.session.data.id).not.toBe(alice.session.data.id)
    expect(recovered?.idleForMs).toBe(90_000)
    expect(manager.getPlacement(alice.session.data.id)).toBe('background')
    expect(manager.getPlacement(recovered?.session.data.id ?? '')).toBe('current')
    expect(
      manager.getCurrentBinding('feishu', 'shared-room', 'feishu:ops', 'ou_alice')?.sessionId,
    ).toBe(recovered?.session.data.id)
    expect(
      manager.getCurrentBinding('feishu', 'shared-room', 'feishu:ops', 'ou_bob')?.sessionId,
    ).toBe(bob.session.data.id)
    expect(memoryWaitCalls).toBe(0)
    expect(turnRuntime.shouldAbort()).toBe(true)

    const recoveryEvent = events.find(
      (entry) => entry.topic === 'session:update' && entry.data.event === 'session_stall_recovered',
    )
    expect(recoveryEvent?.data).toMatchObject({
      sessionId: recovered?.session.data.id,
      previousSessionId: alice.session.data.id,
      quarantinedSessionId: alice.session.data.id,
      replacedBySessionId: recovered?.session.data.id,
      idleForMs: 90_000,
      stallTimeoutMs: 60_000,
      queueDepth: 0,
      executionAbortRequested: true,
    })

    const sessionCountAfterRecovery = manager.listAll().length
    const duplicate = manager.recoverStalledCurrentSessionForChannel('feishu', 'shared-room', {
      channelName: 'feishu:ops',
      participantId: 'ou_alice',
      expectedSessionId: alice.session.data.id,
      stallTimeoutMs: 60_000,
    })
    expect(duplicate).toBeNull()
    expect(manager.listAll()).toHaveLength(sessionCountAfterRecovery)
  })

  test('keeps a healthy in-progress session bound', async () => {
    const manager = createManager()
    const current = manager.getOrCreateForChannel('telegram', 'room-healthy', 'telegram')

    let clock = 20_000
    const turnRuntime = new SessionTurnRuntime({ now: () => clock })
    installTurnRuntime(current.session, turnRuntime)
    await turnRuntime.acquireTurn('healthy-turn')
    clock += 1_000

    const recovered = manager.recoverStalledCurrentSessionForChannel('telegram', 'room-healthy', {
      channelName: 'telegram',
      expectedSessionId: current.session.data.id,
      stallTimeoutMs: 30_000,
    })

    expect(recovered).toBeNull()
    expect(manager.getCurrentBinding('telegram', 'room-healthy', 'telegram')?.sessionId).toBe(
      current.session.data.id,
    )
    expect(manager.listAll()).toHaveLength(1)
  })
})
