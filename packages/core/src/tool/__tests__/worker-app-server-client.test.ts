import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerClient } from '../worker/app-server-client'

let client: CodexAppServerClient | undefined
let directory: string | undefined

function startServer(
  behavior: string,
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {},
) {
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
  client = new CodexAppServerClient({ codexPath, cwd: directory, env: {}, onNotification })
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
      (method, params) => notifications.push([method, params]),
    )
    server.notify('ready', { sequence: 1 })
    const results = await Promise.all([server.request('first', {}), server.request('second', {})])
    expect(results).toEqual([{ name: 'first' }, { name: 'second' }])
    expect(notifications).toEqual([['echo', { sequence: 1 }]])
    await expect(server.request('unsupported', {})).rejects.toThrow('fixture error')
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
