import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage as ZeroIncoming } from '../base'
import type { FetchImpl } from '../weixin/api-transport'
import { WeixinChannel, guessChatType } from '../weixin/channel'
import {
  ITEM_IMAGE,
  ITEM_TEXT,
  SESSION_EXPIRED_PAUSE_MS,
  TYPING_START,
  TYPING_STOP,
} from '../weixin/constants'

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

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: FetchImpl
  calls: FetchCall[]
} {
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

  test('follows OpenClaw direct-only routing even when room_id is present', () => {
    expect(
      guessChatType({ from_user_id: 'u1', to_user_id: 'me', room_id: 'r1@chatroom' }, 'me'),
    ).toEqual({ chatType: 'dm', chatId: 'u1' })
  })

  test('follows OpenClaw direct-only routing even when group_id is present', () => {
    expect(guessChatType({ from_user_id: 'u1', to_user_id: 'me', group_id: 'g1' }, 'me')).toEqual({
      chatType: 'dm',
      chatId: 'u1',
    })
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
        botAgent: 'Zero/0.1 (channel test)',
        sendChunkDelayMs: 0,
      },
      { fetchImpl, sleep: async () => {} },
    )
    await ch.sendToChat('peer', 'hello')
    expect(calls.length).toBe(1)
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      base_info: { channel_version: string; bot_agent: string }
      msg: { item_list: Array<{ text_item?: { text?: string } }> }
    }
    expect(body.base_info.channel_version).toBe('2.4.3')
    expect(body.base_info.bot_agent).toBe('Zero/0.1 (channel test)')
    expect(body.msg.item_list[0].text_item?.text).toBe('hello')
  })

  test('sends typing start and cancel using cached typing ticket', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (new URL(call.url).pathname === '/ilink/bot/getconfig') {
        return new Response(JSON.stringify({ typing_ticket: 'ticket-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    const ch = new WeixinChannel(
      { accountId: 'acc', token: 'tok', homeDir: tempDir },
      { fetchImpl, sleep: async () => {} },
    )
    const internal = ch as unknown as {
      typingNotifier: {
        maybeFetchTicket(chatId: string, contextToken: string | undefined): Promise<void>
      }
    }
    await internal.typingNotifier.maybeFetchTicket('peer', 'context-1')

    await ch.sendTypingIndicator('peer')
    await ch.clearTypingIndicator('peer')

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/ilink/bot/getconfig',
      '/ilink/bot/sendtyping',
      '/ilink/bot/sendtyping',
    ])
    const getConfigBody = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      context_token?: string
      ilink_user_id?: string
    }
    expect(getConfigBody).toMatchObject({
      context_token: 'context-1',
      ilink_user_id: 'peer',
    })
    const statuses = calls.slice(1).map((call) => {
      const body = JSON.parse(String(call.init?.body ?? '{}')) as {
        status?: number
        typing_ticket?: string
      }
      expect(body.typing_ticket).toBe('ticket-1')
      return body.status
    })
    expect(statuses).toEqual([TYPING_START, TYPING_STOP])
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

  test('sends markdown image references as standalone image messages', async () => {
    const sendMessageBodies: Array<{
      msg?: { item_list?: Array<Record<string, unknown>> }
    }> = []
    const { fetchImpl } = makeFetch((call) => {
      const url = String(call.url)
      if (url.includes('getuploadurl')) {
        return new Response(
          JSON.stringify({ upload_param: 'p', upload_full_url: 'https://cdn.example/upload/x' }),
          { status: 200 },
        )
      }
      if (url.startsWith('https://cdn.example/upload/')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'enc-param' } })
      }
      if (url.includes('sendmessage')) {
        sendMessageBodies.push(JSON.parse(String(call.init?.body ?? '{}')))
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    const ch = new WeixinChannel(
      {
        accountId: 'acc',
        token: 'tok',
        homeDir: tempDir,
        sendChunkDelayMs: 0,
      },
      { fetchImpl, sleep: async () => {} },
    )

    await ch.sendToChat('peer', 'Hello\n\n![diagram](data:image/png;base64,aW1n)')

    expect(sendMessageBodies).toHaveLength(2)
    expect(sendMessageBodies[0].msg?.item_list?.[0]).toMatchObject({
      type: ITEM_TEXT,
      text_item: { text: 'Hello' },
    })
    const imageItem = sendMessageBodies[1].msg?.item_list?.[0] as {
      type?: number
      image_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; mid_size?: number }
    }
    expect(imageItem.type).toBe(ITEM_IMAGE)
    expect(imageItem.image_item?.media?.encrypt_query_param).toBe('enc-param')
    expect(imageItem.image_item?.media?.aes_key).toBeTruthy()
    expect(imageItem.image_item?.mid_size).toBeGreaterThan(0)
  })

  test('routes incoming payloads as direct messages like OpenClaw', async () => {
    const received: ZeroIncoming[] = []
    const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
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
    expect(received.length).toBe(1)
    expect(received[0].senderId).toBe('user')
    expect(received[0].content).toBe('hi')
    expect(received[0].metadata).toMatchObject({
      chatType: 'dm',
      chatId: 'user',
    })
  })

  test('DM messages flow through handler and store context token by chatId', async () => {
    const received: ZeroIncoming[] = []
    const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
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
      create_time_ms: 1_765_183_200_000,
      session_id: 'sess1',
      seq: 7,
      message_id: 'm1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    expect(received.length).toBe(1)
    expect(received[0].senderId).toBe('peer')
    expect(received[0].timestamp).toBe('2025-12-08T08:40:00.000Z')
    expect(received[0].metadata).toMatchObject({ sessionId: 'sess1', seq: 7 })
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

  test('stop interrupts a session-expired polling pause', async () => {
    let markPollStarted: (() => void) | undefined
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve
    })
    const fetchImpl: FetchImpl = async (url) => {
      if (String(url).includes('getupdates')) {
        markPollStarted?.()
        return new Response(JSON.stringify({ errcode: -14 }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    const ch = new WeixinChannel(
      { accountId: 'a', token: 't', homeDir: tempDir },
      { fetchImpl },
    )

    await ch.start()
    await pollStarted
    await expect(
      Promise.race([
        ch.stop(),
        Bun.sleep(100).then(() => {
          throw new Error('stop timed out during session-expired polling pause')
        }),
      ]),
    ).resolves.toBeUndefined()

    expect(ch.isConnected()).toBe(false)
  })

  test('start/stop matches OpenClaw by notifying lifecycle endpoints', async () => {
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const calls: string[] = []
    const fetchImplWithHangingPoll: FetchImpl = async (url) => {
      const rawUrl = String(url)
      calls.push(rawUrl)
      if (rawUrl.includes('getupdates')) {
        markFetchStarted?.()
        return await new Promise<Response>(() => {})
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    const ch = new WeixinChannel(
      { accountId: 'a', token: 't', homeDir: tempDir },
      { fetchImpl: fetchImplWithHangingPoll, sleep: async () => {} },
    )

    await ch.start()
    await fetchStarted
    await ch.stop()

    expect(calls.some((url) => url.includes('notifystart'))).toBe(true)
    expect(calls.some((url) => url.includes('notifystop'))).toBe(true)
    expect(calls.some((url) => url.includes('getupdates'))).toBe(true)
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
  test('streaming=false, inline image references=true, maxMessageLength=4000', () => {
    const ch = new WeixinChannel({ accountId: 'a', token: 't', homeDir: tempDir })
    const caps = ch.getCapabilities()
    expect(caps.streaming).toBe(false)
    expect(caps.inlineImages).toBe(true)
    expect(caps.imageMessages).toBe(true)
    expect(caps.markdownNotes).toContain('follow-up image messages')
    expect(caps.maxMessageLength).toBe(4000)
    expect(caps.threadReply).toBe(false)
  })
})
