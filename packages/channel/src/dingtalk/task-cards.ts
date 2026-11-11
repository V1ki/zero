import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DWClientDownStream } from 'dingtalk-stream'
import type { DingtalkRobotMessage } from './incoming-message'

export interface DingtalkTaskCardAction {
  peerId: string
  actorId: string
  cardId: string
  messageId: string
  taskId: number
  action: 'ack'
}

interface Peer {
  peerId: string
  actorId: string
  corpId: string
  spaceType: 'IM_ROBOT' | 'IM_GROUP'
  spaceId: string
}

export interface TaskCardData {
  id: string
  digest: boolean
  entries: Array<{ taskId: number; title: string; summary: string }>
}

type CardState = 'sending' | 'accepted' | 'rejected' | 'unknown'
interface Card extends Peer {
  taskIds: string
  state: CardState
  receipt: string | null
}

export class DingtalkCardError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message)
    this.name = 'DingtalkCardError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function json(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value)
  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}

function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\s*\p{Cc}]/u.test(value) &&
    value !== 'unknown'
  )
}

function markdownFact(value: string, limit: number): string {
  // Source text shares a Markdown field with trusted task references. Keep it on
  // one line and use literal punctuation that IM clients cannot interpret as markup.
  return value
    .replace(/[\p{Bidi_Control}\u200B\u2060]/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .replace(/(?:\b[a-z][a-z\d+.-]{0,31}:\/\/|\bwww\.)[^\s()[\]<>，。；、！？]+/giu, '（来源链接）')
    .replace(
      /[#＃]\s*(任务|task|收件箱?|监听)?\s*(?=\d)/giu,
      (_, kind: string | undefined) => `${kind || '编号'} `,
    )
    .replace(/[\\`*_~@#&|[\]<>]/g, (mark) => String.fromCharCode(mark.charCodeAt(0) + 0xfee0))
    .slice(0, limit)
    .replace(/\p{Cs}$/u, '')
}

export class DingtalkTaskCards {
  private db?: Database

  constructor(
    private readonly options: {
      dbPath: string
      templateId?: string
      account: string
      robotCode: string
      apiBaseUrl: string
      fetch: typeof fetch
      getToken(): Promise<string | undefined>
      onAction?(action: DingtalkTaskCardAction): Promise<boolean>
    },
  ) {}

  private database(): Database {
    if (this.db) return this.db
    if (this.options.dbPath !== ':memory:')
      mkdirSync(dirname(this.options.dbPath), { recursive: true, mode: 0o700 })
    const db = new Database(this.options.dbPath, { create: true })
    db.exec(`
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS peers (
        peerId TEXT NOT NULL, actorId TEXT NOT NULL, corpId TEXT NOT NULL,
        spaceType TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(peerId, actorId)
      );
      CREATE TABLE IF NOT EXISTS cards (
        cardId TEXT PRIMARY KEY, peerId TEXT NOT NULL, actorId TEXT NOT NULL, corpId TEXT NOT NULL,
        spaceType TEXT NOT NULL, spaceId TEXT NOT NULL, taskIds TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT
      );
    `)
    this.db = db
    return db
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  remember(msg: DingtalkRobotMessage): void {
    const { conversationId: peerId, senderStaffId: actorId, chatbotCorpId: corpId } = msg
    if (!identity(peerId) || !identity(actorId) || !identity(corpId) || msg.senderCorpId !== corpId)
      return
    const kind = String(msg.conversationType)
    if (kind !== '1' && kind !== '2') return
    this.database()
      .query('INSERT OR REPLACE INTO peers VALUES (?, ?, ?, ?, ?)')
      .run(
        peerId,
        actorId,
        corpId,
        kind === '1' ? 'IM_ROBOT' : 'IM_GROUP',
        kind === '1' ? actorId : peerId,
      )
  }

  private peer(peerId: string, actorId: string): Peer | null {
    return this.database()
      .query<Peer, [string, string]>('SELECT * FROM peers WHERE peerId = ? AND actorId = ?')
      .get(peerId, actorId)
  }

  canSend(peerId: string, actorId: string): boolean {
    return (
      (!this.options.templateId || !!this.options.onAction) && this.hasBoundPeer(peerId, actorId)
    )
  }

  hasBoundPeer(peerId: string, actorId: string): boolean {
    return !!this.peer(peerId, actorId)
  }

  listDirectPeers(): Pick<Peer, 'peerId' | 'actorId'>[] {
    if (!this.db && !existsSync(this.options.dbPath)) return []
    return this.database()
      .query<Pick<Peer, 'peerId' | 'actorId'>, []>(
        "SELECT peerId, actorId FROM peers WHERE spaceType='IM_ROBOT' AND spaceId=actorId ORDER BY peerId, actorId",
      )
      .all()
  }

  get modeLabel(): string {
    return this.options.templateId ? '互动卡片 · 按钮跟进' : '内置 Markdown · 按任务编号回复'
  }

  private async request(
    method: 'POST' | 'PUT',
    path: string,
    body: object,
    token: string,
    signal: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(15_000)
    let response: Response
    let raw: string
    try {
      response = await this.options.fetch(this.options.apiBaseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      })
      raw = await response.text()
    } catch {
      throw new DingtalkCardError('钉钉卡片接口未返回完整回执，请核对原会话。', true)
    }
    if (!response.ok) {
      const body = json(raw)
      const code =
        typeof body.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(body.code)
          ? `（${body.code}）`
          : ''
      const hint =
        body.code === 'Forbidden.AccessDenied.IpNotInWhiteList'
          ? ' 请核对该应用安全设置中的服务器出口 IP 白名单。'
          : ''
      // Provider messages can include recipient IDs, tokens and network addresses.
      const scopes = record(body.accessDeniedDetail).requiredAccessDeniedPermissionList
      const required = Array.isArray(scopes)
        ? scopes
            .filter(
              (s): s is string =>
                typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(s),
            )
            .slice(0, 5)
        : []
      const requestId = body.requestid ?? body.requestId ?? response.headers.get('x-acs-request-id')
      const trace =
        typeof requestId === 'string' &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId)
          ? ` 请求编号 ${requestId}。`
          : ''
      throw new DingtalkCardError(
        `钉钉接口返回 HTTP ${response.status}${code}。${hint}${required.length ? ` 所需权限 ${required.join('、')}。` : ''}${trace}`,
        response.status >= 500 || response.status === 408 || response.status === 409,
      )
    }
    return json(raw)
  }

  private async cardRequest(
    method: 'POST' | 'PUT',
    path: string,
    body: object,
    token: string,
    signal: AbortSignal,
  ) {
    const receipt = await this.request(method, path, body, token, signal)
    if (receipt.success === false) throw new DingtalkCardError('钉钉平台拒绝了卡片操作。')
    if (receipt.success !== true) throw new DingtalkCardError('钉钉卡片回执缺少操作结果。', true)
    if (method === 'PUT' && receipt.result !== true) {
      throw new DingtalkCardError('钉钉未确认卡片状态已更新。', receipt.result !== false)
    }
    return record(receipt.result)
  }

  async send(
    peerId: string,
    actorId: string,
    data: TaskCardData,
    signal: AbortSignal,
    maySend?: () => boolean,
  ): Promise<string> {
    const peer = this.peer(peerId, actorId)
    if (!peer || !this.canSend(peerId, actorId) || !data.id || !data.entries.length)
      throw new DingtalkCardError('所选钉钉目标、卡片模板或回调不可用。')
    const cardId = `zero_${createHash('sha256')
      .update(JSON.stringify([this.options.account, peerId, actorId, data.id]))
      .digest('hex')
      .slice(0, 48)}`
    const taskIds = JSON.stringify([...new Set(data.entries.map((e) => e.taskId))])
    const db = this.database()
    const token = await this.options.getToken()
    if (!token || signal.aborted) throw new DingtalkCardError('钉钉卡片发送前已取消或凭据不可用。')
    const prior = db.query<Card, [string]>('SELECT * FROM cards WHERE cardId = ?').get(cardId)
    if (prior && prior.taskIds !== taskIds)
      throw new DingtalkCardError('该卡片编号已用于其他任务。')
    if (prior?.state === 'accepted' && prior.receipt) return prior.receipt
    if (prior && prior.state !== 'rejected')
      throw new DingtalkCardError('这张卡片的上一次投递仍待核对。', true)
    // Token acquisition can outlive the original mandate or peer binding. No await
    // separates this check from claiming the card and starting its HTTP request.
    const currentPeer = this.peer(peerId, actorId)
    if (
      (maySend && !maySend()) ||
      currentPeer?.corpId !== peer.corpId ||
      currentPeer.spaceType !== peer.spaceType ||
      currentPeer.spaceId !== peer.spaceId
    )
      throw new DingtalkCardError('发送准备期间钉钉投递授权已变更。')
    const claimed = db
      .query(`INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', NULL)
      ON CONFLICT(cardId) DO UPDATE SET state = 'sending' WHERE cards.state = 'rejected'`)
      .run(cardId, peerId, actorId, peer.corpId, peer.spaceType, peer.spaceId, taskIds)
    if (!claimed.changes) throw new DingtalkCardError('这张卡片正在投递，请核对回执。', true)
    let receipt: string
    try {
      receipt = this.options.templateId
        ? await this.sendCard(cardId, peer, data, token, signal)
        : await this.sendMarkdown(peer, data, token, signal)
    } catch (error) {
      db.query('UPDATE cards SET state = ? WHERE cardId = ?').run(
        error instanceof DingtalkCardError && !error.uncertain ? 'rejected' : 'unknown',
        cardId,
      )
      throw error
    }
    db.query("UPDATE cards SET state = 'accepted', receipt = ? WHERE cardId = ?").run(
      receipt,
      cardId,
    )
    return receipt
  }

  private async sendMarkdown(peer: Peer, data: TaskCardData, token: string, signal: AbortSignal) {
    const direct = peer.spaceType === 'IM_ROBOT'
    const title = data.digest ? 'ZeRo 任务摘要' : 'ZeRo 任务提醒'
    const prefixes = data.entries.map((entry) => `**#任务${entry.taskId}** `)
    const followup = direct
      ? `在本私聊回复「#任务${data.entries[0].taskId} 进展如何」继续。`
      : `在本群 @机器人 并回复「#任务${data.entries[0].taskId} 进展如何」继续。`
    const available = 4200 - Buffer.byteLength([...prefixes, followup].join('\n\n'))
    const budget = Math.max(0, Math.min(600, Math.floor(available / (3 * data.entries.length))))
    const text = [
      ...data.entries.map(
        (e, index) =>
          prefixes[index] + markdownFact([e.title, e.summary].filter(Boolean).join(' · '), budget),
      ),
      followup,
    ].join('\n\n')
    return this.sendRobotMessage(peer, 'sampleMarkdown', { title, text }, token, signal)
  }

  sendListenerReminder(
    peerId: string,
    actorId: string,
    body: string,
    signal: AbortSignal,
    maySend: () => boolean,
  ) {
    return this.sendTextReminder(this.peer(peerId, actorId), body, signal, maySend)
  }

  async sendDirectReminder(
    peerId: string,
    actorId: string,
    body: string,
    signal: AbortSignal,
    maySend: () => boolean,
  ) {
    const peer = this.peer(peerId, actorId)
    if (peer?.spaceType !== 'IM_ROBOT' || peer.spaceId !== actorId)
      return { status: 'rejected' as const, reason: '钉钉机器人尚未确认这个私聊联系人。' }
    return this.sendTextReminder(peer, body, signal, maySend)
  }

  private async sendTextReminder(
    peer: Peer | null,
    body: string,
    signal: AbortSignal,
    maySend: () => boolean,
  ): Promise<
    { status: 'accepted'; receipt: string } | { status: 'unknown' | 'rejected'; reason: string }
  > {
    if (!peer || !body.trim() || signal.aborted || !maySend())
      return { status: 'rejected', reason: '所选钉钉会话不可用或授权已取消。' }
    const preparation = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const interrupted = Promise.withResolvers<undefined>()
    const cancel = () => interrupted.resolve(undefined)
    preparation.addEventListener('abort', cancel, { once: true })
    let token: string | undefined
    try {
      token = await Promise.race([this.options.getToken(), interrupted.promise])
    } catch {
      return { status: 'rejected', reason: '钉钉提醒发送前未能获取凭据。' }
    } finally {
      preparation.removeEventListener('abort', cancel)
    }
    if (!token || preparation.aborted || !maySend())
      return { status: 'rejected', reason: '钉钉提醒发送前凭据不可用或授权已取消。' }
    const current = this.peer(peer.peerId, peer.actorId)
    if (
      current?.corpId !== peer.corpId ||
      current.spaceType !== peer.spaceType ||
      current.spaceId !== peer.spaceId
    )
      return { status: 'rejected', reason: '钉钉提醒的私聊或群聊绑定已变更。' }
    try {
      const receipt = await this.sendRobotMessage(
        peer,
        'sampleText',
        { content: body },
        token,
        signal,
      )
      return { status: 'accepted', receipt }
    } catch (error) {
      if (error instanceof DingtalkCardError)
        return { status: error.uncertain ? 'unknown' : 'rejected', reason: error.message }
      throw error
    }
  }

  private async sendRobotMessage(
    peer: Peer,
    msgKey: 'sampleMarkdown' | 'sampleText',
    msgParam: { title: string; text: string } | { content: string },
    token: string,
    signal: AbortSignal,
  ) {
    const direct = peer.spaceType === 'IM_ROBOT'
    const result = await this.request(
      'POST',
      direct ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send',
      {
        robotCode: this.options.robotCode,
        msgKey,
        msgParam: JSON.stringify(msgParam),
        ...(direct ? { userIds: [peer.actorId] } : { openConversationId: peer.peerId }),
      },
      token,
      signal,
    )
    const failures = [
      result.invalidStaffIdList,
      result.filteredStaffIdList,
      result.flowControlledStaffIdList,
    ]
    if (
      result.success === false ||
      (typeof result.errcode === 'number' && result.errcode !== 0) ||
      failures.some((list) => Array.isArray(list) && list.includes(peer.actorId))
    ) {
      throw new DingtalkCardError('钉钉未接受所选用户的提醒。')
    }
    if (!identity(result.processQueryKey))
      throw new DingtalkCardError('钉钉提醒返回结果缺少查询凭据。', true)
    return result.processQueryKey
  }

  private async sendCard(
    cardId: string,
    peer: Peer,
    data: TaskCardData,
    token: string,
    signal: AbortSignal,
  ) {
    const single = data.entries[0]
    const payload = {
      outTrackId: cardId,
      cardTemplateId: this.options.templateId,
      callbackType: 'STREAM',
      userIdType: 1,
      cardData: {
        cardParamMap: {
          title: data.digest
            ? `ZeRo · ${data.entries.length} 条任务摘要`
            : `#${single.taskId} ${single.title}`,
          summary: data.digest
            ? data.entries
                .map((entry) => `#${entry.taskId} ${entry.title}：${entry.summary}`)
                .join('\n')
            : single.summary,
          tasks: JSON.stringify(
            data.entries.map(({ taskId, title, summary }) => ({ taskId, title, summary })),
          ),
          status: '待跟进',
        },
      },
      openSpaceId: `dtv1.card//${peer.spaceType}.${peer.spaceId}`,
      ...(peer.spaceType === 'IM_GROUP'
        ? {
            imGroupOpenSpaceModel: { supportForward: false },
            imGroupOpenDeliverModel: { robotCode: this.options.robotCode },
          }
        : {
            imRobotOpenSpaceModel: { supportForward: false },
            imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' },
          }),
    }
    const result = await this.cardRequest(
      'POST',
      '/v1.0/card/instances/createAndDeliver',
      payload,
      token,
      signal,
    )
    const results = Array.isArray(result.deliverResults) ? result.deliverResults.map(record) : []
    const delivery = results.find(
      (item) => item.spaceType === peer.spaceType && item.spaceId === peer.spaceId,
    )
    if (
      result.outTrackId !== cardId ||
      results.length !== 1 ||
      !delivery ||
      typeof delivery.success !== 'boolean'
    ) {
      throw new DingtalkCardError('钉钉回执未能确认指定卡片和接收会话。', true)
    }
    if (!delivery.success) throw new DingtalkCardError('钉钉未向所选会话投放卡片。')
    return cardId
  }

  async handle(frame: DWClientDownStream): Promise<boolean> {
    const event = json(frame.data)
    const cardId = event.outTrackId
    const messageId = frame.headers?.messageId
    if (
      !identity(cardId) ||
      !identity(messageId) ||
      event.type !== 'actionCallback' ||
      !this.options.onAction
    )
      return false
    const card = this.database()
      .query<Card, [string]>('SELECT * FROM cards WHERE cardId = ?')
      .get(cardId)
    if (
      !card ||
      card.state !== 'accepted' ||
      card.receipt !== cardId ||
      event.userId !== card.actorId ||
      event.corpId !== card.corpId ||
      Number(event.userIdType) !== 1 ||
      event.spaceType !== card.spaceType ||
      event.spaceId !== card.spaceId
    )
      return false
    const action = record(json(event.content).cardPrivateData)
    if (
      !Array.isArray(action.actionIds) ||
      action.actionIds.length !== 1 ||
      action.actionIds[0] !== 'ack'
    )
      return false
    const taskIds = JSON.parse(card.taskIds) as number[]
    const supplied = record(action.params).taskId
    if (
      supplied !== undefined &&
      typeof supplied !== 'number' &&
      (typeof supplied !== 'string' || !/^[1-9]\d*$/.test(supplied))
    )
      return false
    const taskId = supplied === undefined && taskIds.length === 1 ? taskIds[0] : Number(supplied)
    if (!Number.isSafeInteger(taskId) || !taskIds.includes(taskId)) return false
    if (
      !(await this.options.onAction({
        peerId: card.peerId,
        actorId: card.actorId,
        cardId,
        taskId,
        action: 'ack',
        messageId,
      }))
    )
      return false
    const token = await this.options.getToken()
    if (!token) throw new DingtalkCardError('任务已处理，更新钉钉卡片所需的凭据不可用。')
    await this.cardRequest(
      'PUT',
      '/v1.0/card/instances',
      {
        outTrackId: cardId,
        cardUpdateOptions: { updateCardDataByKey: true },
        cardData: { cardParamMap: { status: `已跟进 #${taskId}` } },
      },
      token,
      AbortSignal.timeout(15_000),
    )
    return true
  }
}
