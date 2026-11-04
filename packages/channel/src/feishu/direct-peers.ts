import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function feishuDirectPeerStorePath(zeroDir: string, name: string, appId: string): string {
  const account = createHash('sha256')
    .update(JSON.stringify([name, appId]))
    .digest('hex')
  return join(zeroDir, 'channels', 'feishu', `${account}.sqlite`)
}

/** Only authenticated IM observations belong here. Session bindings also include group chats. */
export class FeishuDirectPeers {
  private db?: Database

  constructor(private readonly path = ':memory:') {}

  private open(): Database {
    if (!this.db) {
      if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const db = new Database(this.path, { create: true })
      db.exec(`PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS direct_peers (
          chatId TEXT NOT NULL, actorId TEXT NOT NULL, PRIMARY KEY (chatId, actorId)
        )`)
      this.db = db
    }
    return this.db
  }

  list(): Array<{ chatId: string; actorId: string }> {
    if (!this.db && (this.path === ':memory:' || !existsSync(this.path))) return []
    const db = this.db ?? new Database(this.path, { readonly: true })
    try {
      return db
        .query<{ chatId: string; actorId: string }, []>(
          'SELECT chatId, actorId FROM direct_peers ORDER BY chatId, actorId',
        )
        .all()
    } finally {
      if (db !== this.db) db.close()
    }
  }

  recordVerifiedDirect(chatId: string, actorId: string) {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId) || !/^ou_[a-zA-Z0-9_-]+$/.test(actorId)) return
    this.open().run('INSERT OR IGNORE INTO direct_peers VALUES (?, ?)', [chatId, actorId])
  }

  forgetGroup(chatId: string) {
    if (!this.db && (this.path === ':memory:' || !existsSync(this.path))) return
    this.open().run('DELETE FROM direct_peers WHERE chatId = ?', [chatId])
  }

  close() {
    this.db?.close()
    this.db = undefined
  }
}
