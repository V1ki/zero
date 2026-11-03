import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerEvent, TriggerWxarcSession } from '@zero-os/shared'
import { TriggerRoutingRuntime } from '../routing-runtime'
import { ListenerRuntime } from '../runtime'

function inactiveRouter(store: TriggerStore) {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected route')
  }
  return new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
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

  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rescanned = Promise.withResolvers<void>()
  const calls: { rooms: string[]; cursor: string | null }[] = []
  const runtime = new ListenerRuntime(store, () => undefined, inactiveRouter(store), {
    pollGithub: unexpectedGithubPoll,
    async pollWxarc(selected, cursor) {
      const rooms = selected.map((s) => s.id)
      calls.push({ rooms, cursor })
      if (calls.length === 1) {
        started.resolve()
        await release.promise
        return { cursor: '13', events: [message('room-a', '12'), message('room-b', '13')] }
      }
      rescanned.resolve()
      return { cursor: '14', events: [message('room-a', '12'), message('room-a', '14')] }
    },
  })
  try {
    runtime.start()
    await started.promise
    await runtime.scan()
    expect(calls).toEqual([{ rooms: ['room-a', 'room-b'], cursor: '10' }])
    const config = runtime.getSettings()
    config.settings.wxarc.sessions[1].enabled = false
    runtime.saveSettings(config.settings, config.revision)
    release.resolve()
    await rescanned.promise
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(calls).toEqual([
      { rooms: ['room-a', 'room-b'], cursor: '10' },
      { rooms: ['room-a'], cursor: '10' },
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
  const runtime = new ListenerRuntime(store, () => undefined, inactiveRouter(store), {
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
