import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_NUDGE_PROMPT } from '@zero-os/memory'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionEventStore } from '@zero-os/observe'
import {
  type CompletionRequest,
  type CompletionResponse,
  type Message,
  type StreamEvent,
  type ToolContext,
  type ToolResult,
  isMessageAppendEvent,
} from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'
import { prepareRequestMessages } from '../compaction'

const SESSION = 'sess_agent_message_events'
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Do nothing'
  parameters = { type: 'object', properties: {} }

  protected async execute(): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

function response(
  id: string,
  content: CompletionResponse['content'],
  stopReason: CompletionResponse['stopReason'] = 'end_turn',
): CompletionResponse {
  return { id, content, stopReason, usage: { input: 10, output: 5 }, model: 'fake' }
}

/** 两步工具调用后回复;收尾判定 finish;记忆提醒请求回复一句不需要记录 */
class ScriptedAdapter implements ProviderAdapter {
  readonly apiType = 'fake-scripted'
  /** agent loop 的请求(深拷贝:loop 会原地改请求消息数组) */
  requests: CompletionRequest[] = []

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.meta?.purpose === 'task_closure') {
      return response('closure', [{ type: 'text', text: '{"action":"finish","reason":"done"}' }])
    }
    this.requests.push(structuredClone(req))
    const last = req.messages.at(-1)
    if (last?.controlKind === 'memory_nudge') {
      return response('nudge', [{ type: 'text', text: 'nothing worth recording' }])
    }
    const index = this.requests.length
    if (index <= 2) {
      return response(
        `resp_${index}`,
        [
          { type: 'text', text: `working ${index}` },
          { type: 'tool_use', id: `call_${index}`, name: 'noop', input: {} },
        ],
        'tool_use',
      )
    }
    return response(`resp_${index}`, [{ type: 'text', text: 'all done' }])
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* []
    throw new Error('stream not supported in test')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function textMessage(id: string, role: 'user' | 'assistant', text: string): Message {
  return {
    id,
    sessionId: SESSION,
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: '2026-11-01T00:00:00.000Z',
  }
}

describe('Agent writes canonical messages to the event log as they are produced', () => {
  test('every step/start reproduces its request from the log; nudge messages are not written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-agent-message-events-'))
    tempDirs.push(dir)
    const store = new SessionEventStore({ basePath: dir })
    store.ensureSession({ v: 1, sessionId: SESSION, schemaVersion: 1, source: 'web' })
    const history = [textMessage('h0', 'user', 'earlier'), textMessage('h1', 'assistant', 'ok')]
    for (const message of history) store.appendMessage(SESSION, message)

    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const adapter = new ScriptedAdapter()
    const toolContext: ToolContext = {
      sessionId: SESSION,
      workDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      adapter,
      registry,
      toolContext,
      { sessionEvents: store },
    )
    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: history,
      dynamicContext: '<system-reminder>request only</system-reminder>',
      tools: registry.getDefinitions(),
    }

    const canonical = [...history]
    await agent.run(context, 'do the task', undefined, (message) => canonical.push(message))

    // 三次正常请求 + 一次记忆提醒请求;提醒消息不转给调用方
    expect(adapter.requests).toHaveLength(4)
    expect(canonical.some((message) => message.controlKind === 'memory_nudge')).toBe(false)

    const events = store.readEvents(SESSION)
    const messageEvents = events.filter(isMessageAppendEvent)
    expect(messageEvents.map((event) => event.data.message)).toEqual(canonical)
    expect(messageEvents.map((event) => event.data.messageIndex)).toEqual(
      canonical.map((_, index) => index),
    )
    expect(
      messageEvents.some((event) =>
        event.data.message.content.some(
          (block) => block.type === 'text' && block.text === MEMORY_NUDGE_PROMPT,
        ),
      ),
    ).toBe(false)

    const turnUser = canonical[history.length]
    const stepStarts = events.filter((event) => event.type === 'step/start')
    expect(stepStarts).toHaveLength(4)
    // 本 turn 的 user 消息与它的请求注入都在第一个 step/start 之前
    const userEvent = messageEvents.find((event) => event.data.message.id === turnUser.id)
    const injection = events.find((event) => event.type === 'injection/context')
    expect(userEvent && injection && userEvent.seq < injection.seq).toBe(true)
    expect(injection && injection.seq < stepStarts[0].seq).toBe(true)

    adapter.requests.forEach((request, index) => {
      const stepStart = stepStarts[index]
      const projection = store.projectUpTo(SESSION, stepStart.seq)
      if (!projection) throw new Error('missing projection')
      // 请求里的消息都已写在 step/start 之前
      const requestIds = new Set(request.messages.map((message) => message.id))
      for (const event of messageEvents) {
        if (requestIds.has(event.data.message.id)) expect(event.seq).toBeLessThan(stepStart.seq)
      }

      const isNudge = request.messages.at(-1)?.controlKind === 'memory_nudge'
      // 记忆提醒消息不进 canonical,提醒请求比投影多出它(后续步骤处理)
      const requestMessages = isNudge ? request.messages.slice(0, -1) : request.messages
      // 首条 user 消息带只在请求里的动态上下文:换回 canonical 内容再比
      const normalized = requestMessages.map((message) =>
        message.id === turnUser.id ? { ...message, content: turnUser.content } : message,
      )
      expect(
        prepareRequestMessages(projection.messages, projection.checkpoint, {
          requireThinkingForToolUse: false,
        }),
      ).toEqual(normalized)
    })
  })
})
