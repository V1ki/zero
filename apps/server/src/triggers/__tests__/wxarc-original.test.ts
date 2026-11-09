import { expect, test } from 'bun:test'
import { pollWxarc, readWxarcEvent } from '../wxarc'

test('Worker reads the full authorized WXARC message beyond the inbox excerpt, with identity checks', async () => {
  const signal = new AbortController().signal
  const session = { id: 'allowed-room', name: '测试房间', keyword: '', enabled: true }
  const text = `${'初步讨论。'.repeat(100)}最后的限制：不要直接发布，先核对原数据。`
  const row = { id: 10, session: session.id, text, ts: 1700000000, local_type: 1 }
  const batch = await pollWxarc([session], '9', signal, async () => Response.json([row]))
  const event = {
    ...batch.events[0],
    id: 7,
    source: 'wxarc' as const,
    receivedAt: new Date().toISOString(),
  }
  expect(event.summary.length).toBeLessThan(text.length)
  const original = await readWxarcEvent(event, session, signal, async (url) => {
    expect(url).toBe('http://127.0.0.1:8765/ui/refresh?kind=text&ids=10')
    return Response.json([row])
  })
  expect(original.text).toBe(text)
  await expect(
    readWxarcEvent(event, session, signal, async () =>
      Response.json([{ ...row, session: 'other-room' }]),
    ),
  ).rejects.toThrow('不一致')
})
