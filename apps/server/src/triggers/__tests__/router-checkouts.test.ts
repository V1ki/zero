import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import type { CommissionOperator, RouterCodexCheckout } from '@zero-os/shared'
import { createRouterCheckoutResolver } from '../router-checkouts'

let root: string
let workspace: string
let zeroDir: string
const repo = 'Example/Service'
const bot: CommissionOperator = {
  platform: 'weixin',
  channelId: 'personal',
  peerId: 'p',
  operatorId: 'p',
}
const config = (key: string, value: string) =>
  execFileSync('git', ['-C', workspace, 'config', '--local', key, value])
const resolver = (overrides: Partial<RouterCodexCheckout> = {}) =>
  createRouterCheckoutResolver({ [repo]: { path: workspace, ...overrides } }, zeroDir)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-router-checkout-')))
  workspace = join(root, 'project')
  zeroDir = join(root, '.zero')
  mkdirSync(zeroDir)
  execFileSync('git', ['init', '-q', workspace])
  config('remote.origin.url', 'git@github.com:example/Service.git')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('requires a configured GitHub working tree and separately opted-in IM bot', async () => {
  const find = resolver()
  expect(await find(repo, 'web')).toBe(workspace)
  expect(await find('example/other', 'web')).toBeNull()
  expect(await find(repo, bot)).toBeNull()
  const optIn = resolver({ imChannels: [{ platform: bot.platform, channelId: bot.channelId }] })
  expect(await optIn('example/service', bot)).toBe(workspace)
  expect(await optIn(repo, { ...bot, channelId: 'new-bot' })).toBeNull()
  expect(await optIn(repo, { ...bot, platform: 'dingtalk' })).toBeNull()
  config('remote.origin.url', 'https://github.com/another/repo.git')
  expect(await optIn(repo, bot)).toBeNull()
})

test('rechecks exact root, runtime overlap, local origin, multiple URLs and credentials', async () => {
  const find = resolver()
  mkdirSync(join(workspace, 'child'))
  expect(await resolver({ path: join(workspace, 'child') })(repo, 'web')).toBeNull()
  const activeRuntime = join(workspace, 'child')
  expect(
    await createRouterCheckoutResolver({ [repo]: { path: workspace } }, activeRuntime)(repo, 'web'),
  ).toBeNull()
  symlinkSync(zeroDir, join(workspace, '.zero'))
  expect(await find(repo, 'web')).toBeNull()
  rmSync(join(workspace, '.zero'))
  for (const url of [
    'https://name:password@github.com/example/service.git',
    'ext::some-command',
    'https://github.com.evil/example/service.git',
  ]) {
    config('remote.origin.url', url)
    expect(await find(repo, 'web')).toBeNull()
  }
  config('remote.origin.url', 'https://github.com/example/service.git')
  execFileSync('git', [
    '-C',
    workspace,
    'config',
    '--add',
    'remote.origin.url',
    'https://github.com/owner/different',
  ])
  expect(await find(repo, 'web')).toBeNull()
})

test('local Git config checks exclude includes, hooks and external commands', async () => {
  const extra = join(root, 'external-config')
  writeFileSync(extra, '[remote "origin"]\n  url = git@github.com:example/service.git\n')
  execFileSync('git', ['-C', workspace, 'config', '--unset-all', 'remote.origin.url'])
  config('include.path', extra)
  const ran = join(root, 'external-command-ran')
  config('core.fsmonitor', `touch "${ran}"`)
  expect(await resolver()(repo, 'web')).toBeNull()
  expect(existsSync(ran)).toBeFalse()
})

test('loads owner-side checkout configuration with explicit bot grants', () => {
  const file = join(root, 'config.yaml')
  const set = (values: unknown) => writeFileSync(file, JSON.stringify(values))
  set({})
  expect(loadConfig(file).router).toBeUndefined()
  set({
    router: {
      codex_checkouts: {
        [repo]: { path: workspace, im_channels: [{ platform: 'weixin', channel_id: 'personal' }] },
      },
    },
  })
  expect(loadConfig(file).router?.codexCheckouts).toEqual({
    'example/service': {
      path: workspace,
      imChannels: [{ platform: 'weixin', channelId: 'personal' }],
    },
  })
  set({ router: { codexCheckouts: { [repo]: { path: 'relative' } } } })
  expect(() => loadConfig(file)).toThrow('absolute checkout')
  set({
    router: {
      codexCheckouts: {
        [repo]: { path: workspace, imChannels: [{ platform: 'weixin', channelId: '*' }] },
      },
    },
  })
  expect(() => loadConfig(file)).toThrow('exact bot')
})
