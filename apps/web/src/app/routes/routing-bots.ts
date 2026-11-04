import { useQuery } from '@tanstack/react-query'
import type { TriggerRoutingBot } from '@zero-os/shared'
import { apiFetch } from '../lib/api'

export const botDeliveryHints: Record<TriggerRoutingBot['deliveryState'], string> = {
  ready: '可在本人私聊中与 Router 对话和接收主动提醒。',
  offline: '机器人离线，主动提醒将延后至重新连接。',
  awaiting_private: '先私聊这个机器人发一条消息，以便渠道确认你的身份。',
  ambiguous: '有多位私聊联系人，Router 无法确认本人。可改选个人专用的机器人。',
  unavailable: '原有的个人私聊当前不可用。请核对机器人账号和私聊状态。',
}

export function useRoutingBots(enabled = true) {
  return useQuery({
    queryKey: ['listeners', 'routing', 'bots'],
    enabled,
    queryFn: ({ signal }) =>
      apiFetch<{ bots: TriggerRoutingBot[] }>('/api/listeners/routing/bots', { signal }),
    retry: false,
  })
}
