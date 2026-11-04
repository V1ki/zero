import { type ApiOptions, ILinkError, postJson } from './api-transport'
import {
  API_TIMEOUT_MS,
  EP_SEND_MESSAGE,
  ITEM_TEXT,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
} from './constants'

export class ILinkSendRejection extends ILinkError {
  constructor(codes: string[]) {
    super(`微信平台拒绝发送消息（${codes.join('，')}）。`, EP_SEND_MESSAGE, 200)
  }
}

function validServerMessageId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  )
}

function checkSendReceipt(result: unknown, requireAck: boolean): void {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const receipt = result as Record<string, unknown>
    const codes = ['ret', 'errcode'].flatMap((key) => {
      const value = receipt[key]
      return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
        ? [`${key}=${value}`]
        : []
    })
    if (codes.length) throw new ILinkSendRejection(codes)
    if (!requireAck) return

    // Tencent's SDK accepts an empty JSON object and can return only the assigned uint64 ID.
    if (Object.keys(receipt).length === 0) return
    const validCodes =
      (receipt.ret === undefined || receipt.ret === 0) &&
      (receipt.errcode === undefined || receipt.errcode === 0)
    const hasError =
      (receipt.errmsg !== undefined && receipt.errmsg !== '' && receipt.errmsg !== 'ok') ||
      receipt.error != null ||
      receipt.base_resp != null
    const validId = receipt.message_id === undefined || validServerMessageId(receipt.message_id)
    if (
      validCodes &&
      !hasError &&
      validId &&
      (receipt.ret === 0 || receipt.message_id !== undefined)
    )
      return
  }
  if (requireAck) throw new Error('iLink 没有返回可确认的发送回执')
}

export async function sendTextMessage(
  params: {
    baseUrl: string
    token: string
    to: string
    text: string
    contextToken?: string
    clientId: string
  },
  opts: ApiOptions & { requireAck?: boolean } = {},
): Promise<void> {
  if (!params.text || !params.text.trim()) {
    throw new Error('sendTextMessage: text must not be empty')
  }
  const msg: Record<string, unknown> = {
    from_user_id: '',
    to_user_id: params.to,
    client_id: params.clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text: params.text } }],
  }
  if (params.contextToken) msg.context_token = params.contextToken
  const result = await postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_SEND_MESSAGE,
      payload: { msg },
      token: params.token,
      timeoutMs: API_TIMEOUT_MS,
    },
    opts,
  )
  checkSendReceipt(result, opts.requireAck === true)
}

export async function sendRawMessage(
  params: {
    baseUrl: string
    token: string
    msg: Record<string, unknown>
  },
  opts: ApiOptions = {},
): Promise<void> {
  const result = await postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
      baseUrl: params.baseUrl,
      endpoint: EP_SEND_MESSAGE,
      payload: { msg: params.msg },
      token: params.token,
      timeoutMs: API_TIMEOUT_MS,
    },
    opts,
  )
  checkSendReceipt(result, false)
}
