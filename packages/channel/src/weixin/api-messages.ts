import { type ApiOptions, postJson } from './api-transport'
import {
  API_TIMEOUT_MS,
  EP_SEND_MESSAGE,
  ITEM_TEXT,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
} from './constants'

export async function sendTextMessage(
  params: {
    baseUrl: string
    token: string
    to: string
    text: string
    contextToken?: string
    clientId: string
  },
  opts: ApiOptions = {},
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
  await postJson(
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
}

export async function sendRawMessage(
  params: {
    baseUrl: string
    token: string
    msg: Record<string, unknown>
  },
  opts: ApiOptions = {},
): Promise<void> {
  await postJson(
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
}
