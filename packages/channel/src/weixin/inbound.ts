import { ITEM_FILE, ITEM_IMAGE, ITEM_TEXT, ITEM_VIDEO, ITEM_VOICE } from './constants'
import type { ChatType, IncomingMediaItem, IncomingMessage } from './types'

export function safeId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!id) return 'unknown'
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-4)}`
}

export function guessChatType(
  message: IncomingMessage,
  _accountId: string,
): { chatType: ChatType; chatId: string } {
  // @tencent-weixin/openclaw-weixin declares only direct chats and routes
  // inbound messages by from_user_id. Some getUpdates payloads include
  // to_user_id/session_id-like fields, but they are not reliable group targets.
  return { chatType: 'dm', chatId: String(message.from_user_id ?? '').trim() }
}

export function extractText(items: IncomingMediaItem[]): string {
  for (const item of items) {
    if (item.type === ITEM_TEXT) {
      const base = String(item.text_item?.text ?? '')
      const refItem = item.ref_msg?.message_item
      if (refItem) {
        const refType = refItem.type
        if (
          refType === ITEM_IMAGE ||
          refType === ITEM_VIDEO ||
          refType === ITEM_FILE ||
          refType === ITEM_VOICE
        ) {
          const title = item.ref_msg?.title ?? ''
          const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n'
          return `${prefix}${base}`.trim()
        }
        const parts: string[] = []
        if (item.ref_msg?.title) parts.push(String(item.ref_msg.title))
        const refText = extractText([refItem])
        if (refText) parts.push(refText)
        if (parts.length > 0) return `[引用: ${parts.join(' | ')}]\n${base}`.trim()
      }
      return base
    }
  }
  for (const item of items) {
    if (item.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText) return voiceText
    }
  }
  return ''
}
