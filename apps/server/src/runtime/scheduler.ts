import type { Channel } from '@zero-os/channel'
import type { Session, SessionManager } from '@zero-os/core'
import type { SessionDB } from '@zero-os/observe'
import { CronScheduler } from '@zero-os/scheduler'
import type {
  Notification,
  ScheduleConfig,
  SessionSource,
  SystemConfig,
  ToolContext,
} from '@zero-os/shared'
import { collectAssistantReply } from '@zero-os/shared'

type SchedulerHandle = NonNullable<ToolContext['schedulerHandle']>
type ScheduleStore = NonNullable<ToolContext['scheduleStore']>

export interface SchedulerRuntime {
  scheduler: CronScheduler
  schedulerHandle: SchedulerHandle
  scheduleStore: ScheduleStore
  start(options: StartSchedulerRuntimeOptions): void
}

export interface StartSchedulerRuntimeOptions {
  config: SystemConfig
  sessionManager: SessionManager
  channels: Map<string, Channel>
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}

export function createSchedulerRuntime(sessionDb: SessionDB): SchedulerRuntime {
  const scheduler = new CronScheduler()
  const schedulerHandle: SchedulerHandle = {
    addAndStart: (config) => scheduler.addAndStart(config),
    remove: (name) => scheduler.remove(name),
    getStatus: () => scheduler.getStatus(),
  }
  const scheduleStore: ScheduleStore = {
    save: (config) => sessionDb.saveSchedule(config),
    delete: (name) => sessionDb.deleteSchedule(name),
  }

  return {
    scheduler,
    schedulerHandle,
    scheduleStore,
    start: (options) => startSchedulerRuntime(scheduler, sessionDb, options),
  }
}

function startSchedulerRuntime(
  scheduler: CronScheduler,
  sessionDb: SessionDB,
  { config, sessionManager, channels, addNotification }: StartSchedulerRuntimeOptions,
): void {
  scheduler.setTriggerHandler(async (schedConfig) => {
    await handleScheduleTrigger(schedConfig, {
      sessionManager,
      channels,
      addNotification,
    })
  })

  scheduler.setOnRemoved((name) => {
    sessionDb.deleteSchedule(name)
  })

  for (const schedule of config.schedules) {
    scheduler.add({ ...schedule, createdBy: 'config' as const })
  }

  const runtimeSchedules = sessionDb.loadRuntimeSchedules()
  for (const schedule of runtimeSchedules) {
    scheduler.add(schedule)
  }

  scheduler.start()
  const totalSchedules = config.schedules.length + runtimeSchedules.length
  console.log(
    `[ZeRo OS] Scheduler started (${totalSchedules} schedules: ${config.schedules.length} config + ${runtimeSchedules.length} runtime)`,
  )
}

interface ScheduleTriggerOptions {
  sessionManager: SessionManager
  channels: Map<string, Channel>
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
}

export async function handleScheduleTrigger(
  schedConfig: ScheduleConfig,
  { sessionManager, channels, addNotification }: ScheduleTriggerOptions,
): Promise<void> {
  const binding = schedConfig.channel
  let session: Session
  let shouldInitializeAgent = false

  if (binding) {
    const result = sessionManager.getOrCreateForChannel(
      binding.source as SessionSource,
      binding.channelId,
      binding.channelName,
      binding.participantId,
    )
    session = result.session
    shouldInitializeAgent = result.isNew
  } else {
    session = sessionManager.create('scheduler')
    shouldInitializeAgent = true
  }

  if (schedConfig.model) {
    const switched = await session.switchModel(schedConfig.model)
    if (!switched.success) {
      throw new Error(`Schedule "${schedConfig.name}" model resolution failed: ${switched.message}`)
    }
  }

  if (shouldInitializeAgent) {
    session.initAgent({
      name: `schedule-${schedConfig.name}`,
      agentInstruction: schedConfig.instruction,
    })
  }

  const replies = await session.handleMessage(schedConfig.instruction)

  if (!binding) return

  const channel = channels.get(binding.channelName)
  const text = collectAssistantReply(replies)
  const deliveryChannelId = binding.deliveryChannelId ?? binding.channelId
  if (channel?.isConnected() && text) {
    await channel.send(deliveryChannelId, text).catch((err) => {
      console.error(
        `[Scheduler] delivery to ${binding.channelName}:${deliveryChannelId} failed:`,
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
