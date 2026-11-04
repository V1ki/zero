import { DingtalkChannel } from '@zero-os/channel'
import type { MandateTarget } from '@zero-os/shared'
import type { ZeroOS } from '../runtime/types'
import type { MandateDelivery, MandateReceipt } from './mandate-runtime'

type Host = Pick<ZeroOS, 'channels' | 'channelDefinitions'> & {
  sessionManager: Pick<ZeroOS['sessionManager'], 'listCurrentBindings'>
}

export function createDingtalkTaskDelivery(zero: Host) {
  function connectedChannel(channelId: string) {
    const channel = zero.channels.get(channelId)
    const definition = zero.channelDefinitions.get(channelId)
    return !channelId.includes('*') &&
      definition?.type === 'dingtalk' &&
      definition.configured &&
      channel instanceof DingtalkChannel &&
      channel.isConnected()
      ? channel
      : undefined
  }

  function listTargets(personal = false) {
    const targets: Array<MandateTarget & { label: string; operatorId: string }> = []
    for (const binding of zero.sessionManager.listCurrentBindings()) {
      if (binding.source !== 'dingtalk' || !binding.participantId) continue
      const channelId = binding.channelName ?? 'dingtalk'
      const channel = connectedChannel(channelId)
      const peerId = binding.channelId
      const operatorId = binding.participantId
      if (
        !channel ||
        !(personal
          ? channel.taskCards.hasBoundPeer(peerId, operatorId)
          : channel.taskCards.canSend(peerId, operatorId))
      )
        continue
      targets.push({
        platform: 'dingtalk',
        channelId,
        peerId,
        operatorId,
        label: `${channelId} · ${peerId} · ${operatorId}${personal ? '' : ` · ${channel.taskCards.modeLabel}`}`,
      })
    }
    return targets
  }

  function listDirectTargets() {
    return Array.from(zero.channelDefinitions.keys()).flatMap((channelId) =>
      (connectedChannel(channelId)?.taskCards.listDirectPeers() ?? []).map(
        ({ peerId, actorId: operatorId }) => ({
          platform: 'dingtalk' as const,
          channelId,
          peerId,
          operatorId,
          label: `${channelId} · ${peerId} · ${operatorId}`,
        }),
      ),
    )
  }

  async function send(
    target: MandateTarget,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean = () => true,
  ): Promise<MandateReceipt> {
    const channel = zero.channels.get(target.channelId)
    const isBound = () =>
      listTargets().some(
        (candidate) =>
          candidate.channelId === target.channelId &&
          candidate.peerId === target.peerId &&
          candidate.operatorId === target.operatorId,
      )
    if (
      !(channel instanceof DingtalkChannel) ||
      !target.operatorId ||
      target.platform !== 'dingtalk' ||
      !isBound()
    ) {
      return { status: 'rejected', reason: '所选钉钉会话、操作人或卡片模板当前不可用。' }
    }
    try {
      const receipt = await channel.taskCards.send(
        target.peerId,
        target.operatorId,
        payload,
        signal,
        () => maySend() && zero.channels.get(target.channelId) === channel && isBound(),
      )
      return { status: 'accepted', receipt }
    } catch (error) {
      if (error instanceof Error && 'uncertain' in error && typeof error.uncertain === 'boolean') {
        return { status: error.uncertain ? 'unknown' : 'rejected', reason: error.message }
      }
      throw error
    }
  }
  return { listTargets, listDirectTargets, send }
}
