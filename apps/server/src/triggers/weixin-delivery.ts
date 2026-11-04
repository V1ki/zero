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

/** WXARC scope, text, and the model's summary stay in the local inbox. */
export function listenerReminderText(item: TriggerInboxItem, agent: TriggerAgentResult): string {
  const brief =
    item.source === 'wxarc'
      ? '一条已订阅的微信文字有新的处理结果，可打开 ZeRo 收件箱查看。'
      : agent.summary.trim().slice(0, 300) || 'GitHub 监听事项有新的处理结果。'
  return `ZeRo 监听 #${item.id}\n${brief}`
}

export function createTriggerWeixin(zero: WeixinHost) {
  function configuredChannel(channelId: string) {
    const definition = zero.channelDefinitions.get(channelId)
    const channel = zero.channels.get(channelId)
    return !channelId.includes('*') &&
      definition?.type === 'weixin' &&
      definition.configured &&
      channel instanceof WeixinChannel
      ? channel
      : undefined
  }

  function listTargets() {
    const targets: Array<TriggerWeixinTarget & { label: string }> = []
    for (const binding of zero.sessionManager.listCurrentBindings()) {
      if (binding.source !== 'weixin') continue
      const channelId = binding.channelName ?? 'weixin'
      const peerId = binding.channelId
      if (!configuredChannel(channelId)?.canSendReminderTo(peerId)) continue
      if (!targets.some((target) => target.channelId === channelId && target.peerId === peerId)) {
        targets.push({ channelId, peerId, label: `${channelId} · ${peerId}` })
      }
    }
    return targets
  }

  function listDirectTargets() {
    return Array.from(zero.channelDefinitions.keys()).flatMap((channelId) =>
      (configuredChannel(channelId)?.listReminderPeers() ?? []).map((peerId) => ({
        channelId,
        peerId,
        label: `${channelId} · ${peerId}`,
      })),
    )
  }

  async function send(
    target: TriggerWeixinTarget,
    item: TriggerInboxItem,
    agent: TriggerAgentResult,
  ) {
    const channel = configuredChannel(target.channelId)
    if (!channel?.canSendReminderTo(target.peerId)) {
      throw new TriggerWeixinDeliveryError('所选微信私聊当前不可用，请检查通道和会话绑定。', false)
    }
    const receipt = await channel.sendReminderWithReceipt(
      target.peerId,
      listenerReminderText(item, agent),
    )
    if (receipt.status !== 'accepted')
      throw new TriggerWeixinDeliveryError(receipt.reason, receipt.status === 'uncertain')
  }
  return { listTargets, listDirectTargets, send }
}
