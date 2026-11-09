import { createHash } from 'node:crypto'
import type { RouterLedgerStore } from '@zero-os/observe'
import type {
  RouterPresentation,
  RouterPublication,
  RouterPublicationChannel,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { capability, routerChoice, routerInteger, routerText } from './router-capabilities'
import { createRouterUICapability } from './router-ui-capability'
import { DirectReminderUnavailableError, type TriggerRoutingRuntime } from './routing-runtime'

export function deliveryReceipt(publication: RouterPublication | null) {
  if (!publication) return null
  return {
    id: publication.id,
    matterId: publication.matterId,
    matterVersion: publication.matterVersion,
    scope: publication.scope,
    createdAt: publication.createdAt,
    deliveries: publication.deliveries.map(({ channel, status, receipt, reason, attempt }) => ({
      channel,
      status,
      receipt,
      reason,
      attempt,
    })),
    projection:
      '仅投递回执；需要原文时用 read_publication 按平台读取，完整正文与组件仍保存在交付记录中。',
  }
}

const channels = ['web', 'weixin', 'dingtalk', 'feishu'] as const
export class RouterPublications {
  constructor(
    private readonly ledger: RouterLedgerStore,
    private readonly routing: Pick<
      TriggerRoutingRuntime,
      'listPersonalBots' | 'getConfig' | 'prepareDirectReminder' | 'sendDirectReminder'
    > &
      Partial<Pick<TriggerRoutingRuntime, 'readDirectReceipt'>>,
    private readonly accessible: (principal: string, matterId: string) => boolean = () => true,
  ) {}
  private prepare(channel: RouterPublicationChannel) {
    if (channel === 'web') return null
    return JSON.stringify(this.routing.prepareDirectReminder(channel))
  }
  private deliverableMatter(principal: string, matterId: string) {
    if (principal !== 'router-owner' || !this.accessible(principal, matterId)) return null
    const matter = this.ledger.getMatter(principal, matterId)
    return matter?.state === 'paused' || matter?.state === 'cancelled' ? null : matter
  }
  async deliver(principal: string, id: string, signal: AbortSignal) {
    const publication = this.ledger.publications.get(principal, id)
    if (!publication) throw new TriggerAgentError('当前身份下没有这份交付。')
    await Promise.all(
      publication.deliveries.map(async (delivery) => {
        const claim = this.ledger.publications.claim(principal, id, delivery.channel)
        if (!claim) return
        const maySend = () =>
          !signal.aborted &&
          !!this.deliverableMatter(principal, publication.matterId) &&
          (delivery.channel === 'web' || this.routing.getConfig().settings.enabled !== false)
        let outcome: {
          status: 'accepted' | 'rejected' | 'unknown'
          receipt?: string
          reason?: string
        }
        if (delivery.channel !== 'web' && this.routing.getConfig().settings.enabled === false)
          outcome = { status: 'rejected', reason: '主动通知已暂停。' }
        else if (!maySend())
          outcome = { status: 'rejected', reason: '事项已停止或访问授权已变更。' }
        else if (delivery.channel === 'web')
          outcome = { status: 'accepted', receipt: `router-publication:${id}` }
        else if (!claim.target) outcome = { status: 'rejected', reason: '未绑定可投递的机器人。' }
        else {
          try {
            const prepared = JSON.parse(claim.target) as { channelId: string; audienceKey: string }
            outcome = await this.routing.sendDirectReminder(
              delivery.channel,
              prepared,
              delivery.presentation.text,
              `publication-${id}-${delivery.channel}`,
              signal,
              maySend,
              delivery.presentation,
            )
          } catch (error) {
            if (error instanceof DirectReminderUnavailableError)
              outcome = { status: 'rejected', reason: error.message }
            else {
              // The call may have reached a remote platform; never infer it is safe to resend.
              outcome = { status: 'unknown', reason: '未能确认平台结果，请核对投递轨迹。' }
            }
          }
        }
        this.ledger.publications.finish(principal, id, delivery.channel, claim.attempt, {
          status: outcome.status,
          receipt: outcome.receipt ?? null,
          reason: outcome.reason ?? null,
        })
      }),
    )
    return this.ledger.publications.get(principal, id)
  }
  async resume(signal: AbortSignal) {
    for (const row of this.ledger.publications.unknownDeliveries()) {
      if (signal.aborted) return
      if (!this.accessible(row.principal, row.matterId)) continue
      const receipt = this.routing.readDirectReceipt?.(
        row.channel,
        JSON.parse(row.target),
        `publication-${row.id}-${row.channel}`,
      )
      if (receipt)
        this.ledger.publications.confirmReceipt(row.id, row.channel, row.attempt, receipt)
    }
    for (const row of this.ledger.publications.pending()) {
      if (signal.aborted) return
      await this.deliver(row.principal, row.id, signal)
    }
  }
  capabilities(
    principal: string,
    scope: string,
    turnId: number,
    authorized: () => boolean,
    mayRead: (matterId: string) => boolean = () => true,
    reader?: {
      channel: RouterPublicationChannel
      audienceKey: string | null
      observe(matterId: string, readOriginal: boolean): void
    },
  ) {
    if (principal !== 'router-owner' || !authorized()) return []
    const guard = () => {
      if (!authorized()) throw new TriggerAgentError('当前身份没有 Router 个人投递权限。')
    }
    const string = { type: 'string', minLength: 1 }
    return [
      capability(
        'publish_update',
        '交付事项进展或结果。默认同时准备网页和三个已选机器人的版本；用户指定渠道或启用 contextual 情境通知时，由你根据其请求及预演结果选择 deliveryChannels，避免在其他平台重复发送。每个平台独立保存和核对回执。Agent 根据平台组织标题、正文和可见操作：微信先用短段落讲结论和关键限制，默认保留最关键的一条证据链接，其余依据放完整报告；飞书和钉钉用原生展示。钉钉 text 是 Markdown 正文，由 Agent 自行使用空行、列表、加粗及带标题链接组织，不依赖单个换行分段，不把长裸链接塞进段落。网页 text 保存完整文字与证据，components 用有层级的短摘要和操作，不要把完整报告复制到两个位置。当前钉钉模板的 actions 只支持一个 label 为「确认」的按钮；其他操作由用户在私聊继续提出。本工具创建新交付，不能更新旧卡。平台未接入或失败不影响其他平台。actions 的 label 就是用户点击后提交的原文，不能暗藏指令。不要把 accepted 说成已读。',
        {
          matterId: string,
          version: { type: 'integer', minimum: 1 },
          deliveryChannels: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { type: 'string', enum: channels },
            description:
              '用户指定平台或使用情境通知时提供。presentations 必须恰好包含选中的渠道。初期同步模式省略此参数时要求全部已配置平台。',
          },
          remindAt: {
            type: 'string',
            description:
              '需要延后通知时选择仅网页交付，并填写带时区的未来时间。在该时刻重新唤醒主 Agent，读取此交付后判断当时该通知哪个渠道。',
          },
          presentations: {
            type: 'object',
            description:
              '每个交付平台一个 {title,text,actions:[{id,label}]}。飞书和钉钉待决定的交付必须提供可点击 actions，不仅用正文要求回复；钉钉使用一个「确认」按钮并在正文写清点击对应的具体动作。普通进展无需按钮。网页额外提供 components 和 data，与 present_ui 同一 A2UI 目录；有按钮时必须提供 Agent 自行组织的组件树，组件 id 对应 actions.id。',
          },
        },
        async (args, signal) => {
          guard()
          const matterId = routerText(args.matterId, 100)
          const version = routerInteger(args.version)
          if (
            !mayRead(matterId) ||
            this.deliverableMatter(principal, matterId)?.version !== version
          )
            throw new TriggerAgentError('请先读取事项的最新版本。')
          const raw = args.presentations
          if (
            !raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.keys(raw).some((c) => !channels.includes(c as RouterPublicationChannel))
          )
            throw new TriggerAgentError('请按平台准备展示。')
          const definitions = raw as Record<string, unknown>
          const settings = this.routing.getConfig().settings
          const remindAt = args.remindAt === undefined ? undefined : routerText(args.remindAt, 80)
          if (settings.notificationMode === 'contextual' && args.deliveryChannels === undefined)
            throw new TriggerAgentError(
              '按当前情境选择交付渠道；可用 preview_current_route 核对去向。',
            )
          if (
            remindAt &&
            (!Array.isArray(args.deliveryChannels) ||
              args.deliveryChannels.length !== 1 ||
              args.deliveryChannels[0] !== 'web' ||
              !settings.enabled)
          )
            throw new TriggerAgentError('延后提醒需要通知已开启，并先只将本次结果保存在网页。')
          if (
            settings.enabled === false &&
            Array.isArray(args.deliveryChannels) &&
            args.deliveryChannels.some((c) => c !== 'web')
          )
            throw new TriggerAgentError('主动通知已暂停，可将进展保存在网页。')
          const selected = settings.enabled === false ? {} : (settings.personalBots ?? {})
          const expected = channels.filter((c) => c === 'web' || selected[c])
          if (args.deliveryChannels !== undefined) {
            const requested = args.deliveryChannels
            if (
              !Array.isArray(requested) ||
              requested.length === 0 ||
              requested.length > channels.length ||
              new Set(requested).size !== requested.length ||
              requested.some((c) => !expected.includes(c)) ||
              requested.some((c) => !definitions[c]) ||
              Object.keys(definitions).some((c) => !requested.includes(c))
            )
              throw new TriggerAgentError('请选择已配置的交付平台，并仅提供这些平台的展示内容。')
          } else if (
            expected.some((c) => !definitions[c]) ||
            Object.keys(definitions).some((c) => !expected.includes(c as RouterPublicationChannel))
          )
            throw new TriggerAgentError(
              `本次已配置平台为 ${expected.join('、')}。请仅为这些平台准备独立版本。`,
            )
          const parsed = Object.entries(definitions).map(([name, value]) => {
            const channel = routerChoice(name, channels)
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new TriggerAgentError('平台展示必须是对象。')
            const item = value as Record<string, unknown>
            if (
              Object.keys(item).some(
                (k) =>
                  !(
                    channel === 'web'
                      ? ['title', 'text', 'actions', 'components', 'data']
                      : ['title', 'text', 'actions']
                  ).includes(k),
              ) ||
              !Array.isArray(item.actions) ||
              item.actions.length > 4
            )
              throw new TriggerAgentError('平台展示包含无效字段或操作。')
            const presentation: RouterPresentation = {
              title: routerText(item.title, 100),
              text: routerText(item.text, null),
              actions: item.actions.map((a) => {
                if (
                  !a ||
                  typeof a !== 'object' ||
                  Array.isArray(a) ||
                  Object.keys(a).some((k) => !['id', 'label'].includes(k))
                )
                  throw new TriggerAgentError('操作必须提供 id 和可见 label。')
                const id = routerText(a.id, 40)
                if (!/^[a-zA-Z0-9_-]+$/.test(id))
                  throw new TriggerAgentError('操作编号只支持字母、数字、横线和下划线。')
                return { id, label: routerText(a.label, 80) }
              }),
            }
            if (new Set(presentation.actions.map((a) => a.id)).size !== presentation.actions.length)
              throw new TriggerAgentError('操作编号不能重复。')
            if (
              channel === 'web' &&
              (presentation.actions.length || item.components !== undefined)
            ) {
              const ui = createRouterUICapability()
              ui.tool.execute(
                {
                  components: item.components,
                  data: item.data ?? {},
                  actions: Object.fromEntries(
                    presentation.actions.map((a) => [
                      a.id,
                      { instruction: a.label, matterId, matterVersion: version },
                    ]),
                  ),
                },
                signal,
              )
              presentation.generatedUI = ui.get()
            }
            return { channel, presentation }
          })
          const id = createHash('sha256')
            .update(
              JSON.stringify([
                principal,
                turnId,
                matterId,
                version,
                definitions,
                ...(remindAt ? [remindAt] : []),
              ]),
            )
            .digest('hex')
          const existing = this.ledger.publications.get(principal, id)
          if (!existing) {
            const deliveries = parsed.map((item) => {
              try {
                return { ...item, target: this.prepare(item.channel) }
              } catch (error) {
                if (!(error instanceof DirectReminderUnavailableError)) throw error
                return { ...item, target: null, reason: error.message }
              }
            })
            this.ledger.preparePublication(
              {
                id,
                principal,
                matterId,
                matterVersion: version,
                scope,
                deliveries,
              },
              remindAt,
            )
          }
          const receipt = deliveryReceipt(await this.deliver(principal, id, signal))
          return remindAt
            ? { ...receipt, reminder: this.ledger.getTimer(principal, 'publication:' + id) }
            : receipt
        },
        ['deliveryChannels', 'remindAt'],
      ),
      ...(reader
        ? [
            capability(
              'search_publications',
              '用通知标题或正文里的一段原话查当前平台已受理的历史交付，包括较早的通知。结果是候选，用 read_publication 查看原文并核对所属事项。可传回 nextBefore 继续翻页。',
              { query: string, before: string },
              (args) => {
                guard()
                const query = routerText(args.query)
                let before = args.before === undefined ? null : routerText(args.before)
                const items = []
                let nextBefore: string | null = null
                while (items.length <= 30) {
                  const rows = this.ledger.publications.searchDeliveredTo(
                    principal,
                    reader.channel,
                    reader.audienceKey,
                    query,
                    before,
                    31,
                  )
                  items.push(...rows.filter((item) => mayRead(item.matterId)))
                  if (rows.length < 31) break
                  before = rows[rows.length - 1].cursor
                }
                if (items.length > 30) {
                  items.length = 30
                  nextBefore = items[29].cursor
                }
                for (const item of items) reader.observe(item.matterId, false)
                return { items, nextBefore }
              },
              ['before'],
            ),
          ]
        : []),
      capability(
        'read_publication',
        '按交付编号和平台读取当时真实展示的原文、组件及操作。用于核对旧消息或回应用户指代；与当前事项结论区分，不能把旧结论自动当作现状。',
        { publicationId: string, channel: { type: 'string', enum: channels } },
        (args) => {
          guard()
          const publication = this.ledger.publications.get(
            principal,
            routerText(args.publicationId, 100),
          )
          if (!publication || !mayRead(publication.matterId))
            throw new TriggerAgentError('此事项的交付记录不可访问。')
          const channel = routerChoice(args.channel, channels)
          const delivery = publication.deliveries.find((d) => d.channel === channel)
          if (!delivery) throw new TriggerAgentError('该交付没有此平台的记录。')
          reader?.observe(publication.matterId, true)
          return {
            id: publication.id,
            matterId: publication.matterId,
            matterVersion: publication.matterVersion,
            createdAt: publication.createdAt,
            channel,
            status: delivery.status,
            ...(delivery.reason && { reason: delivery.reason }),
            presentation: delivery.presentation,
          }
        },
      ),
      capability(
        'read_deliveries',
        '读取事项每个平台的实际交付记录，不把渠道受理当成已读。',
        { matterId: string },
        (args) => {
          guard()
          const matterId = routerText(args.matterId, 100)
          if (!mayRead(matterId)) throw new TriggerAgentError('此事项的交付记录不可访问。')
          return this.ledger.publications.list(principal, matterId).map(deliveryReceipt)
        },
      ),
      capability(
        'retry_delivery',
        '仅按原交付编号重试一个明确未发送的平台，沿用原文及卡片。其他已成功平台不重复发送；结果未知时须先核对，不能强制重发。',
        { publicationId: string, channel: { type: 'string', enum: channels } },
        async (args, signal) => {
          guard()
          const id = routerText(args.publicationId, 100)
          const channel = routerChoice(args.channel, channels)
          const publication = this.ledger.publications.get(principal, id)
          if (!publication || !mayRead(publication.matterId))
            throw new TriggerAgentError('此事项的交付记录不可访问。')
          this.ledger.publications.retry(principal, id, channel, this.prepare(channel))
          return deliveryReceipt(await this.deliver(principal, id, signal))
        },
      ),
    ]
  }
}
