import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage as ZeroIncoming } from '../base'
import { WeixinChannel, guessChatType } from '../weixin/channel'
import type { FetchImpl } from '../weixin/api'
import { SESSION_EXPIRED_PAUSE_MS } from '../weixin/constants'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'zero-weixin-ch-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

interface FetchCall {
  url: string
  init?: RequestInit
}

function makeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetchImpl: FetchImpl; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    const call: FetchCall = { url: String(url), init }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

describe('guessChatType', () => {
  test('dm when only from/to are set', () => {
    expect(guessChatType({ from_user_id: 'u1', to_user_id: 'me' }, 'me')).toEqual({
      chatType: 'dm',
      chatId: 'u1',
    })
  })

  test('group when room_id is present', () => {
    expect(
      guessChatType({ from_user_id: 'u1', to_user_id: 'me', room_id: 'r1@chatroom' }, 'me'),
    ).toEqual({ chatType: 'group', chatId: 'r1@chatroom' })
  })

  test('group when group_id is present', () => {
    expect(guessChatType({ from_user_id: 'u1', to_user_id: 'me', group_id: 'g1' }, 'me')).toEqual(
      { chatType: 'group', chatId: 'g1' },
    )
  })
})

describe('WeixinChannel.send', () => {
  test('posts each chunk with injected fetch + base_info', async () => {
    const { fetchImpl, calls } = makeFetch(
      () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    )
    const ch = new WeixinChannel(
      {
        accountId: 'acc',
        token: 'tok',
        homeDir: tempDir,
        sendChunkDelayMs: 0,
      },
      { fetchImpl, sleep: async () => {} },
    )
    await ch.sendToChat('peer', 'hello')
    expect(calls.length).toBe(1)
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      base_info: { channel_version: string }
      msg: { item_list: Array<{ text_item?: { text?: string } }> }
    }
    expect(body.base_info.channel_version).toBe('2.2.0')
    expect(body.msg.item_list[0].text_item?.text).toBe('hello')
  })

  test('retries on error up to sendChunkRetries times', async () => {
    let attempts = 0
    const { fetchImpl } = makeFetch(() => {
      attempts += 1
      if (attempts <= 2) return new Response('err', { status: 500 })
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    const ch = new WeixinChannel(
      {
        accountId: 'a',
        token: 't',
        homeDir: tempDir,
        sendChunkDelayMs: 0,
        sendChunkRetries: 2,
        sendChunkRetryDelayMs: 0,
      },
      { fetchImpl, sleep: async () => {} },
    )
    await ch.sendToChat('peer', 'hi')
    expect(attempts).toBe(3)
  })

  test('respects chat policy (groups disabled by default)', async () => {
    const received: ZeroIncoming[] = []
    const { fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    )
    const ch = new WeixinChannel(
      { accountId: 'me', token: 't', homeDir: tempDir },
      { fetchImpl, sleep: async () => {} },
    )
    ch.setMessageHandler(async (m) => {
      received.push(m)
    })
    const internal = ch as unknown as {
      processMessage: (msg: Record<string, unknown>) => Promise<void>
    }
    await internal.processMessage({
      from_user_id: 'user',
      room_id: 'room@chatroom',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    expect(received.length).toBe(0)
  })

  test('DM messages flow through handler and store context token by chatId', async () => {
    const received: ZeroIncoming[] = []
    const { fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    )
    const ch = new WeixinChannel(
      { accountId: 'me', token: 't', homeDir: tempDir },
      { fetchImpl, sleep: async () => {} },
    )
    ch.setMessageHandler(async (m) => {
      received.push(m)
    })
    const internal = ch as unknown as {
      processMessage: (msg: Record<string, unknown>) => Promise<void>
      tokenStore: { get: (acc: string, chat: string) => string | undefined }
    }
    await internal.processMessage({
      from_user_id: 'peer',
      to_user_id: 'me',
      context_token: 'ctx1',
      message_id: 'm1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    expect(received.length).toBe(1)
    expect(received[0].senderId).toBe('peer')
    expect(internal.tokenStore.get('me', 'peer')).toBe('ctx1')
    await internal.processMessage({
      from_user_id: 'peer',
      to_user_id: 'me',
      message_id: 'm1',
      item_list: [{ type: 1, text_item: { text: 'again' } }],
    })
    expect(received.length).toBe(1)
  })
})

describe('WeixinChannel lifecycle', () => {
  test('stop aborts a hanging poll fetch', async () => {
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const fetchImplWithHangingPoll: FetchImpl = async (url) => {
      if (!String(url).includes('getupdates')) {
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }
      markFetchStarted?.()
      return await new Promise<Response>(() => {})
    }
    const ch = new WeixinChannel(
      { accountId: 'a', token: 't', homeDir: tempDir },
      { fetchImpl: fetchImplWithHangingPoll, sleep: async () => {} },
    )

    await ch.start()
    await fetchStarted
    await ch.stop()

    expect(ch.isConnected()).toBe(false)
  })

  test('session expired pauses outbound sends', async () => {
    let resolvePaused: (() => void) | undefined
    const pausedSeen = new Promise<void>((resolve) => {
      resolvePaused = resolve
    })
    let getUpdatesCount = 0
    const calls: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      const rawUrl = String(url)
      calls.push(rawUrl)
      if (rawUrl.includes('notifystart') || rawUrl.includes('notifystop')) {
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }
      if (rawUrl.includes('getupdates')) {
        getUpdatesCount += 1
        if (getUpdatesCount === 1) {
          return new Response(JSON.stringify({ errcode: -14 }), { status: 200 })
        }
        return await new Promise<Response>(() => {})
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    const ch = new WeixinChannel(
      { accountId: 'a', token: 't', homeDir: tempDir },
      {
        fetchImpl,
        sleep: async (ms) => {
          if (ms === SESSION_EXPIRED_PAUSE_MS) resolvePaused?.()
        },
      },
    )

    await ch.start()
    await pausedSeen
    await expect(ch.sendToChat('peer', 'hello')).rejects.toThrow(/session paused|-14/)
    expect(calls.some((url) => url.includes('sendmessage'))).toBe(false)
    await ch.stop()
  })
})

describe('capabilities', () => {
  test('streaming=false, maxMessageLength=4000', () => {
    const ch = new WeixinChannel({ accountId: 'a', token: 't', homeDir: tempDir })
    const caps = ch.getCapabilities()
    expect(caps.streaming).toBe(false)
    expect(caps.inlineImages).toBe(false)
    expect(caps.imageMessages).toBe(true)
    expect(caps.maxMessageLength).toBe(4000)
    expect(caps.threadReply).toBe(false)
  })
})
