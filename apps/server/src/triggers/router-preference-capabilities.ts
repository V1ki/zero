import {
  type TriggerRoutingSettings,
  getTriggerRouteBot,
  triggerRoutePlatforms,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { capability, routerChoice, routerText } from './router-capabilities'
import type { TriggerRoutingRuntime } from './routing-runtime'

type Routing = Pick<TriggerRoutingRuntime, 'getConfig' | 'saveConfig' | 'listPersonalBots'>
/** Local configuration is a capability granted to verified owner input, not source text. */
export function preferenceCapabilities(routing: Routing, authorized: () => boolean) {
  const guard = () => {
    if (!authorized()) throw new TriggerAgentError('当前身份没有修改通知设置的权限。')
  }
  const snapshot = () => {
    const { revision, settings } = routing.getConfig()
    return {
      revision,
      settings: {
        enabled: settings.enabled,
        workStart: settings.workStart,
        workEnd: settings.workEnd,
        workdays: settings.workdays,
        timeZone: settings.timeZone,
        presence: settings.presence,
        notificationMode: settings.notificationMode ?? 'all',
        urgentDestination: settings.urgentDestination,
        duringWork: settings.duringWork,
        afterWork: settings.afterWork,
        offDay: settings.offDay,
        awayFallback: settings.awayFallback,
        personalBots: settings.personalBots,
      },
    }
  }
  return [
    capability(
      'read_notification_preferences',
      '读取当前通知配置与版本。机器人接收人由渠道管理，不让用户选择会话。all 表示同步已选渠道；contextual 表示按偏好择端、择时。',
      {},
      () => {
        guard()
        return snapshot()
      },
    ),
    capability(
      'update_notification_preference',
      '按用户指示更新一项通知设置。先读取当前版本；修改机器人只选已接入账号，不修改私聊凭据。拟稿或讨论设置时不要调用。',
      {
        revision: { type: 'integer', minimum: 0 },
        key: {
          type: 'string',
          enum: [
            'enabled',
            'workStart',
            'workEnd',
            'workdays',
            'timeZone',
            'presence',
            'notificationMode',
            'urgentDestination',
            'duringWork',
            'afterWork',
            'offDay',
            'awayFallback',
            'personalBot',
          ],
        },
        value: {
          description:
            'notificationMode 选 all 或 contextual；urgentDestination 选平台、defer，或 period 沿用时段。personalBot 为已接入的 channelId，workdays 为 0 至 6 的星期数组。',
        },
        platform: { type: 'string', enum: triggerRoutePlatforms },
      },
      (args) => {
        guard()
        const current = routing.getConfig()
        if (!Number.isSafeInteger(args.revision) || args.revision !== current.revision)
          throw new TriggerAgentError('通知设置已变化，请读取最新版本。')
        const key = routerChoice(args.key, [
          'enabled',
          'workStart',
          'workEnd',
          'workdays',
          'timeZone',
          'presence',
          'notificationMode',
          'urgentDestination',
          'duringWork',
          'afterWork',
          'offDay',
          'awayFallback',
          'personalBot',
        ])
        const settings: TriggerRoutingSettings = { ...current.settings }
        if (key === 'personalBot') {
          const platform = routerChoice(args.platform, triggerRoutePlatforms)
          const id = routerText(args.value, 200)
          if (
            !routing.listPersonalBots().some((b) => b.platform === platform && b.channelId === id)
          )
            throw new TriggerAgentError('找不到这个已接入的机器人。')
          settings.personalBots = { ...settings.personalBots, [platform]: id }
        } else {
          if (args.platform !== undefined)
            throw new TriggerAgentError('只有选择机器人时才需要平台。')
          if (key === 'enabled') {
            if (typeof args.value !== 'boolean') throw new TriggerAgentError('通知开关需要布尔值。')
            settings.enabled = args.value
          } else if (key === 'notificationMode') {
            settings.notificationMode = routerChoice(args.value, ['all', 'contextual'] as const)
          } else if (key === 'urgentDestination' && args.value === 'period') {
            settings.urgentDestination = null
          } else if (key === 'workStart' || key === 'workEnd') {
            const value = routerText(args.value, 5)
            if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
              throw new TriggerAgentError('时段使用 00:00 至 23:59。')
            settings[key] = value
          } else if (key === 'workdays') {
            if (
              !Array.isArray(args.value) ||
              args.value.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
              new Set(args.value).size !== args.value.length
            )
              throw new TriggerAgentError('工作日需要不重复的 0 至 6 数字。')
            settings.workdays = args.value
          } else if (key === 'timeZone') {
            const value = routerText(args.value, 100)
            try {
              new Intl.DateTimeFormat('zh-CN', { timeZone: value })
            } catch {
              throw new TriggerAgentError('无效的时区。')
            }
            settings.timeZone = value
          } else if (key === 'presence')
            settings.presence = routerChoice(args.value, ['auto', 'present', 'away'])
          else {
            const value = routerChoice(
              args.value,
              key === 'awayFallback'
                ? [...triggerRoutePlatforms, 'defer']
                : [...triggerRoutePlatforms, 'web', 'defer'],
            )
            if (
              triggerRoutePlatforms.includes(value as (typeof triggerRoutePlatforms)[number]) &&
              !getTriggerRouteBot(settings, value as (typeof triggerRoutePlatforms)[number])
            )
              throw new TriggerAgentError('请先选择这个平台已接入的机器人。')
            if (key === 'awayFallback')
              settings.awayFallback = routerChoice(value, [...triggerRoutePlatforms, 'defer'])
            else settings[key] = value
          }
        }
        routing.saveConfig(settings, current.revision)
        return { status: 'saved', ...snapshot() }
      },
      ['platform'],
      true,
    ),
  ]
}
