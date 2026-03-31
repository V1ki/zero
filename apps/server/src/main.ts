import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Channel, FeishuStreamingSession } from '@zero-os/channel'
import { FeishuChannel, TelegramChannel, WebChannel } from '@zero-os/channel'
import type { AgentSnapshot, Command } from '@zero-os/core'
import {
  CONTEXT_PARAMS,
  CommandRouter,
  loadConfig,
  loadFuseList,
  registerBuiltinCommands,
} from '@zero-os/core'
import {
  BashTool,
  CloseAgentTool,
  CodexTool,
  EditTool,
  FetchTool,
  MemoryGetTool,
  MemorySearchTool,
  MemoryTool,
  ReadTool,
  ScheduleTool,
  SendInputTool,
  SpawnAgentTool,
  TaskTool,
  ToolRegistry,
  WaitAgentTool,
  WriteTool,
} from '@zero-os/core'
import { SessionManager } from '@zero-os/core'
import {
  EmbeddingClient,
  IndexedMemoryStore,
  MemoManager,
  MemoryRetriever,
  MemoryStore,
  VectorIndex,
} from '@zero-os/memory'
import type { MemoryRepository } from '@zero-os/memory'
import { LiteLLMPricing, ModelRouter } from '@zero-os/model'
import { MetricsDB, ObservabilityStore, SessionDB, Tracer } from '@zero-os/observe'
import { CronScheduler } from '@zero-os/scheduler'
import { Vault, generateMasterKey, getMasterKey, setMasterKey } from '@zero-os/secrets'
import { OutputSecretFilter } from '@zero-os/secrets'
import {
  type ChannelInstanceConfig,
  type Notification,
  type ScheduleConfig,
  type SessionSource,
  collectAssistantReply,
  describeError,
  installConsoleTimestamping,
  toErrorMessage,
} from '@zero-os/shared'
import { RepairEngine } from '@zero-os/supervisor'
import { HeartbeatWriter } from '@zero-os/supervisor'
import { globalBus } from './bus'
import { FeishuAdapter } from './feishu-adapter'
import { handleChannelMessage } from './message-handler'
import {
  consumeRestartTrigger,
  formatRestartTriggerLog,
  type RestartTrigger,
  writeRestartTrigger,
} from './restart-trigger'
import { syncTelegramCommandMenu } from './telegram-menu'
import { TelegramAdapter } from './telegram-adapter'
import { rebuildWebBundle } from './web-build'

export interface StartOptions {
  dataDir?: string
  skipProcessExit?: boolean
  onCoreReady?: (zero: ZeroOS) => Promise<void> | void
}

interface FeishuStreamingStarterChannel {
  replyStreaming(messageId: string): Promise<FeishuStreamingSession>
  sendStreaming(chatId: string): Promise<FeishuStreamingSession>
}

export function createFeishuStreamingStarter(
  channel: FeishuStreamingStarterChannel,
  chatId: string,
  replyToMessageId?: string,
): () => Promise<FeishuStreamingSession> {
  return () =>
    replyToMessageId ? channel.replyStreaming(replyToMessageId) : channel.sendStreaming(chatId)
}

interface ChannelRuntimeDefinition {
  name: string
  type: 'web' | 'feishu' | 'telegram'
  configured: boolean
  receiveNotifications: boolean
  secretRefs: string[]
}

interface FeishuRuntimeDefinition extends ChannelRuntimeDefinition {
  type: 'feishu'
  credentials?: {
    appId: string
    appSecret: string
    encryptKey?: string
    verificationToken?: string
  }
}

interface TelegramRuntimeDefinition extends ChannelRuntimeDefinition {
  type: 'telegram'
  credentials?: {
    botToken: string
  }
}

type ExternalChannelRuntimeDefinition = FeishuRuntimeDefinition | TelegramRuntimeDefinition

interface RestartSentinelEntry {
  sessionId: string
  source: SessionSource
  channelId: string
  channelName?: string
  subAgents?: AgentSnapshot[]
}

interface RestartSentinelFile {
  ts: string
  trigger?: RestartTrigger
  sessions: RestartSentinelEntry[]
}

export interface ZeroOS {
  config: ReturnType<typeof loadConfig>
  vault: Vault
  secretFilter: OutputSecretFilter
  observability: ObservabilityStore
  metrics: MetricsDB
  sessionDb: SessionDB
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  sessionManager: SessionManager
  memoryStore: MemoryRepository
  memoryRetriever: MemoryRetriever
  memoManager: MemoManager
  tracer: Tracer
  repairEngine: RepairEngine
  heartbeat: HeartbeatWriter
  scheduler: CronScheduler
  bus: typeof globalBus
  channels: Map<string, Channel>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  notifications: Notification[]
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
  isShuttingDown(): boolean
  shutdown(): Promise<void>
}

/**
 * Initialize and start ZeRo OS.
 */
export async function startZeroOS(options?: StartOptions): Promise<ZeroOS> {
  installConsoleTimestamping()
  const ZERO_DIR = options?.dataDir ?? process.env.ZERO_DATA_DIR ?? join(process.cwd(), '.zero')
  const startedAt = Date.now()
  console.log('[ZeRo OS] Starting...')

  // 1. Ensure .zero/ directory structure exists
  ensureDirectories(ZERO_DIR)

  // 2. Load master key from Keychain (or create if first run)
  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
    console.log('[ZeRo OS] Master key loaded from Keychain')
  } catch {
    console.log('[ZeRo OS] First run — generating master key...')
    masterKey = generateMasterKey()
    await setMasterKey(masterKey)
    console.log('[ZeRo OS] Master key stored in Keychain')
  }

  // 3. Decrypt secrets
  const secretsPath = join(ZERO_DIR, 'secrets.enc')
  const vault = new Vault(masterKey, secretsPath)
  vault.load()
  console.log(`[ZeRo OS] Secrets loaded (${vault.keys().length} keys)`)

  // 4. Secret filter
  const secretFilter = new OutputSecretFilter(vault.entries())

  // 5. Load config
  const configPath = join(ZERO_DIR, 'config.yaml')
  const config = loadConfig(configPath)
  console.log(`[ZeRo OS] Config loaded (${Object.keys(config.providers).length} providers)`)

  // 6. Initialize observability, metrics, and session DB
  const logsDir = join(ZERO_DIR, 'logs')
  const observability = new ObservabilityStore(logsDir)
  const metrics = new MetricsDB(join(logsDir, 'metrics.db'))
  const sessionDb = new SessionDB(join(logsDir, 'sessions.db'))
  const tracer = new Tracer(logsDir)
  const heartbeat = new HeartbeatWriter(join(ZERO_DIR, 'heartbeat.json'))
  heartbeat.setReady(false, 'booting')
  heartbeat.start()
  console.log('[ZeRo OS] Logging initialized')
  console.log('[ZeRo OS] Heartbeat writer started')

  // 6.5. Initialize LiteLLM pricing fallback
  const litellmPricing = LiteLLMPricing.init(join(ZERO_DIR, 'cache'))
  await litellmPricing.ensureLoaded()
  litellmPricing.startRefresh()
  console.log('[ZeRo OS] LiteLLM pricing fallback initialized')

  // 7. Initialize Model Router
  const secrets = new Map(vault.entries())
  const modelRouter = new ModelRouter(config, secrets)
  const initResult = modelRouter.init()
  console.log(`[ZeRo OS] Model Router: ${initResult.message}`)

  // 8. Initialize Tools
  const fuseRules = loadFuseList(join(ZERO_DIR, 'fuse_list.yaml'))
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(new ReadTool())
  toolRegistry.register(new WriteTool())
  toolRegistry.register(new EditTool())
  toolRegistry.register(new BashTool(fuseRules))
  toolRegistry.register(new FetchTool())
  toolRegistry.register(new MemorySearchTool())
  toolRegistry.register(new MemoryGetTool())
  toolRegistry.register(new MemoryTool())
  toolRegistry.register(new TaskTool(modelRouter, toolRegistry))
  toolRegistry.register(new ScheduleTool())
  toolRegistry.register(new CodexTool())
  toolRegistry.register(new SpawnAgentTool(modelRouter, toolRegistry))
  toolRegistry.register(new WaitAgentTool())
  toolRegistry.register(new CloseAgentTool())
  toolRegistry.register(new SendInputTool())
  console.log(`[ZeRo OS] ${toolRegistry.list().length} tools registered`)

  // 9. Memory
  const memoryDir = join(ZERO_DIR, 'memory')
  const baseMemoryStore = new MemoryStore(memoryDir)
  let memoryStore: MemoryRepository = baseMemoryStore
  const memoManager = new MemoManager(join(memoryDir, 'memo.md'))
  let embeddingClient: EmbeddingClient | undefined
  let vectorIndex: VectorIndex | undefined

  const embeddingConfig = config.embedding
  if (embeddingConfig?.baseUrl && embeddingConfig.apiKeyRef && embeddingConfig.model) {
    const apiKey = vault.get(embeddingConfig.apiKeyRef)
    if (apiKey) {
      try {
        heartbeat.setReady(false, 'memory_indexing')
        embeddingClient = new EmbeddingClient({
          baseUrl: embeddingConfig.baseUrl,
          apiKey,
          model: embeddingConfig.model,
          dimensions: embeddingConfig.dimensions,
        })
        vectorIndex = new VectorIndex(join(memoryDir, 'vectors'))
        const indexedMemoryStore = new IndexedMemoryStore(
          baseMemoryStore,
          embeddingClient,
          vectorIndex,
        )
        memoryStore = indexedMemoryStore
        const reindexed = await indexedMemoryStore.reindexAll()
        console.log(`[ZeRo OS] Memory vector index ready (${reindexed} items)`)
      } catch (error) {
        memoryStore = baseMemoryStore

        if (vectorIndex) {
          try {
            await vectorIndex.ensureIndex()
            const stats = await vectorIndex.getStats()
            if (stats.itemCount > 0) {
              console.warn('[ZeRo OS] Using existing memory vector index; reindex skipped', {
                itemCount: stats.itemCount,
                message: toErrorMessage(error),
              })
            } else {
              embeddingClient = undefined
              vectorIndex = undefined
            }
          } catch {
            embeddingClient = undefined
            vectorIndex = undefined
          }
        }

        if (!vectorIndex) {
          console.warn('[ZeRo OS] Memory vector index unavailable, memory search disabled', {
            message: toErrorMessage(error),
          })
        }
      }
    } else {
      console.warn(
        `[ZeRo OS] Embedding secret "${embeddingConfig.apiKeyRef}" not found, memory search disabled`,
      )
    }
  }

  const memoryRetriever = new MemoryRetriever(memoryStore, embeddingClient, vectorIndex, {
    vectorWeight: CONTEXT_PARAMS.retrieval.vectorWeight,
    recencyWeight: CONTEXT_PARAMS.retrieval.recencyWeight,
    recencyHalfLifeDays: CONTEXT_PARAMS.retrieval.recencyHalfLifeDays,
  })

  // 9.5 Identity reader — hot-reloads identity on each turn per agent name
  const identityReader = (agentName: string) => {
    const globalPref = memoryStore.list('preference').find((m) => m.id === 'pref_global')
    return {
      global: globalPref?.content ?? '',
      agent: memoryStore.getAgentPreference(agentName),
    }
  }

  // 10. Session Manager — pass observability deps, memory, bus, secret filter, and identity
  const secretResolver = (ref: string) => vault.get(ref) ?? undefined
  // Pre-create scheduler + handles (trigger handler set later after sessionManager exists)
  const scheduler = new CronScheduler()
  const schedulerHandle = {
    addAndStart: (c: ScheduleConfig) => scheduler.addAndStart(c),
    remove: (n: string) => scheduler.remove(n),
    getStatus: () => scheduler.getStatus(),
  }
  const scheduleStore = {
    save: (c: ScheduleConfig) => sessionDb.saveSchedule(c),
    delete: (n: string) => sessionDb.deleteSchedule(n),
  }

  const sessionManager = new SessionManager(
    modelRouter,
    toolRegistry,
    {
      observability,
      metrics,
      tracer,
      secretFilter,
      secretResolver,
      memoryRetriever,
      memoryStore,
      identityReader,
      bus: globalBus,
      sessionDb,
      schedulerHandle,
      scheduleStore,
      taskClosureModel: config.taskClosureModel,
    },
    sessionDb,
  )

  // 10.5. Restore active sessions from DB
  heartbeat.setReady(false, 'restoring_sessions')
  const restoredCount = sessionManager.restoreFromDB()
  if (restoredCount > 0) {
    console.log(`[ZeRo OS] Restored ${restoredCount} sessions from DB`)
  }

  // 11. Repair Engine
  const repairEngine = new RepairEngine()

  // 13. Scheduler — trigger handler (scheduler + handles created in step 10)
  heartbeat.setReady(false, 'starting_channels')
  const channels = new Map<string, Channel>()
  const channelDefinitions = new Map<string, ChannelRuntimeDefinition>()

  heartbeat.setHealthMetricsProvider(() => ({
    channels: Array.from(channels.entries()).map(([name, channel]) => ({
      name,
      type: channel.type,
      connected: channel.isConnected(),
      configured: channelDefinitions.get(name)?.configured ?? channel.type === 'web',
    })),
  }))
  heartbeat.setOnWrite((data) => {
    globalBus.emit('heartbeat', {
      status: data.health.status,
      channels: data.channels,
      disconnectedChannels: data.health.channels.offline,
      timestamp: data.timestamp,
    })
  })
  heartbeat.write()

  scheduler.setTriggerHandler(async (schedConfig) => {
    const binding = schedConfig.channel
    let session: import('@zero-os/core').Session

    if (binding) {
      const result = sessionManager.getOrCreateForChannel(
        binding.source as SessionSource,
        binding.channelId,
        binding.channelName,
      )
      session = result.session
      if (result.isNew) {
        session.initAgent({
          name: `schedule-${schedConfig.name}`,
          agentInstruction: schedConfig.instruction,
        })
      }
    } else {
      session = sessionManager.create('scheduler')
      session.initAgent({
        name: `schedule-${schedConfig.name}`,
        agentInstruction: schedConfig.instruction,
      })
    }

    const replies = await session.handleMessage(schedConfig.instruction)

    // Deliver result back to originating channel
    if (binding) {
      const channel = channels.get(binding.channelName)
      const text = collectAssistantReply(replies)
      if (channel?.isConnected() && text) {
        await channel.send(binding.channelId, text).catch((err) => {
          console.error(
            `[Scheduler] delivery to ${binding.channelName}:${binding.channelId} failed:`,
            err,
          )
          addNotification({
            type: 'system',
            severity: 'warn',
            title: `Schedule "${schedConfig.name}" delivery failed`,
            description: text.slice(0, 500),
            source: 'scheduler',
            sessionId: session.data.id,
            actionable: false,
          })
        })
      } else if (text) {
        addNotification({
          type: 'system',
          severity: 'info',
          title: `Schedule "${schedConfig.name}" completed (channel offline)`,
          description: text.slice(0, 500),
          source: 'scheduler',
          sessionId: session.data.id,
          actionable: false,
        })
      }
    }
  })

  // Clean up DB when oneShot schedule auto-removes
  scheduler.setOnRemoved((name) => {
    sessionDb.deleteSchedule(name)
  })

  // Load config-based schedules
  for (const s of config.schedules) {
    scheduler.add({ ...s, createdBy: 'config' as const })
  }

  // Load runtime-created (channel-bound) schedules from DB
  const runtimeSchedules = sessionDb.loadRuntimeSchedules()
  for (const s of runtimeSchedules) {
    scheduler.add(s)
  }

  scheduler.start()
  const totalSchedules = config.schedules.length + runtimeSchedules.length
  console.log(
    `[ZeRo OS] Scheduler started (${totalSchedules} schedules: ${config.schedules.length} config + ${runtimeSchedules.length} runtime)`,
  )

  // 14. Notification store
  const notifications: Notification[] = []
  const notificationsPath = join(ZERO_DIR, 'logs', 'notifications.jsonl')

  // Load persisted notifications
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
    // Persist to JSONL
    appendFileSync(notificationsPath, `${JSON.stringify(notification)}\n`)
    // Emit to bus so WS clients receive it
    globalBus.emit('notification', {
      notification,
      event: 'notification:new',
    })
    // Push to explicitly opted-in channels — send to each active conversation
    for (const [name, ch] of channels) {
      const definition = channelDefinitions.get(name)
      if (!definition?.receiveNotifications || !ch.isConnected() || ch.type === 'web') continue
      const chatIds = sessionManager.getActiveChannelIds(definition.type as SessionSource, name)
      const text = `[notification]${notification.title}: ${notification.description}`
      for (const chatId of chatIds) {
        ch.send(chatId, text).catch(() => {})
      }
    }
    return notification
  }

  // 15. Channel registry (channels Map declared earlier with scheduler)

  // Web channel — always registered
  const webChannel = new WebChannel()
  await webChannel.start()
  channels.set('web', webChannel)
  channelDefinitions.set('web', {
    name: 'web',
    type: 'web',
    configured: true,
    receiveNotifications: false,
    secretRefs: [],
  })
  heartbeat.write()

  let shuttingDown = false
  const allActiveStreamingSessions: Set<FeishuStreamingSession>[] = []
  const restartSentinelPath = join(ZERO_DIR, 'restart-sentinel.json')
  const shouldPersistBusEvent = (payload: { topic: string; data: Record<string, unknown> }) => {
    switch (payload.topic) {
      case 'session:create':
      case 'session:end':
      case 'model:switch':
      case 'notification':
      case 'repair:start':
      case 'repair:end':
      case 'fuse:trigger':
        return true
      case 'session:update':
        return (
          payload.data.event === 'task_closure_decision' ||
          payload.data.event === 'task_closure_failed'
        )
      default:
        return false
    }
  }
  const wildcardLogListener = (payload: { topic: string; data: Record<string, unknown> }) => {
    if (!shouldPersistBusEvent(payload)) return
    observability.log('info', payload.topic, payload.data)
  }
  const repairMetricsListener = (payload: { data: Record<string, unknown> }) => {
    metrics.recordRepair({
      sessionId: payload.data.sessionId as string | undefined,
      status: (payload.data.status as string) === 'success' ? 'success' : 'failed',
      diagnosis: (payload.data.diagnosis as string) ?? '',
      action: (payload.data.action as string) ?? '',
      result: (payload.data.result as string) ?? '',
    })
  }
  const toolMetricsListener = (payload: { data: Record<string, unknown>; timestamp: string }) => {
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

  globalBus.on('*', wildcardLogListener)
  globalBus.on('repair:end', repairMetricsListener)
  globalBus.on('tool:call', toolMetricsListener)

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[ZeRo OS] Shutting down...')
    scheduler.stop()
    console.log('[ZeRo OS] Scheduler stopped')

    const interruptedSessions = await sessionManager.drainAndCollectInterrupted(30_000)
    const trigger = consumeRestartTrigger(ZERO_DIR)
    const sentinel: RestartSentinelFile = {
      ts: new Date().toISOString(),
      trigger,
      sessions: interruptedSessions.filter(
        (session): session is RestartSentinelEntry =>
          typeof session.channelId === 'string' && session.source !== 'scheduler',
      ),
    }

    if (trigger || sentinel.sessions.length > 0) {
      writeFileSync(restartSentinelPath, JSON.stringify(sentinel))
      console.log(
        `[ZeRo OS] Restart sentinel recorded ${sentinel.sessions.length} interrupted session(s)`,
      )

      if (sentinel.sessions.length > 0) {
        await Promise.allSettled(
          sentinel.sessions.map(async (entry) => {
            const channel = entry.channelName ? channels.get(entry.channelName) : undefined
            if (!channel || !channel.isConnected()) return

            try {
              await channel.send(entry.channelId, '🔄 ZeRo OS 正在重启...')
            } catch (error) {
              console.warn(
                `[ZeRo OS] Failed to send restart notice to ${entry.channelName ?? 'unknown'}:${entry.channelId}:`,
                describeError(error),
              )
            }
          }),
        )
      }
    }

    const activeStreamingCount = allActiveStreamingSessions.reduce(
      (count, sessions) => count + sessions.size,
      0,
    )
    if (activeStreamingCount > 0) {
      await Promise.allSettled(
        allActiveStreamingSessions.flatMap((sessions) =>
          Array.from(sessions).map(async (streaming) => {
            try {
              await streaming.abort('ZeRo OS is restarting...')
            } finally {
              sessions.delete(streaming)
            }
          }),
        ),
      )
      console.log(
        `[ZeRo OS] Aborted ${activeStreamingCount} active Feishu streaming session(s) during shutdown`,
      )
    }

    globalBus.off('*', wildcardLogListener)
    globalBus.off('repair:end', repairMetricsListener)
    globalBus.off('tool:call', toolMetricsListener)
    litellmPricing.dispose()
    console.log('[ZeRo OS] LiteLLM pricing disposed')
    for (const [, ch] of channels) {
      try {
        await ch.stop()
      } catch {}
    }
    console.log('[ZeRo OS] Channels closed')
    heartbeat.stop()
    console.log('[ZeRo OS] Heartbeat stopped')
    sessionManager.flushAll()
    console.log('[ZeRo OS] Sessions flushed to DB')
    sessionDb.close()
    console.log('[ZeRo OS] Session DB closed')
    metrics.close()
    console.log('[ZeRo OS] Metrics DB closed')
    console.log('[ZeRo OS] Shutdown complete.')
    if (!options?.skipProcessExit) process.exit(0)
  }

  const zero: ZeroOS = {
    config,
    vault,
    secretFilter,
    observability,
    metrics,
    sessionDb,
    modelRouter,
    toolRegistry,
    sessionManager,
    memoryStore,
    memoryRetriever,
    memoManager,
    tracer,
    repairEngine,
    heartbeat,
    scheduler,
    bus: globalBus,
    channels,
    channelDefinitions,
    notifications,
    addNotification,
    isShuttingDown: () => shuttingDown,
    shutdown,
  }

  await options?.onCoreReady?.(zero)

  const commandRouter = new CommandRouter()
  registerBuiltinCommands(commandRouter)

  const restartCommand: Command = {
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

      const build = rebuildWebBundle()
      if (!build.ok) {
        await ctx.reply(`Web rebuild failed, restart cancelled: ${build.error ?? 'unknown error'}`)
        return { handled: true }
      }

      if (ctx.source === 'feishu' || ctx.source === 'telegram') {
        try {
          writeRestartTrigger(ZERO_DIR, {
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
  commandRouter.register(restartCommand)

  const externalChannelDefinitions = buildExternalChannelDefinitions(config.channels, vault)
  const defaultAgentInstruction =
    'You are ZeRo OS, an AI agent system. Be helpful, concise, and accurate.'

  for (const definition of externalChannelDefinitions) {
    channelDefinitions.set(definition.name, definition)

    if (definition.type === 'feishu') {
      const agentName = buildAgentName(definition.name)
      const feishuChannel = new FeishuChannel({
        name: definition.name,
        appId: definition.credentials?.appId ?? '',
        appSecret: definition.credentials?.appSecret ?? '',
        encryptKey: definition.credentials?.encryptKey,
        verificationToken: definition.credentials?.verificationToken,
        downloadsDir: join(ZERO_DIR, 'workspace', agentName, 'uploads'),
      })

      if (definition.credentials) {
        const channelName = definition.name
        const activeStreamingSessions = new Set<FeishuStreamingSession>()
        allActiveStreamingSessions.push(activeStreamingSessions)
        const feishuAdapter = new FeishuAdapter(feishuChannel, {
          activeStreamingSessions,
        })

        feishuChannel.setMessageHandler(async (msg) => {
          await handleChannelMessage(msg, {
            channelType: 'feishu',
            channelName,
            agentName,
            agentInstruction: defaultAgentInstruction,
            sessionManager,
            commandRouter,
            channelAdapter: feishuAdapter,
            metrics,
            channelCapabilities: feishuChannel.getCapabilities(),
            isShuttingDown: () => shuttingDown,
          })
        })

        await feishuChannel.start()
        console.log(`[ZeRo OS] Channel started: ${definition.name}`)
      }

      channels.set(definition.name, feishuChannel)
      heartbeat.write()
      continue
    }

    const telegramChannel = new TelegramChannel({
      name: definition.name,
      botToken: definition.credentials?.botToken ?? '',
    })

    if (definition.credentials) {
      const channelName = definition.name
      const agentName = buildAgentName(channelName)
      const telegramAdapter = new TelegramAdapter(telegramChannel)

      telegramChannel.setMessageHandler(async (msg) => {
        await handleChannelMessage(msg, {
          channelType: 'telegram',
          channelName,
          agentName,
          agentInstruction: defaultAgentInstruction,
          sessionManager,
          commandRouter,
          channelAdapter: telegramAdapter,
          metrics,
          channelCapabilities: telegramChannel.getCapabilities(),
          isShuttingDown: () => shuttingDown,
        })
      })

      await telegramChannel.start()

      try {
        await syncTelegramCommandMenu(telegramChannel)
        console.log(`[ZeRo OS] ${definition.name} commands/menu synced`)
      } catch (err) {
        console.warn(`[ZeRo OS] ${definition.name} commands/menu sync failed:`, err)
      }

      console.log(`[ZeRo OS] Channel started: ${definition.name}`)
    }

    channels.set(definition.name, telegramChannel)
    heartbeat.write()
  }

  console.log(`[ZeRo OS] ${channels.size} channels registered`)

  if (existsSync(restartSentinelPath)) {
    try {
      const sentinel = JSON.parse(readFileSync(restartSentinelPath, 'utf-8')) as RestartSentinelFile
      unlinkSync(restartSentinelPath)

      if (sentinel.trigger) {
        console.log(formatRestartTriggerLog(sentinel.trigger))

        // Notify the channel that triggered the restart
        if (sentinel.trigger.channelName && sentinel.trigger.channelId) {
          const triggerChannel = channels.get(sentinel.trigger.channelName)
          if (triggerChannel?.isConnected()) {
            try {
              await triggerChannel.send(sentinel.trigger.channelId, '✅ ZeRo OS 已重启完成')
            } catch (error) {
              console.warn(
                `[ZeRo OS] Failed to send restart completion notice:`,
                describeError(error),
              )
            }
          }
        }
      }

      if (Array.isArray(sentinel.sessions) && sentinel.sessions.length > 0) {
        console.log(
          `[ZeRo OS] Restart sentinel found ${sentinel.sessions.length} interrupted session(s)`,
        )

        const triggerChannelId = sentinel.trigger?.channelId
        for (const entry of sentinel.sessions) {
          void (async () => {
            const session = sessionManager.get(entry.sessionId)
            if (!session) return

            const channel = entry.channelName ? channels.get(entry.channelName) : undefined
            if (!channel || !channel.isConnected()) return

            if (!session.getAgentConfig()) {
              console.warn(
                `[ZeRo OS] Restart sentinel skipped session without agent config: ${entry.sessionId}`,
              )
              return
            }

            try {
              session.setChannelCapabilities(channel.getCapabilities() as Record<string, unknown>)
              if (entry.subAgents?.length) {
                session.restoreSubAgentSnapshot(entry.subAgents)
              }
              // Skip duplicate restart notice if trigger already notified this chat
              if (entry.channelId !== triggerChannelId) {
                await channel.send(entry.channelId, '✅ ZeRo OS 已重启完成')
              }
              const replies = await session.handleMessage(buildRestartRecoveryMessage(entry))
              const replyText = collectAssistantReply(replies)
              if (replyText) {
                await channel.send(entry.channelId, replyText)
              }
            } catch (error) {
              console.warn(
                `[ZeRo OS] Restart sentinel failed to resume session ${entry.sessionId}:`,
                describeError(error),
              )
            }
          })()
        }
      }
    } catch (error) {
      console.warn('[ZeRo OS] Failed to read restart sentinel:', describeError(error))
    }
  }

  heartbeat.setReady(true, 'ready')
  heartbeat.write()
  console.log('[ZeRo OS] System ready.')

  globalBus.emit('session:create', { event: 'system_start' })

  return zero
}

function buildRestartRecoveryMessage(entry: RestartSentinelEntry): string {
  let systemMessage = '[System] The process restarted while your previous turn was still running.'

  if (entry.subAgents?.length) {
    const completed = entry.subAgents.filter((agent) => agent.state === 'completed')
    const running = entry.subAgents.filter(
      (agent) => agent.state === 'running' || agent.state === 'waiting',
    )
    const failed = entry.subAgents.filter((agent) => agent.state === 'failed')

    systemMessage += '\n\nSub-agent state at restart:'
    systemMessage += `\n- ${completed.length} completed (outputs preserved, accessible via wait_agent)`
    systemMessage += `\n- ${running.length} were still running/waiting (marked as failed, need re-spawn)`
    systemMessage += `\n- ${failed.length} had already failed`

    if (running.length > 0) {
      systemMessage += '\n\nLost sub-agents that need re-spawning:'
      for (const agent of running) {
        systemMessage += `\n  - "${agent.label}" (was: ${agent.instruction.slice(0, 100)})`
      }
    }
  }

  systemMessage +=
    '\n\nContinue the interrupted task from the existing conversation context. If the task is already complete, briefly confirm completion.'

  if (entry.subAgents?.length) {
    systemMessage +=
      ' For completed sub-agents, use wait_agent with their original IDs to retrieve results. For lost sub-agents, re-spawn them.'
  }

  return systemMessage
}

function buildExternalChannelDefinitions(
  configuredChannels: ChannelInstanceConfig[] | undefined,
  vault: Vault,
): ExternalChannelRuntimeDefinition[] {
  if (configuredChannels) {
    return configuredChannels.reduce<ExternalChannelRuntimeDefinition[]>((definitions, channel) => {
      if (channel.enabled === false || channel.type === 'web') {
        return definitions
      }

      if (channel.type === 'feishu') {
        const appId = vault.get(channel.appIdRef)
        const appSecret = vault.get(channel.appSecretRef)

        definitions.push({
          name: channel.name,
          type: 'feishu' as const,
          configured: !!(appId && appSecret),
          receiveNotifications: channel.receiveNotifications ?? false,
          secretRefs: [
            channel.appIdRef,
            channel.appSecretRef,
            ...(channel.encryptKeyRef ? [channel.encryptKeyRef] : []),
            ...(channel.verificationTokenRef ? [channel.verificationTokenRef] : []),
          ],
          credentials:
            appId && appSecret
              ? {
                  appId,
                  appSecret,
                  encryptKey: channel.encryptKeyRef
                    ? (vault.get(channel.encryptKeyRef) ?? undefined)
                    : undefined,
                  verificationToken: channel.verificationTokenRef
                    ? (vault.get(channel.verificationTokenRef) ?? undefined)
                    : undefined,
                }
              : undefined,
        })
        return definitions
      }

      if (channel.type !== 'telegram') return definitions

      const botToken = vault.get(channel.botTokenRef)
      definitions.push({
        name: channel.name,
        type: 'telegram' as const,
        configured: !!botToken,
        receiveNotifications: channel.receiveNotifications ?? false,
        secretRefs: [channel.botTokenRef],
        credentials: botToken ? { botToken } : undefined,
      })
      return definitions
    }, [])
  }

  const feishuAppId = vault.get('feishu_app_id')
  const feishuAppSecret = vault.get('feishu_app_secret')
  const telegramToken = vault.get('telegram_bot_token')

  return [
    {
      name: 'feishu',
      type: 'feishu',
      configured: !!(feishuAppId && feishuAppSecret),
      receiveNotifications: false,
      secretRefs: [
        'feishu_app_id',
        'feishu_app_secret',
        'feishu_encrypt_key',
        'feishu_verification_token',
      ],
      credentials:
        feishuAppId && feishuAppSecret
          ? {
              appId: feishuAppId,
              appSecret: feishuAppSecret,
              encryptKey: vault.get('feishu_encrypt_key') ?? undefined,
              verificationToken: vault.get('feishu_verification_token') ?? undefined,
            }
          : undefined,
    },
    {
      name: 'telegram',
      type: 'telegram',
      configured: !!telegramToken,
      receiveNotifications: false,
      secretRefs: ['telegram_bot_token'],
      credentials: telegramToken ? { botToken: telegramToken } : undefined,
    },
  ]
}

function buildAgentName(channelName: string): string {
  return `zero-${channelName.replace(/[^a-z0-9_-]+/gi, '-')}`
}

function ensureDirectories(ZERO_DIR: string): void {
  const dirs = [
    ZERO_DIR,
    join(ZERO_DIR, 'channels'),
    join(ZERO_DIR, 'tools'),
    join(ZERO_DIR, 'skills'),
    join(ZERO_DIR, 'skills', 'browser'),
    join(ZERO_DIR, 'logs'),
    join(ZERO_DIR, 'memory'),
    join(ZERO_DIR, 'memory/preferences'),
    join(ZERO_DIR, 'memory/preferences/agents'),
    join(ZERO_DIR, 'memory/sessions'),
    join(ZERO_DIR, 'memory/incidents'),
    join(ZERO_DIR, 'memory/runbooks'),
    join(ZERO_DIR, 'memory/decisions'),
    join(ZERO_DIR, 'memory/notes'),
    join(ZERO_DIR, 'memory/inbox'),
    join(ZERO_DIR, 'memory/archive'),
    join(ZERO_DIR, 'cache'),
    join(ZERO_DIR, 'workspace'),
    join(ZERO_DIR, 'workspace/shared'),
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

// Auto-start if run directly
if (import.meta.main) {
  startZeroOS().catch(console.error)
}
