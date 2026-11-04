import { expect, spyOn, test } from 'bun:test'
import { FeishuChannel } from '@zero-os/channel'
import type { ChannelSessionBinding, MandateTarget } from '@zero-os/shared'
import { createFeishuTaskDelivery } from '../feishu-task-delivery'

test('only the selected live chat and bound operator can receive a Feishu task; document access is independent of chat binding', async () => {
  const channel = new FeishuChannel({ name: 'office', appId: 'fixture', appSecret: 'fixture' })
  const connected = spyOn(channel, 'isConnected').mockReturnValue(true)
  const send = spyOn(channel.router, 'send').mockResolvedValue({
    status: 'accepted',
    receipt: 'om_native',
  })
  const probe = spyOn(channel.router, 'probeDocument').mockResolvedValue({
    ok: true,
    reason: 'fixture',
  })
  let bindings: ChannelSessionBinding[] = [
    {
      channelName: 'office',
      source: 'feishu',
      channelId: 'oc_chat',
      participantId: 'ou_selected',
      sessionId: 'someone',
      updatedAt: new Date().toISOString(),
    },
  ]
  const service = createFeishuTaskDelivery({
    channels: new Map([['office', channel]]),
    channelDefinitions: new Map([
      [
        'office',
        {
          name: 'office',
          type: 'feishu',
          configured: true,
          secretRefs: [],
          receiveNotifications: false,
        },
      ],
    ]),
    sessionManager: { listCurrentBindings: () => bindings },
  })
  const target: MandateTarget = {
    platform: 'feishu',
    channelId: 'office',
    peerId: 'oc_chat',
    operatorId: 'ou_selected',
  }
  const payload = {
    id: 'notice',
    digest: false,
    entries: [{ matchId: 3, taskId: 2, inboxId: 1, title: 'title', summary: 'summary' }],
  }
  const signal = new AbortController().signal
  expect(service.listTargets()).toEqual([expect.objectContaining(target)])
  expect((await service.send({ ...target, operatorId: 'ou_other' }, payload, signal)).status).toBe(
    'rejected',
  )
  expect((await service.send({ ...target, peerId: 'oc_other' }, payload, signal)).status).toBe(
    'rejected',
  )
  expect(send).not.toHaveBeenCalled()
  expect(await service.send(target, payload, signal)).toEqual({
    status: 'accepted',
    receipt: 'om_native',
  })
  bindings = []
  expect((await service.send(target, payload, signal)).status).toBe('rejected')
  expect(
    await service.probeArchive({ channelId: 'office', documentId: 'docxTarget' }),
  ).toMatchObject({ ok: true })
  expect(probe).toHaveBeenCalledWith('docxTarget')
  connected.mockReturnValue(false)
  expect(service.listArchiveChannels()).toEqual([])
  expect(
    await service.probeArchive({ channelId: 'office', documentId: 'docxTarget' }),
  ).toMatchObject({ ok: false })
})
