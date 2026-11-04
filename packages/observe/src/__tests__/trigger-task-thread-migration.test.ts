import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '../trigger-store'

const hash = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const imId = (id: number, actor: string, message: string, task = true) => {
  const prefix = hash('weixin', 'channel', 'person', actor, String(task), String(id))
  return `im-${prefix}-${hash('weixin', 'channel', 'person', actor, message)}`
}

test('old integer threads upgrade in place and only proven task IM replies leave the event thread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-task-migration-'))
  const path = join(dir, 'history.sqlite')
  try {
    const base = new TriggerStore(path)
    base.close()
    const seed = new Database(path)
    const stamp = new Date().toISOString()
    const first = imId(8, 'person', 'first')
    const last = imId(8, 'person', 'pending')
    const other = imId(9, 'person', 'sibling')
    const legacyEvent = imId(8, 'person', 'event', false)
    const forged = imId(8, 'other', 'unproven')
    try {
      seed.exec(`DROP VIEW trigger_visible_turns;
        DROP TABLE trigger_conversation_turns;
        DROP TABLE trigger_conversation_actions;
        CREATE TABLE trigger_conversation_turns(id INTEGER PRIMARY KEY, thread INTEGER NOT NULL CHECK(thread>=0),
        request_id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT,status TEXT NOT NULL,attempt INTEGER NOT NULL,
        error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(thread,request_id));
        CREATE TABLE trigger_conversation_actions(thread INTEGER NOT NULL CHECK(thread>=0),request_id TEXT NOT NULL,
        identity TEXT NOT NULL,PRIMARY KEY(thread,request_id));
        CREATE VIEW trigger_visible_turns AS SELECT * FROM trigger_conversation_turns;`)
      for (const id of [8, 9]) {
        seed.run(
          `INSERT INTO mandate_tasks(id,mandate_id,business_key,title,latest_inbox_id,updated_at)
          VALUES(?,?,?,?,3,?)`,
          [id, `mandate-${id}`, 'pr:1', 'Test', stamp],
        )
        seed.run(
          "INSERT INTO mandate_matches(id,task_id,mandate_id,inbox_id,status) VALUES(?,?,?,3,'ready')",
          [id, id, `mandate-${id}`],
        )
        seed.run(
          "INSERT INTO mandate_effects(match_id,kind,status,destination,target) VALUES(?,'notify','done','weixin',?)",
          [id, JSON.stringify({ platform: 'weixin', channelId: 'channel', peerId: 'person' })],
        )
      }
      for (const [i, request] of [
        first,
        other,
        legacyEvent,
        forged,
        'web-question',
        last,
      ].entries()) {
        seed.run(
          `INSERT INTO trigger_conversation_turns VALUES(?,3,?,'test question',?, ?,1,NULL,?,?)`,
          [
            i + 1,
            request,
            request === last ? null : '{"text":"private reply"}',
            request === last ? 'pending' : 'completed',
            stamp,
            stamp,
          ],
        )
      }
      seed.run("INSERT INTO trigger_conversation_actions VALUES (0,'im-in-global','receipt')")
      seed.run("INSERT INTO trigger_conversation_actions VALUES (3,'web-action','web-card')")
    } finally {
      seed.close()
    }
    const store = new TriggerStore(path)
    try {
      const turns = store.conversations
      expect(turns.list('task-8').map((t) => [t.id, t.requestId])).toEqual([[1, first]])
      expect(turns.list('task-9').map((t) => t.requestId)).toEqual([other])
      expect(turns.list(3).map((t) => t.requestId)).toEqual([
        legacyEvent,
        forged,
        'web-question',
        last,
      ])
      expect(turns.getActionIdentity('general', 'im-in-global')).toBe('receipt')
      expect(turns.getActionIdentity(3, 'web-action')).toBe('web-card')
      expect(turns.begin(3, first, 'replay').kind).toBe('conflict')
      expect(turns.begin('task-8', first, 'test question').kind).toBe('existing')
      expect(turns.get(3, last)?.status).toBe('pending')
      turns.recoverInterrupted()
      expect(turns.get('task-8', last)?.status).toBe('failed')
      expect(turns.get(3, last)).toBeNull()
      const second = new TriggerStore(path)
      try {
        expect(second.conversations.list('task-8').map((t) => t.id)).toEqual([1, 6])
      } finally {
        second.close()
      }
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
