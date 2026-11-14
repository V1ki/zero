import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleRequest, hashRequest } from '@zero-os/core'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionEventStore } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  TriggerConversationTurn,
} from '@zero-os/shared'
import { type AgentDependencies, routerLogSessionId, runTriggerModel } from '../event-agent'
import { type RouterAgentInput, createRouterAgent } from '../router-agent'

let logs: string
let store: SessionEventStore
beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'zero-router-log-'))
  store = new SessionEventStore({ basePath: logs })
})
afterEach(() => rmSync(logs, { recursive: true, force: true }))

const hashOf = (request: CompletionRequest) =>
  hashRequest({
    system: request.system ?? '',
    toolNames: (request.tools ?? []).map((tool) => tool.name),
    messages: request.messages,
  })

/** Answers with the scripted responses in order and records the hash of each request received. */
function dependencies(...responses: CompletionResponse['content'][]) {
  const received: string[] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    stream() {
      throw Error('unexpected stream')
    },
    healthCheck: async () => true,
    async complete(request) {
      received.push(hashOf(request))
      const content = responses[received.length - 1]
      if (!content) throw Error('unexpected extra model call')
      const tools = content.some((block) => block.type === 'tool_use')
      return {
        id: `resp-${received.length}`,
        model: 'test',
        content,
        usage: { input: 1, output: 1 },
        stopReason: tools ? 'tool_use' : 'end_turn',
      }
    },
  }
  const deps: AgentDependencies = {
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (text) => text.replaceAll('secret-code', '[redacted]') },
    sessionEvents: store,
  }
  return { deps, received }
}

/** The single call file of `sessionId` in today's Router directory, with its replayed requests. */
function callLog(sessionId: string) {
  const index = JSON.parse(readFileSync(join(logs, 'subagent-index.json'), 'utf-8')) as {
    children: Record<string, string>
  }
  const calls = Object.entries(index.children).filter(([id]) => id.startsWith(`${sessionId}.`))
  expect(calls).toHaveLength(1)
  const [[callId, relative]] = calls
  expect(relative).toBe(`sessions/${routerLogSessionId()}/sub-${callId}.jsonl`)
  const events = store.readEvents(callId)
  const steps = events.filter((event) => event.type === 'step/start')
  const rebuilt = steps.map((event) => {
    const input = store.getRequestAssemblyInput(callId, event.seq)
    if (!input) throw new Error(`step ${event.seq} cannot be rebuilt`)
    return hashRequest(assembleRequest(input))
  })
  return { events, logged: steps.map((event) => event.data.requestHash), rebuilt }
}

test('a Router call with tools writes its own file, and every request can be rebuilt from it', async () => {
  const { deps, received } = dependencies(
    [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'secret-code' } }],
    [{ type: 'text', text: 'done' }],
  )

  const output = await runTriggerModel(deps, {
    sessionId: 'router-job-7',
    purpose: 'router_job',
    label: 'ZeRo 执行任务',
    system: 'system',
    prompt: 'question',
    toolset: {
      definitions: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      execute: async () => 'found',
    },
  })

  expect(output).toBe('done')
  const { events, logged, rebuilt } = callLog('router-job-7')
  expect(events[0].data).toMatchObject({
    origin: 'subagent',
    parentSessionId: routerLogSessionId(),
    name: 'ZeRo 执行任务',
    role: 'router_job',
  })
  expect(events.map((event) => event.type)).toEqual([
    'session',
    'system/prompt',
    'tools/set',
    'loop/start',
    'user/message',
    'step/start',
    'step/end',
    'assistant/message',
    'tool/call',
    'tool/result',
    'user/message',
    'step/start',
    'step/end',
    'assistant/message',
  ])
  expect(logged).toEqual(received)
  expect(rebuilt).toEqual(received)
})

const at = '2026-11-03T08:02:00Z'
const turns: TriggerConversationTurn[] = [
  {
    id: 1,
    requestId: 'request-1',
    status: 'completed',
    question: '为什么延后？ secret-code',
    answer: { text: '当时网页不在场。', intent: 'route', points: ['查阅设置'] },
    createdAt: at,
    updatedAt: at,
    error: null,
  },
  {
    id: 2,
    requestId: 'request-2',
    status: 'failed',
    question: '没有答复的一轮',
    answer: null,
    createdAt: at,
    updatedAt: at,
    error: 'timeout',
  },
  {
    id: 3,
    requestId: 'request-3',
    status: 'completed',
    question: '现在呢？',
    answer: { text: '现在发到网页。' },
    createdAt: at,
    updatedAt: at,
    error: null,
  },
]
const conversation: RouterAgentInput = {
  sessionId: 'router-general',
  question: '接着说。',
  history: turns,
  event: null,
  route: null,
  settings: {
    enabled: true,
    workStart: '09:00',
    workEnd: '18:00',
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    presence: 'auto',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    awayFallback: 'defer',
    weixinTarget: null,
  },
  subscriptions: { github: 0, wxarc: 0 },
  personalBots: [],
}

test('a Router conversation logs the history it sends, so its requests can be rebuilt from the log alone', async () => {
  const { deps, received } = dependencies(
    [{ type: 'tool_use', id: 'call-1', name: 'get_routing_context', input: {} }],
    [{ type: 'text', text: '{"text":"好的。"}' }],
  )

  const answer = await createRouterAgent(deps)(conversation)

  expect(answer.text).toBe('好的。')
  const { events, logged, rebuilt } = callLog('router-general')
  // The history of the two answered turns, written before the loop starts.
  const loopStart = events.findIndex((event) => event.type === 'loop/start')
  const history = events.slice(0, loopStart).filter((event) => event.type.endsWith('/message'))
  expect(history.map((event) => event.type)).toEqual([
    'user/message',
    'assistant/message',
    'user/message',
    'assistant/message',
  ])
  expect(JSON.stringify(history)).toContain('[redacted]')
  expect(JSON.stringify(history)).not.toContain('secret-code')
  expect(logged).toHaveLength(2)
  expect(logged).toEqual(received)
  expect(rebuilt).toEqual(received)
})
