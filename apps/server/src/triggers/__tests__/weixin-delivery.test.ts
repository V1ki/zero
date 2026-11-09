import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextTokenStore, WeixinChannel } from '@zero-os/channel'
import type { ChannelSessionBinding, TriggerInboxItem } from '@zero-os/shared'
import { createMandatePlatforms } from '../mandate-platforms'
import { decideTriggerRoute } from '../routing-policy'
import { createTriggerWeixin } from '../weixin-delivery'

const channelId = 'personal'
const peerId = 'chosen-peer'
const target = { channelId, peerId }
const item: TriggerInboxItem = {
  id: 24,
  source: 'wxarc',
  eventId: 'test-event',
  scope: 'private-room',
  occurredAt: '2026-11-03T00:00:00Z',
  receivedAt: '2026-11-03T00:00:01Z',
  title: 'private-title',
  summary: 'private-message',
}
const bindings: ChannelSessionBinding[] = [
  peerId,
  'blocked-peer',
  'previous-account',
  '*',
  'group@chatroom',
].map((channel) => ({
  source: 'weixin',
  channelName: channelId,
  channelId: channel,
  sessionId: channel,
  updatedAt: '',
}))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function setup(sendResponse: () => Response, currentBindings = bindings) {
  const dir = mkdtempSync(join(tmpdir(), 'zero-trigger-weixin-'))
  const contexts = new ContextTokenStore(dir)
  for (const peer of [peerId, 'blocked-peer', '*', 'group@chatroom'])
    contexts.set('account', peer, 'test-context')
  contexts.set('old-account', 'previous-account', 'old-context')
  const sent: string[] = []
  const poll = Promise.withResolvers<Response>()
  const channel = new WeixinChannel(
    {
      accountId: 'account',
      token: 'test',
      homeDir: dir,
      name: channelId,
      allowFrom: [peerId, 'previous-account', '*', 'group@chatroom'],
      dmPolicy: 'allowlist',
      sendChunkRetries: 2,
    },
    {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith('/getupdates')) return poll.promise
        if (String(url).endsWith('/sendmessage')) {
          sent.push(String(options?.body))
          return sendResponse()
        }
        return Response.json({ ret: 0 })
      },
    },
  )
  function disconnect() {
    const stopped = channel.stop()
    poll.resolve(Response.json({ ret: 0 }))
    return stopped
  }
  cleanups.push(async () => {
    await disconnect()
    rmSync(dir, { recursive: true, force: true })
  })
  await channel.start()
  const host = {
    channels: new Map([[channelId, channel]]),
    channelDefinitions: new Map([
      [
        channelId,
        {
          name: channelId,
          type: 'weixin',
          configured: true,
          receiveNotifications: false,
          secretRefs: [],
        },
      ],
    ]),
    sessionManager: { listCurrentBindings: () => currentBindings },
  } satisfies Parameters<typeof createTriggerWeixin>[0]
  return {
    sink: createTriggerWeixin(host),
    platforms: createMandatePlatforms(host),
    channel,
    sent,
    disconnect,
    poll,
  }
}

describe('directed iLink trigger reminders', () => {
  test.each([
    '{}',
    '{"ret":0,"errmsg":"","trace_id":"unrelated metadata"}',
    '{"ret":0,"message_id":18446744073709551615}',
    '{"message_id":"18446744073709551615"}',
  ])('accepts a Tencent success receipt without claiming a read confirmation: %s', async (raw) => {
    const { platforms, sent } = await setup(() => new Response(raw), [])
    const [dm] = platforms.listPersonalDirectTargets()
    const result = await platforms.sendDirect(
      dm,
      '提醒',
      'id',
      new AbortController().signal,
      () => true,
    )
    expect(result).toEqual({ status: 'accepted' })
    expect(sent).toHaveLength(1)
  })

  test.each([
    [
      200,
      '{"ret":-2,"errcode":-14,"errmsg":"private platform detail"}',
      'rejected',
      'ret=-2，errcode=-14',
    ],
    [403, 'private platform detail', 'rejected', 'HTTP 403'],
    [429, 'private platform detail', 'rejected', 'HTTP 429'],
    [408, 'private platform detail', 'unknown', 'HTTP 408'],
    [503, 'private platform detail', 'unknown', 'HTTP 503'],
    [200, 'private platform detail', 'unknown', '核对'],
  ] as const)(
    'forwards only safe receipt details to Router for HTTP %i',
    async (code, raw, status, detail) => {
      const { platforms, sent } = await setup(() => new Response(raw, { status: code }), [])
      const [dm] = platforms.listPersonalDirectTargets()
      const result = await platforms.sendDirect(
        dm,
        '提醒',
        'id',
        new AbortController().signal,
        () => true,
      )
      expect(result).toMatchObject({ status, reason: expect.stringContaining(detail) })
      expect(JSON.stringify(result)).not.toContain('private')
      expect(sent).toHaveLength(1)
    },
  )

  test('the existing one-shot channel method still returns the status without resending', async () => {
    const { channel, sent } = await setup(() => Response.json({}))
    expect(await channel.sendReminderOnce(peerId, '提醒')).toBe('accepted')
    expect(sent).toHaveLength(1)
  })

  test('manual private reminders send only the requested text and a stable, non-identifying client ID', async () => {
    const { platforms, sent } = await setup(() => Response.json({ ret: 0 }), [])
    const [dm] = platforms.listPersonalDirectTargets()
    const signal = new AbortController().signal
    for (const id of ['first-request', 'first-request', 'a-separate-request']) {
      expect(
        (await platforms.sendDirect(dm, '处理 DeepSeek 的充值', id, signal, () => true)).status,
      ).toBe('accepted')
    }
    const messages = sent.map((body) => JSON.parse(body).msg)
    expect(messages[0].item_list[0].text_item.text).toBe('处理 DeepSeek 的充值')
    expect(messages[0].client_id).not.toContain('first-request')
    expect(messages[0].client_id).toBe(messages[1].client_id)
    expect(messages[0].client_id).not.toBe(messages[2].client_id)
    expect(
      (await platforms.sendDirect(dm, '已撤销', 'fourth-request', signal, () => false)).status,
    ).toBe('rejected')
    expect(sent).toHaveLength(3)
  })
  test('long reminders retain line breaks, Unicode and the last fact across individually acknowledged messages', async () => {
    const { platforms, sent } = await setup(() => Response.json({ ret: 0 }), [])
    const [dm] = platforms.listPersonalDirectTargets()
    const text = '结论在前。\n\n' + '核'.repeat(3999) + '🌿' + '\n    原始证据与下一步。'
    const send = () =>
      platforms.sendDirect(dm, text, 'long-request', new AbortController().signal, () => true)
    expect((await send()).status).toBe('accepted')
    const messages = sent.map((raw) => JSON.parse(raw).msg)
    const parts = messages.map((m) => m.item_list[0].text_item.text as string)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(text)
    expect(
      parts.every(
        (p) =>
          p.length <= 4000 && [...p].every((c) => c.length !== 1 || !/[\uD800-\uDFFF]/u.test(c)),
      ),
    ).toBe(true)
    expect(new Set(messages.map((m) => m.client_id)).size).toBe(messages.length)
  })

  test.each(['rejected', 'revoked'] as const)(
    'stops multi-part delivery after %s and reports its accepted prefix',
    async (mode) => {
      let accepted = 0
      const { platforms, sent } = await setup(() => {
        if (accepted++) return Response.json({ ret: -2 })
        return Response.json({ ret: 0 })
      }, [])
      const [dm] = platforms.listPersonalDirectTargets()
      const result = await platforms.sendDirect(
        dm,
        '段'.repeat(9000),
        'partial-request',
        new AbortController().signal,
        () => mode === 'rejected' || accepted === 0,
      )
      expect(result).toMatchObject({
        status: 'unknown',
        reason: expect.stringContaining('前 1 段已受理'),
      })
      expect(sent.length).toBe(mode === 'revoked' ? 1 : 2)
    },
  )
  test('a verified direct peer can receive a personal reminder without an Agent session', async () => {
    const { sink, sent } = await setup(() => Response.json({ ret: 0 }), [])
    expect(sink.listTargets()).toEqual([])
    expect(sink.listDirectTargets()).toEqual([{ ...target, label: `${channelId} · ${peerId}` }])
    await sink.send(target, item, { summary: '摘要' })
    expect(JSON.parse(sent[0]).msg.to_user_id).toBe(peerId)
  })

  test('only a current allowed DM can receive a single text item without private WXARC content', async () => {
    const { sink, sent } = await setup(() => Response.json({ ret: 0 }))
    expect(sink.listTargets()).toEqual([{ ...target, label: `${channelId} · ${peerId}` }])
    for (const peer of ['blocked-peer', 'previous-account', '*', 'group@chatroom']) {
      await expect(
        sink.send({ ...target, peerId: peer }, item, { summary: 'private-summary' }),
      ).rejects.toMatchObject({ uncertain: false })
    }
    await sink.send(target, item, { summary: 'private-summary' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('private-')
    const msg = JSON.parse(sent[0]).msg
    expect(msg.to_user_id).toBe(peerId)
    expect(msg.context_token).toBe('test-context')
    expect(msg.item_list).toHaveLength(1)
    expect(msg.item_list[0].text_item.text).toContain('#24')
  })

  test.each(['disconnected', 'expired'] as const)(
    'defers the selected Weixin route when the channel is %s',
    async (state) => {
      const { sink, sent, disconnect, poll } = await setup(() => Response.json({ ret: 0 }))
      const decide = () =>
        decideTriggerRoute(
          {
            enabled: true,
            timeZone: 'UTC',
            workdays: [1],
            workStart: '09:00',
            workEnd: '18:00',
            presence: 'present',
            duringWork: 'weixin',
            afterWork: 'defer',
            offDay: 'defer',
            awayFallback: 'defer',
            weixinTarget: target,
          },
          new Date('2026-11-02T12:00:00Z'),
          undefined,
          sink
            .listTargets()
            .some((entry) => entry.channelId === channelId && entry.peerId === peerId),
        ).destination
      expect(decide()).toBe('weixin')
      if (state === 'disconnected') {
        await disconnect()
      } else {
        poll.resolve(Response.json({ errcode: -14 }))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(decide()).toBe('defer')
      expect(sent).toHaveLength(0)
    },
  )

  test.each([
    [() => Response.json({ ret: 0, errcode: -14, errmsg: 'sensitive response' }), false],
    [() => Response.json({ ret: -1 }), false],
    [() => new Response(''), true],
    [() => Response.json(null), true],
    [() => Response.json([]), true],
    [() => Response.json(0), true],
    [() => Response.json({ trace_id: 'arbitrary' }), true],
    [() => Response.json({ errcode: 0 }), true],
    [() => Response.json({ base_resp: { ret: 0 } }), true],
    [() => Response.json({ ret: '0' }), true],
    [() => Response.json({ ret: 0, errcode: null }), true],
    [() => Response.json({ ret: 0, errmsg: 'sensitive error' }), true],
    [() => Response.json({ ret: 0, base_resp: { ret: -1 } }), true],
    [() => Response.json({ ret: 0, error: 'unknown delivery' }), true],
    [() => Response.json({ message_id: '18446744073709551616' }), true],
    [() => Response.json({ message_id: '0' }), true],
    [() => Response.json({ message_id: {} }), true],
    [() => new Response('sensitive response'), true],
    [() => new Response('sensitive response', { status: 503 }), true],
    [
      () => {
        throw new TypeError('sensitive transport detail')
      },
      true,
    ],
  ] as const)(
    'classifies the platform result without retry or leaking its body',
    async (response, uncertain) => {
      const { sink, sent } = await setup(response)
      let failure: unknown
      try {
        await sink.send(target, item, { summary: 'private-summary' })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ name: 'TriggerWeixinDeliveryError', uncertain })
      expect(String(failure)).not.toContain('sensitive')
      expect(sent).toHaveLength(1)
    },
  )
})
