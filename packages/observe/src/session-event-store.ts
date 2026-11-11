import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type Message,
  SESSION_EVENT_FILE,
  SESSION_EVENT_SCHEMA_VERSION,
  SUBAGENT_EVENT_FILE_PREFIX,
  type SessionEvent,
  type SessionEventData,
  type SessionEventFileCheck,
  type SessionEventInput,
  type SessionEventProjection,
  type TimelineCompactionBlock,
  getSessionLogRelativeDir,
} from '@zero-os/shared'
import { externalizeImageData } from './image-ref'

/**
 * Append-only session event log store.
 *
 * 每个会话一个 `session.jsonl`(子代理为父目录下 `sub-<id>.jsonl`):
 * - 首条必为 `session` 头事件(seq=0),之后 seq 严格递增;
 * - canonical 消息/压缩块通过 syncCanonical 做 diff 追加(回滚产生 truncate 事件);
 * - project() 重放 surface 事件得到 canonical 投影,是恢复路径的权威读取端。
 */
export class SessionEventStore {
  private readonly states = new Map<string, SessionEventState>()
  private readonly basePath: string

  constructor(
    private readonly options: {
      basePath: string
      now?: () => string
      onError?: (message: string) => void
    },
  ) {
    // 统一解析为绝对路径:imageRef.path 等字段会把 basePath 原样烤进事件,
    // 形态必须与调用方传相对/绝对路径无关
    this.basePath = resolve(options.basePath)
  }

  /**
   * Ensure the session header event exists. Returns true when the file was created.
   * 幂等:文件已存在时不改写。
   */
  ensureSession(header: SessionEventData): boolean {
    const state = this.loadState(header.sessionId)
    // 文件已存在(含损坏)时不创建
    if (state) return false

    const relative = this.defaultRelativeFile(header.sessionId)
    const created = this.appendEvents(
      header.sessionId,
      undefined,
      [{ type: 'session', data: { ...header, schemaVersion: SESSION_EVENT_SCHEMA_VERSION } }],
      relative,
    )
    return created !== null
  }

  /**
   * Register a subagent session: its event file lives in the parent session
   * directory as `sub-<childId>.jsonl`, tracked in a rebuildable index.
   */
  registerSubagent(registration: {
    childSessionId: string
    parentSessionId: string
    spawnedByRequestId?: string
    name?: string
    role?: string
  }): boolean {
    const parentRelative = getSessionLogRelativeDir(registration.parentSessionId)
    const relative = join(
      parentRelative,
      `${SUBAGENT_EVENT_FILE_PREFIX}${registration.childSessionId}.jsonl`,
    )
    this.writeSubagentIndexEntry(registration.childSessionId, relative)

    const state = this.loadState(registration.childSessionId)
    // 文件已存在(含损坏)时不创建
    if (state) return false

    const created = this.appendEvents(
      registration.childSessionId,
      undefined,
      [
        {
          type: 'session',
          data: {
            v: 1,
            sessionId: registration.childSessionId,
            schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
            origin: 'subagent',
            parentSessionId: registration.parentSessionId,
            spawnedByRequestId: registration.spawnedByRequestId,
            name: registration.name,
            role: registration.role,
            source: 'spawn',
          },
        },
      ],
      relative,
    )
    return created !== null
  }

  /** Append diagnostics events (seq/ts assigned here). Returns first assigned seq. */
  append(sessionId: string, events: SessionEventInput[]): number | null {
    if (events.length === 0) return null
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return this.appendEvents(sessionId, state, events)
  }

  /**
   * Diff-sync canonical messages and compaction blocks, then append a checkpoint.
   * 双写期的等价性校验:按采样规则从磁盘重放并与输入比对,不一致时上报。
   */
  syncCanonical(
    sessionId: string,
    input: { messages: Message[]; blocks: TimelineCompactionBlock[] },
  ): void {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return

    const messages = externalizeImageData(input.messages, {
      logsBasePath: this.basePath,
      sessionId,
    })
    const blocks = input.blocks

    const pending: SessionEventInput[] = [
      ...buildMessageSyncInputs(state.projection.messages, messages),
    ]

    if (!stableEqual(state.projection.blocks, blocks)) {
      pending.push({
        type: 'compaction/block',
        data: { blocks, changed: describeBlockChange(state.projection.blocks, blocks) },
      })
    }

    if (pending.length > 0) {
      this.appendEvents(sessionId, state, pending)
      this.appendEvents(sessionId, state, [
        {
          type: 'checkpoint',
          data: {
            atSeq: state.lastSeq,
            messageCount: messages.length,
            projectionHash: hashProjection(messages, blocks),
          },
        },
      ])
    }

    this.maybeVerify(sessionId, state, { messages, blocks })
  }

  /**
   * 只同步 canonical 消息,不动压缩块状态(恢复期修复路径使用:
   * 修复时拿不到权威 blocks,不能把 blocks 投影清空)。
   */
  syncMessages(sessionId: string, messages: Message[]): void {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return

    const externalized = externalizeImageData(messages, {
      logsBasePath: this.basePath,
      sessionId,
    })
    const pending = buildMessageSyncInputs(state.projection.messages, externalized)
    if (pending.length === 0) return

    this.appendEvents(sessionId, state, pending)
    this.appendEvents(sessionId, state, [
      {
        type: 'checkpoint',
        data: {
          atSeq: state.lastSeq,
          messageCount: externalized.length,
          projectionHash: hashProjection(externalized, state.projection.blocks),
        },
      },
    ])
  }

  /** Full surface projection; null when no event file or the file is corrupt. */
  project(sessionId: string): SessionEventProjection | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return {
      messages: clone(state.projection.messages),
      blocks: clone(state.projection.blocks),
      lastSeq: state.lastSeq,
      header: state.projection.header ? { ...state.projection.header } : null,
    }
  }

  /** Projection frozen at a seq (request reconstruction anchor). */
  projectUpTo(sessionId: string, seq: number): SessionEventProjection | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    const events = this.readEvents(sessionId)
    const check = checkSessionEvents(events)
    if (!check.ok) return null
    return projectEvents(check.events.filter((event) => event.seq <= seq))
  }

  readEvents(sessionId: string): SessionEvent[] {
    const relative = this.resolveRelativeFile(sessionId)
    if (!relative) return []
    return readEventsFile(join(this.basePath, relative))
  }

  /** 最近一次工具集声明;未发射过返回 null */
  getToolSet(sessionId: string): { hash: string; toolNames: string[] } | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return state.projection.toolSet ?? null
  }

  /** 最近一次系统提示词快照;未发射过返回 null */
  getSystemPrompt(sessionId: string): { hash: string; content: string } | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return state.projection.systemPrompt ?? null
  }

  /** 当前最后一条事件 seq;无文件/损坏返回 null。用作请求上下文的投影锚点。 */
  getLastSeq(sessionId: string): number | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return state.lastSeq
  }

  hasSession(sessionId: string): boolean {
    const state = this.loadState(sessionId)
    return state !== undefined && !state.corrupt
  }

  // --- internals ---

  private maybeVerify(
    sessionId: string,
    state: SessionEventState,
    expected: { messages: Message[]; blocks: TimelineCompactionBlock[] },
  ): void {
    state.syncCount += 1
    const sampled = state.syncCount <= 3 || state.syncCount % 20 === 0
    if (!sampled) return

    const events = this.readEvents(sessionId)
    const check = checkSessionEvents(events)
    if (!check.ok) {
      this.options.onError?.(
        `[SessionEventStore] session ${sessionId} verify failed: ${check.error}`,
      )
      return
    }
    const projection = projectEvents(check.events)
    if (
      projection.messages.length !== expected.messages.length ||
      hashProjection(projection.messages, projection.blocks) !==
        hashProjection(expected.messages, expected.blocks)
    ) {
      this.options.onError?.(
        `[SessionEventStore] session ${sessionId} projection mismatch: ` +
          `events=${projection.messages.length} expected=${expected.messages.length}`,
      )
    }
  }

  /**
   * Append events to a session file. `state` must be provided for existing files;
   * new files require `relativeOverride` plus a leading `session` header event.
   * Returns the first assigned seq, or null when nothing was written.
   */
  private appendEvents(
    sessionId: string,
    state: SessionEventState | undefined,
    inputs: SessionEventInput[],
    relativeOverride?: string,
  ): number | null {
    if (inputs.length === 0) return null

    const relative = state?.relative ?? relativeOverride ?? this.defaultRelativeFile(sessionId)
    const filePath = join(this.basePath, relative)
    mkdirSync(dirname(filePath), { recursive: true })

    const now = this.options.now ?? defaultNow
    let seq = state?.lastSeq ?? -1
    const firstSeq = seq + 1
    const lines: string[] = []
    const events: SessionEvent[] = []
    for (const input of inputs) {
      seq += 1
      const event = { seq, ts: now(), type: input.type, data: input.data } as SessionEvent
      lines.push(JSON.stringify(event))
      events.push(event)
    }

    appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')

    if (state) {
      applySurfaceEvents(state.projection, events)
      state.lastSeq = seq
    } else {
      this.states.set(sessionId, createSessionEventState(relative, events))
    }
    return firstSeq
  }

  private loadState(sessionId: string): SessionEventState | undefined {
    const cached = this.states.get(sessionId)
    if (cached) return cached

    const relative = this.resolveRelativeFile(sessionId)
    if (!relative) return undefined

    const events = readEventsFile(join(this.basePath, relative))
    const check = checkSessionEvents(events)
    if (!check.ok) {
      this.options.onError?.(
        `[SessionEventStore] session ${sessionId} event file invalid (${relative}): ${check.error}`,
      )
      const corrupt = createCorruptState(relative)
      this.states.set(sessionId, corrupt)
      return corrupt
    }

    const state = createSessionEventState(relative, check.events)
    this.states.set(sessionId, state)
    return state
  }

  private defaultRelativeFile(sessionId: string): string {
    return join(getSessionLogRelativeDir(sessionId), SESSION_EVENT_FILE)
  }

  private resolveRelativeFile(sessionId: string): string | null {
    const own = this.defaultRelativeFile(sessionId)
    if (existsSync(join(this.basePath, own))) return own
    const indexed = this.readSubagentIndex()[sessionId]
    if (indexed && existsSync(join(this.basePath, indexed))) return indexed
    return null
  }

  private readSubagentIndex(): Record<string, string> {
    const indexPath = join(this.basePath, SUBAGENT_INDEX_FILE)
    try {
      if (!existsSync(indexPath)) return {}
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
        children?: Record<string, string>
      }
      return parsed.children ?? {}
    } catch {
      return {}
    }
  }

  private writeSubagentIndexEntry(childSessionId: string, relative: string): void {
    const children = this.readSubagentIndex()
    if (children[childSessionId] === relative) return
    children[childSessionId] = relative
    const indexPath = join(this.basePath, SUBAGENT_INDEX_FILE)
    mkdirSync(dirname(indexPath), { recursive: true })
    writeFileSync(indexPath, JSON.stringify({ version: 1, children }, undefined, 2), 'utf-8')
  }
}

const SUBAGENT_INDEX_FILE = 'subagent-index.json'

interface SessionEventState {
  relative: string
  lastSeq: number
  syncCount: number
  corrupt: boolean
  projection: ProjectionCore
}

function createSessionEventState(relative: string, events: SessionEvent[]): SessionEventState {
  const projection = projectEvents(events)
  return {
    relative,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
    syncCount: 0,
    corrupt: false,
    projection,
  }
}

function createCorruptState(relative: string): SessionEventState {
  return {
    relative,
    lastSeq: -1,
    syncCount: 0,
    corrupt: true,
    projection: { header: null, messages: [], blocks: [] },
  }
}

/** 文件级不变式:首条为 session 头(seq=0),seq 严格递增。 */
export function checkSessionEvents(events: SessionEvent[]): SessionEventFileCheck {
  if (events.length === 0) return { ok: false, error: 'empty', events }
  const first = events[0]
  if (first.type !== 'session' || first.seq !== 0) {
    return { ok: false, error: 'missing session header at seq 0', events }
  }
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].seq <= events[i - 1].seq) {
      return { ok: false, error: `seq not increasing at ${events[i].seq}`, events }
    }
  }
  return { ok: true, events }
}

/** Fold surface events into the canonical projection. */
export function projectEvents(events: SessionEvent[]): SessionEventProjection {
  const projection: SessionEventProjection = {
    header: null,
    messages: [],
    blocks: [],
    lastSeq: -1,
  }

  for (const event of events) {
    projection.lastSeq = event.seq
    applySurfaceEvent(projection, event)
  }
  return projection
}

type ProjectionCore = Pick<SessionEventProjection, 'header' | 'messages' | 'blocks'> & {
  systemPrompt?: { hash: string; content: string }
  toolSet?: { hash: string; toolNames: string[] }
}

function applySurfaceEvents(projection: ProjectionCore, events: SessionEvent[]): void {
  for (const event of events) {
    applySurfaceEvent(projection, event)
  }
}

function applySurfaceEvent(projection: ProjectionCore, event: SessionEvent): void {
  switch (event.type) {
    case 'session':
      projection.header = event.data
      break
    case 'user/message':
    case 'assistant/message':
      projection.messages[event.data.messageIndex] = event.data.message
      break
    case 'messages/truncate':
      projection.messages.length = event.data.toMessageIndex
      break
    case 'compaction/block':
      projection.blocks = event.data.blocks
      break
    case 'system/prompt':
      projection.systemPrompt = { hash: event.data.hash, content: event.data.content }
      break
    case 'tools/set':
      projection.toolSet = { hash: event.data.hash, toolNames: event.data.toolNames }
      break
    default:
      break
  }
}

/** Diff canonical 消息为追加/截断事件序列(不改写历史事件)。 */
function buildMessageSyncInputs(projected: Message[], messages: Message[]): SessionEventInput[] {
  const pending: SessionEventInput[] = []
  const prefix = commonPrefixLength(projected, messages)
  if (prefix < projected.length) {
    pending.push({
      type: 'messages/truncate',
      data: { toMessageIndex: prefix, reason: 'turn_failed' },
    })
  }
  for (let i = prefix; i < messages.length; i += 1) {
    const message = messages[i]
    pending.push({
      type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
      data: {
        messageIndex: i,
        message,
        source: message.source,
        hash: hashValue(message),
      },
    })
  }
  return pending
}

function commonPrefixLength(
  previous: Message[],
  next: Message[],
  equals: (a: Message, b: Message) => boolean = stableEqualMessage,
): number {
  const max = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < max && equals(previous[prefix], next[prefix])) prefix += 1
  return prefix
}

function describeBlockChange(
  previous: TimelineCompactionBlock[],
  next: TimelineCompactionBlock[],
): { blockId: string; lifecycle: 'created' | 'reused' | 'superseded' } {
  const previousIds = new Set(previous.map((block) => block.id))
  const nextIds = new Set(next.map((block) => block.id))
  const added = next.find((block) => !previousIds.has(block.id))
  if (added) return { blockId: added.id, lifecycle: 'created' }
  const removed = previous.find((block) => !nextIds.has(block.id))
  if (removed) return { blockId: removed.id, lifecycle: 'superseded' }
  return { blockId: next[0]?.id ?? '', lifecycle: 'reused' }
}

function readEventsFile(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) return []
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const events: SessionEvent[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as SessionEvent
      if (typeof parsed?.seq === 'number' && typeof parsed?.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // 半行(崩溃中追加)跳过
    }
  }
  return events
}

function defaultNow(): string {
  return new Date().toISOString()
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function stableEqualMessage(a: Message, b: Message): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function hashProjection(messages: Message[], blocks: TimelineCompactionBlock[]): string {
  return hashValue({ messages, blocks })
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
