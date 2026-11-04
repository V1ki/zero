import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerEvent, TriggerWxarcSession } from '@zero-os/shared'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'
import { ListenerRuntime } from '../runtime'
import { pollWxarc } from '../wxarc'

function inactiveServices(store: TriggerStore) {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected route')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
  return [routing, new RouterWorkspaceService(store, routing, unexpected)] as const
}

function room(id: string): TriggerWxarcSession {
  return { id, name: id, enabled: true, keyword: '' }
}

function message(scope: string, eventId: string): TriggerEvent {
  return { scope, eventId, title: scope, summary: 'matched', occurredAt: '2026-01-01T00:00:00Z' }
}

async function unexpectedGithubPoll(): Promise<never> {
  throw new Error('Unexpected GitHub scan')
}

test('shared WXARC page is retried from the surviving cursor when a selected room is paused in flight', async () => {
  const store = new TriggerStore(':memory:')
  const sessions = [room('room-a'), room('room-b')]
  const revision = store.saveSettings(
    { github: { credentialRef: '', repositories: [] }, wxarc: { sessions } },
    0,
  )
  for (const { id } of sessions) {
    store.commitBatch({
      source: 'wxarc',
      stream: `wxarc:${id}`,
      revision,
      previousCursor: null,
      cursor: '10',
      events: [],
    })
  }

  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const rescanned = Promise.withResolvers<void>()
  const calls: { rooms: string[]; cursor: string | null }[] = []
  const runtime = new ListenerRuntime(store, () => undefined, ...inactiveServices(store), {
    pollGithub: unexpectedGithubPoll,
    async pollWxarc(selected, cursor, signal) {
      const rooms = selected.map((s) => s.id)
      calls.push({ rooms, cursor })
      if (calls.length === 1) {
        started.resolve(signal)
        await release.promise
        return { cursor: '13', events: [message('room-a', '12'), message('room-b', '13')] }
      }
      rescanned.resolve()
      return { cursor: '14', events: [message('room-a', '12'), message('room-a', '14')] }
    },
  })
  try {
    runtime.start()
    const oldSignal = await started.promise
    await runtime.scan()
    expect(calls).toEqual([{ rooms: ['room-a', 'room-b'], cursor: '10' }])
    const config = runtime.getSettings()
    config.settings.wxarc.sessions[1].enabled = false
    runtime.saveSettings(config.settings, config.revision)
    expect(oldSignal.aborted).toBe(true)
    release.resolve()
    await rescanned.promise
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(calls).toEqual([
      { rooms: ['room-a', 'room-b'], cursor: '10' },
      { rooms: ['room-a'], cursor: '10' },
      { rooms: ['room-a'], cursor: '14' },
    ])
    expect(store.readCursor('wxarc:room-a')).toBe('14')
    expect(store.readCursor('wxarc:room-b')).toBeNull()
    expect(runtime.listInbox().map((row) => [row.scope, row.eventId])).toEqual([
      ['room-a', '14'],
      ['room-a', '12'],
    ])
  } finally {
    release.resolve()
    await runtime.close()
  }
})

test('a waiting HTTP stream serves live rooms as other rooms catch up and join at its checkpoint', async () => {
  const store = new TriggerStore(':memory:')
  const sessions = [room('live'), { ...room('catchup'), keyword: '关注' }]
  const revision = store.saveSettings(
    { github: { credentialRef: '', repositories: [] }, wxarc: { sessions } },
    0,
  )
  for (const [index, session] of sessions.entries()) {
    store.commitBatch({
      source: 'wxarc',
      stream: `wxarc:${session.id}`,
      revision,
      previousCursor: null,
      cursor: index === 0 ? '2' : '0',
      events: [],
    })
  }
  const observed = Promise.withResolvers<void>()
  const arrival = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  const traces: string[] = []
  const row = (id: number, session: string, text: string) => ({
    id,
    session,
    text,
    local_type: 1,
    ts: 1_700_000_000,
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      traces.push(url.pathname + url.search)
      const cursor = url.searchParams.get('since_id')
      if (cursor === '0') {
        return Response.json([row(1, 'live', 'before subscription'), row(2, 'catchup', '关注旧项')])
      }
      if (cursor === '2') {
        observed.resolve()
        await arrival.promise
        return Response.json([
          row(3, 'catchup', '忽略'),
          row(4, 'unselected', '关注私人文字'),
          row(5, 'catchup', '关注新项'),
          row(6, 'live', '新项'),
        ])
      }
      resumed.resolve()
      return Response.json([])
    },
  })
  const services = inactiveServices(store)
  const runtime = new ListenerRuntime(store, () => undefined, ...services, {
    pollGithub: unexpectedGithubPoll,
    pollWxarc: (selected, cursor, signal) =>
      pollWxarc(selected, cursor, signal, (url, init) => {
        const { pathname, search } = new URL(url)
        return fetch(new URL(pathname + search, server.url), init)
      }),
  })
  try {
    runtime.start()
    await observed.promise
    for (let n = 0; n < 100 && !store.listInbox().length; n++) await Bun.sleep(5)
    expect(store.listInbox().map((item) => item.summary)).toEqual(['关注旧项'])
    expect(store.readCursor('wxarc:catchup')).toBe('2')
    expect(traces.sort()).toEqual([
      '/text/events?since_id=0&wait=60',
      '/text/events?since_id=2&wait=60',
    ])
    arrival.resolve()
    await resumed.promise
    expect(
      store
        .listInbox()
        .map((item) => item.eventId)
        .sort(),
    ).toEqual(['wxarc:text:2', 'wxarc:text:5', 'wxarc:text:6'])
    expect(store.readCursor('wxarc:live')).toBe('6')
    expect(store.readCursor('wxarc:catchup')).toBe('6')
    expect(traces.filter((url) => url === '/text/events?since_id=6&wait=60')).toHaveLength(1)
  } finally {
    arrival.resolve()
    await runtime.close()
    server.stop(true)
  }
})

test('shutdown aborts pending discovery, discards its late result, and prevents scheduled scans after close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-listener-lifecycle-'))
  const path = join(dir, 'inbox.sqlite')
  const store = new TriggerStore(path)
  store.saveSettings(
    { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [room('room-a')] } },
    0,
  )
  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const runtime = new ListenerRuntime(store, () => undefined, ...inactiveServices(store), {
    pollGithub: unexpectedGithubPoll,
    async pollWxarc(_selected, _cursor, signal) {
      calls++
      started.resolve(signal)
      await release.promise
      return { cursor: '19', events: [message('room-a', '19')], hasMore: true }
    },
  })
  try {
    runtime.start()
    const signal = await started.promise
    const stopped = runtime.close()
    expect(signal.aborted).toBe(true)
    release.resolve()
    await stopped
    await runtime.scan()
    runtime.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toBe(1)
    const reopened = new TriggerStore(path)
    try {
      expect(reopened.readCursor('wxarc:room-a')).toBeNull()
      expect(reopened.listInbox()).toEqual([])
    } finally {
      reopened.close()
    }
  } finally {
    release.resolve()
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WXARC reconnects after a source failure at the last committed checkpoint', async () => {
  const store = new TriggerStore(':memory:')
  const session = room('reconnect')
  const revision = store.saveSettings(
    { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [session] } },
    0,
  )
  store.commitBatch({
    source: 'wxarc',
    stream: 'wxarc:reconnect',
    revision,
    previousCursor: null,
    cursor: '8',
    events: [],
  })
  const failed = Promise.withResolvers<void>()
  const committed = Promise.withResolvers<void>()
  const starts: (string | null)[] = []
  const runtime = new ListenerRuntime(store, () => undefined, ...inactiveServices(store), {
    pollGithub: unexpectedGithubPoll,
    async pollWxarc(_sessions, cursor) {
      starts.push(cursor)
      if (starts.length === 1) {
        failed.resolve()
        throw new Error('WXARC 请求失败（HTTP 503）')
      }
      if (cursor === '8') return { cursor: '9', events: [message(session.id, '9')] }
      committed.resolve()
      return { cursor: '9', events: [] }
    },
  })
  try {
    runtime.start()
    await failed.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(runtime.getStatus()[0]).toMatchObject({
      state: 'error',
      error: 'WXARC 请求失败（HTTP 503）',
    })
    expect(store.readCursor('wxarc:reconnect')).toBe('8')
    await committed.promise
    expect(starts).toEqual(['8', '8', '9'])
    expect(runtime.getStatus()[0]).toMatchObject({ state: 'watching' })
    expect(store.listInbox().map((item) => item.eventId)).toEqual(['9'])
  } finally {
    await runtime.close()
  }
}, 10_000)
