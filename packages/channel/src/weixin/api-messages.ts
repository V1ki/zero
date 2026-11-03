import { type ApiOptions, ILinkError, postJson } from './api-transport'
import {
  API_TIMEOUT_MS,
  EP_SEND_MESSAGE,
  ITEM_TEXT,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
} from './constants'

function checkSendReceipt(result: unknown, requireAck: boolean): void {
  const receipt = result && typeof result === 'object' ? result : {}
  const ret = 'ret' in receipt ? receipt.ret : undefined
  const errcode = 'errcode' in receipt ? receipt.errcode : undefined
  const rejection = [ret, errcode].find((code) => typeof code === 'number' && code !== 0)
  if (rejection !== undefined) {
    throw new ILinkError(`iLink 拒绝发送消息（业务码 ${rejection}）`, EP_SEND_MESSAGE, 200)
  }
  // iLink documents a top-level ret=0 for sendmessage; errcode alone is not an acknowledgement.
  if (requireAck && (ret !== 0 || (errcode !== undefined && errcode !== 0))) {
    throw new Error('iLink 没有返回可确认的发送回执')
  }
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
