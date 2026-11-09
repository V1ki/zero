import type { RouterGeneratedUI } from './router-surface'
export type RouterPublicationChannel = 'web' | 'weixin' | 'dingtalk' | 'feishu'
export interface RouterPresentation {
  title: string
  text: string
  generatedUI?: RouterGeneratedUI
  /** Visible operations selected by the Agent; each returns to the same main loop. */
  actions: Array<{ id: string; label: string }>
}
export interface RouterPublication {
  id: string
  principal: string
  matterId: string
  matterVersion: number
  scope: string
  createdAt: string
  deliveries: Array<{
    channel: RouterPublicationChannel
    presentation: RouterPresentation
    status: 'pending' | 'sending' | 'accepted' | 'rejected' | 'unknown'
    receipt: string | null
    reason: string | null
    attempt: number
  }>
}

export interface RouterPublicationTrace {
  runId: string
  ordinal: number
  operation: 'publish_update' | 'retry_delivery'
  channel?: RouterPublicationChannel
}

export interface RouterPublicationAction {
  peerId: string
  actorId: string
  cardId: string
  messageId: string
  deliveryId: string
  actionId: string
}
