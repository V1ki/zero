import { DingtalkChannel, FeishuChannel, WeixinChannel } from '@zero-os/channel'
import {
  type MandateTarget,
  type RouterPresentation,
  type TriggerAgentResult,
  type TriggerInboxItem,
  isTriggerRoutePlatform,
  sameTriggerRouteTarget,
} from '@zero-os/shared'
import { createDingtalkTaskDelivery } from './dingtalk-task-delivery'
import { createFeishuTaskDelivery } from './feishu-task-delivery'
import type { MandateDelivery, MandateReceipt } from './mandate-runtime'
import { createTriggerWeixin, listenerReminderText } from './weixin-delivery'

type Host = Parameters<typeof createTriggerWeixin>[0]
type PersonalReceipt = MandateReceipt & { authorizationLost?: true }

async function sendWeixinText(
  channel: WeixinChannel,
  peerId: string,
  text: string,
  deliveryId?: string,
  maySend?: () => boolean,
): Promise<MandateReceipt> {
  const receipt = await channel.sendReminderWithReceipt(peerId, text, deliveryId, maySend)
  if (receipt.status === 'accepted') return receipt
  return { status: receipt.status === 'uncertain' ? 'unknown' : 'rejected', reason: receipt.reason }
}

export function createMandatePlatforms(
  host: Host,
  isSelectedDirectTarget?: (target: MandateTarget) => boolean,
) {
  const weixin = createTriggerWeixin(host)
  const feishu = createFeishuTaskDelivery(host, isLiveTarget)
  const dingtalk = createDingtalkTaskDelivery(host, isLiveTarget)
  function listPersonalBots() {
    return Array.from(host.channelDefinitions).flatMap(([channelId, definition]) => {
      const platform = definition.type
      if (!definition.configured || !isTriggerRoutePlatform(platform) || channelId.includes('*'))
        return []
      const channel = host.channels.get(channelId)
      return [
        {
          platform,
          channelId,
          label: definition.name || channelId,
          online: channel?.type === platform && channel.isConnected(),
        },
      ]
    })
  }
  function weixinTargets(direct = false) {
    // iLink reminder contexts are direct conversations. The peer is also the actor.
    return (direct ? weixin.listDirectTargets() : weixin.listTargets()).map((t) => ({
      ...t,
      platform: 'weixin' as const,
      operatorId: t.peerId,
    }))
  }

  function listTargets(personal = false) {
    const targets = [...weixinTargets(), ...feishu.listTargets(), ...dingtalk.listTargets(personal)]
    if (!personal && !isSelectedDirectTarget) return targets
    // Personal resolution needs all verified DMs to detect ambiguity. Mandates may use
    // a detached DM only when it is the selected bot's currently authorized recipient.
    for (const direct of listPersonalDirectTargets(!personal)) {
      if (!personal && !isSelectedDirectTarget?.(direct)) continue
      if (!targets.some((candidate) => sameTriggerRouteTarget(candidate, direct)))
        targets.push(direct)
    }
    return targets
  }

  function listPersonalDirectTargets(forTask = false) {
    return [
      ...weixinTargets(true),
      ...feishu.listDirectTargets(),
      ...dingtalk.listDirectTargets(forTask),
    ]
  }

  function listPersonalTargets() {
    return listTargets(true)
  }

  function isLiveTarget(target: MandateTarget, personal = false) {
    return (personal ? listPersonalTargets() : listTargets()).some((candidate) =>
      sameTriggerRouteTarget(candidate, target),
    )
  }

  /** Explicit personal messages never fall back to a group or a channel-wide broadcast. */
  async function sendDirect(
    target: MandateTarget,
    text: string,
    deliveryId: string,
    signal: AbortSignal,
    maySend: () => boolean,
    presentation?: RouterPresentation,
  ): Promise<MandateReceipt> {
    const channel = host.channels.get(target.channelId)
    const authorized = () =>
      !signal.aborted &&
      host.channels.get(target.channelId) === channel &&
      listPersonalDirectTargets().some((t) => sameTriggerRouteTarget(t, target)) &&
      maySend()
    if (!target.operatorId || !authorized())
      return { status: 'rejected', reason: '机器人的个人私聊已变更或发送已取消。' }
    if (presentation && target.platform === 'feishu' && channel instanceof FeishuChannel)
      return channel.router.sendPresentation(
        target.peerId,
        deliveryId,
        presentation,
        signal,
        authorized,
      )
    if (presentation && target.platform === 'dingtalk' && channel instanceof DingtalkChannel)
      return channel.taskCards.sendPresentation(
        target.peerId,
        target.operatorId,
        deliveryId,
        presentation,
        signal,
        authorized,
      )
    if (target.platform === 'weixin' && channel instanceof WeixinChannel)
      return sendWeixinText(channel, target.peerId, text, deliveryId, authorized)
    if (target.platform === 'feishu' && channel instanceof FeishuChannel)
      return channel.router.sendDirectReminder(target.peerId, deliveryId, text, signal, authorized)
    if (target.platform === 'dingtalk' && channel instanceof DingtalkChannel)
      return channel.taskCards.sendDirectReminder(
        target.peerId,
        target.operatorId,
        text,
        signal,
        authorized,
      )
    return { status: 'rejected', reason: '所选机器人当前不可用。' }
  }

  /** Personal notifications identify an inbox event; only mandate deliveries have a task. */
  async function sendPersonal(
    target: MandateTarget,
    event: TriggerInboxItem,
    agent: TriggerAgentResult,
    signal: AbortSignal,
    maySend: () => boolean,
  ): Promise<PersonalReceipt> {
    const channel = host.channels.get(target.channelId)
    let denied = false
    const authorized = () => {
      if (
        signal.aborted ||
        host.channels.get(target.channelId) !== channel ||
        !isLiveTarget(target, true) ||
        !maySend()
      )
        denied = true
      return !denied
    }
    if (!target.operatorId || !authorized()) {
      return { status: 'rejected', reason: '通知授权或所选会话已变更。', authorizationLost: true }
    }
    const text = listenerReminderText(event, agent)
    let result: MandateReceipt
    if (target.platform === 'feishu' && channel instanceof FeishuChannel) {
      result = await channel.router.sendListenerReminder(
        target.peerId,
        event.id,
        text,
        signal,
        authorized,
      )
    } else if (target.platform === 'dingtalk' && channel instanceof DingtalkChannel) {
      result = await channel.taskCards.sendListenerReminder(
        target.peerId,
        target.operatorId,
        text,
        signal,
        authorized,
      )
    } else {
      return { status: 'rejected', reason: '发送所需的渠道当前不可用。' }
    }
    return result.status === 'rejected' && denied ? { ...result, authorizationLost: true } : result
  }

  async function send(
    target: MandateTarget,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean = () => true,
  ): Promise<MandateReceipt> {
    if (signal.aborted || !isLiveTarget(target)) {
      return { status: 'rejected', reason: '所选会话当前不可用，或发送已取消。' }
    }
    if (target.platform === 'feishu') return feishu.send(target, payload, signal, maySend)
    if (target.platform === 'dingtalk') return dingtalk.send(target, payload, signal, maySend)
    const channel = host.channels.get(target.channelId)
    if (!(channel instanceof WeixinChannel))
      return { status: 'rejected', reason: '微信连接已关闭。' }
    // Reserve space for every task reference, including in a digest.
    const perEntry = Math.max(
      0,
      Math.min(260, Math.floor(3600 / Math.max(1, payload.entries.length)) - 32),
    )
    const text = [
      payload.digest ? 'ZeRo 任务摘要' : 'ZeRo 任务提醒',
      ...payload.entries.map((e) => `#任务${e.taskId} ${e.summary.slice(0, perEntry)}`),
      '回复「#任务编号 问题」继续。',
    ].join('\n')
    if (!maySend()) return { status: 'rejected', reason: '发送微信提醒的授权已变更。' }
    return sendWeixinText(channel, target.peerId, text)
  }

  return {
    listTargets,
    listPersonalBots,
    listPersonalTargets,
    listPersonalDirectTargets,
    isLiveTarget,
    sendPersonal,
    sendDirect,
    lookupDirectReceipt(target: MandateTarget, deliveryId: string) {
      const channel = host.channels.get(target.channelId)
      return target.platform === 'dingtalk' &&
        target.operatorId &&
        channel instanceof DingtalkChannel
        ? channel.taskCards.publicationReceipt(target.peerId, target.operatorId, deliveryId)
        : null
    },
    send,
    archive: feishu.archive,
    appendDocument: feishu.appendDocument,
    listArchiveChannels: feishu.listArchiveChannels,
    probeArchive: feishu.probeArchive,
  }
}
