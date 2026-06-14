export interface ChannelRuntimeDefinition {
  name: string
  type: 'web' | 'feishu' | 'telegram' | 'weixin'
  configured: boolean
  receiveNotifications: boolean
  secretRefs: string[]
}

export interface FeishuRuntimeDefinition extends ChannelRuntimeDefinition {
  type: 'feishu'
  credentials?: {
    appId: string
    appSecret: string
    encryptKey?: string
    verificationToken?: string
  }
}

export interface TelegramRuntimeDefinition extends ChannelRuntimeDefinition {
  type: 'telegram'
  streaming: boolean
  credentials?: {
    botToken: string
  }
}

export interface WeixinRuntimeDefinition extends ChannelRuntimeDefinition {
  type: 'weixin'
  credentials?: {
    accountId: string
    token: string
    baseUrl?: string
    cdnBaseUrl?: string
    botAgent?: string
    dmPolicy?: 'open' | 'allowlist' | 'disabled'
    groupPolicy?: 'open' | 'allowlist' | 'disabled'
    allowFrom?: string[]
    groupAllowFrom?: string[]
  }
}

export type ExternalChannelRuntimeDefinition =
  | FeishuRuntimeDefinition
  | TelegramRuntimeDefinition
  | WeixinRuntimeDefinition
