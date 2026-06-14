import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consumeRestartTrigger,
  formatRestartTriggerLog,
  writeRestartTrigger,
} from '../system/restart-trigger'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('restart trigger helpers', () => {
  test('writes only defined trigger fields and consumes the file once', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'restart-trigger-'))
    tempDirs.push(zeroDir)

    writeRestartTrigger(zeroDir, {
      source: 'cli',
      sessionId: 'sess_123',
      channelName: 'telegram:ops',
    })

    expect(existsSync(join(zeroDir, 'restart-trigger.json'))).toBe(true)

    const trigger = consumeRestartTrigger(zeroDir)
    expect(trigger).toEqual({
      source: 'cli',
      sessionId: 'sess_123',
      channelName: 'telegram:ops',
    })
    expect(existsSync(join(zeroDir, 'restart-trigger.json'))).toBe(false)
  })

  test('formats restart trigger logs with optional channel and session details', () => {
    expect(
      formatRestartTriggerLog({
        source: 'chat',
        channelName: 'feishu:ops',
        sessionId: 'sess_456',
      }),
    ).toBe('[ZeRo OS] Restart was triggered by chat (feishu:ops) session=sess_456')

    expect(formatRestartTriggerLog({ source: 'cli' })).toBe(
      '[ZeRo OS] Restart was triggered by cli',
    )
  })
})
