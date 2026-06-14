import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readYaml } from '@zero-os/shared'
import {
  PROVIDER_LOGIN_USAGE,
  buildProviderLoginLabel,
  parseProviderLoginTargetRequest,
  prepareProviderLoginTarget,
} from '../cli/provider-login'
import { getProviderConfigPath } from '../oauth/provider/provider-config'

const previousZeroDataDir = process.env.ZERO_DATA_DIR

function writeConfig(dataDir: string) {
  writeFileSync(
    join(dataDir, 'config.yaml'),
    `providers: {}
default_model: chatgpt/gpt-5.4
fallback_chain: []
schedules: []
fuse_list: []
`,
  )
}

afterEach(() => {
  if (previousZeroDataDir === undefined) {
    process.env.ZERO_DATA_DIR = undefined
  } else {
    process.env.ZERO_DATA_DIR = previousZeroDataDir
  }
})

describe('provider login target', () => {
  test('parses supported provider login targets and name options', () => {
    expect(parseProviderLoginTargetRequest(['login', 'chatgpt', '--name', 'Work'])).toEqual({
      kind: 'chatgpt',
      flags: { name: 'Work' },
    })
    expect(parseProviderLoginTargetRequest(['status', 'chatgpt'])).toBe(null)
    expect(parseProviderLoginTargetRequest(['login', 'unknown'])).toBe(null)
    expect(PROVIDER_LOGIN_USAGE).toContain('provider login <chatgpt|anthropic|x-premium>')
  })

  test('builds default and named provider labels', () => {
    expect(buildProviderLoginLabel('chatgpt', 'chatgpt')).toBe('ChatGPT')
    expect(buildProviderLoginLabel('chatgpt', 'chatgpt-work')).toBe('ChatGPT (chatgpt-work)')
  })

  test('prepares named provider config and returns the display target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-provider-login-target-'))
    process.env.ZERO_DATA_DIR = dir
    writeConfig(dir)

    try {
      const target = prepareProviderLoginTarget({
        kind: 'chatgpt',
        flags: { name: 'Work Account' },
      })

      expect(target).toEqual({
        kind: 'chatgpt',
        providerName: 'chatgpt-work-account',
        label: 'ChatGPT (chatgpt-work-account)',
      })

      const raw = readYaml<Record<string, unknown>>(getProviderConfigPath())
      const providers = raw.providers as Record<string, unknown>
      expect(providers['chatgpt-work-account']).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
