import { expect, test } from 'bun:test'
import { pollWxarc } from '../wxarc'

const room = { id: 'project-room', name: '项目群', keyword: '发布', enabled: true }
const privateHistory = '不可传入 Router 的旧消息正文'
const plain = (id: number, searchId: number, scope = room.id) => ({
  id,
  session: scope,
  ts: 1_700_000_000 + id,
  local_type: 1,
  text: '发布进度',
  quote_thread_id: searchId,
})
const quote = (local_type = 57) => ({
  ...plain(92, 9902),
  local_type,
  text: '[引用消息]',
  quote: { status: 'available', body: '发布验证通过', target_id: 6801, text: privateHistory },
})

async function poll(incoming: object[], recentIds: number[] = [], refreshed: object[] = []) {
  const lookups: number[][] = []
  const recent = recentIds.map((id) => ({
    id,
    occurredAt: new Date(plain(id, 6801).ts * 1000).toISOString(),
    summary: '发布进度',
  }))
  const result = await pollWxarc(
    [room],
    '90',
    new AbortController().signal,
    async (url) => {
      const { pathname, searchParams } = new URL(url)
      if (pathname === '/text/events') return Response.json(incoming)
      expect(pathname).toBe('/ui/refresh')
      expect(searchParams.get('kind')).toBe('text')
      const ids = (searchParams.get('ids') ?? '').split(',').map(Number)
      expect(ids.every((id) => id === 92 || recentIds.includes(id))).toBe(true)
      lookups.push(ids)
      return Response.json(refreshed)
    },
    (scope) => (scope === room.id ? recent : []),
  )
  expect(JSON.stringify(result)).not.toContain(privateHistory)
  return { result, lookups }
}

test.each([57, 57 * 2 ** 32 + 49])(
  'WXARC quote type %i resolves a search message ID to a previous event from the authorized room',
  async (localType) => {
    const { result, lookups } = await poll(
      [quote(localType)],
      [41],
      [plain(41, 6801), quote(localType)],
    )
    expect(lookups.map((ids) => ids.toSorted((a, b) => a - b))).toEqual([[41, 92]])
    expect(result.events).toMatchObject([
      { eventId: 'wxarc:text:92', wxarcReplyToEventId: 'wxarc:text:41', summary: '发布验证通过' },
    ])
  },
)

test('a matched earlier event on the same page can receive the next reply', async () => {
  const { result } = await poll([plain(91, 6801), quote()])
  expect(result.events[1]).toMatchObject({ wxarcReplyToEventId: 'wxarc:text:91' })
})

test('ambiguous, changed, cross-room, or unsolicited refresh rows cannot bind a reply', async () => {
  for (const { recent, rows } of [
    { recent: [41, 42], rows: [plain(41, 6801), plain(42, 6801), quote()] },
    { recent: [41], rows: [plain(41, 6801, 'private-other-room'), quote()] },
    { recent: [41], rows: [plain(42, 6801), quote()] },
    { recent: [41], rows: [{ ...plain(41, 6801), ts: 1_700_000_111 }, quote()] },
    { recent: [41], rows: [{ ...plain(41, 6801), text: '发布内容已替换' }, quote()] },
    { recent: [41], rows: [plain(41, 6801)] },
    { recent: [41], rows: [plain(41, 6801), { ...quote(), session: 'other' }] },
    { recent: [], rows: [] },
  ]) {
    const { result } = await poll([quote()], recent, rows)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).not.toHaveProperty('wxarcReplyToEventId')
  }
})

test('quoted history cannot match a keyword and plaintext cannot claim predecessor identity', async () => {
  const quoted = quote()
  const { result } = await poll([
    { ...plain(91, 9091), text: '发布 回复 wxarc:text:41 / quote.target_id=6801' },
    { ...quoted, quote: { ...quoted.quote, body: '收到', text: `发布 ${privateHistory}` } },
  ])
  expect(result.events).toHaveLength(1)
  expect(result.events[0]).not.toHaveProperty('wxarcReplyToEventId')
})

test('a parent outside the selected keyword cannot establish a same-batch worker binding', async () => {
  const { result } = await poll([{ ...plain(91, 6801), text: '个人生活' }, quote()])
  expect(result.events).toHaveLength(1)
  expect(result.events[0]).not.toHaveProperty('wxarcReplyToEventId')
})

test('an unavailable optional quote index cannot block inbox intake or expose its response', async () => {
  for (const [status, body] of [
    [404, 'not installed'],
    [503, 'unavailable'],
    [200, privateHistory],
  ] as const) {
    const result = await pollWxarc(
      [room],
      '90',
      new AbortController().signal,
      async (url) =>
        new URL(url).pathname === '/text/events'
          ? Response.json([plain(91, 9991), quote()])
          : new Response(body, { status }),
      () => [
        {
          id: 41,
          occurredAt: new Date(plain(41, 6801).ts * 1000).toISOString(),
          summary: '发布进度',
        },
      ],
    )
    expect(result.cursor).toBe('92')
    expect(result.events.map((event) => event.eventId)).toEqual(['wxarc:text:91', 'wxarc:text:92'])
    expect(result.events[1]).not.toHaveProperty('wxarcReplyToEventId')
    expect(JSON.stringify(result)).not.toContain(privateHistory)
  }
})

test('cancelling an optional history refresh cancels the intake batch', async () => {
  const controller = new AbortController()
  await expect(
    pollWxarc(
      [room],
      '90',
      controller.signal,
      async (url, init) => {
        if (new URL(url).pathname === '/text/events') return Response.json([quote()])
        controller.abort(new DOMException('stop WXARC intake', 'AbortError'))
        init.signal?.throwIfAborted()
        throw Error('expected refresh cancellation')
      },
      () => [
        {
          id: 41,
          occurredAt: new Date(plain(41, 6801).ts * 1000).toISOString(),
          summary: '发布进度',
        },
      ],
    ),
  ).rejects.toThrow('stop WXARC intake')
})
