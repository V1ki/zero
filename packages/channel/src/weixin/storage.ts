/**
 * Disk-backed stores for Weixin accounts.
 * All writes go through an atomic tmp+rename flow.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function accountsDir(homeDir: string): string {
  const dir = join(homeDir, 'weixin', 'accounts')
  mkdirSync(dir, { recursive: true })
  return dir
}

function atomicWriteJson(path: string, payload: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
  renameSync(tmp, path)
}

export function loadSyncBuf(homeDir: string, accountId: string): string {
  const path = join(accountsDir(homeDir), `${accountId}.sync.json`)
  if (!existsSync(path)) return ''
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { get_updates_buf?: string }
    return typeof data.get_updates_buf === 'string' ? data.get_updates_buf : ''
  } catch {
    return ''
  }
}

export function saveSyncBuf(homeDir: string, accountId: string, syncBuf: string): void {
  const path = join(accountsDir(homeDir), `${accountId}.sync.json`)
  atomicWriteJson(path, { get_updates_buf: syncBuf })
}

/**
 * Disk-backed context_token cache keyed by (accountId, peerId).
 * OpenClaw's Weixin channel is direct-message only, so peerId is the inbound
 * from_user_id and is echoed as to_user_id for replies.
 */
export class ContextTokenStore {
  private readonly accounts = new Map<string, Map<string, string>>()

  constructor(private readonly homeDir: string) {}

  private account(accountId: string) {
    let chats = this.accounts.get(accountId)
    if (!chats) {
      chats = new Map()
      this.accounts.set(accountId, chats)
    }
    return chats
  }

  private tokensPath(accountId: string): string {
    return join(accountsDir(this.homeDir), `${accountId}.context-tokens.json`)
  }

  restore(accountId: string): void {
    const path = this.tokensPath(accountId)
    if (!existsSync(path)) return
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      for (const [chatId, token] of Object.entries(data)) {
        if (typeof token === 'string' && token) {
          this.account(accountId).set(chatId, token)
        }
      }
    } catch {
      // ignore corrupt file
    }
  }

  get(accountId: string, chatId: string): string | undefined {
    return this.accounts.get(accountId)?.get(chatId)
  }

  listPeers(accountId: string): string[] {
    return Array.from(this.accounts.get(accountId)?.keys() ?? [])
  }

  set(accountId: string, chatId: string, token: string): void {
    const chats = this.account(accountId)
    chats.set(chatId, token)
    atomicWriteJson(this.tokensPath(accountId), Object.fromEntries(chats))
  }
}
