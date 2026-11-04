import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Client, EventDispatcher } from '@larksuiteoapi/node-sdk'

interface RouterEntry {
  taskId: number
  title: string
  summary: string
}
interface RouterContent {
  id: string
  digest: boolean
  entries: RouterEntry[]
}
interface CardClick {
  chatId: string
  actorId: string
  messageId: string
  eventId: string
  taskId: number
}
type Receipt =
  | { status: 'accepted'; receipt: string }
  | { status: 'rejected' | 'unknown'; reason: string }

const documentToken = /^[a-zA-Z0-9]{1,128}$/
const nativeChat = /^oc_[a-zA-Z0-9_-]+$/
const nativeActor = /^ou_[a-zA-Z0-9_-]+$/
const nativeMessage = /^om_[a-zA-Z0-9_-]+$/
const text = (content: string) => ({ tag: 'plain_text', content })
const paragraph = (content: string) => ({ tag: 'div', text: text(content) })
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

function nativeUuid(kind: string, targetId: string, id: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([kind, targetId, id]))
    .digest()
  // A deterministic RFC 9562 UUIDv8. Both native APIs have a client idempotency field.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function card(title: string, elements: unknown[]) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: text(title), template: 'blue' },
    body: { elements },
  }
}

function taskCard(payload: RouterContent) {
  const digest = payload.digest || payload.entries.length > 1
  const maxShown = 8
  const elements: unknown[] = []
  for (const entry of payload.entries.slice(0, maxShown)) {
    elements.push(
      paragraph(
        `#任务${entry.taskId} · ${entry.title.slice(0, 90)}\n${entry.summary.slice(0, digest ? 320 : 1200)}`,
      ),
    )
    elements.push({
      tag: 'button',
      type: 'primary',
      text: text(`确认任务 #${entry.taskId}`),
      behaviors: [
        {
          type: 'callback',
          value: { source: 'zero_router', action: 'ack', taskId: entry.taskId, digest },
        },
      ],
    })
  }
  if (payload.entries.length > maxShown)
    elements.push(
      paragraph(
        `其余任务：${payload.entries
          .slice(maxShown)
          .map((entry) => `#任务${entry.taskId}`)
          .join('、')}。可按编号继续处理。`,
      ),
    )
  const example = `#任务${payload.entries[0].taskId}`
  const chooseTask = payload.entries.length > 1 ? '以第一项为例，其他任务请替换编号。' : ''
  elements.push(
    paragraph(
      `${chooseTask}在本会话发送「${example} 确认」可确认，发送「${example} 进展如何」可追问。`,
    ),
  )
  return card(digest ? `ZeRo 任务摘要 · ${payload.entries.length} 条` : 'ZeRo 任务提醒', elements)
}

// This SDK's generated methods do not take an AbortSignal. A write that outlives
// this wait may still land at the provider and must stay unknown until reconciled.
async function awaitResponse<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const stop = signal ? AbortSignal.any([timeout, signal]) : timeout
  stop.throwIfAborted()
  let cancel: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(stop.reason)
    stop.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([send(), interrupted])
  } finally {
    if (cancel) stop.removeEventListener('abort', cancel)
  }
}

function rejected(reason: string): Receipt {
  return { status: 'rejected', reason }
}

type FeishuHttp = NonNullable<ConstructorParameters<typeof Client>[0]['httpInstance']>
class WriteNotAuthorized extends Error {
  constructor(readonly dispatched: boolean) {
    super('飞书写入授权已变更。')
  }
}

function apiFailure(error: unknown, operation: string): Receipt {
  if (error instanceof WriteNotAuthorized && !error.dispatched)
    return rejected('飞书投递前授权已变更或已取消。')
  const response = record(record(error).response)
  const status = response.status
  const code = record(response.data).code
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return rejected(
      `飞书拒绝${operation}（HTTP ${status}${typeof code === 'number' ? `，${code}` : ''}）。`,
    )
  }
  return { status: 'unknown', reason: `${operation}回执不确定，请核对飞书后再处理。` }
}

export class FeishuRouterDelivery {
  private readonly beforeWrite = new AsyncLocalStorage<() => void>()
  private onClick?: (click: CardClick) => Promise<boolean>

  constructor(
    private readonly client: () => Client | null,
    private readonly appId: string,
  ) {}

  // Generated SDK methods await token resolution before calling request(). The guard
  // belongs to this dispatch only, even when other operations share the same client.
  wrapTransport(http: FeishuHttp): FeishuHttp {
    return {
      ...http,
      request: (options) => {
        this.beforeWrite.getStore()?.()
        return http.request(options)
      },
    }
  }

  private async write<T>(
    client: Client,
    signal: AbortSignal,
    maySend: (() => boolean) | undefined,
    send: () => Promise<T>,
  ): Promise<T> {
    let open = true
    let dispatched = false
    const check = () => {
      if (!open || signal.aborted || client !== this.client() || (maySend && !maySend())) {
        throw new WriteNotAuthorized(dispatched)
      }
    }
    try {
      check()
      return await this.beforeWrite.run(
        () => {
          check()
          dispatched = true
        },
        () => awaitResponse(send, signal),
      )
    } finally {
      // If token resolution outlives awaitResponse, its eventual write is fenced out.
      open = false
    }
  }

  setActionHandler(handler: (click: CardClick) => Promise<boolean>): void {
    this.onClick = handler
  }

  register(dispatcher: EventDispatcher, isCurrent: () => boolean): void {
    dispatcher.register({
      'card.action.trigger': (data: unknown) => this.click(data, isCurrent()),
    })
  }

  private async click(data: unknown, current: boolean) {
    const event = record(data)
    const { app_id, tenant_key, event_id, host } = event
    const actor = record(event.operator)
    const { open_message_id, open_chat_id } = record(event.context)
    const { tag, value } = record(event.action)
    const { source, action, taskId, digest } = record(value)
    const denied = { toast: { type: 'error', content: '该卡片操作不可用或没有权限。' } }
    // Apps can host unrelated cards. Trace only identified Router actions, without payload fields.
    if (app_id !== this.appId || source !== 'zero_router') return denied
    console.log('[FeishuChannel] Router card callback: received')
    if (!current || !this.onClick) {
      console.log('[FeishuChannel] Router card callback: unavailable')
      return denied
    }
    if (
      typeof tenant_key !== 'string' ||
      !tenant_key ||
      typeof actor.open_id !== 'string' ||
      !nativeActor.test(actor.open_id) ||
      typeof event_id !== 'string' ||
      !event_id ||
      host !== 'im_message' ||
      typeof open_chat_id !== 'string' ||
      !nativeChat.test(open_chat_id) ||
      typeof open_message_id !== 'string' ||
      !nativeMessage.test(open_message_id) ||
      tag !== 'button' ||
      action !== 'ack' ||
      typeof taskId !== 'number' ||
      !Number.isSafeInteger(taskId) ||
      taskId < 1 ||
      typeof digest !== 'boolean'
    ) {
      console.log('[FeishuChannel] Router card callback: invalid')
      return denied
    }
    if (actor.tenant_key !== tenant_key) {
      console.log('[FeishuChannel] Router card callback: denied')
      return denied
    }

    const handled = await this.onClick({
      chatId: open_chat_id,
      actorId: actor.open_id,
      messageId: open_message_id,
      eventId: event_id,
      taskId,
    })
    if (!handled) {
      console.log('[FeishuChannel] Router card callback: denied')
      return denied
    }
    console.log('[FeishuChannel] Router card callback: acknowledged')

    // Only replace a single-task card. A digest still has other authorized actions.
    return {
      toast: { type: 'success', content: `已确认任务 #${taskId}。` },
      ...(!digest && {
        card: {
          type: 'raw',
          data: card(`已确认 · 任务 #${taskId}`, [
            paragraph(`已记录确认。发送「#任务${taskId} 你的问题」可继续处理。`),
          ]),
        },
      }),
    }
  }

  async send(
    chatId: string,
    payload: RouterContent,
    signal: AbortSignal,
    maySend?: () => boolean,
  ): Promise<Receipt> {
    const client = this.client()
    if (
      !client ||
      signal.aborted ||
      !nativeChat.test(chatId) ||
      !payload.id ||
      !payload.entries.length
    )
      return rejected('飞书提醒没有可用的目标或已取消。')
    try {
      const response = await this.write(client, signal, maySend, () =>
        client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(taskCard(payload)),
            uuid: nativeUuid('card', chatId, payload.id),
          },
        }),
      )
      if (typeof response.code === 'number' && response.code !== 0)
        return rejected(`飞书拒绝发送卡片（${response.code}）。`)
      const id = response.data?.message_id
      if (response.code === 0 && id && nativeMessage.test(id))
        return { status: 'accepted', receipt: id }
      return { status: 'unknown', reason: '飞书卡片缺少可核对的消息回执。' }
    } catch (error) {
      return apiFailure(error, '发送卡片')
    }
  }

  async probeDocument(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason: string }> {
    const client = this.client()
    if (!client || !documentToken.test(documentId))
      return { ok: false, reason: '请选择已连接的飞书通道，并填写新版文档的 document token。' }
    try {
      const grants = await awaitResponse(() => client.application.scope.list({}), signal)
      if (
        grants.code !== 0 ||
        !grants.data?.scopes?.some(
          (s) =>
            s.grant_status === 1 &&
            s.scope_type !== 'user' &&
            (s.scope_name === 'docx:document' || s.scope_name === 'docx:document:write_only'),
        )
      )
        return { ok: false, reason: '未能确认飞书应用已获新版文档写入权限。' }
      const permission = await awaitResponse(
        () =>
          client.drive.permissionMember.auth({
            path: { token: documentId },
            params: { type: 'docx', action: 'edit' },
          }),
        signal,
      )
      if (permission.code !== 0 || permission.data?.auth_result !== true)
        return {
          ok: false,
          reason: '无法确认应用可编辑所选飞书文档，请检查文档分享及权限查询授权。',
        }
      return { ok: true, reason: '应用写入权限和所选文档编辑权限已核对。' }
    } catch {
      return { ok: false, reason: '无法核对飞书应用权限或文档授权，请检查连接。' }
    }
  }

  async archive(
    documentId: string,
    payload: RouterContent,
    signal: AbortSignal,
    maySend?: () => boolean,
  ): Promise<Receipt> {
    if (signal.aborted || !payload.id || !payload.entries.length || payload.entries.length > 50)
      return rejected('飞书文档写入请求无效或已取消。')
    const client = this.client()
    const access = await this.probeDocument(documentId, signal)
    if (!access.ok) return rejected(access.reason)
    if (!client || client !== this.client() || signal.aborted)
      return rejected('飞书归档已取消或通道已切换。')
    const token = nativeUuid('docx', documentId, payload.id)
    try {
      const response = await this.write(client, signal, maySend, () =>
        client.docx.documentBlockChildren.create({
          path: { document_id: documentId, block_id: documentId },
          params: { document_revision_id: -1, client_token: token },
          data: {
            index: -1,
            children: payload.entries.map((entry) => ({
              block_type: 2,
              text: {
                elements: [
                  {
                    text_run: {
                      content: `ZeRo · #任务${entry.taskId} · ${entry.title.slice(0, 150)}\n${entry.summary.slice(0, 2000)}`,
                    },
                  },
                ],
              },
            })),
          },
        }),
      )
      if (typeof response.code === 'number' && response.code !== 0)
        return rejected(`飞书拒绝写入文档（${response.code}）。`)
      const ids = response.data?.children?.map((block) => block.block_id)
      if (
        response.code === 0 &&
        response.data?.client_token === token &&
        ids?.length === payload.entries.length &&
        ids.every(Boolean)
      )
        return { status: 'accepted', receipt: `${documentId}#${ids.join(',')}` }
      return { status: 'unknown', reason: '飞书文档回执不完整，请核对原文档。' }
    } catch (error) {
      return apiFailure(error, '写入文档')
    }
  }
}
