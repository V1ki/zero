import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

  test('publishes atomically without leaving a temporary artifact', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'restart-trigger-atomic-'))
    tempDirs.push(zeroDir)

    writeRestartTrigger(zeroDir, { source: 'cli' })

    expect(readdirSync(zeroDir)).toEqual(['restart-trigger.json'])
  })

  test('safely drops a malformed trigger instead of aborting shutdown', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'restart-trigger-malformed-'))
    tempDirs.push(zeroDir)
    writeFileSync(join(zeroDir, 'restart-trigger.json'), '{"source":')

    expect(consumeRestartTrigger(zeroDir)).toBeUndefined()
    expect(readdirSync(zeroDir)).toEqual([])
  })

  test('recovers a stale clear claim and removes stale incomplete artifacts', () => {
    const zeroDir = mkdtempSync(join(tmpdir(), 'restart-trigger-stale-'))
    tempDirs.push(zeroDir)
    const oldDate = new Date(Date.now() - 60 * 60_000)
    const staleClearClaim = join(
      zeroDir,
      '.restart-trigger.json.00000000-0000-4000-8000-000000000001.clear-claim',
    )
    const staleTemp = join(
      zeroDir,
      '.restart-trigger.json.00000000-0000-4000-8000-000000000002.tmp',
    )
    const staleConsumeClaim = join(
      zeroDir,
      '.restart-trigger.json.00000000-0000-4000-8000-000000000003.consume-claim',
    )
    writeFileSync(
      staleClearClaim,
      JSON.stringify({
        id: 'trigger-id',
        source: 'chat',
        channelName: 'feishu:ops',
        ts: new Date().toISOString(),
      }),
    )
    writeFileSync(staleTemp, 'incomplete')
    writeFileSync(staleConsumeClaim, JSON.stringify({ source: 'already-claimed' }))
    utimesSync(staleClearClaim, oldDate, oldDate)
    utimesSync(staleTemp, oldDate, oldDate)
    utimesSync(staleConsumeClaim, oldDate, oldDate)

    expect(consumeRestartTrigger(zeroDir)).toEqual({
      source: 'chat',
      channelName: 'feishu:ops',
    })
    expect(readdirSync(zeroDir)).toEqual([])
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
