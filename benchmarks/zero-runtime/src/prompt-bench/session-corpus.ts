import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Block = { type: string; text?: string; name?: string; isError?: boolean }
export type StoredMessage = {
  id: string
  role: string
  messageType?: string
  createdAt?: string
  source?: { messageId?: string }
  content: Block[]
}

export const FAMILIES = [
  ['research-publishing', '研究并制作公众号内容', /公众号|微信.*草稿|卡通.*风格/],
  ['source-research', '网页、论文与原始资料查找', /文章|论文|帖子|原帖|原文|报道|研究|找一下|搜索/],
  ['media-transcription', '视频、音频与转写', /视频|ASR|转写|逐字稿|抽帧|音频/i],
  [
    'model-evaluation',
    '模型测试与部署配置',
    /模型|推理|上下文|显存|qwen|deepseek|llm|API.*测试|测试.*API/i,
  ],
  ['file-processing', '文件、表格与格式处理', /文件|表格|xlsx|Excel|PDF|epub|TXT|小说|发票|转换/i],
  [
    'code-review',
    '代码、PR 与问题修复',
    /\bPR\b|pull request|issue|代码|源码|仓库|rebase|bug|修复|分支|合并/i,
  ],
  ['market-comparison', '价格与设备比较', /价格|多少钱|比价|报价|淘宝|京东|闲鱼|折扣/],
  [
    'runtime-diagnosis',
    '运行状态与环境排查',
    /服务器|SSH|K8S|端口|网络|报错|故障|排查|运行.*情况/i,
  ],
] as const

export function messageText(message: StoredMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

export function exclusion(message: StoredMessage): string | undefined {
  if (message.role !== 'user') return 'assistant-or-other-role'
  if (!['message', 'queued'].includes(message.messageType ?? 'message')) return 'runtime-message'
  const text = messageText(message).trim()
  if (!text) return 'tool-result-or-nontext'
  if (
    /^(?:<system[\s_>]|<queued_message|<memory[\s_>]|<task_notification|\[以下是之前对话的摘要\]|New conversation started\.|Session (?:started|resumed))/i.test(
      text,
    )
  ) {
    return 'runtime-wrapper-or-compaction'
  }
  if (/^\[文件:/.test(text) && /已下载到:/.test(text)) return 'attachment-notice'
  if (/^\/\S+(?:\s+\S+)?\s*$/.test(text)) return 'slash-command'
  return undefined
}

export function taskMessages(messages: StoredMessage[]) {
  const seenIds = new Set<string>()
  const seenSourceIds = new Set<string>()
  return messages.flatMap((message, index) => {
    if (exclusion(message)) return []
    const sourceId = message.source?.messageId
    if (seenIds.has(message.id) || (sourceId && seenSourceIds.has(sourceId))) return []
    seenIds.add(message.id)
    if (sourceId) seenSourceIds.add(sourceId)
    return [{ message, index }]
  })
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function scanDatabase(path: string, since: string, until: string) {
  const start = Date.parse(since)
  const end = Date.parse(until)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Invalid time window')
  }
  const db = new Database(path, { readonly: true, create: false })
  try {
    db.exec('BEGIN')
    const rows = db
      .query<{ id: string; source: string; created_at: string; messages_json: string }, []>(
        `SELECT s.id, s.source, s.created_at, m.messages_json
         FROM sessions s JOIN session_messages m ON s.id=m.session_id ORDER BY s.id`,
      )
      .all()
    const sessions = rows.map((row) => {
      const messages: StoredMessage[] = JSON.parse(row.messages_json)
      const candidates = taskMessages(messages)
      const recent = candidates.filter(({ message }) => {
        const time = Date.parse(message.createdAt ?? '')
        return time >= start && time < end
      })
      const exclusions: Record<string, number> = {}
      for (const message of messages) {
        const reason = exclusion(message)
        if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1
      }
      const refs = (entries: typeof candidates) =>
        entries.map(({ message, index }) => ({
          id: message.id,
          index,
          createdAt: message.createdAt,
          textHash: digest(messageText(message)),
          families: FAMILIES.filter(([, , pattern]) => pattern.test(messageText(message))).map(
            ([id]) => id,
          ),
        }))
      return {
        id: row.id,
        source: row.source,
        createdAt: row.created_at,
        messagesHash: digest(row.messages_json),
        messageCount: messages.length,
        exclusions,
        duplicateCandidateCount:
          messages.filter((message) => !exclusion(message)).length - candidates.length,
        taskMessages: refs(candidates),
        recentTaskMessages: refs(recent),
        storedEmptyAssistantCount: messages.filter(
          (message) =>
            message.role === 'assistant' &&
            !messageText(message).trim() &&
            !message.content.some((block) => block.type === 'tool_use'),
        ).length,
      }
    })
    const families = FAMILIES.map(([id, label]) => {
      const members = sessions.filter((session) =>
        session.recentTaskMessages.some((message) => message.families.includes(id)),
      )
      return { id, label, sessionCount: members.length, sessionIds: members.map((s) => s.id) }
    }).sort((a, b) => b.sessionCount - a.sessionCount)
    return {
      schema: 1,
      origin: 'zero-session-database',
      database: resolve(path),
      capturedAt: new Date().toISOString(),
      logicalSnapshotHash: digest(JSON.stringify(sessions.map((s) => [s.id, s.messagesHash]))),
      window: { since, until, semantics: 'message.createdAt >= since and < until' },
      counts: {
        sessions: sessions.length,
        messages: sessions.reduce((n, s) => n + s.messageCount, 0),
        taskMessageCandidates: sessions.reduce((n, s) => n + s.taskMessages.length, 0),
        recentSessions: sessions.filter((s) => s.recentTaskMessages.length).length,
        recentTaskMessageCandidates: sessions.reduce((n, s) => n + s.recentTaskMessages.length, 0),
        storedEmptyAssistantMessages: sessions.reduce((n, s) => n + s.storedEmptyAssistantCount, 0),
      },
      limitations: [
        'Task-message candidates include follow-ups and status queries; they are not independent tasks.',
        'Frequency is keyword-based, multi-label, distinct-session coverage; manual review is required.',
        'Compacted or removed messages and log-only sessions are not reconstructed from this database.',
        'Stored empty assistant messages alone do not prove an empty upstream reply or user-visible failure.',
        'No raw user text, tool inputs, outputs, system prompts or credentials are exported.',
      ],
      families,
      sessions,
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  const [database, output, since, until] = process.argv.slice(2)
  if (!database || !output || !since || !until) {
    throw new Error('Usage: session-corpus.ts DATABASE NEW_OUTPUT_DIR SINCE UNTIL')
  }
  // Output is exclusive; never overwrite an earlier scan or operational data.
  mkdirSync(output)
  const result = scanDatabase(database, since, until)
  const root = resolve(database, '..', 'sessions')
  const directories = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('_')) return []
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return [entry.name]
    return readdirSync(resolve(root, entry.name), { withFileTypes: true })
      .filter((child) => child.isDirectory())
      .map((child) => child.name)
  })
  const registered = new Set(result.sessions.map((session) => session.id))
  const distinct = new Set(directories)
  writeFileSync(
    resolve(output, 'inventory.json'),
    `${JSON.stringify({ ...result, logDirectories: { count: directories.length, distinctSessionIds: distinct.size, duplicateDirectories: directories.length - distinct.size, notInDatabase: [...distinct].filter((id) => !registered.has(id)).length } }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  console.log(
    JSON.stringify(
      { ...result.counts, families: result.families.map(({ sessionIds: _, ...family }) => family) },
      null,
      2,
    ),
  )
}
