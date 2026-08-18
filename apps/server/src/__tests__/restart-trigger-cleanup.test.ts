import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearRestartTriggerIfMatch,
  consumeRestartTrigger,
  writeRestartTrigger,
} from '../system/restart-trigger'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('restart trigger cleanup', () => {
  test('clears only the trigger created by the failed handoff', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'zero-restart-trigger-cleanup-'))
    tempDirs.push(zeroDir)
    const first = writeRestartTrigger(zeroDir, { source: 'cli' })
    const replacement = writeRestartTrigger(zeroDir, { source: 'chat' })

    expect(clearRestartTriggerIfMatch(zeroDir, first.id)).toBe(false)
    expect(existsSync(join(zeroDir, 'restart-trigger.json'))).toBe(true)
    expect(clearRestartTriggerIfMatch(zeroDir, replacement.id)).toBe(true)
    expect(existsSync(join(zeroDir, 'restart-trigger.json'))).toBe(false)
  })

  test('restores a claimed replacement when its id does not match', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'zero-restart-trigger-replacement-'))
    tempDirs.push(zeroDir)
    const replacement = writeRestartTrigger(zeroDir, {
      source: 'chat',
      channelName: 'feishu:ops',
    })

    expect(clearRestartTriggerIfMatch(zeroDir, 'older-trigger-id')).toBe(false)
    expect(consumeRestartTrigger(zeroDir)).toEqual({
      source: 'chat',
      channelName: 'feishu:ops',
    })
    expect(clearRestartTriggerIfMatch(zeroDir, replacement.id)).toBe(false)
  })
})
