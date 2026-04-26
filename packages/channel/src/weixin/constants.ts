/**
 * iLink Bot API constants shared across the Weixin channel.
 * Mirrored from Hermes Agent's weixin.py (commit d8a52109).
 */

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const ILINK_APP_ID = 'bot'
export const WEIXIN_PROTOCOL_VERSION = '2.2.0'
export const CHANNEL_VERSION = WEIXIN_PROTOCOL_VERSION

export function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

export const LONG_POLL_TIMEOUT_MS = 35_000
export const API_TIMEOUT_MS = 15_000
export const CONFIG_TIMEOUT_MS = 10_000
export const QR_TIMEOUT_MS = 35_000

export const MAX_CONSECUTIVE_FAILURES = 3
export const RETRY_DELAY_MS = 2_000
export const BACKOFF_DELAY_MS = 30_000
export const SESSION_EXPIRED_ERRCODE = -14
export const SESSION_EXPIRED_PAUSE_MS = 600_000
export const MESSAGE_DEDUP_TTL_MS = 300_000
export const MAX_MESSAGE_LENGTH = 4_000

export const EP_GET_UPDATES = 'ilink/bot/getupdates'
export const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
export const EP_SEND_TYPING = 'ilink/bot/sendtyping'
export const EP_GET_CONFIG = 'ilink/bot/getconfig'
export const EP_NOTIFY_START = 'ilink/bot/msg/notifystart'
export const EP_NOTIFY_STOP = 'ilink/bot/msg/notifystop'
export const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl'
export const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode'
export const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status'

export const MEDIA_IMAGE = 1
export const MEDIA_VIDEO = 2
export const MEDIA_FILE = 3
export const MEDIA_VOICE = 4

export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

export const MSG_TYPE_USER = 1
export const MSG_TYPE_BOT = 2
export const MSG_STATE_FINISH = 2

export const TYPING_START = 1
export const TYPING_STOP = 2
