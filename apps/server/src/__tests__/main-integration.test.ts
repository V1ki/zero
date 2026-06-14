import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import {
  createTestProjectRoot,
  getSessionAgentForTest,
} from '../../../../packages/core/src/session/__tests__/test-helpers'
import { startZeroOS } from '../main'
import type { ZeroOS } from '../main'
import {
  setIntegrationMasterKey,
  writeIntegrationConfig,
  writeIntegrationSecrets,
} from './main-integration-harness'

let zero: ZeroOS
let testDataDir: string
const testProject = createTestProjectRoot('zero-main-integration-')

beforeAll(async () => {
  testDataDir = testProject.zeroDir
  setIntegrationMasterKey()
  writeIntegrationConfig(testDataDir)
  writeIntegrationSecrets(testDataDir)
  zero = await startZeroOS({
    dataDir: testDataDir,
    projectRoot: testProject.projectRoot,
    skipProcessExit: true,
  })
})

afterAll(async () => {
  await zero.shutdown()
  process.env.ZERO_MASTER_KEY_BASE64 = undefined
  testProject.cleanup()
})

describe('startZeroOS Integration', () => {
  test('runs core-ready hook before external channels start', async () => {
    const observed = {
      webRegistered: false,
      externalChannelsRegistered: false,
    }

    const hookedZero = await startZeroOS({
      dataDir: testDataDir,
      projectRoot: testProject.projectRoot,
      skipProcessExit: true,
      onCoreReady: (runtime) => {
        observed.webRegistered = runtime.channels.has('web')
        observed.externalChannelsRegistered = runtime.channels.size > 1
      },
    })

    expect(observed.webRegistered).toBe(true)
    expect(observed.externalChannelsRegistered).toBe(false)

    await hookedZero.shutdown()
  })

  test('registers an unconfigured Weixin channel without starting it', async () => {
    const weixinProject = createTestProjectRoot('zero-weixin-unconfigured-')
    const dataDir = weixinProject.zeroDir
    setIntegrationMasterKey()
    writeIntegrationConfig(dataDir, { includeUnconfiguredWeixin: true })
    writeIntegrationSecrets(dataDir)

    let weixinZero: ZeroOS | undefined
    try {
      weixinZero = await startZeroOS({
        dataDir,
        projectRoot: weixinProject.projectRoot,
        skipProcessExit: true,
      })
      const channel = weixinZero.channels.get('weixin:test')
      expect(channel?.type).toBe('weixin')
      expect(channel?.isConnected()).toBe(false)
      expect(weixinZero.channelDefinitions.get('weixin:test')?.configured).toBe(false)
    } finally {
      await weixinZero?.shutdown()
      weixinProject.cleanup()
    }
  })

  test('returns all required components', () => {
    expect(zero.config).toBeDefined()
    expect(zero.vault).toBeDefined()
    expect(zero.secretFilter).toBeDefined()
    expect(zero.observability).toBeDefined()
    expect(zero.metrics).toBeDefined()
    expect(zero.modelRouter).toBeDefined()
    expect(zero.toolRegistry).toBeDefined()
    expect(zero.sessionManager).toBeDefined()
    expect(zero.memoryStore).toBeDefined()
    expect(zero.memoManager).toBeDefined()
    expect(zero.tracer).toBeDefined()
    expect(zero.repairEngine).toBeDefined()
    expect(zero.bus).toBeDefined()
    expect(zero.channels).toBeDefined()
    expect(zero.notifications).toBeDefined()
    expect(typeof zero.addNotification).toBe('function')
  })

  test('modelRouter has initialized adapters', () => {
    const current = zero.modelRouter.getCurrentModel()
    expect(current).toBeDefined()
    if (!current) {
      throw new Error('expected current model')
    }
    expect(current.modelName).toBe('gpt-5.4-medium')
  })

  test('passes taskClosureModel into new session agents as a dedicated closure adapter', async () => {
    const closureProject = createTestProjectRoot('zero-task-closure-')
    const dataDir = closureProject.zeroDir
    setIntegrationMasterKey()
    writeIntegrationConfig(dataDir, {
      includeClosureModel: true,
      taskClosureModel: 'openai-codex/gpt-5.3-codex-medium',
    })
    writeIntegrationSecrets(dataDir)

    let closureZero: ZeroOS | undefined

    try {
      closureZero = await startZeroOS({
        dataDir,
        projectRoot: closureProject.projectRoot,
        skipProcessExit: true,
      })
      const session = closureZero.sessionManager.create('web')
      session.initAgent({
        name: 'closure-test-agent',
        agentInstruction: 'Test closure routing.',
      })

      const agent = getSessionAgentForTest<{
        adapter: ProviderAdapter
        closureAdapter: ProviderAdapter
      }>(session)
      expect(agent).toBeDefined()
      expect(agent?.adapter).toBe(closureZero.modelRouter.getDefaultModel()?.adapter)
      expect(agent?.closureAdapter).toBe(
        closureZero.modelRouter.resolveModel('openai-codex/gpt-5.3-codex-medium')?.adapter,
      )
      expect(agent?.closureAdapter).not.toBe(agent?.adapter)
      expect(
        existsSync(join(closureProject.projectRoot, '.zero', 'workspace', 'closure-test-agent')),
      ).toBe(true)
    } finally {
      await closureZero?.shutdown()
      closureProject.cleanup()
    }
  })

  test('toolRegistry has 15 registered tools', () => {
    const tools = zero.toolRegistry.list()
    expect(tools.length).toBe(15)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('read_image')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('bash')
    expect(names).toContain('fetch')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_read')
    expect(names).toContain('memory')
    expect(names).toContain('schedule')
    expect(names).toContain('codex')
    expect(names).toContain('spawn_agent')
    expect(names).toContain('wait_agent')
    expect(names).toContain('close_agent')
    expect(names).toContain('send_input')
  })

  test('channels map contains web, feishu, telegram', () => {
    expect(zero.channels.has('web')).toBe(true)
    expect(zero.channels.has('feishu')).toBe(true)
    expect(zero.channels.has('telegram')).toBe(true)
    // Web should be connected
    const webChannel = zero.channels.get('web')
    if (!webChannel) {
      throw new Error('expected web channel')
    }
    expect(webChannel.isConnected()).toBe(true)
  })

  test('bus can emit events without error', () => {
    expect(() => {
      zero.bus.emit('heartbeat', { key: 'value' })
    }).not.toThrow()
  })
})
