#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// The test controls the server through the task instruction. Never connect to a model.
const workspace = process.env.ZERO_WORKSPACE
const traceFile = join(workspace, 'wire.jsonl')
const record = (event) => appendFileSync(traceFile, `${JSON.stringify(event)}\n`)
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const lines = createInterface({ input: process.stdin })
let threadId = 'thread-fixture'
const turnId = 'turn-fixture'
const turn = (status, error = null) => ({ id: turnId, status, items: [], error })
const event = (method, params) => send({ method, params: { threadId, turnId, ...params } })
const complete = (status, error) => event('turn/completed', { turn: turn(status, error) })
const completedItem = (item) => event('item/completed', { item })

record({
  args: process.argv.slice(2),
  sessionId: process.env.ZERO_SESSION_ID,
  channelId: process.env.ZERO_CHANNEL_ID,
})
for await (const line of lines) {
  const { id, method, params = {}, result } = JSON.parse(line)
  if (method === 'initialize') {
    record({ method })
    send({ id, result: { userAgent: 'worker-fixture' } })
  } else if (method === 'initialized') {
    record({ method })
  } else if (method === 'thread/start' || method === 'thread/resume') {
    threadId = params.threadId ?? threadId
    const { model, cwd, sandbox, approvalPolicy } = params
    record({ method, threadId, model, cwd, sandbox, approvalPolicy })
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
    const mode = params.input[0].text
    record({ method, threadId: params.threadId, mode, sandboxPolicy: params.sandboxPolicy })
    if (mode === 'reject') {
      send({ id, error: { code: -32602, message: 'invalid turn parameters' } })
      continue
    }
    if (mode !== 'early') send({ id, result: { turn: turn('inProgress') } })
    if (mode === 'fail') {
      complete('failed', { message: 'fixture model rejected the turn', codexErrorInfo: null })
    } else if (mode === 'eof') {
      completedItem({ type: 'agentMessage', id: 'partial', text: 'incomplete reply' })
      process.stdin.destroy()
      break
    } else if (mode === 'approval') {
      send({
        id: 'approval-1',
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
  } else if (id === 'approval-1') {
    record({ decision: result?.decision })
    completedItem({ id: 'approval-reply', type: 'agentMessage', text: 'approval was declined' })
    complete('completed')
  } else if (method === 'turn/interrupt') {
    record({ method, threadId: params.threadId, turnId: params.turnId })
    send({ id, result: {} })
    complete('interrupted')
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `unhandled fixture method ${method}` } })
  }
}
