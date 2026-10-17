import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type StoredMessage, exclusion, scanDatabase, taskMessages } from '../session-corpus'

const message = (id: string, text: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  id,
  role: 'user',
  messageType: 'message',
  createdAt: '2026-09-01T00:00:00Z',
  content: [{ type: 'text', text }],
  ...extra,
})

test('exclude runtime re-injections but retain queued steering and repeated real requests', () => {
  const messages = [
    message('1', '看看这个论文'),
    message('2', '补充：用中文', { messageType: 'queued', source: { messageId: 'external' } }),
    message('3', '<queued_message>补充：用中文</queued_message>', { messageType: 'control' }),
    message('4', '补充：用中文', { source: { messageId: 'external' } }),
    message('5', '看看这个论文'),
    message('6', '[以下是之前对话的摘要] old task'),
    message('7', '', { content: [{ type: 'tool_result' }] }),
  ]
  expect(taskMessages(messages).map(({ index }) => index)).toEqual([0, 1, 4])
  expect(exclusion(message('8', '[文件: a.xlsx] 已下载到: /a'))).toBe('attachment-notice')
})

test('read-only scan uses message dates, deduplicates family sessions and exports no content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-corpus-'))
  const path = join(dir, 'sessions.db')
  try {
    const db = new Database(path)
    db.exec('CREATE TABLE sessions (id TEXT, source TEXT, created_at TEXT)')
    db.exec('CREATE TABLE session_messages (session_id TEXT, messages_json TEXT)')
    db.query('INSERT INTO sessions VALUES (?, ?, ?)').run('s', 'web', '2020-01-01')
    db.query('INSERT INTO session_messages VALUES (?, ?)').run(
      's',
      JSON.stringify([
        message('1', '论文 API password=DO_NOT_EXPORT'),
        message('2', '论文'),
        message('3', '论文', { createdAt: '2026-09-02T00:00:00Z' }),
      ]),
    )
    db.close()
    const before = readFileSync(path)
    const scan = scanDatabase(path, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')
    expect(scan.counts.recentTaskMessageCandidates).toBe(2)
    expect(scan.families.find((family) => family.id === 'source-research')?.sessionCount).toBe(1)
    expect(JSON.stringify(scan)).not.toContain('DO_NOT_EXPORT')
    expect(JSON.stringify(scan)).not.toContain('password')
    expect(readFileSync(path)).toEqual(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
