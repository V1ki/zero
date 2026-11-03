import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerClient } from '../worker/app-server-client'

let client: CodexAppServerClient | undefined
let directory: string | undefined

type ClientOptions = ConstructorParameters<typeof CodexAppServerClient>[0]
type Observers = Partial<
  Pick<ClientOptions, 'onNotification' | 'onLateResult' | 'onLateResumeRejected'>
>

function startServer(behavior: string, observers: Observers = {}) {
  directory = mkdtempSync(join(tmpdir(), 'zero-worker-rpc-'))
  const codexPath = join(directory, 'fake-codex.cjs')
  writeFileSync(
    codexPath,
    `#!${process.execPath}
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = (message) => console.log(JSON.stringify(message));
const requests = [];
lines.on('line', (line) => {
  const message = JSON.parse(line);
  ${behavior}
});
`,
    { mode: 0o700 },
  )
  client = new CodexAppServerClient({
    codexPath,
    cwd: directory,
    env: {},
    onNotification: () => {},
    ...observers,
  })
  return client
}

afterEach(async () => {
  try {
    await client?.close()
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true })
    client = undefined
    directory = undefined
  }
})

describe('CodexAppServerClient', () => {
  test('matches out-of-order replies by ID and dispatches interleaved notifications', async () => {
    const notifications: unknown[] = []
    const server = startServer(
      `
      if (message.id === undefined) {
        send({ method: 'echo', params: message.params });
      } else if (message.method === 'unsupported') {
        send({ id: message.id, error: { code: -32601, message: 'fixture error' } });
      } else {
        requests.push(message);
        if (requests.length === 2) {
          for (const request of requests.reverse()) {
            send({ id: request.id, result: { name: request.method } });
          }
        }
      }
      `,
      { onNotification: (method, params) => notifications.push([method, params]) },
    )
    server.notify('ready', { sequence: 1 })
    const results = await Promise.all([server.request('first', {}), server.request('second', {})])
    expect(results).toEqual([{ name: 'first' }, { name: 'second' }])
    expect(notifications).toEqual([['echo', { sequence: 1 }]])
    await expect(server.request('unsupported', {})).rejects.toThrow('fixture error')
  })

  test('reports a late thread/start result once and keeps the shared connection usable', async () => {
    const lateResults: unknown[] = []
    const server = startServer(
      `
      if (message.method === 'thread/start') {
        requests.push(message);
      } else {
        const reply = { id: requests[0].id, result: { thread: { id: 'late-thread' } } };
        send(reply);
        send(reply);
        send({ id: message.id, result: { healthy: true } });
      }
      `,
      { onLateResult: (method, result) => lateResults.push([method, result]) },
    )
    await expect(server.request('thread/start', {}, { timeoutMs: 25 })).rejects.toThrow(
      /timed out/i,
    )
    // Release the held response only after the client has observed the timeout.
    expect(await server.request('release', {})).toEqual({ healthy: true })
    expect(lateResults).toEqual([['thread/start', { thread: { id: 'late-thread' } }]])
  })

  test('isolates RPC errors but rejects all pending calls for an ID never issued', async () => {
    const server = startServer(`
      if (message.method === 'wait') {
        requests.push(message);
      } else if (message.method === 'reject') {
        send({ id: message.id, error: { code: -32602, message: 'invalid request' } });
        send({ id: requests.pop().id, result: { healthy: true } });
      } else {
        send({ id: 999999, result: {} });
      }
    `)
    const healthy = server.request('wait', {})
    await expect(server.request('reject', {})).rejects.toThrow('invalid request')
    expect(await healthy).toEqual({ healthy: true })

    const results = await Promise.allSettled([
      server.request('wait', {}),
      server.request('unknown', {}),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect((await server.closed).message).toMatch(/response ID/i)
  })

  test('correlates out-of-order late resumes by requested thread ID even when the server returns a different thread', async () => {
    const outcomes: unknown[] = []
    const server = startServer(
      `
      if (message.method === 'thread/resume') {
        requests.push(message);
      } else {
        const [first, second] = requests;
        const denied = { id: second.id, error: { code: -32602, message: 'not resumable' } };
        const resumed = { id: first.id, result: { thread: { id: 'different-thread' } } };
        for (const reply of [denied, resumed, denied, resumed]) send(reply);
        send({ id: message.id, result: {} });
      }
      `,
      {
        onLateResult: (method, result, requestedId) => outcomes.push([method, requestedId, result]),
        onLateResumeRejected: (requestedId) => outcomes.push(['rejected', requestedId]),
      },
    )
    const resume = (threadId: string) =>
      server.request('thread/resume', { threadId }, { timeoutMs: 25 })
    const results = await Promise.allSettled([resume('first-thread'), resume('second-thread')])
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { message: expect.stringMatching(/timed out/i) },
      })
    }
    await server.request('release', {})
    expect(outcomes).toEqual([
      ['rejected', 'second-thread'],
      ['thread/resume', 'first-thread', { thread: { id: 'different-thread' } }],
    ])
  })

  test('answers server approval requests without confusing them with client requests', async () => {
    const server = startServer(`
      if (message.method) {
        requests.push(message);
        send({ id: message.id, method: message.params.ask, params: {} });
      } else {
        send({ id: requests.pop().id, result: { reply: message.result ?? message.error } });
      }
    `)
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ]) {
      expect(await server.request('probe', { ask: method })).toEqual({
        reply: { decision: 'decline' },
      })
    }
    expect(await server.request('probe', { ask: 'item/permissions/requestApproval' })).toEqual({
      reply: { permissions: {}, scope: 'turn' },
    })
    expect(await server.request('probe', { ask: 'mcpServer/elicitation/request' })).toMatchObject({
      reply: { action: 'decline' },
    })
    expect(await server.request('probe', { ask: 'unknown/method' })).toMatchObject({
      reply: { code: -32601 },
    })
  })

  test.each([
    ['malformed JSON', "process.stdout.write('invalid-json\\n');"],
    ['unexpected exit', 'process.exit(7);'],
  ])('settles all pending calls and closed on %s', async (_reason, behavior) => {
    const server = startServer(behavior)
    const pending = await Promise.allSettled([
      server.request('first', {}),
      server.request('second', {}),
    ])
    expect(pending.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(await server.closed).toBeInstanceOf(Error)
    await Promise.all([server.close(), server.close()])
  })

  test('reports a missing executable and finishes cleanup', async () => {
    directory = mkdtempSync(join(tmpdir(), 'zero-worker-missing-'))
    const cwd = directory
    const connect = async () => {
      client = new CodexAppServerClient({
        cwd,
        env: {},
        codexPath: join(cwd, 'not-installed'),
        onNotification: () => {},
      })
      await client.request('initialize', {})
    }
    await expect(connect()).rejects.toThrow(/ENOENT|not-installed/)
    // Bun can fail synchronously during spawn; Node can signal an error after construction.
    if (client) {
      expect(await client.closed).toBeInstanceOf(Error)
      await client.close()
    }
  })

  test('retains a useful stderr diagnostic without exposing bearer credentials', async () => {
    const server = startServer(`
      process.stderr.write('fixture authentication failure: Bearer dummy-private-value\\n', () => process.exit(1));
    `)
    await expect(server.request('initialize', {})).rejects.toThrow('fixture authentication failure')
    expect((await server.closed).message).not.toContain('dummy-private-value')
  })
})
