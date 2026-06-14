import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import { createXSearchTool } from '../runtime/tools'

const tempDirs: string[] = []

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-x-search-tool-'))
  tempDirs.push(dir)
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return vault
}

function createConfig(providers: SystemConfig['providers'] = {}): SystemConfig {
  return {
    providers,
    defaultModel: 'mock/provider',
    fallbackChain: [],
    schedules: [],
    fuseList: [],
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createXSearchTool', () => {
  test('skips x_search when no xAI credentials are configured', () => {
    const vault = createVault()

    expect(createXSearchTool({ config: createConfig(), vault })).toBeNull()
  })

  test('creates x_search when xai_api_key is available', () => {
    const vault = createVault()
    vault.set('xai_api_key', 'xai-secret')

    const tool = createXSearchTool({ config: createConfig(), vault })

    expect(tool?.name).toBe('x_search')
  })

  test('creates x_search when x-premium OAuth credentials are available', () => {
    const vault = createVault()
    vault.set('x-premium-session', 'serialized-session')

    const tool = createXSearchTool({
      config: createConfig({
        'x-premium': {
          apiType: 'x_responses',
          baseUrl: 'https://api.x.ai/v1',
          auth: {
            type: 'oauth2',
            oauthTokenRef: 'x-premium-session',
          },
          models: {},
        },
      }),
      vault,
    })

    expect(tool?.name).toBe('x_search')
  })
})
