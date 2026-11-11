import type { TriggerEvent, TriggerWxarcSession } from '@zero-os/shared'

const WXARC_ORIGIN = 'http://127.0.0.1:8765'
const PAGE_SIZE = 200
const LONG_POLL_SECONDS = 60
const EXCERPT_LENGTH = 240
type WxarcFetch = (url: string, init: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function readJson(
  path: string,
  signal: AbortSignal,
  fetcher: WxarcFetch,
  waitSeconds = 0,
): Promise<unknown> {
  const response = await fetcher(WXARC_ORIGIN + path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 15) * 1000)]),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`WXARC 请求失败（HTTP ${response.status}）`)
  }
  try {
    return await response.json()
  } catch (error) {
    // JSON parse errors can quote the upstream body, including private messages.
    if (error instanceof SyntaxError) throw new Error('WXARC 返回的数据不是有效 JSON')
    throw error
  }
}

export async function listWxarcSessions(signal: AbortSignal, fetcher: WxarcFetch = fetch) {
  const rows = await readJson('/text/sessions?limit=10000', signal, fetcher)
  if (!Array.isArray(rows)) throw new Error('WXARC 会话列表格式无效')
  return rows.map((row: unknown) => {
    if (!isObject(row) || typeof row.username !== 'string' || !row.username) {
      throw new Error('WXARC 会话缺少稳定标识')
    }
    return {
      id: row.username,
      name: typeof row.name === 'string' && row.name ? row.name : row.username,
    }
  })
}

async function readTail(signal: AbortSignal, fetcher: WxarcFetch, floor = 0) {
  const result = await readJson('/ui/bootstrap', signal, fetcher)
  if (!isObject(result) || !isObject(result.cursors) || !isWatermark(result.cursors.text)) {
    throw new Error('WXARC 文字流水位无效')
  }
  if (result.cursors.text < floor) {
    throw new Error('WXARC 文字流水位已回退，请核对数据来源并重新建立订阅基线')
  }
  const listener = isObject(result.health) && result.health.listener
  if (isObject(listener)) {
    if (listener.running === false) throw new Error('WXARC 文字监听器未运行')
    if (isObject(listener.text) && listener.text.last_error) {
      throw new Error('WXARC 文字采集异常，请检查本机监听器')
    }
  }
  return result.cursors.text
}

export async function pollWxarc(
  sessions: TriggerWxarcSession[],
  previousCursor: string | null,
  signal: AbortSignal,
  fetcher: WxarcFetch = fetch,
): Promise<{ cursor: string; events: TriggerEvent[]; hasMore?: boolean }> {
  if (previousCursor === null) {
    return { cursor: String(await readTail(signal, fetcher)), events: [] }
  }
  const start = Number(previousCursor)
  if (!isWatermark(start) || String(start) !== previousCursor) {
    throw new Error('WXARC 已保存的文字流水位无效')
  }
  const allowed = new Map(sessions.filter((s) => s.enabled).map((s) => [s.id, s]))
  if (!allowed.size) return { cursor: previousCursor, events: [] }

  const rows = await readJson(
    `/text/events?since_id=${start}&wait=${LONG_POLL_SECONDS}`,
    signal,
    fetcher,
    LONG_POLL_SECONDS,
  )
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('WXARC 文字事件批次无效')
  if (!rows.length) {
    const tail = await readTail(signal, fetcher, start)
    // The producer can append between the empty read and bootstrap. Read it next.
    return { cursor: previousCursor, events: [], hasMore: tail > start }
  }

  const events: TriggerEvent[] = []
  let last = start
  for (const row of rows as unknown[]) {
    if (
      !isObject(row) ||
      !isWatermark(row.id) ||
      row.id <= last ||
      typeof row.session !== 'string'
    ) {
      throw new Error('WXARC 文字事件缺少有效的顺序或会话标识')
    }
    last = row.id
    const session = allowed.get(row.session)
    if (!session || row.local_type !== 1) continue
    if (typeof row.text !== 'string') throw new Error('WXARC 文字事件缺少正文')
    const text = row.text.trim()
    const match = text.indexOf(session.keyword)
    if (!text || match < 0) continue
    if (typeof row.ts !== 'number' || !Number.isFinite(new Date(row.ts * 1000).getTime())) {
      throw new Error('WXARC 文字事件时间无效')
    }
    const offset = Math.max(0, match - 60)
    const excerpt = text.slice(offset, offset + EXCERPT_LENGTH)
    events.push({
      eventId: `wxarc:text:${row.id}`,
      scope: session.id,
      occurredAt: new Date(row.ts * 1000).toISOString(),
      title: `${session.name} · 新微信文字`,
      summary: (offset ? '…' : '') + excerpt + (offset + excerpt.length < text.length ? '…' : ''),
    })
  }
  return { cursor: String(last), events, hasMore: rows.length === PAGE_SIZE }
}
