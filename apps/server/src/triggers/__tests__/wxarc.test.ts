import { describe, expect, test } from 'bun:test'
import { listWxarcSessions, pollWxarc } from '../wxarc'

const signal = new AbortController().signal
const session = { id: 'project-room', name: '测试项目群', keyword: '发布失败', enabled: true }
const row = (id: number, source: string, text: string) => ({
  id,
  session: source,
  sender: '显示名',
  session_name: '上游显示名',
  text,
  ts: 1_700_000_000,
  local_type: 1,
})

describe('WXARC local text connector', () => {
  test('selectable sessions expose stable IDs and names only', async () => {
    const sessions = await listWxarcSessions(signal, async (url, init) => {
      expect(url).toBe('http://127.0.0.1:8765/text/sessions?limit=10000')
      expect(init.redirect).toBe('error')
      return Response.json([
        { username: 'a', name: '相同昵称', last_timestamp: 8, message_count: 12 },
        { username: 'b', name: '相同昵称', ignored_extra: 'private' },
      ])
    })
    expect(sessions).toEqual([
      { id: 'a', name: '相同昵称' },
      { id: 'b', name: '相同昵称' },
    ])
  })

  test('new subscription establishes current tail without reading message history', async () => {
    const result = await pollWxarc([session], null, signal, async (url) => {
      expect(new URL(url).pathname).toBe('/ui/bootstrap')
      return Response.json({ cursors: { text: 400, media: 99 }, health: { other: 'private' } })
    })
    expect(result).toEqual({ cursor: '400', events: [] })
  })

  test('advances across ignored messages, then drains backlog without retaining their content', async () => {
    const early = Array.from({ length: 200 }, (_, n) =>
      row(n + 1, 'private', '发布失败 · 未授权正文'),
    )
    const received = await pollWxarc([session], '0', signal, async () => Response.json(early))
    expect(received).toEqual({ cursor: '200', events: [], hasMore: true })
    const next = await pollWxarc([session], received.cursor, signal, async (url) => {
      expect(new URL(url).searchParams.get('since_id')).toBe('200')
      return Response.json([
        row(201, session.id, '忽略'),
        { ...row(202, session.id, '发布失败 · XML'), local_type: 49 },
        row(203, session.id, '发布失败，请检查 '),
      ])
    })
    expect(next).toEqual({
      cursor: '203',
      events: [
        {
          eventId: 'wxarc:text:203',
          scope: session.id,
          title: '测试项目群 · 新微信文字',
          summary: '发布失败，请检查',
          occurredAt: '2023-11-14T22:13:20.000Z',
        },
      ],
      hasMore: false,
    })
  })

  test('detects reset and preserves the previous cursor if producer appends after an empty page', async () => {
    const poll = (tail: number) =>
      pollWxarc([session], '90', signal, async (url) =>
        Response.json(new URL(url).pathname === '/text/events' ? [] : { cursors: { text: tail } }),
      )
    await expect(poll(80)).rejects.toThrow('水位已回退')
    expect(await poll(91)).toEqual({ cursor: '90', events: [], hasMore: true })
  })

  test('corrupt pages and upstream error bodies never leak text or advance the cursor', async () => {
    await expect(
      pollWxarc([session], '10', signal, async () =>
        Response.json([
          row(11, session.id, '发布失败 · 私人文字'),
          row(10, session.id, '私人文字'),
        ]),
      ),
    ).rejects.toThrow('顺序或会话标识')
    await expect(
      listWxarcSessions(signal, async () => new Response('private secret')),
    ).rejects.toThrow('WXARC 返回的数据不是有效 JSON')
    await expect(
      listWxarcSessions(signal, async () => new Response('private secret', { status: 503 })),
    ).rejects.toThrow('WXARC 请求失败（HTTP 503）')
  })
})
