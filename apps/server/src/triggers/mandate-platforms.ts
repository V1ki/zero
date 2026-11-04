import { WeixinChannel } from '@zero-os/channel'
import type { MandateTarget } from '@zero-os/shared'
import { createDingtalkTaskDelivery } from './dingtalk-task-delivery'
import { createFeishuTaskDelivery } from './feishu-task-delivery'
import type { MandateDelivery, MandateReceipt } from './mandate-runtime'
import { createTriggerWeixin } from './weixin-delivery'

type Host = Parameters<typeof createTriggerWeixin>[0]

export function createMandatePlatforms(host: Host) {
  const weixin = createTriggerWeixin(host)
  const feishu = createFeishuTaskDelivery(host)
  const dingtalk = createDingtalkTaskDelivery(host)
  function listTargets() {
    // iLink reminder contexts are direct conversations. The peer is also the actor.
    return [
      ...weixin
        .listTargets()
        .map((t) => ({ ...t, platform: 'weixin' as const, operatorId: t.peerId })),
      ...feishu.listTargets(),
      ...dingtalk.listTargets(),
    ]
  }

  function isLiveTarget(target: MandateTarget) {
    return listTargets().some(
      (t) =>
        t.channelId === target.channelId &&
        t.platform === target.platform &&
        t.peerId === target.peerId &&
        t.operatorId === target.operatorId,
    )
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
    const outcome = await channel.sendReminderOnce(target.peerId, text)
    if (outcome === 'accepted') return { status: 'accepted' }
    if (outcome === 'uncertain') return { status: 'unknown', reason: '微信发送结果待核对。' }
    return {
      status: 'rejected',
      reason: outcome === 'rejected' ? '微信平台拒绝了此次提醒。' : '指定微信私聊已不可用。',
    }
  }

  return {
    listTargets,
    isLiveTarget,
    send,
    archive: feishu.archive,
    listArchiveChannels: feishu.listArchiveChannels,
    probeArchive: feishu.probeArchive,
  }
}
