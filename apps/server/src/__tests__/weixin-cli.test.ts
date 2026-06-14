import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import { renderQrForTerminal, upsertWeixinChannelConfig } from '../channels/weixin'

describe('weixin CLI usage', () => {
  test('prints usage and exits before QR login when no subcommand is provided', () => {
    const result = spawnSync('bun', ['run', 'apps/server/src/cli.ts', 'weixin'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Usage: bun zero weixin login [--name <channel>]',
    )
  })

  test('renders QR payload as terminal block art', () => {
    const rendered = renderQrForTerminal('https://liteapp.weixin.qq.com/q/test?qrcode=abc')

    expect(rendered).toContain('▄▄▄▄')
    expect(rendered.split('\n').length).toBeGreaterThan(5)
  })

  test('upserts Weixin channel config after login', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-weixin-cli-'))
    const configPath = join(dir, 'config.yaml')
    writeFileSync(
      configPath,
      `providers: {}
channels:
  - type: telegram
    name: alerts
    botTokenRef: telegram_token
`,
    )

    try {
      upsertWeixinChannelConfig(configPath, {
        name: 'personal-bot',
        accountIdRef: 'weixin_personal-bot_account_id',
        tokenRef: 'weixin_personal-bot_token',
        baseUrlRef: 'weixin_personal-bot_base_url',
      })
      upsertWeixinChannelConfig(configPath, {
        name: 'personal-bot',
        accountIdRef: 'weixin_personal-bot_account_id',
        tokenRef: 'weixin_personal-bot_token',
        baseUrlRef: 'weixin_personal-bot_base_url',
      })

      const raw = readYaml<{ channels: Array<Record<string, unknown>> }>(configPath)
      expect(raw.channels).toHaveLength(2)
      expect(raw.channels[1]).toEqual({
        type: 'weixin',
        name: 'personal-bot',
        accountIdRef: 'weixin_personal-bot_account_id',
        tokenRef: 'weixin_personal-bot_token',
        baseUrlRef: 'weixin_personal-bot_base_url',
        dmPolicy: 'open',
        groupPolicy: 'disabled',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
