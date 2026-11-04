import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuDirectPeers, feishuDirectPeerStorePath } from '../direct-peers'
import { FeishuIncomingEventReceiver } from '../index'

test('only verified user DMs supply durable, app-scoped proactive addresses, even before an Agent session exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-feishu-peer-'))
  const path = feishuDirectPeerStorePath(dir, 'test-bot', 'app1')
  const peers = new FeishuDirectPeers(path)
  try {
    expect(peers.list()).toEqual([])
    expect(existsSync(path)).toBe(false)
    const receiver = new FeishuIncomingEventReceiver({
      channelName: 'test-bot',
      incomingBuilder: { build: async () => null, buildRecalled: async () => null },
      directPeers: peers,
    })
    receiver.setMessageHandler(async () => {})
    let id = 0
    const receive = (chatType: string | undefined, actor: string, senderType?: string) =>
      receiver.handleReceived({
        sender: { sender_type: senderType, sender_id: { open_id: actor } },
        message: { message_id: `om_${++id}`, chat_type: chatType, chat_id: 'oc_room' },
      })
    await receive('group', 'ou_from_group', 'user')
    await receive(undefined, 'ou_untyped', 'user')
    await receive('p2p', 'ou_app', 'app')
    await receive('p2p', 'ou_unknown_sender_type')
    await receive('p2p', 'unknown', 'user')
    expect(peers.list()).toEqual([])
    await receive('p2p', 'ou_person', 'user')
    await receive('p2p', 'ou_person', 'user')
    peers.close()
    expect(peers.list()).toEqual([{ chatId: 'oc_room', actorId: 'ou_person' }])
    expect(
      new FeishuDirectPeers(feishuDirectPeerStorePath(dir, 'test-bot', 'app2')).list(),
    ).toEqual([])
    expect(
      new FeishuDirectPeers(feishuDirectPeerStorePath(dir, 'other-bot', 'app1')).list(),
    ).toEqual([])
    await receive('group', 'ou_someone', 'user')
    expect(peers.list()).toEqual([])
  } finally {
    peers.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
