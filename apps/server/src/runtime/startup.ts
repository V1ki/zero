import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Channel } from '@zero-os/channel'
import {
  type Command,
  CommandRouter,
  type SessionManager,
  registerBuiltinCommands,
} from '@zero-os/core'
import type { MetricsDB, ObservabilityStore } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import {
  type Notification,
  type SessionSource,
  type SystemConfig,
  describeError,
} from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import type { ChannelAdapter } from '../channels/adapter'
import { createBackgroundToolCompletionDeliveryHandler } from '../message/background-delivery'
import { writeRestartTrigger } from '../system/restart-trigger'
import { rebuildWebBundleAsync } from '../system/runtime'
import type { BusPayload, EventBus } from './bus'
import { type ChannelRecoveryController, createChannelRecoveryController } from './channel-recovery'
import {
  registerExternalRuntimeChannels,
  registerWebRuntimeChannel,
} from './channel-runtime/runtime'
import type { ChannelRuntimeDefinition } from './channel-runtime/types'
import { type CoreRuntime, createCoreRuntime } from './core'
import { createReloadModelProviders } from './model-providers/reload'
import { recoverInterruptedSessionsAfterRestart } from './restart'
import { type ShutdownRuntime, createShutdownRuntime } from './shutdown'
import type { ZeroOS } from './types'

const DEFAULT_AGENT_INSTRUCTION =
  'You are ZeRo OS, an AI agent system. Be helpful, concise, and accurate.'

interface CreateStartupRuntimeOptions {
  zeroDir: string
  projectRoot: string
  bus: EventBus
  skipProcessExit?: boolean
}

export interface StartupRuntime {
  startedAt: number
  zeroDir: string
  restartSentinelPath: string
  core: CoreRuntime
  zero: ZeroOS
  shutdownRuntime: ShutdownRuntime
  channelRecovery: ChannelRecoveryController
  getConfig(): SystemConfig
}

interface StartupRuntimeShell {
  channels: Map<string, Channel>
  channelAdapters: Map<string, ChannelAdapter>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  channelRecovery: ChannelRecoveryController
  notifications: Notification[]
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}

function getRestartSentinelPath(zeroDir: string): string {
  return join(zeroDir, 'restart-sentinel.json')
}

export async function createStartupRuntime({
  zeroDir,
  projectRoot,
  bus,
  skipProcessExit,
}: CreateStartupRuntimeOptions): Promise<StartupRuntime> {
  const startedAt = Date.now()
  const core = await createCoreRuntime({
    zeroDir,
    projectRoot,
    bus,
  })
  const config = core.config

  const shell = await createStartupRuntimeShell({
    zeroDir,
    bus,
    core,
    config,
  })

  const restartSentinelPath = getRestartSentinelPath(zeroDir)
  const shutdownRuntime = createStartupShutdownRuntime({
    zeroDir,
    restartSentinelPath,
    core,
    bus,
    channels: shell.channels,
    channelRecovery: shell.channelRecovery,
    addNotification: shell.addNotification,
    skipProcessExit,
  })

  const zeroHandle = createZeroOSHandle({
    core,
    config,
    bus,
    shell,
    shutdownRuntime,
  })

  return {
    startedAt,
    zeroDir,
    restartSentinelPath,
    core,
    zero: zeroHandle.zero,
    shutdownRuntime,
    channelRecovery: shell.channelRecovery,
    getConfig: zeroHandle.getConfig,
  }
}

export async function startStartupRuntimeChannels(runtime: StartupRuntime): Promise<void> {
  await startExternalRuntimeChannels({
    zeroDir: runtime.zeroDir,
    startedAt: runtime.startedAt,
    restartSentinelPath: runtime.restartSentinelPath,
    config: runtime.getConfig(),
    vault: runtime.core.vault,
    channels: runtime.zero.channels,
    channelAdapters: runtime.zero.channelAdapters,
    channelDefinitions: runtime.zero.channelDefinitions,
    sessionManager: runtime.core.sessionManager,
    metrics: runtime.core.metrics,
    heartbeat: runtime.core.heartbeat,
    shutdown: runtime.shutdownRuntime.shutdown,
    isShuttingDown: runtime.shutdownRuntime.isShuttingDown,
    registerFeishuStreamingSessionSet: runtime.shutdownRuntime.registerFeishuStreamingSessionSet,
  })
  runtime.channelRecovery.start()
}

export function markStartupRuntimeReady(runtime: StartupRuntime): void {
  runtime.core.heartbeat.setReady(true, 'ready')
  runtime.core.heartbeat.write()
  console.log('[ZeRo OS] System ready.')

  runtime.zero.bus.emit('session:create', { event: 'system_start' })
}

async function createStartupRuntimeShell({
  zeroDir,
  bus,
  core,
  config,
}: {
  zeroDir: string
  bus: EventBus
  core: CoreRuntime
  config: SystemConfig
}): Promise<StartupRuntimeShell> {
  core.heartbeat.setReady(false, 'starting_channels')
  const channels = new Map<string, Channel>()
  const channelAdapters = new Map<string, ChannelAdapter>()
  const channelDefinitions = new Map<string, ChannelRuntimeDefinition>()
  const channelRecovery = createChannelRecoveryController({
    channels,
    channelDefinitions,
    checkIntervalMs: config.recovery?.channelCheckIntervalMs,
    disconnectedGraceMs: config.recovery?.channelDisconnectGraceMs,
    baseBackoffMs: config.recovery?.channelBaseBackoffMs,
    maxBackoffMs: config.recovery?.channelMaxBackoffMs,
    recoveryTimeoutMs: config.recovery?.channelRecoveryTimeoutMs,
  })

  configureRuntimeHeartbeat({
    bus,
    heartbeat: core.heartbeat,
    channels,
    channelDefinitions,
    channelRecovery,
  })
  core.heartbeat.write()

  const { notifications, addNotification } = createNotificationRuntime({
    zeroDir,
    bus,
    channels,
    channelDefinitions,
    sessionManager: core.sessionManager,
  })

  core.startSchedulerRuntime({
    config,
    sessionManager: core.sessionManager,
    channels,
    addNotification,
  })

  await registerWebRuntimeChannel({
    channels,
    channelDefinitions,
    heartbeat: core.heartbeat,
  })

  return {
    channels,
    channelAdapters,
    channelDefinitions,
    channelRecovery,
    notifications,
    addNotification,
  }
}

function createStartupShutdownRuntime({
  zeroDir,
  restartSentinelPath,
  core,
  bus,
  channels,
  channelRecovery,
  addNotification,
  skipProcessExit,
}: {
  zeroDir: string
  restartSentinelPath: string
  core: CoreRuntime
  bus: EventBus
  channels: Map<string, Channel>
  channelRecovery: ChannelRecoveryController
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
  skipProcessExit?: boolean
}): ShutdownRuntime {
  const disposeRuntimeEventListeners = registerRuntimeEventListeners({
    bus,
    observability: core.observability,
    metrics: core.metrics,
    sessionManager: core.sessionManager,
    channels,
    addNotification,
  })

  return createShutdownRuntime({
    zeroDir,
    restartSentinelPath,
    scheduler: core.scheduler,
    sessionManager: core.sessionManager,
    channels,
    stopChannelRecovery: () => channelRecovery.stop(),
    disposeRuntimeEventListeners,
    disposePricing: () => {
      core.modelRouter.dispose()
      core.litellmPricing.dispose()
    },
    heartbeat: core.heartbeat,
    sessionDb: core.sessionDb,
    metrics: core.metrics,
    skipProcessExit,
    flushMemoryUsage: () => core.memoryUsage.flush(),
  })
}

interface StartExternalRuntimeChannelsOptions {
  zeroDir: string
  startedAt: number
  restartSentinelPath: string
  config: SystemConfig
  vault: Vault
  channels: Map<string, Channel>
  channelAdapters: Map<string, ChannelAdapter>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  sessionManager: SessionManager
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'write'>
  shutdown: ShutdownRuntime['shutdown']
  isShuttingDown: ShutdownRuntime['isShuttingDown']
  registerFeishuStreamingSessionSet: ShutdownRuntime['registerFeishuStreamingSessionSet']
}

async function startExternalRuntimeChannels({
  zeroDir,
  startedAt,
  restartSentinelPath,
  config,
  vault,
  channels,
  channelAdapters,
  channelDefinitions,
  sessionManager,
  metrics,
  heartbeat,
  shutdown,
  isShuttingDown,
  registerFeishuStreamingSessionSet,
}: StartExternalRuntimeChannelsOptions): Promise<void> {
  const commandRouter = new CommandRouter()
  registerBuiltinCommands(commandRouter)
  commandRouter.register(createRestartCommand({ zeroDir, startedAt, shutdown }))

  await registerExternalRuntimeChannels({
    zeroDir,
    config,
    vault,
    channels,
    channelAdapters,
    channelDefinitions,
    sessionManager,
    commandRouter,
    metrics,
    heartbeat,
    agentInstruction: DEFAULT_AGENT_INSTRUCTION,
    sessionStallTimeoutMs: config.recovery?.sessionStallTimeoutMs,
    isShuttingDown,
    registerFeishuStreamingSessionSet,
  })

  sessionManager.setBackgroundToolCompletionHandler(
    createBackgroundToolCompletionDeliveryHandler({
      channelAdapters,
      sessionManager,
    }),
  )

  console.log(`[ZeRo OS] ${channels.size} channels registered`)

  await recoverInterruptedSessionsAfterRestart({
    restartSentinelPath,
    sessionManager,
    channels,
  })
}

interface RuntimeEventListenersOptions {
  bus: EventBus
  observability: ObservabilityStore
  metrics: MetricsDB
  sessionManager: SessionManager
  channels: Map<string, Channel>
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}

function registerRuntimeEventListeners({
  bus,
  observability,
  metrics,
  sessionManager,
  channels,
  addNotification,
}: RuntimeEventListenersOptions): () => void {
  const wildcardLogListener = (payload: BusPayload) => {
    if (!shouldPersistBusEvent(payload)) return
    observability.log('info', payload.topic, payload.data)
  }

  const repairMetricsListener = (payload: BusPayload) => {
    metrics.recordRepair({
      sessionId: payload.data.sessionId as string | undefined,
      status: (payload.data.status as string) === 'success' ? 'success' : 'failed',
      diagnosis: (payload.data.diagnosis as string) ?? '',
      action: (payload.data.action as string) ?? '',
      result: (payload.data.result as string) ?? '',
    })
  }

  const toolMetricsListener = (payload: BusPayload) => {
    const sessionId = payload.data.sessionId as string | undefined
    if (!sessionId) return

    metrics.recordOperation({
      sessionId,
      tool: (payload.data.tool as string) ?? '',
      event: 'tool:call',
      success: true,
      durationMs: 0,
      createdAt: payload.timestamp,
    })
  }

  const backgroundToolCompletionListener = (payload: BusPayload) => {
    void notifyBackgroundToolCompletion({
      payload,
      sessionManager,
      channels,
      addNotification,
    })
  }

  bus.on('*', wildcardLogListener)
  bus.on('repair:end', repairMetricsListener)
  bus.on('tool:call', toolMetricsListener)
  bus.on('background_tool:completed', backgroundToolCompletionListener)

  return () => {
    bus.off('*', wildcardLogListener)
    bus.off('repair:end', repairMetricsListener)
    bus.off('tool:call', toolMetricsListener)
    bus.off('background_tool:completed', backgroundToolCompletionListener)
  }
}

async function notifyBackgroundToolCompletion(options: {
  payload: BusPayload
  sessionManager: SessionManager
  channels: Map<string, Channel>
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}): Promise<void> {
  const channelName = options.payload.data.channelName as string | undefined
  const deliveryChannelId = options.payload.data.deliveryChannelId as string | undefined
  if (!channelName || !deliveryChannelId || channelName === 'web') return

  const channel = options.channels.get(channelName)
  const text = buildBackgroundToolNotificationText(options.payload, {
    prefixSessionId: shouldPrefixBackgroundToolSessionId(options.payload, options.sessionManager),
  })
  if (channel?.isConnected()) {
    await channel.send(deliveryChannelId, text).catch((error) => {
      console.error(
        `[ZeRo OS] background tool completion notification failed for ${channelName}:${deliveryChannelId}:`,
        describeError(error),
      )
      options.addNotification({
        type: 'system',
        severity: 'warn',
        title: 'Background tool notification failed',
        description: text,
        source: 'runtime',
        sessionId: options.payload.data.sessionId as string | undefined,
        actionable: false,
      })
    })
    return
  }

  options.addNotification({
    type: 'system',
    severity: 'info',
    title: 'Background tool completed',
    description: text,
    source: 'runtime',
    sessionId: options.payload.data.sessionId as string | undefined,
    actionable: false,
  })
}

export function buildBackgroundToolNotificationText(
  payload: BusPayload,
  options: { prefixSessionId?: boolean } = {},
): string {
  const tool = (payload.data.tool as string | undefined) ?? 'tool'
  const status = payload.data.status === 'success' ? 'completed' : 'failed'
  const summary = (payload.data.outputSummary as string | undefined)?.trim()
  const text = summary
    ? `Background ${tool} task ${status}: ${summary}`
    : `Background ${tool} task ${status}.`
  const sessionId = (payload.data.sessionId as string | undefined)?.trim()
  return options.prefixSessionId && sessionId ? `${sessionId}: ${text}` : text
}

export function shouldPrefixBackgroundToolSessionId(
  payload: BusPayload,
  sessionManager: Pick<SessionManager, 'isCurrentSessionForChannel'>,
): boolean {
  const sessionId = (payload.data.sessionId as string | undefined)?.trim()
  const source = payload.data.source as SessionSource | undefined
  const channelId = payload.data.channelId as string | undefined
  const channelName = payload.data.channelName as string | undefined
  const participantId = payload.data.participantId as string | undefined
  if (!sessionId || !source || !channelId) return false

  return !sessionManager.isCurrentSessionForChannel(
    source,
    channelId,
    channelName,
    sessionId,
    participantId,
  )
}

function shouldPersistBusEvent(payload: BusPayload) {
  switch (payload.topic) {
    case 'session:create':
    case 'model:switch':
    case 'notification':
    case 'repair:start':
    case 'repair:end':
    case 'fuse:trigger':
    case 'background_tool:started':
    case 'background_tool:completed':
      return true
    case 'session:update':
      return (
        payload.data.event === 'binding_set' ||
        payload.data.event === 'binding_replaced' ||
        payload.data.event === 'binding_cleared' ||
        payload.data.event === 'session_backgrounded' ||
        payload.data.event === 'session_stall_recovered' ||
        payload.data.event === 'task_closure_decision' ||
        payload.data.event === 'task_closure_failed'
      )
    default:
      return false
  }
}

interface RuntimeHeartbeatOptions {
  bus: EventBus
  heartbeat: HeartbeatWriter
  channels: Map<string, Channel>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  channelRecovery: ChannelRecoveryController
}

function configureRuntimeHeartbeat({
  bus,
  heartbeat,
  channels,
  channelDefinitions,
  channelRecovery,
}: RuntimeHeartbeatOptions): void {
  heartbeat.setHealthMetricsProvider(() => {
    const recoveryByName = new Map(
      channelRecovery.getSnapshot().map((snapshot) => [snapshot.name, snapshot]),
    )
    return {
      channels: Array.from(channels.entries()).map(([name, channel]) => {
        const recovery = recoveryByName.get(name)
        return {
          name,
          type: channel.type,
          connected: recovery?.connected ?? readChannelConnected(channel),
          configured: channelDefinitions.get(name)?.configured ?? channel.type === 'web',
          ...(recovery
            ? {
                recoveryState: recovery.state,
                recoveryAttempts: recovery.attemptCount,
                disconnectedSince: recovery.disconnectedSince,
                nextRecoveryAt: recovery.nextAttemptAt,
                lastRecoveredAt: recovery.lastRecoveredAt,
                lastRecoveryError: recovery.lastError,
              }
            : {}),
        }
      }),
    }
  })
  heartbeat.setOnWrite((data) => {
    bus.emit('heartbeat', {
      status: data.health.status,
      channels: data.channels,
      disconnectedChannels: data.health.channels.offline,
      timestamp: data.timestamp,
    })
  })
}

function readChannelConnected(channel: Channel): boolean {
  try {
    return channel.isConnected()
  } catch {
    return false
  }
}

interface NotificationRuntimeOptions {
  zeroDir: string
  bus: EventBus
  channels: Map<string, Channel>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  sessionManager: SessionManager
}

interface NotificationRuntime {
  notifications: Notification[]
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}

function createNotificationRuntime({
  zeroDir,
  bus,
  channels,
  channelDefinitions,
  sessionManager,
}: NotificationRuntimeOptions): NotificationRuntime {
  const notifications: Notification[] = []
  const notificationsPath = join(zeroDir, 'logs', 'notifications.jsonl')

  if (existsSync(notificationsPath)) {
    const lines = readFileSync(notificationsPath, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        notifications.push(JSON.parse(line))
      } catch {}
    }
  }

  function addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification {
    const notification: Notification = {
      ...n,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    notifications.push(notification)
    appendFileSync(notificationsPath, `${JSON.stringify(notification)}\n`)
    bus.emit('notification', {
      notification,
      event: 'notification:new',
    })

    for (const [name, ch] of channels) {
      const definition = channelDefinitions.get(name)
      if (!definition?.receiveNotifications || !ch.isConnected() || ch.type === 'web') continue
      const chatIds = sessionManager.getCurrentChannelIds(definition.type as SessionSource, name)
      const text = `[notification]${notification.title}: ${notification.description}`
      for (const chatId of chatIds) {
        ch.send(chatId, text).catch(() => {})
      }
    }

    return notification
  }

  return { notifications, addNotification }
}

function createRestartCommand({
  zeroDir,
  startedAt,
  shutdown,
}: {
  zeroDir: string
  startedAt: number
  shutdown(): Promise<void>
}): Command {
  return {
    name: '/restart',
    description: 'Rebuild the web UI and restart ZeRo OS.',
    parse(content) {
      if (Date.now() - startedAt < 15_000) return null
      return /^\/restart(?:@\S+)?$/i.test(content.trim()) ? {} : null
    },
    async execute(_args, ctx) {
      if (ctx.source === 'telegram' && ctx.metadata?.chatType !== 'private') {
        return {
          handled: true,
          reply: 'The /restart command is only available in private chats.',
        }
      }

      await ctx.reply('Rebuilding web UI and restarting ZeRo OS...')

      const build = await rebuildWebBundleAsync()
      if (!build.ok) {
        await ctx.reply(`Web rebuild failed, restart cancelled: ${build.error ?? 'unknown error'}`)
        return { handled: true }
      }

      if (ctx.source === 'feishu' || ctx.source === 'telegram' || ctx.source === 'weixin') {
        try {
          writeRestartTrigger(zeroDir, {
            source: 'chat',
            channelName: ctx.channelName,
            channelId: ctx.chatId,
          })
        } catch (error) {
          await ctx.reply(
            `Failed to record restart trigger, restart cancelled: ${describeError(error)}`,
          )
          return { handled: true }
        }
      }

      setTimeout(() => {
        void shutdown()
      }, 500)
      return { handled: true }
    },
  }
}

function createZeroOSHandle({
  core,
  config: initialConfig,
  bus,
  shell,
  shutdownRuntime,
}: {
  core: CoreRuntime
  config: SystemConfig
  bus: EventBus
  shell: StartupRuntimeShell
  shutdownRuntime: ShutdownRuntime
}): {
  zero: ZeroOS
  getConfig(): SystemConfig
} {
  let config = initialConfig
  const zeroRef: { current?: ZeroOS } = {}
  const reloadModelProviders = createReloadModelProviders({
    configPath: core.configPath,
    vault: core.vault,
    providerHealth: core.providerHealth,
    modelRouter: core.modelRouter,
    usageRecorder: core.usageRecorder,
    sessionManager: core.sessionManager,
    bus,
    setConfig(nextConfig) {
      config = nextConfig
      if (zeroRef.current) zeroRef.current.config = nextConfig
    },
  })

  const zero: ZeroOS = {
    config,
    bus,
    vault: core.vault,
    secretFilter: core.secretFilter,
    observability: core.observability,
    metrics: core.metrics,
    sessionDb: core.sessionDb,
    modelRouter: core.modelRouter,
    providerHealth: core.providerHealth,
    toolRegistry: core.toolRegistry,
    sessionManager: core.sessionManager,
    memoryStore: core.memoryStore,
    memoryRetriever: core.memoryRetriever,
    memoryLifecycle: core.memoryLifecycle,
    vectorIndex: core.vectorIndex,
    memoManager: core.memoManager,
    tracer: core.tracer,
    repairEngine: core.repairEngine,
    heartbeat: core.heartbeat,
    scheduler: core.scheduler,
    channels: shell.channels,
    channelAdapters: shell.channelAdapters,
    channelDefinitions: shell.channelDefinitions,
    channelRecovery: shell.channelRecovery,
    notifications: shell.notifications,
    addNotification: shell.addNotification,
    reloadModelProviders,
    isShuttingDown: shutdownRuntime.isShuttingDown,
    shutdown: shutdownRuntime.shutdown,
  }
  zeroRef.current = zero

  return {
    zero,
    getConfig: () => config,
  }
}
