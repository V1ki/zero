import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextTokenStore, WeixinChannel } from '@zero-os/channel'
import type { ChannelSessionBinding, TriggerInboxItem } from '@zero-os/shared'
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

async function setup(sendResponse: () => Response) {
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
  const sink = createTriggerWeixin({
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
    sessionManager: { listCurrentBindings: () => bindings },
  })
  return { sink, sent, disconnect, poll }
}

describe('directed iLink trigger reminders', () => {
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
    [() => Response.json({}), true],
    [() => Response.json({ errcode: 0 }), true],
    [() => Response.json({ base_resp: { ret: 0 } }), true],
    [() => Response.json({ ret: '0' }), true],
    [() => Response.json({ ret: 0, errcode: null }), true],
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
