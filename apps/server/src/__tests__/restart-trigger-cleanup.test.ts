import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import { recordRestartSentinel, recoverInterruptedSessionsAfterRestart } from '../runtime/restart'
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
  test('does not send either restart notice to a bot now owned by Router', async () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'zero-restart-router-only-'))
    tempDirs.push(zeroDir)
    const restartSentinelPath = join(zeroDir, 'restart-sentinel.json')
    const sessionManager = {
      isRouterOwnedChannel: (source: string, channel: string) =>
        source === 'weixin' && channel === 'personal',
    } as unknown as SessionManager
    const send = mock(async () => {})
    const channels = new Map([
      ['personal', { type: 'weixin', isConnected: () => true, send } as unknown as Channel],
    ])
    writeRestartTrigger(zeroDir, { source: 'chat', channelName: 'personal', channelId: 'dm' })
    await recordRestartSentinel({
      zeroDir,
      restartSentinelPath,
      sessionManager,
      channels,
      interruptedSessions: [
        { sessionId: 'previous', source: 'weixin', channelName: 'personal', channelId: 'dm' },
      ],
    })
    await recoverInterruptedSessionsAfterRestart({ restartSentinelPath, sessionManager, channels })
    expect(send).not.toHaveBeenCalled()
    expect(existsSync(restartSentinelPath)).toBe(false)
  })

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
