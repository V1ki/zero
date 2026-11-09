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
import { TriggerStore } from '@zero-os/observe'
import { RouterWorkspaceService } from '../router-workspace'
import { RouterJobs } from '../router-jobs'
import { RouterJobPrincipals, jobActor } from '../router-job-principal'
import { TriggerRoutingRuntime } from '../routing-runtime'
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
const principalFor = (actor: 'web' | CommissionOperator) =>
  actor === 'web' || (actor.operatorId === 'p' && actor.peerId === 'p') ? 'router-owner' : null
const resolver = (overrides: Partial<RouterCodexCheckout> = {}) =>
  createRouterCheckoutResolver({ [repo]: { path: workspace, ...overrides } }, zeroDir, principalFor)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-router-checkout-')))
  workspace = join(root, 'project')
  zeroDir = join(root, '.zero')
  mkdirSync(zeroDir)
  execFileSync('git', ['init', '-q', workspace])
  config('remote.origin.url', 'git@github.com:example/Service.git')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('one repository mapping follows the verified owner across all Router entrances', async () => {
  const find = resolver()
  expect(await find(repo, 'web')).toBe(workspace)
  for (const platform of ['weixin', 'feishu', 'dingtalk'] as const)
    expect(await find(repo, { ...bot, platform })).toBe(workspace)
  expect(await find(repo, { ...bot, operatorId: 'other' })).toBeNull()
  expect(await find('example/other', bot)).toBeNull()
  config('remote.origin.url', 'https://github.com/another/repo.git')
  expect(await find(repo, bot)).toBeNull()
})

test('rechecks exact root, runtime overlap, local origin, multiple URLs and credentials', async () => {
  const find = resolver()
  mkdirSync(join(workspace, 'child'))
  expect(await resolver({ path: join(workspace, 'child') })(repo, 'web')).toBeNull()
  const activeRuntime = join(workspace, 'child')
  expect(
    await createRouterCheckoutResolver(
      { [repo]: { path: workspace } },
      activeRuntime,
      principalFor,
    )(repo, 'web'),
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

test('reads legacy checkout configuration without requiring channel grants', () => {
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
  expect(loadConfig(file).router?.codexCheckouts[repo.toLowerCase()]).toEqual({ path: workspace })
})

test('a tracked repository without a mapping acquires one shared checkout on demand', async () => {
  const checkoutRoot = join(root, 'managed')
  let clones = 0
  const resolve = createRouterCheckoutResolver({}, zeroDir, principalFor, {
    root: checkoutRoot,
    isTracked: (name) => name === repo.toLowerCase(),
    clone: async (name, dest) => {
      clones++
      execFileSync('git', ['init', '-q', dest])
      execFileSync('git', ['-C', dest, 'remote', 'add', 'origin', `https://github.com/${name}.git`])
    },
  })
  expect(await resolve(repo, { ...bot, operatorId: 'unknown' })).toBeNull()
  expect(await resolve('unknown/repo', 'web')).toBeNull()
  expect(clones).toBe(0)
  expect(await resolve(repo, bot)).toBe(join(checkoutRoot, repo.toLowerCase()))
  expect(await resolve(repo, 'web')).toBe(join(checkoutRoot, repo.toLowerCase()))
  expect(clones).toBe(1)
})

test('a request to open a fix PR from the verified WeChat owner reaches the engineering executor with the web checkout', async () => {
  const store = new TriggerStore(':memory:')
  const deny = async (): Promise<never> => {
    throw Error('Unexpected external delivery')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: deny,
    weixin: { listTargets: () => [], send: deny },
    personal: {
      listPersonalBots: () => [{ ...bot, label: 'fixture', online: true }],
      listPersonalTargets: () => [{ ...bot, label: 'fixture' }],
      listPersonalDirectTargets: () => [{ ...bot, label: 'fixture' }],
      sendPersonal: deny,
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    { ...config.settings, personalBots: { weixin: bot.channelId } },
    config.revision,
  )
  const modelAccess = routing.claimRouterImTarget(bot)
  expect(modelAccess?.()).toBe(true)
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'fixture-repo-read' })
  const matter = store.ledger.createMatter('router-owner', '修复图片问题', '修复并开 PR', [
    '验证与 PR 链接',
  ])
  const path = resolver()
  const done = Promise.withResolvers<{ status: string; result: string | null }>()
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: async (job) => {
      const actor = jobActor(job)
      if (!actor || !job.repository) throw Error('Missing dispatch identity')
      expect(await path(job.repository, actor)).toBe(workspace)
      expect(job.executor).toBe('codex')
      return { result: '隔离执行器已收到修复和开 PR 的任务' }
    },
    completed: async (job) => {
      done.resolve(job)
      return 'delivered'
    },
  })
  const service = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      if (!input.actions?.delegateTask || !signal) throw Error('Missing dispatch')
      const result = await input.actions.delegateTask(
        { executor: 'codex', matterId: matter.id, repository: repo, instruction: input.question },
        signal,
      )
      return { text: `已交给 Worker #${result.id}` }
    },
    { principals, principalFor, checkout: path, delegatedJobs: jobs },
  )
  try {
    service.start()
    const answer = await service.handleIm(
      {
        platform: 'weixin',
        channelId: bot.channelId,
        peerId: bot.peerId,
        actorId: bot.operatorId,
        messageId: 'pr',
        text: '创建对应的 PR 修复这个问题',
        isDirect: true,
      },
      () => !!modelAccess?.(),
    )
    expect(answer).toContain('Worker #')
    expect(await done.promise).toMatchObject({
      status: 'completed',
      result: '隔离执行器已收到修复和开 PR 的任务',
    })
  } finally {
    await service.close()
    await routing.close()
    store.close()
  }
})
