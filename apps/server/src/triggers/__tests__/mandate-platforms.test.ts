import { expect, test } from 'bun:test'
import { WeixinChannel } from '@zero-os/channel'
import { createMandatePlatforms } from '../mandate-platforms'

function weixinFixture(result: 'accepted' | 'uncertain') {
  const messages: string[] = []
  const channel = Object.assign(Object.create(WeixinChannel.prototype), {
    canSendReminderTo: (peer: string) => peer === 'self',
    sendReminderOnce: async (_peer: string, text: string) => {
      messages.push(text)
      return result
    },
  })
  const bindings = [
    {
      source: 'weixin',
      channelName: 'personal',
      channelId: 'self',
      sessionId: 'bound',
      updatedAt: new Date().toISOString(),
    },
  ]
  const host = {
    channels: new Map([['personal', channel]]),
    channelDefinitions: new Map([['personal', { type: 'weixin', configured: true }]]),
    sessionManager: { listCurrentBindings: () => bindings },
  } as Parameters<typeof createMandatePlatforms>[0]
  const platforms = createMandatePlatforms(host)
  return { platforms, messages, bindings }
}

test('matches the current sender binding exactly and never sends to an unbound operator', async () => {
  const { platforms, messages, bindings } = weixinFixture('accepted')
  const target = {
    platform: 'weixin' as const,
    channelId: 'personal',
    peerId: 'self',
    operatorId: 'self',
  }
  const payload = {
    id: 'delivery',
    digest: false,
    entries: [{ taskId: 1, matchId: 1, inboxId: 1, title: '标题', summary: '已确认的摘要' }],
  }
  expect(platforms.isLiveTarget(target)).toBe(true)
  expect(platforms.isLiveTarget({ ...target, operatorId: undefined })).toBe(false)
  expect(platforms.isLiveTarget({ ...target, operatorId: 'another' })).toBe(false)
  expect(
    (
      await platforms.send(
        { ...target, operatorId: 'another' },
        payload,
        new AbortController().signal,
      )
    ).status,
  ).toBe('rejected')
  expect(
    (await platforms.send(target, payload, new AbortController().signal, () => false)).status,
  ).toBe('rejected')
  expect(messages).toEqual([])
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'accepted',
  )
  expect(messages[0]).toContain('#任务1')
  expect(messages[0]).toContain('已确认的摘要')
  bindings.splice(0)
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'rejected',
  )
  expect(messages).toHaveLength(1)
})

test('bounds a digest while retaining every task reference and propagates unknown receipt', async () => {
  const { platforms, messages } = weixinFixture('uncertain')
  const target = platforms.listTargets()[0]
  const entries = Array.from({ length: 50 }, (_, index) => ({
    taskId: index + 1,
    matchId: index + 1,
    inboxId: index + 1,
    title: '标题',
    summary: '内容'.repeat(500),
  }))
  const payload = { id: 'batch', digest: true, entries }
  const cancelled = new AbortController()
  cancelled.abort()
  expect((await platforms.send(target, payload, cancelled.signal)).status).toBe('rejected')
  expect(messages).toHaveLength(0)
  expect((await platforms.send(target, payload, new AbortController().signal)).status).toBe(
    'unknown',
  )
  expect(messages[0].length).toBeLessThan(4000)
  for (const entry of entries) expect(messages[0]).toContain(`#任务${entry.taskId} `)
})
