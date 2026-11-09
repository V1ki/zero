import type { TriggerEvent, TriggerInboxItem, TriggerWxarcSession } from '@zero-os/shared'

const WXARC_ORIGIN = 'http://127.0.0.1:8765'
const PAGE_SIZE = 200
const LONG_POLL_SECONDS = 60
const EXCERPT_LENGTH = 240
class WxarcReadError extends Error {}
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
    throw new WxarcReadError(`WXARC 请求失败（HTTP ${response.status}）`)
  }
  try {
    return await response.json()
  } catch (error) {
    // JSON parse errors can quote the upstream body, including private messages.
    if (error instanceof SyntaxError) throw new WxarcReadError('WXARC 返回的数据不是有效 JSON')
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

/** Refresh only the already-authorized event; embedded quoted messages are not implicitly authorized. */
export async function readWxarcEvent(
  event: TriggerInboxItem,
  session: TriggerWxarcSession,
  signal: AbortSignal,
  fetcher: WxarcFetch = fetch,
) {
  const match = /^wxarc:text:([1-9]\d*)$/.exec(event.eventId)
  const id = match && Number(match[1])
  if (
    !id ||
    !Number.isSafeInteger(id) ||
    event.source !== 'wxarc' ||
    !session.enabled ||
    session.id !== event.scope
  )
    throw new WxarcReadError('当前归档事件不在已授权的会话内。')
  const rows = await readJson(`/ui/refresh?kind=text&ids=${id}`, signal, fetcher)
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0]))
    throw new WxarcReadError('无法找到这条归档原文。')
  const raw = rows[0]
  const verified = textRow(raw, session)
  if (
    !verified ||
    verified.id !== id ||
    verified.occurredAt !== event.occurredAt ||
    verified.summary !== event.summary
  )
    throw new WxarcReadError('归档原文与入箱记录不一致，请核对来源。')
  const quote =
    (raw.local_type === 57 || raw.local_type === 57 * 2 ** 32 + 49) && isObject(raw.quote)
      ? raw.quote
      : null
  const body = quote ? quote.body : raw.text
  if (typeof body !== 'string') throw new WxarcReadError('归档缺少原始正文。')
  return {
    eventId: event.eventId,
    occurredAt: verified.occurredAt,
    text: body,
    source: 'wxarc',
    quotedContextIncluded: false,
  }
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

type WxarcCandidate = { id: number; occurredAt: string; summary: string }
type TextRow = { id: number; occurredAt: string; summary: string; node?: number; parent?: number }
const positive = (id: unknown): id is number => isWatermark(id) && id > 0

// Only the referring author's new text is eligible. The embedded target body can predate
// consent, include another sender, or contain media/URLs and is never copied into ZeRo.
function textRow(raw: Record<string, unknown>, session: TriggerWxarcSession): TextRow | null {
  if (raw.session !== session.id || !positive(raw.id)) return null
  let value: unknown
  const quote =
    (raw.local_type === 57 || raw.local_type === 57 * 2 ** 32 + 49) && isObject(raw.quote)
      ? raw.quote
      : null
  if (quote) value = quote.body
  else if (raw.local_type === 1) value = raw.text
  else return null
  if (typeof value !== 'string') throw new Error('WXARC 文字事件缺少正文')
  const text = value.trim()
  const at = text.indexOf(session.keyword)
  if (!text || at < 0) return null
  if (typeof raw.ts !== 'number' || !Number.isFinite(new Date(raw.ts * 1000).getTime()))
    throw new Error('WXARC 文字事件时间无效')
  const start = Math.max(0, at - 60)
  const excerpt = text.slice(start, start + EXCERPT_LENGTH)
  return {
    id: raw.id,
    occurredAt: new Date(raw.ts * 1000).toISOString(),
    summary: (start ? '…' : '') + excerpt + (start + excerpt.length < text.length ? '…' : ''),
    ...(positive(raw.quote_thread_id) && { node: raw.quote_thread_id }),
    ...(quote?.status === 'available' &&
      positive(quote.target_id) &&
      positive(raw.quote_thread_id) &&
      quote.target_id !== raw.quote_thread_id && { parent: quote.target_id }),
  }
}

async function connectQuotes(
  session: TriggerWxarcSession,
  entries: { row: TextRow; event: TriggerEvent }[],
  recent: ((scope: string) => WxarcCandidate[]) | undefined,
  signal: AbortSignal,
  fetcher: WxarcFetch,
) {
  const missing = entries.filter(({ row, event }) => {
    if (!row.parent) return false
    const hits = entries.filter((item) => item.row.id < row.id && item.row.node === row.parent)
    if (hits.length === 1) event.wxarcReplyToEventId = hits[0].event.eventId
    return hits.length === 0
  })
  if (!missing.length || !recent) return
  const prior = recent(session.id)
    .filter((item) => positive(item.id))
    .slice(0, 48)
  if (!prior.length) return
  // Both ends of an edge must use the SAME live search index. Refresh known, authorized
  // event IDs together and compare their original local receipts before using search IDs.
  for (let offset = 0; offset < missing.length; offset += 48) {
    const group = missing.slice(offset, offset + 48)
    const ids = [...new Set([...prior.map((item) => item.id), ...group.map((item) => item.row.id)])]
    let refreshed: unknown
    try {
      refreshed = await readJson(`/ui/refresh?kind=text&ids=${ids.join(',')}`, signal, fetcher)
    } catch (error) {
      signal.throwIfAborted()
      if (
        !(
          error instanceof WxarcReadError ||
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError')
        )
      )
        throw error
      console.warn('[WXARC] 本次无法核对引用关系，消息将作为独立线索入箱。')
      continue
    }
    if (!Array.isArray(refreshed) || refreshed.length > ids.length) continue
    const records = refreshed.flatMap((item) =>
      isObject(item) && positive(item.id) && ids.includes(item.id)
        ? (textRow(item, session) ?? [])
        : [],
    )
    const exact = (saved: WxarcCandidate) => {
      const hits = records.filter((row) => row.id === saved.id)
      return hits.length === 1 &&
        hits[0].summary === saved.summary &&
        hits[0].occurredAt === saved.occurredAt
        ? hits[0]
        : undefined
    }
    const known = prior.map(exact).filter((r): r is TextRow => !!r)
    for (const { row, event } of group) {
      const current = exact(row)
      if (!current?.parent) continue
      const matches = known.filter((old) => old.id < row.id && old.node === current.parent)
      if (matches.length === 1) event.wxarcReplyToEventId = `wxarc:text:${matches[0].id}`
    }
  }
}

export async function pollWxarc(
  sessions: TriggerWxarcSession[],
  previousCursor: string | null,
  signal: AbortSignal,
  fetcher: WxarcFetch = fetch,
  recent?: (scope: string) => WxarcCandidate[],
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
  const groups = new Map<TriggerWxarcSession, { row: TextRow; event: TriggerEvent }[]>()
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
    if (!session) continue
    const data = textRow(row, session)
    if (!data) continue
    const event: TriggerEvent = {
      eventId: `wxarc:text:${row.id}`,
      scope: session.id,
      title: `${session.name} · 新微信文字`,
      occurredAt: data.occurredAt,
      summary: data.summary,
    }
    events.push(event)
    const group = groups.get(session) ?? []
    group.push({ row: data, event })
    groups.set(session, group)
  }
  for (const [session, items] of groups)
    await connectQuotes(session, items, recent, signal, fetcher)
  return { cursor: String(last), events, hasMore: rows.length === PAGE_SIZE }
}
