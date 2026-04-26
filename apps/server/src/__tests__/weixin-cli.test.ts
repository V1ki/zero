import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import { renderQrForTerminal } from '../weixin-cli'

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
})
