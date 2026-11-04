import { FeishuChannel } from '@zero-os/channel'
import { type MandateArchive, type MandateTarget, sameTriggerRouteTarget } from '@zero-os/shared'
import type { ZeroOS } from '../runtime/types'
import type { MandateDelivery, MandateReceipt } from './mandate-runtime'
import type { MandateTargetOption } from './mandate-service'

type FeishuHost = Pick<ZeroOS, 'channels' | 'channelDefinitions'> & {
  sessionManager: Pick<ZeroOS['sessionManager'], 'listCurrentBindings'>
}

export function createFeishuTaskDelivery(
  host: FeishuHost,
  isLiveTarget?: (target: MandateTarget) => boolean,
) {
  function connectedChannel(id: string) {
    const channel = host.channels.get(id)
    const definition = host.channelDefinitions.get(id)
    return !id.includes('*') &&
      definition?.configured &&
      definition.type === 'feishu' &&
      channel instanceof FeishuChannel &&
      channel.isConnected()
      ? channel
      : undefined
  }

  function listTargets(): MandateTargetOption[] {
    const targets: MandateTargetOption[] = []
    for (const binding of host.sessionManager.listCurrentBindings()) {
      if (binding.source !== 'feishu') continue
      const channelId = binding.channelName ?? 'feishu'
      const peerId = binding.channelId
      const operatorId = binding.participantId
      if (
        !connectedChannel(channelId) ||
        !/^oc_[a-zA-Z0-9_-]+$/.test(peerId) ||
        !operatorId ||
        !/^ou_[a-zA-Z0-9_-]+$/.test(operatorId)
      )
        continue
      targets.push({
        platform: 'feishu',
        channelId,
        peerId,
        operatorId,
        label: `飞书 · ${channelId} · 会话 ${peerId.slice(-8)} · 操作人 ${operatorId.slice(-8)}`,
      })
    }
    return targets
  }

  function listArchiveChannels() {
    return [...host.channels.keys()].filter((id) => connectedChannel(id))
  }

  function listDirectTargets(): MandateTargetOption[] {
    return listArchiveChannels().flatMap((channelId) =>
      (connectedChannel(channelId)?.directPeers.list() ?? []).map(({ chatId, actorId }) => ({
        platform: 'feishu' as const,
        channelId,
        peerId: chatId,
        operatorId: actorId,
        label: `飞书 · ${channelId} · 会话 ${chatId.slice(-8)} · 操作人 ${actorId.slice(-8)}`,
      })),
    )
  }

  async function probeArchive(target: MandateArchive) {
    const channel = connectedChannel(target.channelId)
    if (!channel) return { ok: false, reason: '所选飞书通道未连接。' }
    return channel.router.probeDocument(target.documentId)
  }

  async function send(
    target: MandateTarget,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean = () => true,
  ): Promise<MandateReceipt> {
    const channel = connectedChannel(target.channelId)
    const isBound = () =>
      isLiveTarget?.(target) ??
      listTargets().some((candidate) => sameTriggerRouteTarget(candidate, target))
    if (target.platform !== 'feishu' || !channel || !isBound())
      return { status: 'rejected', reason: '飞书目标会话和操作人未绑定或已失效。' }
    return channel.router.send(
      target.peerId,
      payload,
      signal,
      () => maySend() && connectedChannel(target.channelId) === channel && isBound(),
    )
  }

  async function archive(
    target: MandateArchive,
    payload: MandateDelivery,
    signal: AbortSignal,
    maySend: () => boolean = () => true,
  ): Promise<MandateReceipt> {
    const channel = connectedChannel(target.channelId)
    if (!channel) return { status: 'rejected', reason: '所选飞书归档通道未连接。' }
    return channel.router.archive(
      target.documentId,
      payload,
      signal,
      () => maySend() && connectedChannel(target.channelId) === channel,
    )
  }

  return { listTargets, listDirectTargets, listArchiveChannels, probeArchive, send, archive }
}
