import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RouterPublicationStore } from '../router-publication-store'

const presentation = { title: '核查结果', text: '找到了相关记录，但尚未确认根因。', actions: [] }
const input = {
  id: 'one',
  principal: 'owner',
  matterId: 'matter',
  matterVersion: 1,
  scope: 'general',
  deliveries: [
    { channel: 'web' as const, presentation, target: null },
    { channel: 'weixin' as const, presentation, target: 'private-pin' },
    { channel: 'feishu' as const, presentation, target: 'other-private-pin' },
  ],
}
test('delivery channels have independent receipts and only a rejected channel can be retried', () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterPublicationStore(db)
    expect(store.prepare(input)).toEqual(store.prepare(input))
    expect(() => store.prepare({ ...input, scope: 'other' })).toThrow('内容发生变化')
    expect(store.get('stranger', 'one')).toBeNull()
    const web = store.claim('owner', 'one', 'web')
    const wx = store.claim('owner', 'one', 'weixin')
    const fs = store.claim('owner', 'one', 'feishu')
    if (!web || !wx || !fs) throw Error('Expected independent delivery claims')
    expect(store.claim('owner', 'one', 'weixin')).toBeNull()
    store.finish('owner', 'one', 'web', web.attempt, {
      status: 'accepted',
      receipt: 'saved',
      reason: null,
    })
    store.finish('owner', 'one', 'weixin', wx.attempt, {
      status: 'unknown',
      receipt: null,
      reason: 'timeout',
    })
    store.finish('owner', 'one', 'feishu', fs.attempt, {
      status: 'rejected',
      receipt: null,
      reason: 'offline',
    })
    for (const channel of ['web', 'weixin'] as const)
      expect(() => store.retry('owner', 'one', channel, 'new')).toThrow('仅能重试')
    store.retry('owner', 'one', 'feishu', 'new')
    expect(store.claim('owner', 'one', 'feishu')).toEqual({ target: 'new', attempt: 2 })
    expect(JSON.stringify(store.get('owner', 'one'))).not.toContain('private-pin')
    expect(store.get('owner', 'one')?.deliveries.find((d) => d.channel === 'web')?.attempt).toBe(1)
  } finally {
    db.close()
  }
})
test('restart preserves pending work but never automatically repeats an unconfirmed send', () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterPublicationStore(db)
    store.prepare(input)
    store.claim('owner', 'one', 'weixin')
    const recovered = new RouterPublicationStore(db)
    expect(recovered.recoverInterrupted()).toBe(1)
    expect(recovered.claim('owner', 'one', 'weixin')).toBeNull()
    expect(
      recovered.get('owner', 'one')?.deliveries.find((d) => d.channel === 'weixin')?.status,
    ).toBe('unknown')
    expect(recovered.pending()).toEqual([{ principal: 'owner', id: 'one' }])
    expect(recovered.claim('owner', 'one', 'web')?.attempt).toBe(1)
  } finally {
    db.close()
  }
})

test('a native message receipt resolves an old publication only for its original platform and audience', () => {
  const db = new Database(':memory:')
  const store = new RouterPublicationStore(db)
  try {
    for (let i = 0; i < 12; i++) {
      const id = 'pub' + i
      store.prepare({
        ...input,
        id,
        deliveries: [
          {
            channel: 'feishu',
            presentation,
            target: JSON.stringify({ audienceKey: 'same-reader' }),
          },
        ],
      })
      const claim = store.claim('owner', id, 'feishu')!
      store.finish('owner', id, 'feishu', claim.attempt, {
        status: i === 11 ? 'unknown' : 'accepted',
        receipt: 'om_' + i,
        reason: null,
      })
    }
    expect(store.recentDeliveredTo('owner', 'feishu', 'same-reader')).toHaveLength(10)
    expect(
      store.recentDeliveredTo('owner', 'feishu', 'same-reader', 'om_0')[0]?.publicationId,
    ).toBe('pub0')
    expect(store.recentDeliveredTo('owner', 'feishu', 'same-reader', 'om_11')).toEqual([])
    expect(store.recentDeliveredTo('owner', 'feishu', 'different-reader', 'om_0')).toEqual([])
    expect(store.recentDeliveredTo('owner', 'dingtalk', 'same-reader', 'om_0')).toEqual([])
    expect(store.recentDeliveredTo('other', 'feishu', 'same-reader', 'om_0')).toEqual([])
  } finally {
    db.close()
  }
})
