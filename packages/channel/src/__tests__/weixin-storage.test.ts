import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextTokenStore, loadSyncBuf, saveSyncBuf } from '../weixin/storage'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'zero-weixin-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('sync buffer', () => {
  test('defaults to empty string', () => {
    expect(loadSyncBuf(tempDir, 'acc')).toBe('')
  })

  test('persists value', () => {
    saveSyncBuf(tempDir, 'acc', 'cursor-123')
    expect(loadSyncBuf(tempDir, 'acc')).toBe('cursor-123')
  })
})

describe('ContextTokenStore', () => {
  test('stores tokens keyed by chatId (DM)', () => {
    const store = new ContextTokenStore(tempDir)
    store.set('acc', 'userA', 't1')
    expect(store.get('acc', 'userA')).toBe('t1')
  })

  test('stores tokens keyed by chatId (group room_id)', () => {
    const store = new ContextTokenStore(tempDir)
    store.set('acc', 'room123@chatroom', 't_group')
    // Unlike the Hermes bug, reading via the room id (not the sender) works.
    expect(store.get('acc', 'room123@chatroom')).toBe('t_group')
  })

  test('restore() rehydrates from disk', () => {
    const s1 = new ContextTokenStore(tempDir)
    s1.set('acc', 'x', 'tx')
    const s2 = new ContextTokenStore(tempDir)
    s2.restore('acc')
    expect(s2.get('acc', 'x')).toBe('tx')
  })

  test('accounts are isolated', () => {
    const store = new ContextTokenStore(tempDir)
    store.set('accA', 'c1', 'a')
    store.set('accB', 'c1', 'b')
    expect(store.get('accA', 'c1')).toBe('a')
    expect(store.get('accB', 'c1')).toBe('b')
  })
})
