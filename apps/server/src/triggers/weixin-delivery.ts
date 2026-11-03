import { WeixinChannel } from '@zero-os/channel'
import type { TriggerAgentResult, TriggerInboxItem, TriggerWeixinTarget } from '@zero-os/shared'
import type { ZeroOS } from '../runtime/types'

type WeixinHost = Pick<ZeroOS, 'channelDefinitions' | 'channels'> & {
  sessionManager: Pick<ZeroOS['sessionManager'], 'listCurrentBindings'>
}

export class TriggerWeixinDeliveryError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message)
    this.name = 'TriggerWeixinDeliveryError'
  }
}

export function createTriggerWeixin(zero: WeixinHost) {
  function listTargets() {
    const targets: Array<TriggerWeixinTarget & { label: string }> = []
    for (const binding of zero.sessionManager.listCurrentBindings()) {
      if (binding.source !== 'weixin') continue
      const channelId = binding.channelName ?? 'weixin'
      const peerId = binding.channelId
      const definition = zero.channelDefinitions.get(channelId)
      const channel = zero.channels.get(channelId)
      if (
        channelId.includes('*') ||
        definition?.type !== 'weixin' ||
        !definition.configured ||
        !(channel instanceof WeixinChannel) ||
        !channel.canSendReminderTo(peerId)
      )
        continue
      if (!targets.some((target) => target.channelId === channelId && target.peerId === peerId)) {
        targets.push({ channelId, peerId, label: `${channelId} · ${peerId}` })
      }
    }
    return targets
  }

  async function send(
    target: TriggerWeixinTarget,
    item: TriggerInboxItem,
    agent: TriggerAgentResult,
  ) {
    const channel = zero.channels.get(target.channelId)
    if (
      !(channel instanceof WeixinChannel) ||
      !listTargets().some(
        (candidate) =>
          candidate.channelId === target.channelId && candidate.peerId === target.peerId,
      )
    ) {
      throw new TriggerWeixinDeliveryError('所选微信私聊当前不可用，请检查通道和会话绑定。', false)
    }
    // Private WeChat source material stays in its local inbox and agent session.
    const brief =
      item.source === 'wxarc'
        ? '一条已订阅的微信文字有新的处理结果，可打开 ZeRo 收件箱查看。'
        : agent.summary.trim().slice(0, 300) || 'GitHub 监听事项有新的处理结果。'
    const outcome = await channel.sendReminderOnce(target.peerId, `ZeRo 监听 #${item.id}\n${brief}`)
    switch (outcome) {
      case 'accepted':
        return
      case 'unavailable':
        throw new TriggerWeixinDeliveryError('微信通道或私聊上下文不可用。', false)
      case 'rejected':
        throw new TriggerWeixinDeliveryError('微信平台已拒绝本次提醒。', false)
      case 'uncertain':
        throw new TriggerWeixinDeliveryError('微信发送回执不确定，请先核对会话。', true)
    }
  }
  return { listTargets, send }
}
