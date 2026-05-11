/**
 * Protocol-level types for the Weixin iLink Bot API.
 */

export type ChatType = 'dm' | 'group'
export type Policy = 'open' | 'allowlist' | 'disabled'

export interface ILinkCredentials {
  accountId: string
  token: string
  baseUrl: string
  userId?: string
  savedAt: string
}

export interface IncomingMediaItem {
  type: number
  text_item?: { text?: string }
  image_item?: {
    aeskey?: string
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string }
  }
  video_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string }
  }
  file_item?: {
    file_name?: string
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string }
  }
  voice_item?: {
    text?: string
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string }
  }
  ref_msg?: {
    title?: string
    message_item?: IncomingMediaItem
  }
}

export interface IncomingMessage {
  seq?: number
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  group_id?: string
  room_id?: string
  chat_room_id?: string
  msg_type?: number
  context_token?: string
  item_list?: IncomingMediaItem[]
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  longpolling_timeout_ms?: number
  get_updates_buf?: string
  msgs?: IncomingMessage[]
}

export interface UploadUrlResponse {
  upload_param?: string
  upload_full_url?: string
  [key: string]: unknown
}

export interface QrCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

export interface QrStatusResponse {
  status?: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'
  redirect_host?: string
  ilink_bot_id?: string
  bot_token?: string
  baseurl?: string
  ilink_user_id?: string
}

export interface WeixinChannelConfig {
  name?: string
  accountId: string
  token: string
  baseUrl?: string
  cdnBaseUrl?: string
  botAgent?: string
  homeDir: string
  dmPolicy?: Policy
  groupPolicy?: Policy
  allowFrom?: string[]
  groupAllowFrom?: string[]
  sendChunkDelayMs?: number
  sendChunkRetries?: number
  sendChunkRetryDelayMs?: number
  splitMultilineMessages?: boolean
}
