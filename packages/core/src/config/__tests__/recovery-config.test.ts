import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../loader'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runtime recovery config', () => {
  test('normalizes snake_case recovery deadlines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-recovery-config-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'config.yaml')
    writeFileSync(
      configPath,
      `
providers: {}
default_model: ''
fallback_chain: []
recovery:
  channel_check_interval_ms: 15000
  channel_disconnect_grace_ms: 180000
  channel_base_backoff_ms: 30000
  channel_max_backoff_ms: 600000
  channel_recovery_timeout_ms: 30000
  session_stall_timeout_ms: 1800000
`,
    )

    expect(loadConfig(configPath).recovery).toEqual({
      channelCheckIntervalMs: 15_000,
      channelDisconnectGraceMs: 180_000,
      channelBaseBackoffMs: 30_000,
      channelMaxBackoffMs: 600_000,
      channelRecoveryTimeoutMs: 30_000,
      sessionStallTimeoutMs: 1_800_000,
    })
  })

  test('ignores non-positive and non-numeric recovery values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-recovery-config-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'config.yaml')
    writeFileSync(
      configPath,
      `
providers: {}
default_model: ''
fallback_chain: []
recovery:
  channel_check_interval_ms: 0
  channel_disconnect_grace_ms: nope
  session_stall_timeout_ms: -1
`,
    )

    expect(loadConfig(configPath).recovery).toEqual({})
  })

  test('accepts zero for grace/backoff and ignores fractional durations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-recovery-config-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'config.yaml')
    writeFileSync(
      configPath,
      `
providers: {}
default_model: ''
fallback_chain: []
recovery:
  channel_check_interval_ms: 1.5
  channel_disconnect_grace_ms: 0
  channel_base_backoff_ms: 0
  channel_max_backoff_ms: 0
  channel_recovery_timeout_ms: 2.5
  session_stall_timeout_ms: 3.5
`,
    )

    expect(loadConfig(configPath).recovery).toEqual({
      channelDisconnectGraceMs: 0,
      channelBaseBackoffMs: 0,
      channelMaxBackoffMs: 0,
    })
  })
})
