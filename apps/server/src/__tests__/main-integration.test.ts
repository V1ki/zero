import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerTool } from '@zero-os/core'
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

    const worker = hookedZero.toolRegistry.get('worker')
    if (!(worker instanceof WorkerTool)) throw new Error('Expected a Codex Worker tool')
    const close = spyOn(worker, 'close')
    try {
      await hookedZero.shutdown()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
    }
  })

  test('exposes a host source and its registered executor to the normal Router', async () => {
    const project = createTestProjectRoot('zero-router-extension-')
    setIntegrationMasterKey()
    writeIntegrationConfig(project.zeroDir)
    writeIntegrationSecrets(project.zeroDir)
    let emit: ((event: { id: string; data: Record<string, unknown> }) => number) | undefined
    let lifetime: AbortSignal | undefined
    const observed = Promise.withResolvers<void>()
    let restore = () => {}
    let runtime: ZeroOS | undefined
    try {
      runtime = await startZeroOS({
        dataDir: project.zeroDir,
        projectRoot: project.projectRoot,
        skipProcessExit: true,
        routerSources: [
          {
            name: 'station',
            description: '测试站点回执',
            subscribe(receive, signal) {
              emit = receive
              lifetime = signal
            },
          },
        ],
        routerExecutors: [
          {
            name: 'station-reader',
            description: '读取站点原始记录',
            execute: async () => ({ result: '完成' }),
          },
        ],
        onCoreReady(zero) {
          const model = zero.modelRouter.getDefaultModel()
          if (!model) throw Error('Expected fixture model')
          const complete = spyOn(model.adapter, 'complete').mockImplementation(async (req) => {
            const dispatch = req.tools?.find((t) => t.name === 'delegate_task')
            const text = JSON.stringify(req.messages)
            if (
              dispatch &&
              JSON.stringify(dispatch).includes('station-reader') &&
              dispatch.description.includes('读取站点原始记录') &&
              text.includes('fixture-receipt')
            )
              observed.resolve()
            else
              observed.reject(
                Error('Missing registered source, executor or capability description'),
              )
            return {
              id: 'ack',
              model: 'test',
              stopReason: 'end_turn',
              content: [{ type: 'text', text: '已记录站点回执。' }],
              usage: { input: 1, output: 1 },
            }
          })
          restore = () => complete.mockRestore()
        },
      })
      if (!emit) throw Error('Source was not subscribed')
      const input = emit({ id: 'fixture-receipt', data: { reading: 12 } })
      expect(input).toBeGreaterThan(0)
      await observed.promise
    } finally {
      if (runtime) await runtime.shutdown()
      restore()
      project.cleanup()
    }
    expect(lifetime?.aborted).toBe(true)
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

  test('toolRegistry has all runtime tools registered', () => {
    const tools = zero.toolRegistry.list()
    // x_search registers only when x_premium is configured; this fixture has
    // no x_premium, so the unconditional set is asserted in full to make any
    // future tool addition or removal an explicit test update.
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'read',
        'read_image',
        'write',
        'edit',
        'grep',
        'glob',
        'bash',
        'fetch',
        'memory_search',
        'memory_read',
        'memory',
        'schedule',
        'worker',
        'spawn_agent',
        'wait_agent',
        'close_agent',
        'send_input',
      ].sort(),
    )
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
