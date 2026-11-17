import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type ContextCheckpoint,
  type Message,
  type MessagesTruncateReason,
  type RequestAssemblyInput,
  type RequestEntry,
  SESSION_EVENT_FILE,
  SESSION_EVENT_SCHEMA_VERSION,
  SUBAGENT_EVENT_FILE_PREFIX,
  type SessionEvent,
  type SessionEventData,
  type SessionEventFileCheck,
  type SessionEventInput,
  type SessionEventProjection,
  type SessionRestoreProjection,
  type TimelineCompactionBlock,
  getSessionLogRelativeDir,
  isMessageAppendEvent,
} from '@zero-os/shared'
import { externalizeImageData } from './image-ref'

/**
 * Append-only session event log store.
 *
 * 每个会话一个 `session.jsonl`(子代理为父目录下 `sub-<id>.jsonl`):
 * - 首条必为 `session` 头事件(seq=0),之后 seq 严格递增;
 * - canonical 消息在产生的那一刻经 appendMessage 追加(唯一写入口,下标按投影长度分配);
 * - 改动已有消息的一方(回滚、撤回、恢复修复)经 syncMessages 声明截断原因;
 * - syncCanonical 在 turn 结束时对账:正常找不到差异,没有声明原因的差异记 unexpected 并上报;
 * - 上下文检查点由 agent 在压缩发生时直接 append(compaction/checkpoint);
 * - project() 重放 surface 事件得到 canonical 投影;projectForRestore() 再加上恢复需要的其余状态,
 *   是恢复路径的权威读取端。
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
   * Returns the file path relative to the logs root, or null when no file was created.
   */
  registerSubagent(registration: {
    childSessionId: string
    parentSessionId: string
    spawnedByRequestId?: string
    name?: string
    role?: string
  }): string | null {
    const parentRelative = getSessionLogRelativeDir(registration.parentSessionId)
    const relative = join(
      parentRelative,
      `${SUBAGENT_EVENT_FILE_PREFIX}${registration.childSessionId}.jsonl`,
    )
    this.writeSubagentIndexEntry(registration.childSessionId, relative)

    const state = this.loadState(registration.childSessionId)
    // 文件已存在(含损坏)时不创建
    if (state) return null

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
    return created === null ? null : relative
  }

  /**
   * 一次性运行(记忆检索、Router 的每次模型调用)的事件文件:在父会话目录下新建 `sub-<childSessionId>.jsonl`。
   * 它的状态只在返回的句柄里,不进子文件索引,也不进按 sessionId 的缓存:这类文件每个 turn、每次调用都会新建一份,
   * 进索引会让索引一直变大。之后不能用 childSessionId 读写它,读它按 `logFile` 读文件。
   */
  openRun(registration: {
    childSessionId: string
    parentSessionId: string
    name?: string
    role?: string
  }): SessionRunLog {
    const { childSessionId, parentSessionId } = registration
    const logFile = join(
      getSessionLogRelativeDir(parentSessionId),
      `${SUBAGENT_EVENT_FILE_PREFIX}${childSessionId}.jsonl`,
    )
    const state = createSessionEventState(
      logFile,
      this.writeEvents(logFile, -1, [
        {
          type: 'session',
          data: {
            v: 1,
            sessionId: childSessionId,
            schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
            origin: 'subagent',
            parentSessionId,
            name: registration.name,
            role: registration.role,
            source: 'spawn',
          },
        },
      ]),
    )
    return {
      logFile,
      append: (events) => this.appendTo(childSessionId, state, events),
      appendMessage: (message) => this.appendMessageTo(childSessionId, state, message),
    }
  }

  /**
   * Append non-message events (seq/ts assigned here). Returns first assigned seq.
   * 事件里的图片(request/message、queued_merge 的 blocks)与消息一样外置为 imageRef。
   */
  append(sessionId: string, events: SessionEventInput[]): number | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return this.appendTo(sessionId, state, events)
  }

  private appendTo(
    sessionId: string,
    state: SessionEventState,
    events: SessionEventInput[],
  ): number | null {
    if (events.length === 0) return null
    return this.appendEvents(
      sessionId,
      state,
      externalizeImageData(events, {
        logsBasePath: this.basePath,
        sessionId: state.projection.header?.parentSessionId ?? sessionId,
      }),
    )
  }

  /**
   * 追加一条 canonical 消息:下标取当前投影长度,不与已有消息比对。
   * 子代理的图片落在父会话目录下,与它的事件文件放在一起。
   */
  appendMessage(sessionId: string, message: Message): void {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return
    this.appendMessageTo(sessionId, state, message)
  }

  private appendMessageTo(sessionId: string, state: SessionEventState, message: Message): void {
    const [externalized] = externalizeImageData([message], {
      logsBasePath: this.basePath,
      sessionId: state.projection.header?.parentSessionId ?? sessionId,
    })
    this.appendEvents(sessionId, state, [
      buildMessageEventInput(state.projection.messages.length, externalized),
    ])
  }

  /**
   * 对账 canonical 消息与压缩块,有变化时补一条 checkpoint。
   * 消息已由 appendMessage 即时写入,这里正常找不到差异;出现差异说明有改动没经过 store,
   * 截断记 `unexpected`,两种情况都经 onError 上报。
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

    const messageInputs = buildMessageSyncInputs(state.projection.messages, messages, 'unexpected')
    if (messageInputs.length > 0) {
      const truncated = messageInputs[0].type === 'messages/truncate'
      this.options.onError?.(
        `[SessionEventStore] session ${sessionId} canonical changed outside the store: ` +
          `${truncated ? 'unexpected truncate, ' : ''}` +
          `${messageInputs.length - (truncated ? 1 : 0)} message(s) appended at sync`,
      )
    }
    const pending: SessionEventInput[] = [...messageInputs]

    if (!stableEqual(state.projection.blocks, blocks)) {
      pending.push({
        type: 'compaction/block',
        data: { blocks, changed: describeBlockChange(state.projection.blocks, blocks) },
      })
    }

    this.appendEvents(sessionId, state, pending)
    this.appendCheckpointIfChanged(sessionId, state)
    this.maybeVerify(sessionId, state, { messages, blocks })
  }

  /**
   * 只同步 canonical 消息,不动压缩块状态。改动已有消息的一方调用它并声明截断原因
   * (turn 失败回滚、尾部回滚、撤回、恢复修复)。
   */
  syncMessages(sessionId: string, messages: Message[], reason: MessagesTruncateReason): void {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return

    const externalized = externalizeImageData(messages, {
      logsBasePath: this.basePath,
      sessionId,
    })
    this.appendEvents(
      sessionId,
      state,
      buildMessageSyncInputs(state.projection.messages, externalized, reason),
    )
    this.appendCheckpointIfChanged(sessionId, state)
  }

  /** Full surface projection; null when no event file or the file is corrupt. */
  project(sessionId: string): SessionEventProjection | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    return {
      messages: clone(state.projection.messages),
      blocks: clone(state.projection.blocks),
      checkpoint: clone(resolveCheckpoint(state.projection)),
      lastSeq: state.lastSeq,
      header: state.projection.header ? { ...state.projection.header } : null,
    }
  }

  /**
   * 恢复会话需要的全部状态(会话元数据除外):canonical 投影、最后一份系统提示词、最大的 turn 编号、
   * 已注入记忆表。无文件或损坏时返回 null。
   */
  projectForRestore(sessionId: string): SessionRestoreProjection | null {
    const projection = this.project(sessionId)
    const state = this.states.get(sessionId)
    if (!projection || !state) return null
    return {
      ...projection,
      systemPrompt: state.projection.systemPrompt?.content,
      lastTurnIndex: state.projection.lastTurnIndex,
      injectedMemoryIds: new Map(state.projection.injectedMemoryIds),
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

  /** 一次请求(step/start 的 seq)的组装输入,见 buildRequestAssemblyInput;文件不存在或损坏时返回 null */
  getRequestAssemblyInput(sessionId: string, stepSeq: number): RequestAssemblyInput | null {
    const state = this.loadState(sessionId)
    if (!state || state.corrupt) return null
    const check = checkSessionEvents(this.readEvents(sessionId))
    if (!check.ok) return null
    return buildRequestAssemblyInput(check.events, stepSeq)
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

  /**
   * 删除 `sessions/` 下名字以 `prefix` 开头的目录里、最后写入不晚于 `cutoff` 的文件,目录删空后一并删除。
   * Router 按天的事件目录到了正文保留期由它清理;那里的文件都由 `openRun` 建立,不在子文件索引里。返回删除的文件数。
   */
  deleteFilesBefore(prefix: string, cutoff: Date): number {
    const root = join(this.basePath, 'sessions')
    if (!existsSync(root)) return 0
    let deleted = 0
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith(prefix)) continue
      const path = join(root, dir.name)
      for (const file of readdirSync(path, { withFileTypes: true })) {
        const filePath = join(path, file.name)
        if (!file.isFile() || statSync(filePath).mtime > cutoff) continue
        rmSync(filePath)
        deleted += 1
      }
      if (readdirSync(path).length === 0) rmdirSync(path)
    }
    return deleted
  }

  // --- internals ---

  /** 上一条 checkpoint 之后消息或压缩块有变化时写一条 checkpoint */
  private appendCheckpointIfChanged(sessionId: string, state: SessionEventState): void {
    if (!state.changedSinceCheckpoint) return
    this.appendEvents(sessionId, state, [
      {
        type: 'checkpoint',
        data: {
          atSeq: state.lastSeq,
          messageCount: state.projection.messages.length,
          projectionHash: hashProjection(state.projection.messages, state.projection.blocks),
        },
      },
    ])
  }

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
    const events = this.writeEvents(relative, state?.lastSeq ?? -1, inputs)
    const lastSeq = events[events.length - 1].seq

    if (state) {
      applySurfaceEvents(state.projection, events)
      state.lastSeq = lastSeq
      state.changedSinceCheckpoint = changedSinceCheckpoint(events, state.changedSinceCheckpoint)
    } else {
      this.states.set(sessionId, createSessionEventState(relative, events))
    }
    return events[0].seq
  }

  /** 把事件追加到文件末尾,seq 从 `lastSeq + 1` 起分配。 */
  private writeEvents(
    relative: string,
    lastSeq: number,
    inputs: SessionEventInput[],
  ): SessionEvent[] {
    const filePath = join(this.basePath, relative)
    mkdirSync(dirname(filePath), { recursive: true })

    const now = this.options.now ?? defaultNow
    const events = inputs.map(
      (input, index) =>
        ({
          seq: lastSeq + 1 + index,
          ts: now(),
          type: input.type,
          data: input.data,
        }) as SessionEvent,
    )
    appendFileSync(
      filePath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf-8',
    )
    return events
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

/** `SessionEventStore.openRun` 返回的句柄:一次性运行的事件文件,只经它写入。 */
export interface SessionRunLog {
  /** 文件相对日志根目录的路径 */
  logFile: string
  append(events: SessionEventInput[]): number | null
  appendMessage(message: Message): void
}

interface SessionEventState {
  relative: string
  lastSeq: number
  syncCount: number
  corrupt: boolean
  /** 上一条 checkpoint 之后是否写过消息、截断或压缩块事件 */
  changedSinceCheckpoint: boolean
  projection: ProjectionCore
}

function createSessionEventState(relative: string, events: SessionEvent[]): SessionEventState {
  const projection = foldSurfaceEvents(events)
  return {
    relative,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
    syncCount: 0,
    corrupt: false,
    changedSinceCheckpoint: changedSinceCheckpoint(events, false),
    projection,
  }
}

function createCorruptState(relative: string): SessionEventState {
  return {
    relative,
    lastSeq: -1,
    syncCount: 0,
    corrupt: true,
    changedSinceCheckpoint: false,
    projection: {
      header: null,
      messages: [],
      blocks: [],
      checkpoints: [],
      injectedMemoryIds: new Map(),
    },
  }
}

function changedSinceCheckpoint(events: SessionEvent[], initial: boolean): boolean {
  let changed = initial
  for (const event of events) {
    if (event.type === 'checkpoint') changed = false
    else if (
      isMessageAppendEvent(event) ||
      event.type === 'messages/truncate' ||
      event.type === 'compaction/block'
    ) {
      changed = true
    }
  }
  return changed
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
  const core = foldSurfaceEvents(events)
  return {
    header: core.header,
    messages: core.messages,
    blocks: core.blocks,
    checkpoint: resolveCheckpoint(core),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
  }
}

/**
 * 一次请求的组装输入,只依赖事件(详见 docs/session-event-log.md「请求重建」):
 * - 所属 loop:step/start 之前最近的 loop/start;history 与 checkpoint 是该 loop/start 处的投影;
 * - system 与工具集:step/start 之前最后一条 system/prompt 与 tools/set;
 * - entries:loop/start 与 step/start 之间按日志顺序的 canonical 消息事件(排队消息除外:紧跟在
 *   agent/inbox/enqueued 之后、下标为其 messageIndex 的那条)、request/message、带 messageId 的
 *   injection/context、compaction/checkpoint。
 * seq 不是 step/start、它之前没有 loop/start(旧日志)、或 loop 内出现 messages/truncate(turn 中途撤回原地
 * 改写了请求里的消息)时返回 null。
 */
export function buildRequestAssemblyInput(
  events: SessionEvent[],
  stepSeq: number,
): RequestAssemblyInput | null {
  const stepPosition = events.findIndex((event) => event.seq === stepSeq)
  if (stepPosition < 0 || events[stepPosition].type !== 'step/start') return null
  const before = events.slice(0, stepPosition)
  const loopPosition = before.findLastIndex((event) => event.type === 'loop/start')
  const loopStart = before[loopPosition]
  if (loopStart?.type !== 'loop/start') return null

  const base = projectEvents(before.slice(0, loopPosition + 1))
  let systemPrompt = ''
  let identityMemory: string | undefined
  let toolNames: string[] = []
  for (const event of before) {
    if (event.type === 'system/prompt') {
      systemPrompt = event.data.content
      identityMemory = event.data.identity
    } else if (event.type === 'tools/set') {
      toolNames = event.data.toolNames
    }
  }

  const entries: RequestEntry[] = []
  let queuedMessageIndex: number | undefined
  for (const event of before.slice(loopPosition + 1)) {
    switch (event.type) {
      case 'agent/inbox/enqueued':
        queuedMessageIndex = event.data.messageIndex
        break
      case 'user/message':
      case 'assistant/message':
        // 排队消息进 canonical,但不在 loop 的请求里:它的原文由 queued_merge 拼进请求
        if (event.data.messageIndex === queuedMessageIndex) queuedMessageIndex = undefined
        else entries.push({ kind: 'message', message: event.data.message })
        break
      case 'request/message':
        entries.push({ kind: 'message', message: event.data.message })
        break
      case 'injection/context': {
        const { messageId } = event.data
        if (messageId) entries.push({ kind: 'injection', injection: { ...event.data, messageId } })
        break
      }
      case 'compaction/checkpoint':
        entries.push({ kind: 'checkpoint', checkpoint: event.data.checkpoint })
        break
      case 'messages/truncate':
        return null
      default:
        break
    }
  }

  return {
    systemPrompt,
    ...(identityMemory === undefined ? {} : { identityMemory }),
    toolNames,
    history: base.messages,
    ...(base.checkpoint ? { checkpoint: base.checkpoint } : {}),
    requireThinkingForToolUse: loopStart.data.requireThinkingForToolUse,
    entries,
  }
}

type ProjectionCore = Pick<SessionEventProjection, 'header' | 'messages' | 'blocks'> & {
  /** 依次写入的检查点;null 表示回到没有检查点 */
  checkpoints: Array<ContextCheckpoint | null>
  systemPrompt?: { hash: string; content: string }
  toolSet?: { hash: string; toolNames: string[] }
  /** turn/start 里最大的 turnIndex */
  lastTurnIndex?: number
  /** status 为 injected 的 memory/retrieval/end 选中的记忆 id → title */
  injectedMemoryIds: Map<string, string>
}

function foldSurfaceEvents(events: SessionEvent[]): ProjectionCore {
  const projection: ProjectionCore = {
    header: null,
    messages: [],
    blocks: [],
    checkpoints: [],
    injectedMemoryIds: new Map(),
  }
  applySurfaceEvents(projection, events)
  return projection
}

/**
 * 重放规则:取最后一份指向的消息都在投影里的检查点;遇到更晚的无效检查点就往前回退,
 * 回退到 null(回滚到没有检查点)或开头则没有检查点。
 */
function resolveCheckpoint(projection: ProjectionCore): ContextCheckpoint | undefined {
  const ids = new Set(projection.messages.map((message) => message.id))
  for (let i = projection.checkpoints.length - 1; i >= 0; i -= 1) {
    const checkpoint = projection.checkpoints[i]
    if (checkpoint === null) return undefined
    const { summarizedThroughMessageId, prunedThroughMessageId } = checkpoint
    if (
      (summarizedThroughMessageId === undefined || ids.has(summarizedThroughMessageId)) &&
      (prunedThroughMessageId === undefined || ids.has(prunedThroughMessageId))
    ) {
      return checkpoint
    }
  }
  return undefined
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
    case 'compaction/checkpoint':
      projection.checkpoints.push(event.data.checkpoint)
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
    case 'turn/start':
      projection.lastTurnIndex = Math.max(projection.lastTurnIndex ?? 0, event.data.turnIndex)
      break
    case 'memory/retrieval/end':
      if (event.data.status === 'injected') {
        for (const memory of event.data.selected) {
          projection.injectedMemoryIds.set(memory.id, memory.title)
        }
      }
      break
    default:
      break
  }
}

/** Diff canonical 消息为追加/截断事件序列(不改写历史事件)。 */
function buildMessageSyncInputs(
  projected: Message[],
  messages: Message[],
  reason: MessagesTruncateReason,
): SessionEventInput[] {
  const pending: SessionEventInput[] = []
  const prefix = commonPrefixLength(projected, messages)
  if (prefix < projected.length) {
    pending.push({
      type: 'messages/truncate',
      data: { toMessageIndex: prefix, reason },
    })
  }
  for (let i = prefix; i < messages.length; i += 1) {
    pending.push(buildMessageEventInput(i, messages[i]))
  }
  return pending
}

function buildMessageEventInput(messageIndex: number, message: Message): SessionEventInput {
  return {
    type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
    data: {
      messageIndex,
      message,
      source: message.source,
      hash: hashValue(message),
    },
  }
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

/** 读一份事件文件;文件不存在或读不了时返回空数组,写了一半的行跳过。 */
export function readEventsFile(filePath: string): SessionEvent[] {
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
