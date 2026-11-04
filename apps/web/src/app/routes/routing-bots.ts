import { useQuery } from '@tanstack/react-query'
import type { TriggerRoutingBot } from '@zero-os/shared'
import { apiFetch } from '../lib/api'

export const botDeliveryHints: Record<TriggerRoutingBot['deliveryState'], string> = {
  ready: '可接收消息、回复和发送主动提醒。',
  offline: '机器人离线，主动提醒将延后至重新连接。',
  awaiting_private: '可以接收和回复消息。先私聊这个机器人发一条消息，以便它给你发主动提醒。',
  ambiguous: '可以接收和回复消息。有多位私聊联系人，暂缓主动提醒。可改选个人专用的机器人。',
  unavailable: '可以接收和回复消息。原有的主动提醒通道当前不可用，提醒将延后。',
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
