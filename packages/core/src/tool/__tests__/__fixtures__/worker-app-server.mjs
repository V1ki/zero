#!/usr/bin/env bun
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// The test controls the server through the task instruction. Never connect to a model.
const workspace = import.meta.dir
const traceFile = join(workspace, 'wire.jsonl')
const record = (event) => appendFileSync(traceFile, `${JSON.stringify(event)}\n`)
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const lines = createInterface({ input: process.stdin })
const threads = new Map()
const retainedSubscriptions = new Set()
const activeTurns = new Map()
const approvals = new Map()
const zeroKeys = [
  'ZERO_WORKSPACE',
  'ZERO_PROJECT_ROOT',
  'ZERO_SESSION_ID',
  'ZERO_CHANNEL_NAME',
  'ZERO_CHANNEL_ID',
]
const zeroEnv = (env = {}) =>
  Object.fromEntries(zeroKeys.filter((key) => key in env).map((key) => [key, env[key]]))
let turnsStarted = 0
let threadsStarted = 0

function createTurn(threadId) {
  const id = `turn-fixture-${++turnsStarted}`
  const turn = (status, error = null) => ({ id, status, items: [], error })
  const event = (method, params) => send({ method, params: { threadId, turnId: id, ...params } })
  const completedItem = (item) => event('item/completed', { item })
  const complete = (status, error) => {
    event('turn/completed', { turn: turn(status, error) })
    activeTurns.delete(threadId)
  }
  const state = { id, turn, event, completedItem, complete }
  activeTurns.set(threadId, state)
  return state
}

record({
  pid: process.pid,
  cwd: process.cwd(),
  args: process.argv.slice(2),
  inheritedZeroKeys: Object.keys(zeroEnv(process.env)),
})
for await (const line of lines) {
  const { id, method, params = {}, result } = JSON.parse(line)
  if (method === 'initialize') {
    record({ method })
    send({ id, result: { userAgent: 'worker-fixture' } })
  } else if (method === 'initialized') {
    record({ method })
  } else if (method === 'thread/start' || method === 'thread/resume') {
    const threadId = params.threadId ?? `thread-fixture-${++threadsStarted}`
    const env = params.config?.shell_environment_policy?.set
    // A loaded thread can keep the environment it received on its first subscription.
    if (!threads.has(threadId)) threads.set(threadId, zeroEnv(env))
    const { model, cwd, sandbox, approvalPolicy } = params
    record({
      method,
      threadId,
      model,
      cwd,
      sandbox,
      approvalPolicy,
      env: zeroEnv(env),
      extraEnvKeys: Object.keys(env ?? {}).filter((key) => !zeroKeys.includes(key)).length,
    })
    send({
      id,
      result: {
        thread: { id: threadId, turns: [] },
        model,
        cwd,
        approvalPolicy,
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [join(workspace, 'configured-root')],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      },
    })
  } else if (method === 'turn/start') {
    const threadId = params.threadId
    if (!threads.has(threadId) || activeTurns.has(threadId)) {
      send({ id, error: { code: -32602, message: 'thread missing or already active' } })
      continue
    }
    const mode = params.input[0].text
    record({ method, threadId: params.threadId, mode, sandboxPolicy: params.sandboxPolicy })
    if (mode === 'reject') {
      send({ id, error: { code: -32602, message: 'invalid turn parameters' } })
      continue
    }
    const { id: turnId, turn, event, completedItem, complete } = createTurn(threadId)
    if (mode === 'wait for start gate') {
      const deadline = Date.now() + 3000
      const gate = setInterval(() => {
        if (!existsSync(join(workspace, 'allow-turn-start')) && Date.now() < deadline) return
        clearInterval(gate)
        send({ id, result: { turn: turn('inProgress') } })
      }, 5)
      continue
    }
    if (mode !== 'early') send({ id, result: { turn: turn('inProgress') } })
    if (mode === 'keep thread loaded') {
      retainedSubscriptions.add(threadId)
      complete('completed')
    } else if (mode === 'close retained threads') {
      for (const retained of retainedSubscriptions) {
        threads.delete(retained)
        send({ method: 'thread/closed', params: { threadId: retained } })
      }
      retainedSubscriptions.clear()
      complete('completed')
    } else if (mode === 'report thread session') {
      completedItem({
        id: 'session',
        type: 'agentMessage',
        text: threads.get(threadId).ZERO_SESSION_ID,
      })
      complete('completed')
    } else if (mode === 'fail') {
      complete('failed', { message: 'fixture model rejected the turn', codexErrorInfo: null })
    } else if (mode === 'malformed notification') {
      completedItem({ id: 'bad-message', type: 'agentMessage', text: 42 })
    } else if (mode === 'eof') {
      completedItem({ type: 'agentMessage', id: 'partial', text: 'incomplete reply' })
      process.exit(7)
    } else if (mode === 'approval') {
      const approvalId = `approval-${turnId}`
      approvals.set(approvalId, activeTurns.get(threadId))
      send({
        id: approvalId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'dangerous-command', command: 'do not run this' },
      })
    } else if (mode !== 'wait') {
      const delta = 'fixture stdout'
      const outputFile = join(workspace, 'updated.ts')
      event('turn/completed', {
        turn: { id: 'different-turn', status: 'failed', error: { message: 'from other turn' } },
      })
      event('item/commandExecution/outputDelta', { itemId: 'cmd', delta })
      completedItem({
        id: 'cmd',
        type: 'commandExecution',
        command: 'bun test',
        aggregatedOutput: delta,
        exitCode: 0,
        status: 'completed',
      })
      completedItem({
        id: 'edit',
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: outputFile, kind: { type: 'update', move_path: null }, diff: '+new' }],
      })
      completedItem({
        id: 'denied-edit',
        type: 'fileChange',
        status: 'declined',
        changes: [{ path: join(workspace, 'denied.ts'), kind: { type: 'add' }, diff: '+no' }],
      })
      completedItem({
        id: 'move',
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: outputFile,
            kind: { type: 'update', move_path: join(workspace, 'renamed.ts') },
            diff: '',
          },
          { path: join(workspace, 'deleted.ts'), kind: { type: 'delete' }, diff: '-old' },
        ],
      })
      completedItem({ id: 'reply', type: 'agentMessage', text: 'the final worker response' })
      const last = {
        totalTokens: 12,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
      }
      event('thread/tokenUsage/updated', {
        tokenUsage: {
          last,
          total: {
            ...last,
            totalTokens: 1413,
            inputTokens: 1234,
            outputTokens: 179,
            cachedInputTokens: 456,
          },
        },
      })
      complete('completed')
      if (mode === 'early') send({ id, result: { turn: turn('inProgress') } })
    }
  } else if (approvals.has(id)) {
    const { completedItem, complete } = approvals.get(id)
    approvals.delete(id)
    record({ decision: result?.decision })
    completedItem({ id: 'approval-reply', type: 'agentMessage', text: 'approval was declined' })
    complete('completed')
  } else if (method === 'turn/steer') {
    const instruction = params.input?.[0]?.text
    record({ method, ...params })
    const active = activeTurns.get(params.threadId)
    if (!active || params.expectedTurnId !== active.id) {
      send({ id, error: { code: -32602, message: 'turn mismatch' } })
    } else if (instruction === 'reject steer') {
      send({ id, error: { code: -32602, message: 'fixture rejected the adjustment' } })
    } else if (instruction === 'wrong ack') {
      send({ id, result: { turnId: 'different-turn' } })
    } else if (instruction !== 'hold ack') {
      send({ id, result: { turnId: active.id } })
      if (instruction === 'finish with adjusted scope') {
        active.completedItem({ id: 'reply', type: 'agentMessage', text: instruction })
        active.complete('completed')
      }
    }
  } else if (method === 'turn/interrupt') {
    record({ method, threadId: params.threadId, turnId: params.turnId })
    const active = activeTurns.get(params.threadId)
    if (active?.id !== params.turnId) {
      send({ id, error: { code: -32602, message: 'interrupt target mismatch' } })
    } else {
      send({ id, result: {} })
      active.complete('interrupted')
    }
  } else if (method === 'thread/unsubscribe') {
    const { threadId } = params
    record({ method, threadId })
    if (retainedSubscriptions.has(threadId)) {
      send({ id, error: { code: -32603, message: 'fixture still holds subscription' } })
      continue
    }
    const subscribed = threads.delete(threadId)
    send({ id, result: { status: subscribed ? 'unsubscribed' : 'notSubscribed' } })
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `unhandled fixture method ${method}` } })
  }
}
